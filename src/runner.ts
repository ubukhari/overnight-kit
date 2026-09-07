import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildFixPrompt,
  fetchGithubFailureLogs,
  fetchVercelLogs,
  waitForGithubChecks,
  waitForVercel,
  type GateResult,
} from "./ci.js";
import {
  loadPromptsFile,
  renderPromptText,
  type MergeStrategy,
  type Prompt,
  type PromptsFile,
} from "./config.js";
import { classifyResult, extractLogSummary, recommendResumeOption, stripAnsi } from "./detect.js";
import { pushEvents } from "./digest-client.js";
import { commandExists, exec, execToFile } from "./exec.js";
import { Git } from "./git.js";
import { RunLog, readEventsJsonl } from "./logs.js";
import { createNotifier, type FetchLike, type Notifier } from "./notify.js";
import {
  allDirtyMatchCommonRegen,
  computeDirtyDelta,
  filterIgnoredPaths,
  resolveIgnoredPaths,
  splitPorcelain,
} from "./paths.js";
import {
  Completions,
  classifyStateForResume,
  isoNow,
  prefixHash,
  promptsHash,
  readState,
  removeState,
  statePath as statePathFor,
  timestampForFiles,
  writeState,
  type CiStatus,
  type RunState,
  type RunStatus,
} from "./state.js";

export type RunMode = "auto" | "resume" | "continue" | "fresh";

export interface RunOptions {
  promptsPath: string;
  mode?: RunMode;
  forceContinue?: boolean;
  autoRecover?: boolean;
  autoStash?: boolean;
  strictPreflight?: boolean;
  skipCurrent?: boolean;
  /** CLI override of the file's merge_strategy. */
  merge?: MergeStrategy;
  /** CLI override of wait_for_ci (false = --no-wait-for-ci). */
  waitForCi?: boolean;
  /** CLI override of ci.fix_max_attempts (0 = --no-ci-fix). */
  ciFixAttempts?: number;
  strictCiTimeout?: boolean;
  /** Walk the whole sequence without invoking claude, touching git state, notifying or writing state. */
  dryRun?: boolean;
  /** Runner home (logs/state/recovery/locks). Default: $OVERNIGHT_HOME, $CLAUDE_RUNNER_HOME, ~/.overnight */
  home?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  status: "completed" | "nothing_new" | "continue_done" | "dry_run";
  branch: string;
  logDir: string;
  statePath?: string;
  prUrl?: string;
  total: number;
  ran: number;
}

/** Thrown after the runner has already notified, written diagnostics and flushed state. */
export class HaltError extends Error {
  readonly code = "HALT";
  constructor(message: string) {
    super(message);
    this.name = "HaltError";
  }
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["OVERNIGHT_HOME"] ?? env["CLAUDE_RUNNER_HOME"] ?? join(homedir(), ".overnight");
}

interface Outcome {
  id: string;
  label: string;
  sha: string;
  kind: string;
}

export async function runBatch(opts: RunOptions): Promise<RunSummary> {
  const env = opts.env ?? process.env;
  const out = opts.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = opts.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = opts.now ?? (() => new Date());
  const mode: RunMode = opts.mode ?? "auto";
  const loaded = await loadPromptsFile(opts.promptsPath);
  for (const w of loaded.warnings) err(`warning: ${w}`);
  const cfg: PromptsFile = loaded.config;
  const promptsFile = loaded.file;
  const prompts = cfg.prompts;
  const total = prompts.length;
  const branch = cfg.branch_name;
  const mergeStrategy: MergeStrategy = opts.merge ?? cfg.merge_strategy;
  const waitForCi = opts.waitForCi ?? cfg.wait_for_ci;
  const ci = { ...cfg.ci, strict_timeout: opts.strictCiTimeout ?? cfg.ci.strict_timeout };
  if (opts.ciFixAttempts !== undefined) ci.fix_max_attempts = opts.ciFixAttempts;
  const defaultModel =
    cfg.default_model ?? env["OVERNIGHT_DEFAULT_MODEL"] ?? env["CLAUDE_RUNNER_DEFAULT_MODEL"];
  const ignored = resolveIgnoredPaths(env);
  const home = opts.home ?? resolveHome(env);
  const stamp = timestampForFiles(now());
  const logDir = await uniqueLogDir(join(home, "logs"), stamp);
  const isContinue = mode === "continue";
  const statePath = statePathFor(home, branch);
  const lockPath = join(home, "locks", `${branch}.pid`);
  const recoveryDir = join(home, "recovery", branch);
  const lastFailurePath = join(recoveryDir, "last-failure.md");
  const lastSuccessPath = join(recoveryDir, "last-success.md");
  const git = new Git(cfg.project_path, env);
  const log = new RunLog(logDir, { branch, project: cfg.project_path });
  const digestToken = env["OVERNIGHT_DIGEST_TOKEN"] ?? cfg.digest?.token;
  const digest =
    cfg.digest && digestToken ? { url: cfg.digest.url, token: digestToken } : undefined;

  if (!(await git.isRepo())) {
    throw new HaltError(`${cfg.project_path} is not a git repository (project_path)`);
  }

  // ---------------------------------------------------------------------------------------------
  // Dry run: the whole sequence, no side effects beyond the log dir.
  // ---------------------------------------------------------------------------------------------
  if (opts.dryRun) return dryRun();

  const notifier: Notifier = createNotifier({
    discordUrl: env["OVERNIGHT_DISCORD_WEBHOOK_URL"] ?? cfg.discord_webhook_url,
    slackUrl: env["OVERNIGHT_SLACK_WEBHOOK_URL"] ?? cfg.slack_webhook_url,
    logFile: log.notificationsPath,
    disabled:
      env["OVERNIGHT_DISABLE_NOTIFY"] === "1" || env["CLAUDE_RUNNER_DISABLE_NOTIFY"] === "1",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    onFirstFailure: (info) =>
      err(
        `\n==============================================================\n  WARNING: First notification FAILED (${info.outcome}, http ${info.status}: ${info.error}).\n  Notifications appear to be DOWN for this run; it continues without them.\n  Common cause: webhook revoked (HTTP 404). Log: ${log.notificationsPath}\n==============================================================\n`,
      ),
  });

  await log.init();
  await mkdir(dirname(lockPath), { recursive: true });

  // --- Lock -------------------------------------------------------------------------------------
  try {
    const old = (await readFile(lockPath, "utf8")).trim();
    const pid = Number(old);
    if (pid && isAlive(pid)) {
      await halt(
        `Another runner is active for branch '${branch}' (PID ${pid}). Aborting to avoid double-run.`,
      );
    }
    out(`Cleaning up stale lock ${lockPath} (PID '${old || "unknown"}' is no longer running).`);
    await rm(lockPath, { force: true });
  } catch (e) {
    if (e instanceof HaltError) throw e;
  }
  await writeFile(lockPath, `${process.pid}\n`, "utf8");
  const releaseLock = () => rm(lockPath, { force: true }).catch(() => undefined);

  // --- State --------------------------------------------------------------------------------------
  let resume = false;
  let stateLoaded = false;
  let lastCompletedId = "";
  let lastCompletedIndex = -1;
  let completions = new Completions();
  const outcomes: Outcome[] = [];
  let lastSuccess: { index: number; label: string; sha: string } | undefined;
  let completedAtStart = 0;
  let newlyAppendedAtStart = 0;
  let pendingAtStart = total;
  let workDone = 0;
  let halted = false;
  const fullHash = promptsHash(prompts);
  // CI tool availability (resolved once before the main loop; read by the gate helpers).
  let vercelOk = false;
  let ghOk = false;
  let slug: string | null = null;

  const stateWritesEnabled = () => !isContinue;
  async function updateState(status: RunStatus): Promise<void> {
    if (!stateWritesEnabled()) return;
    const state: RunState = {
      branch_name: branch,
      prompts_file: promptsFile,
      prompts_hash: fullHash,
      completed_prefix_hash: prefixHash(prompts, lastCompletedIndex),
      status,
      last_completed_id: lastCompletedId,
      last_completed_index: lastCompletedIndex,
      timestamp: isoNow(now()),
      completions: completions.toArray(),
    };
    await writeState(statePath, state);
  }

  async function pushDigest(): Promise<void> {
    if (!digest) return;
    try {
      const events = await readEventsJsonl(log.eventsPath);
      const r = await pushEvents({
        url: digest.url,
        token: digest.token,
        events,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      await log.note(
        `digest-push url=${digest.url} ok=${r.ok} status=${r.status} accepted=${r.accepted ?? "—"} error=${r.error ?? "—"}`,
      );
      if (!r.ok)
        err(`(digest push failed: ${r.error ?? r.status}; events kept in ${log.eventsPath})`);
    } catch (e) {
      await log.note(`digest-push error=${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function finalizeHalt(): Promise<never> {
    halted = true;
    if (stateLoaded) await updateState("halted").catch(() => undefined);
    await pushDigest();
    await releaseLock();
    throw new HaltError("halted");
  }

  async function halt(message: string, decision = false): Promise<never> {
    err(`HALT: ${message}`);
    await notifier.send(`🛑 HALT ${message}`, "halt", "halt");
    await log.event({ type: "halt", reason: message });
    if (decision) await log.event({ type: "decision", message });
    return finalizeHalt();
  }

  /** Halt after the caller already sent a tailored notification. */
  async function haltRich(consoleMessage: string): Promise<never> {
    err(`HALT: ${consoleMessage}`);
    return finalizeHalt();
  }

  try {
    if (isContinue) {
      // ignore state entirely
    } else if (mode === "fresh") {
      if (await readState(statePath)) {
        await removeState(statePath);
        out(`--fresh: removed existing state file at ${statePath}.`);
      }
    } else {
      const existing = await readState(statePath);
      if (!existing) {
        if (mode === "resume" || opts.forceContinue)
          out(`--resume: no state file at ${statePath}; treating as fresh run.`);
      } else {
        const decision = await classifyStateForResume({
          state: existing,
          path: statePath,
          prompts,
          branch,
          now: now(),
        });
        if (decision.kind === "resume") {
          if (decision.migrated)
            out(
              `Migrated legacy state file at ${statePath}: recorded completed_prefix_hash from current JSON.`,
            );
          resume = true;
          if (mode === "auto")
            out(
              "Implicit resume: state file matches this JSON; will skip completed prompts and run pending/appended/failed.",
            );
        } else if (decision.kind === "archived") {
          out(
            `JSON has no id overlap with state for branch '${branch}'. Previous state archived to ${decision.archive}.`,
          );
          await notifier.send(
            `ℹ️ JSON replaced for branch '${branch}' (no id overlap with state). Previous state archived. Running all ${total} prompts.`,
            "min",
            "json-archived",
          );
        } else if (opts.forceContinue) {
          out("--force-continue: prefix-hash mismatch ignored, resuming anyway.");
          await notifier.send(
            `⚠️ ${decision.message} --force-continue resuming anyway.`,
            "default",
            "force-continue",
          );
          resume = true;
        } else {
          await notifier.send(`🛑 ${decision.message}`, "halt", "prefix-mismatch");
          await halt(decision.message, true);
        }
      }
    }

    // --- Batch-start ping ----------------------------------------------------------------------
    let startLine: string;
    if (isContinue) {
      startLine = `🚀 Starting batch: ${branch} (--continue mode, ${total} prompts on current branch)`;
    } else {
      const state = resume ? await readState(statePath) : null;
      completedAtStart = state
        ? state.completions.filter((c) => c.status === "completed").length
        : 0;
      if (state) {
        const known = new Set(state.completions.map((c) => c.id));
        newlyAppendedAtStart = prompts.filter((p) => !known.has(p.id)).length;
      }
      pendingAtStart = total - completedAtStart;
      startLine = `🚀 Starting batch: ${branch} (${completedAtStart} completed, ${pendingAtStart} pending — including ${newlyAppendedAtStart} newly appended)`;
    }
    out(startLine);
    await notifier.send(
      `${startLine}\nproject: ${cfg.project_path}\nlog dir: ${logDir}`,
      "default",
      "batch-start",
    );
    await log.event({
      type: "batch.start",
      message: startLine,
      data: { total, completedAtStart, pendingAtStart, newlyAppendedAtStart, mode },
    });

    // --- Branch handling -----------------------------------------------------------------------
    if (isContinue) {
      out(
        `Continue mode: staying on '${await git.currentBranch()}'. Branch creation, state file, and PR steps disabled.`,
      );
    } else {
      if (!(await git.fetch()))
        out("(warning: git fetch origin failed; proceeding with local refs only)");
      const localExists = await git.localBranchExists(branch);
      const remoteExists = await git.remoteBranchExists(branch);
      const current = await git.currentBranch();
      if (resume) {
        if (localExists) {
          if (current !== branch && !(await git.checkout(branch)))
            await halt(`Cannot checkout '${branch}' for resume`);
        } else if (remoteExists) {
          if (!(await git.checkoutTracking(branch)))
            await halt(`Cannot checkout '${branch}' from origin for resume`);
        } else {
          await halt(
            `Resume requested but branch '${branch}' does not exist locally or on origin.`,
          );
        }
        const state = (await readState(statePath))!;
        lastCompletedIndex = state.last_completed_index;
        lastCompletedId = state.last_completed_id;
        completions =
          state.completions.length > 0
            ? Completions.from(state.completions)
            : Completions.fromLegacy(prompts, state.last_completed_index);
        for (const c of completions.toArray()) {
          if (c.status !== "completed") continue;
          outcomes.push({
            id: c.id,
            label: prompts[c.index]?.label ?? c.id,
            sha: c.sha,
            kind: c.kind || "prior-run",
          });
        }
      } else if (localExists) {
        if (current === branch) {
          if (await git.isAncestor(cfg.base_branch, "HEAD"))
            out(
              `Already on '${branch}' with '${cfg.base_branch}' in its ancestry. Continuing on it.`,
            );
          else
            await halt(
              `On branch '${branch}' but '${cfg.base_branch}' is not an ancestor. Refusing to proceed.`,
              true,
            );
        } else if (!(await git.checkout(branch))) {
          await halt(`Cannot checkout existing branch '${branch}'`);
        }
        if (remoteExists) {
          const { ahead, behind } = await git.aheadBehind(branch);
          if (ahead > 0 && behind > 0) {
            const localOnly = await git.logOneline(`origin/${branch}..${branch}`, 5);
            const remoteOnly = await git.logOneline(`${branch}..origin/${branch}`, 5);
            await halt(
              `Branch '${branch}' diverged from origin: ${ahead} local-only, ${behind} remote-only commits.\nLocal-only:\n${localOnly}\nRemote-only:\n${remoteOnly}\nRefusing to auto-resolve. Resolve manually (rebase / reset / force-push) and re-run.`,
              true,
            );
          } else if (behind > 0) {
            out(`Branch '${branch}' is ${behind} commits behind origin; fast-forwarding.`);
            if (!(await git.pullFfOnly())) await halt(`git pull --ff-only failed on '${branch}'`);
          } else if (ahead > 0) {
            out(`Branch '${branch}' is ${ahead} commits ahead of origin (will push at end).`);
          }
        }
      } else if (remoteExists) {
        out(`Branch '${branch}' exists on origin only. Creating a tracking branch locally.`);
        if (!(await git.checkoutTracking(branch)))
          await halt(`Cannot create tracking branch '${branch}'`);
      } else {
        if (current !== cfg.base_branch && !(await git.checkout(cfg.base_branch)))
          await halt(`Cannot checkout base branch '${cfg.base_branch}'`);
        if (await git.hasRemote()) {
          if (!(await git.pullFfOnly()))
            await halt(`git pull --ff-only failed on '${cfg.base_branch}'`);
        }
        if (!(await git.checkoutNew(branch, cfg.base_branch)))
          await halt(`Cannot create branch '${branch}'`);
        await updateState("in_progress");
      }
    }
    stateLoaded = true;

    // --- --skip-current --------------------------------------------------------------------------
    if (opts.skipCurrent) {
      const failed = completions.lastFailed();
      if (!failed) out("--skip-current: no failed prompt in state file — nothing to skip.");
      else {
        const sha = failed.sha || (await git.shortHead());
        completions.upsert({
          id: failed.id,
          index: failed.index,
          status: "completed",
          sha,
          kind: "skip-current",
        });
        lastCompletedId = failed.id;
        lastCompletedIndex = failed.index;
        await updateState("in_progress");
        out(
          `[${failed.index + 1}/${total}] ⏭ ${failed.id} — force-skipped via --skip-current (sha ${sha || "—"})`,
        );
        await notifier.send(
          `[${failed.index + 1}/${total}] ⏭ ${failed.id} — force-skipped via --skip-current`,
          "min",
          "skip-current",
          failed.id,
        );
        resume = true;
      }
    }

    // --- Pre-flight cleanliness ----------------------------------------------------------------
    if (!isContinue) {
      const raw = await git.porcelain();
      const rawLines = splitPorcelain(raw);
      const dirty = opts.strictPreflight ? rawLines : filterIgnoredPaths(rawLines, ignored);
      if (dirty.length > 0) {
        if (opts.autoStash) {
          const msg = `overnight pre-run stash ${stamp}`;
          if (!(await git.stashPush(msg)))
            await halt("git stash push failed; aborting before any prompt runs");
          out(`--auto-stash: created stash '${msg}' (left in place for review at end of run).`);
          await notifier.send(`📦 Pre-run stash created: ${msg}`, "default", "pre-run-stash");
        } else if (opts.autoRecover) {
          out(`--auto-recover: dirty working tree on '${branch}':\n${await git.shortStatus()}`);
          const msg = lastCompletedId
            ? `overnight recovery: leftover from ${lastCompletedId}`
            : "overnight recovery: residual changes";
          if (!(await git.commitAll(msg))) await halt("Could not commit residual changes");
          out(`Committed dirty tree as: ${msg}`);
        } else {
          const hint = opts.strictPreflight
            ? "\n(--strict-preflight is on: ignored paths are NOT applied to the pre-flight check. Drop the flag to honor them.)"
            : "";
          await halt(
            `Starting working tree has uncommitted changes outside the ignored paths — found:\n${dirty.join("\n")}\n\nEither commit, stash, or discard manually, then re-run.\nFor an automatic stash and continue:\n  overnight run ${promptsFile} --auto-stash\n(Pass --auto-recover to commit them as part of the previous prompt instead.)${hint}`,
            true,
          );
        }
      } else if (rawLines.length > 0) {
        out(
          `Pre-flight: ${rawLines.length} uncommitted file(s) all match the ignored paths — proceeding.`,
        );
      }
      const range = (await git.refExists(cfg.base_branch)) ? `${cfg.base_branch}..HEAD` : "HEAD";
      const recoveryCommits = (await git.logFormat(range, "%h %s"))
        .split("\n")
        .filter((l) => /^[a-f0-9]+ overnight recovery: leftover from /.test(l));
      if (recoveryCommits.length > 0) {
        out(
          `\n⚠ Found ${recoveryCommits.length} auto-recovery 'leftover from' commit(s) on this branch:\n${recoveryCommits.map((l) => `    ${l}`).join("\n")}\n    Clean up manually with \`git rebase -i ${cfg.base_branch}\` if you want them gone (never done automatically).\n`,
        );
      }
    }

    // --- Pending summary -----------------------------------------------------------------------
    let pendingCount = total;
    if (resume) {
      pendingCount = prompts.filter((_, k) => completions.statusFor(k) !== "completed").length;
      out(
        pendingCount === 0
          ? `All prompts already complete for '${branch}' — nothing to run.`
          : `Resuming '${branch}': ${pendingCount} of ${total} prompts pending or failed.`,
      );
    }
    out(`Logs: ${logDir}`);
    out(stateWritesEnabled() ? `State: ${statePath}` : "State: (disabled in --continue mode)");
    out(`Running ${pendingCount} of ${total} prompts...`);

    // Tool availability for the CI gate (checked once).
    if (waitForCi) {
      vercelOk = ci.vercel && (await commandExists("vercel", env));
      ghOk = ci.github_checks && (await commandExists("gh", env));
      slug = ghOk ? await git.originSlug() : null;
      if (ci.vercel && !vercelOk)
        err(
          "warning: ci.vercel is on but the 'vercel' CLI is not on PATH — skipping the Vercel gate (brew install vercel-cli; vercel login; vercel link).",
        );
      if (ci.github_checks && !ghOk)
        err(
          "warning: ci.github_checks is on but 'gh' is not on PATH — skipping the GitHub Checks gate.",
        );
      if (ghOk && !slug)
        err("warning: could not derive owner/repo from origin — skipping the GitHub Checks gate.");
      if (!vercelOk && !(ghOk && slug))
        err(
          "warning: no CI gate available; commits are pushed but not verified. Pass --no-wait-for-ci to silence this.",
        );
    }

    // --- Main loop -------------------------------------------------------------------------------
    for (let i = 0; i < total; i++) {
      const p = prompts[i]!;
      const human = i + 1;
      const model = p.model ?? defaultModel;
      const logPath = log.promptLogPath(p.id);

      if (resume && completions.statusFor(i) === "completed") {
        const sha = completions.shaFor(i);
        const reachable = !sha || (await git.isAncestor(sha, "HEAD"));
        if (reachable) {
          out(`\n[${human}/${total}] ⏭ ${p.label} — already complete (${sha || "noop"})`);
          await notifier.send(
            `[${human}/${total}] ⏭ ${p.label} — already complete (${sha || "noop"})`,
            "min",
            "skip-complete",
            p.id,
          );
          await log.event({
            type: "prompt.skip",
            prompt: { id: p.id, label: p.label, index: i, total },
            sha,
          });
          outcomes.push({ id: p.id, label: p.label, sha, kind: "skip" });
          lastCompletedId = p.id;
          lastCompletedIndex = i;
          continue;
        }
        out(
          `[${human}/${total}] ${p.label} — recorded sha ${sha} not reachable from HEAD; re-running.`,
        );
      }

      out(
        `\n=== [${human}/${total}] ${p.id} — ${p.label} (model: ${model ?? "claude default"}) ===`,
      );
      out(`Log: ${logPath}`);
      workDone++;
      const before = await git.head();
      const preStatus = await git.porcelain();
      const args = ["-p"];
      if (model) args.push("--model", model);
      args.push(
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        renderPromptText(p),
      );
      const { code } = await execToFile("claude", args, logPath, { cwd: cfg.project_path, env });
      const after = await git.head();
      const postStatus = await git.porcelain();
      const delta = computeDirtyDelta(preStatus, postStatus, ignored);
      const logText = await log.readPromptLog(p.id);
      const cls = classifyResult({
        exitCode: code,
        log: logText,
        headBefore: before,
        headAfter: after,
        deltaDirty: delta.length > 0,
      });
      await log.decision(i, total, p.id, cls.outcome, cls.reason);

      if (cls.outcome === "failure") {
        const recPath = delta.length > 0 ? await writeRecovery(p.id) : "";
        const headAdvanced = before !== after;
        const failedSha = headAdvanced ? await git.shortHead() : "";
        completions.upsert({ id: p.id, index: i, status: "failed", sha: failedSha, kind: "" });
        await writeLastFailure(
          i,
          cls.reason,
          cls.pattern ?? "",
          logPath,
          recPath,
          headAdvanced,
          before,
          after,
          logText,
        );
        let prevLine = "(none — no successful prompts yet)";
        if (lastSuccess)
          prevLine = `[${lastSuccess.index + 1}/${total}] ${lastSuccess.label} (${lastSuccess.sha})`;
        else if (outcomes.length > 0)
          prevLine = `[${outcomes.length}/${total}] ${outcomes[outcomes.length - 1]!.label} (no commit — noop)`;
        const tail = logText ? stripAnsi(logText).slice(-2000) : "";
        const payload = buildHaltPayload({
          human,
          total,
          id: p.id,
          label: p.label,
          reason: cls.reason,
          prevLine,
          tail,
          logPath,
          summaryPath: lastFailurePath,
          recPath,
        });
        await notifier.send(payload, "halt", "halt", p.id);
        await log.event({
          type: "prompt.failed",
          prompt: { id: p.id, label: p.label, index: i, total },
          sha: failedSha,
          reason: cls.reason,
          data: { tail: tail.slice(-600), log: logPath, summary: lastFailurePath },
        });
        await log.event({
          type: "decision",
          message: `Prompt ${p.id} halted: ${cls.reason}. See ${lastFailurePath}`,
        });
        await haltRich(
          `at [${human}/${total}] ${p.label}. Reason: ${cls.reason}. Log: ${logPath}. Summary: ${lastFailurePath}${recPath ? `. Recovery: ${recPath}` : ""}`,
        );
      }

      if (cls.outcome === "noop") {
        outcomes.push({ id: p.id, label: p.label, sha: "", kind: "noop" });
        lastCompletedId = p.id;
        lastCompletedIndex = i;
        completions.upsert({ id: p.id, index: i, status: "completed", sha: "", kind: "noop" });
        if (waitForCi) completions.setCi(i, "skipped");
        await updateState("in_progress");
        await writeLastSuccess(i, "", "noop");
        const summary = extractLogSummary(logText);
        await notifier.send(
          `[${human}/${total}] ℹ️ ${p.label} — no changes needed\nno changes needed${summary ? `\n${summary}` : ""}`,
          "low",
          "noop",
          p.id,
        );
        await log.event({
          type: "prompt.noop",
          prompt: { id: p.id, label: p.label, index: i, total },
          message: summary,
        });
        out(`[${human}/${total}] ✓ ${p.label} — no changes needed`);
        continue;
      }

      const sha = await git.shortHead();
      outcomes.push({ id: p.id, label: p.label, sha, kind: "commit" });
      lastCompletedId = p.id;
      lastCompletedIndex = i;
      lastSuccess = { index: i, label: p.label, sha };
      completions.upsert({ id: p.id, index: i, status: "completed", sha, kind: "commit" });
      await updateState("in_progress");
      await writeLastSuccess(i, sha, "commit");
      const subject = await git.commitSubject(sha);
      const shortstat = await git.shortStat(sha);
      const summary = extractLogSummary(logText);
      await notifier.send(
        [`[${human}/${total}] ✅ ${p.label} — committed (${sha})`, subject, shortstat, summary]
          .filter(Boolean)
          .join("\n"),
        "default",
        "commit",
        p.id,
      );
      await log.event({
        type: "prompt.commit",
        prompt: { id: p.id, label: p.label, index: i, total },
        sha,
        message: subject,
        data: { shortstat, summary },
      });
      out(`[${human}/${total}] ✓ ${p.label} — committed (${sha})`);

      if (waitForCi) await ciGate(i, human, p, sha);
    }

    // --- Push, PR, auto-merge ------------------------------------------------------------------
    out("");
    if (isContinue) {
      out("Continue mode: pushing branch (if origin reachable)...");
      const current = await git.currentBranch();
      const r = await git.push(current);
      if (r.nonFastForward)
        await halt(
          `non-fast-forward push rejected on '${current}'. Refusing to force-push.\n${r.output}\nResolve manually and re-run.`,
          true,
        );
      if (!r.ok) out("(push failed or no remote configured; skipping in --continue mode)");
      out("Continue mode complete. Skipped PR create/merge.");
      await log.event({
        type: "batch.complete",
        message: "continue mode",
        data: { ran: workDone },
      });
      await pushDigest();
      return { status: "continue_done", branch, logDir, total, ran: workDone };
    }
    if (workDone === 0) {
      out(`All prompts already complete on '${branch}' — nothing new to push.`);
      await notifier.send(
        `✅ All prompts already complete on '${branch}' — nothing new to push.`,
        "min",
        "nothing-new",
      );
      await updateState("completed");
      await log.event({ type: "batch.nothing_new" });
      await pushDigest();
      return { status: "nothing_new", branch, logDir, statePath, total, ran: 0 };
    }
    out(`All prompts completed. Pushing '${branch}'...`);
    const pushed = await git.push(branch);
    if (pushed.nonFastForward)
      await halt(
        `non-fast-forward push rejected on '${branch}'. Refusing to force-push.\n${pushed.output}\nResolve manually and re-run.`,
        true,
      );
    if (!pushed.ok) await halt(`git push failed for '${branch}'\n${pushed.output}`);
    const pr = await exec(
      "gh",
      [
        "pr",
        "create",
        "--title",
        cfg.pr_title,
        "--body",
        cfg.pr_body,
        "--base",
        cfg.base_branch,
        "--head",
        branch,
      ],
      { cwd: cfg.project_path, env },
    );
    if (pr.code !== 0) await halt(`gh pr create failed\n${pr.stderr.trim()}`);
    const prUrl = pr.stdout.trim().split("\n").pop() ?? "";
    const prNum = /\/pull\/(\d+)/.exec(prUrl)?.[1] ?? "?";
    await log.event({ type: "pr.opened", url: prUrl, message: cfg.pr_title });
    let finalBody = `🎉 All ${total} prompts complete. PR #${prNum} ready for review: ${prUrl}`;
    if (mergeStrategy === "none") out("Merge strategy: none (PR awaits manual review).");
    else {
      const flag =
        mergeStrategy === "auto-squash"
          ? "--squash"
          : mergeStrategy === "auto-merge"
            ? "--merge"
            : "--rebase";
      const m = await exec("gh", ["pr", "merge", prUrl, "--auto", flag], {
        cwd: cfg.project_path,
        env,
      });
      if (m.code !== 0)
        await halt(`gh pr merge --auto ${flag} failed (PR #${prNum})\n${m.stderr.trim()}`);
      finalBody += `\n⚠️ Auto-merge enabled (${mergeStrategy}) — will merge once CI + reviews pass.`;
      out(`Merge strategy: ${mergeStrategy} (auto-merge will fire after CI/reviews).`);
      await log.event({ type: "pr.automerge", url: prUrl, message: mergeStrategy });
    }
    await notifier.send(finalBody, "high", "batch-complete");
    out(finalBody);
    await updateState("completed");
    await log.event({ type: "batch.complete", url: prUrl, data: { ran: workDone, total } });
    await pushDigest();
    out(`\nDone. PR: ${prUrl}`);
    return { status: "completed", branch, logDir, statePath, prUrl, total, ran: workDone };
  } finally {
    if (!halted) await releaseLock();
  }

  // ===============================================================================================
  // helpers (closures over the run)
  // ===============================================================================================

  async function ciGate(i: number, human: number, p: Prompt, sha: string): Promise<void> {
    out(`[${human}/${total}] Pushing ${sha} to origin/${branch}...`);
    const r = await git.push(branch);
    if (r.nonFastForward)
      await halt(
        `non-fast-forward push rejected on '${branch}'. Refusing to force-push.\n${r.output}\nResolve manually and re-run.`,
        true,
      );
    if (!r.ok) await halt(`git push failed for '${branch}' after prompt ${p.id}.\n${r.output}`);
    if (!vercelOk && !(ghOk && slug)) {
      completions.setCi(i, "skipped");
      await updateState("in_progress");
      return;
    }
    await notifier.send(
      `⏳ Waiting on CI for [${human}/${total}] ${p.label} (${sha})`,
      "default",
      "ci-wait",
      p.id,
    );
    await log.event({
      type: "ci.wait",
      prompt: { id: p.id, label: p.label, index: i, total },
      sha,
    });
    let gate = await runGates(sha);
    if (gate.status === "ready" || gate.status === "no_checks") {
      out(`[${human}/${total}] ✓ CI green: ${gate.url ?? ""}`);
      await notifier.send(
        `✅ [${human}/${total}] ${p.label} — CI green: ${gate.url ?? ""}`,
        "default",
        "ci-passed",
        p.id,
      );
      await log.event({
        type: "ci.passed",
        prompt: { id: p.id, label: p.label, index: i, total },
        sha,
        url: gate.url ?? "",
      });
      completions.setCi(i, "passed");
      await updateState("in_progress");
      return;
    }
    if (gate.status === "timeout_building" || gate.status === "timeout_no_deployment") {
      const status: CiStatus =
        gate.status === "timeout_building" ? "timeout_continued" : "skipped_no_deployment";
      if (ci.strict_timeout) {
        completions.setCi(i, "failed");
        await updateState("in_progress");
        await notifier.send(
          `🛑 [${human}/${total}] CI wait timed out for '${branch}' after ${ci.timeout_seconds}s (strict_timeout)`,
          "halt",
          "ci-timeout-strict",
          p.id,
        );
        await halt(
          `CI wait timed out for '${branch}' after ${ci.timeout_seconds}s (prompt ${p.id}, sha ${sha}). strict_timeout is set.`,
        );
      }
      completions.setCi(i, status);
      await updateState("in_progress");
      const msg =
        gate.status === "timeout_building"
          ? `⚠️ [${human}/${total}] ${p.label} — CI timeout after ${ci.timeout_seconds}s. Continuing without verification — a later build will surface any breaks.`
          : `⚠️ [${human}/${total}] No CI run surfaced for ${sha} within ${ci.timeout_seconds}s. Possibly skipped or queued. Continuing without verification.`;
      await notifier.send(
        msg,
        "default",
        gate.status === "timeout_building" ? "ci-timeout-continued" : "ci-skipped-no-deployment",
        p.id,
      );
      await log.event({
        type: "ci.timeout",
        prompt: { id: p.id, label: p.label, index: i, total },
        sha,
        reason: gate.status,
      });
      out(
        `[${human}/${total}] ⚠ CI: ${gate.status.replace(/_/g, " ")} within ${ci.timeout_seconds}s — continuing without verification.`,
      );
      return;
    }
    // --- red build → fix loop ------------------------------------------------------------------
    await log.event({
      type: "ci.failed",
      prompt: { id: p.id, label: p.label, index: i, total },
      sha,
      url: gate.url ?? "",
      reason: gate.details ?? "",
    });
    if (ci.fix_max_attempts === 0) {
      completions.setCi(i, "failed");
      await updateState("in_progress");
      await notifier.send(
        `🛑 [${human}/${total}] CI FAILED: ${gate.url ?? "(no url)"}`,
        "halt",
        "ci-failed",
        p.id,
      );
      await halt(
        `CI failed for '${branch}' after prompt ${p.id} (${sha}). Run: ${gate.url ?? "(no url)"} ${gate.details ?? ""}`,
      );
    }
    const originalSha = sha;
    const diagnosisFile = join(tmpdir(), `overnight-diagnosis-${originalSha}.txt`);
    await rm(diagnosisFile, { force: true });
    const fixCommits: string[] = [];
    const failedUrls: string[] = [gate.url ?? "(no url)"];
    let currentSha = sha;
    let attempts = 0;
    for (let attempt = 1; attempt <= ci.fix_max_attempts; attempt++) {
      attempts = attempt;
      await notifier.send(
        `🔧 [${human}/${total}] CI fix attempt ${attempt}/${ci.fix_max_attempts} for ${p.label}`,
        "default",
        "ci-fix-attempt",
        p.id,
      );
      await log.event({
        type: "ci.fix_attempt",
        prompt: { id: p.id, label: p.label, index: i, total },
        sha: currentSha,
        data: { attempt, max: ci.fix_max_attempts },
      });
      const logs =
        gate.system === "vercel" && gate.url
          ? await fetchVercelLogs(gate.url, cfg.project_path, env)
          : slug
            ? await fetchGithubFailureLogs(slug, await git.head(), cfg.project_path, env)
            : (gate.details ?? "");
      const fixPrompt = buildFixPrompt({
        sha: currentSha,
        branch,
        label: p.label,
        url: gate.url ?? "",
        attempt,
        max: ci.fix_max_attempts,
        logs,
        diagnosisFile,
        system: gate.system === "vercel" ? "Vercel" : "GitHub Checks",
      });
      const headBefore = await git.head();
      const fixModel = ci.fix_model ?? defaultModel;
      const fixArgs = ["-p", "--dangerously-skip-permissions"];
      if (fixModel) fixArgs.push("--model", fixModel);
      fixArgs.push(fixPrompt);
      await execToFile("claude", fixArgs, log.ciFixLogPath(originalSha, attempt), {
        cwd: cfg.project_path,
        env,
      });
      const headAfter = await git.head();
      let diagnosis = "";
      try {
        diagnosis = (await readFile(diagnosisFile, "utf8")).slice(0, 1500);
      } catch {
        // none
      }
      if (diagnosis) {
        completions.setCi(i, "fix_declined", attempts, fixCommits);
        await updateState("in_progress");
        await notifier.send(
          `🛑 [${human}/${total}] CI failed, Claude declined to fix: ${diagnosis}`,
          "halt",
          "ci-fix-declined",
          p.id,
        );
        await halt(
          `CI failed for ${sha} and Claude declined to fix (non-code issue). Diagnosis: ${diagnosis}`,
          true,
        );
      }
      if (headBefore !== headAfter) {
        currentSha = await git.shortHead();
        fixCommits.push(currentSha);
        // The fix prompt asked Claude to push; we deliberately do not push for it (a forgotten push
        // shows up as a timeout instead of being masked).
        gate = await runGates(await git.head());
        if (gate.status === "ready" || gate.status === "no_checks") {
          completions.setCi(i, "passed_after_fix", attempts, fixCommits);
          await updateState("in_progress");
          out(
            `[${human}/${total}] ✓ CI passed after fix (attempts=${attempts}, url=${gate.url ?? ""})`,
          );
          await notifier.send(
            `✅ [${human}/${total}] ${p.label} — CI passed after fix (attempts=${attempts}): ${gate.url ?? ""}`,
            "default",
            "ci-passed-after-fix",
            p.id,
          );
          await log.event({
            type: "ci.passed",
            prompt: { id: p.id, label: p.label, index: i, total },
            sha: currentSha,
            url: gate.url ?? "",
            data: { attempts },
          });
          return;
        }
        if (gate.status === "error") {
          failedUrls.push(gate.url ?? "(no url)");
          continue;
        }
        completions.setCi(i, "failed", attempts, fixCommits);
        await updateState("in_progress");
        await notifier.send(
          `🛑 [${human}/${total}] CI re-wait timed out during fix attempt ${attempts} for '${branch}'.`,
          "halt",
          "ci-fix-timeout",
          p.id,
        );
        await halt(
          `CI re-wait timed out during fix attempt ${attempts} for '${branch}' — no new run within ${ci.timeout_seconds}s. Claude may have committed without pushing.`,
        );
      }
      // no diagnosis, no commit: count the attempt and retry
    }
    completions.setCi(i, "failed", attempts, fixCommits);
    await updateState("in_progress");
    const latest = fixCommits[fixCommits.length - 1] ?? sha;
    await notifier.send(
      `🛑 [${human}/${total}] CI failed after ${ci.fix_max_attempts} fix attempts. Latest sha: ${latest}. Branch left for manual review.\nFailed runs:${failedUrls.map((u) => `\n  - ${u}`).join("")}`,
      "halt",
      "ci-fix-exhausted",
      p.id,
    );
    await halt(
      `CI still failing after ${ci.fix_max_attempts} fix attempts on '${branch}' (latest sha: ${latest}).`,
      true,
    );
  }

  /** Vercel first, then GitHub Checks; the first red result wins. */
  async function runGates(fullSha: string): Promise<GateResult & { system: "vercel" | "github" }> {
    const gateCtx = {
      cwd: cfg.project_path,
      cfg: ci,
      log: (l: string) => log.note(l),
      env,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    };
    let combined: GateResult & { system: "vercel" | "github" } = {
      status: "no_checks",
      system: "github",
    };
    if (vercelOk) {
      const v = await waitForVercel(branch, gateCtx);
      combined = { ...v, system: "vercel" };
      if (v.status !== "ready") return combined;
    }
    if (ghOk && slug) {
      const g = await waitForGithubChecks(slug, fullSha, gateCtx);
      if (g.status === "ready" || g.status === "error" || g.status === "timeout_building")
        return { ...g, system: "github" };
      // no_checks on GitHub: fall through to whatever Vercel said (or no_checks)
      if (!vercelOk) return { ...g, system: "github" };
    }
    return combined;
  }

  async function writeRecovery(promptId: string): Promise<string> {
    const path = join(recoveryDir, `${promptId}-${timestampForFiles(now())}.diff`);
    await mkdir(recoveryDir, { recursive: true });
    const body = [
      "# overnight recovery snapshot",
      `# branch:    ${branch}`,
      `# prompt:    ${promptId}`,
      `# captured:  ${isoNow(now())}`,
      "",
      "# --- git status --short ---",
      await git.shortStatus(),
      "",
      "# --- git diff HEAD ---",
      await git.diffHead(),
      "",
      "# --- untracked files ---",
      await git.untracked(),
      "",
    ].join("\n");
    await writeFile(path, body, "utf8");
    return path;
  }

  async function writeLastSuccess(idx: number, sha: string, kind: string): Promise<void> {
    const p = prompts[idx]!;
    await mkdir(recoveryDir, { recursive: true });
    const lines = [
      "# overnight — last successful prompt",
      "",
      `- Timestamp: ${isoNow(now())}`,
      `- Branch: \`${branch}\``,
      `- Prompts file: \`${promptsFile}\``,
      `- Index: ${idx + 1}/${total}`,
      `- id: \`${p.id}\``,
      `- label: ${p.label}`,
      `- kind: ${kind}`,
      ...(sha ? [`- commit: \`${sha}\``] : []),
      "",
      "## Prompt count breakdown",
      "",
      `- Total prompts in JSON: ${total}`,
      `- Completed at start of this run: ${completedAtStart}`,
      `- Newly appended (in JSON, not in state at start): ${newlyAppendedAtStart}`,
      `- Pending at start of this run: ${pendingAtStart}`,
      "",
      "## Recent commits (last 10)",
      "",
      "```",
      await git.logOneline("HEAD", 10),
      "```",
      "",
    ];
    await writeFile(lastSuccessPath, lines.join("\n"), "utf8");
  }

  async function writeLastFailure(
    idx: number,
    reason: string,
    pattern: string,
    logPath: string,
    recDiff: string,
    headAdvanced: boolean,
    before: string,
    after: string,
    logText: string | null,
  ): Promise<void> {
    const p = prompts[idx]!;
    await mkdir(recoveryDir, { recursive: true });
    const rec = headAdvanced ? recommendResumeOption(logText) : "";
    const falsePositive = allDirtyMatchCommonRegen(await git.porcelain());
    const lines: string[] = ["# overnight failure summary", ""];
    if (falsePositive) {
      lines.push(
        "> **Note:** All uncommitted files match common regeneration patterns (test results, lockfiles, build artifacts, logs).",
        "> This may be a false-positive halt. Consider adding the matching path(s) to OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA.",
        "",
      );
    }
    lines.push("## Resume strategy", "");
    if (!headAdvanced) {
      lines.push(
        "HEAD did not advance during this prompt. Recommended action:",
        "",
        "```sh",
        `overnight run ${promptsFile} --resume`,
        "```",
      );
    } else {
      lines.push(
        `HEAD advanced ${before.slice(0, 7)} → ${after.slice(0, 7)} during this prompt.`,
        "Claude committed work before the runner halted on a downstream check (e.g. a stream-error pattern that fired after the commit, or a lockfile dirty after `npm install`).",
        "",
      );
      lines.push(
        rec === "A"
          ? "**Recommended: Option A** — log shows evidence of test/lint/build success."
          : "**Recommended: Option B** — log doesn't clearly show test/lint/build success.",
        "",
      );
      lines.push(
        "### Option A — work completed, mark and continue",
        "",
        "```sh",
        `overnight run ${promptsFile} --skip-current`,
        "```",
        "",
        "### Option B — discard and retry",
        "",
        "```sh",
        `( cd '${cfg.project_path}' && git reset --hard ${before.slice(0, 7)} && git clean -fd )`,
        `overnight run ${promptsFile} --resume`,
        "```",
        "",
        "### Option C — force-skip (no verification)",
        "",
        "```sh",
        `overnight run ${promptsFile} --skip-current`,
        "```",
      );
    }
    lines.push(
      "",
      `- Timestamp: ${isoNow(now())}`,
      `- Branch: \`${branch}\``,
      `- Prompts file: \`${promptsFile}\``,
      `- Failing prompt: \`${p.id}\` — ${p.label}`,
      `- Reason: ${reason}`,
    );
    if (pattern) lines.push(`- Matched pattern: \`${pattern}\``);
    if (recDiff) lines.push(`- Recovery diff: \`${recDiff}\``);
    lines.push(
      `- Failing prompt log: \`${logPath}\``,
      `- Run log dir: \`${logDir}\``,
      "",
      "## Prompt count breakdown",
      "",
      `- Total prompts in JSON: ${total}`,
      `- Completed at start of this run: ${completedAtStart}`,
      `- Newly appended (in JSON, not in state at start): ${newlyAppendedAtStart}`,
      `- Pending at start of this run: ${pendingAtStart}`,
      "",
      "## Progress",
      "",
      "### Completed",
      "",
    );
    if (outcomes.length === 0) lines.push("_(none)_");
    else {
      lines.push("| # | id | label | sha | kind |", "|---|----|----|-----|----|");
      outcomes.forEach((o, n) =>
        lines.push(`| ${n + 1} | \`${o.id}\` | ${o.label} | \`${o.sha || "—"}\` | ${o.kind} |`),
      );
    }
    lines.push(
      "",
      "### Failing",
      "",
      `- id: \`${p.id}\``,
      `- label: ${p.label}`,
      "",
      "#### Prompt text",
      "",
      "```",
      renderPromptText(p),
      "```",
      "",
      "### Pending",
      "",
    );
    if (idx + 1 >= total) lines.push("_(none)_");
    else {
      lines.push("| # | id | label |", "|---|----|----|");
      for (let j = idx + 1; j < total; j++)
        lines.push(`| ${j + 1} | \`${prompts[j]!.id}\` | ${prompts[j]!.label} |`);
    }
    lines.push(
      "",
      "## Failing prompt log (full, ANSI-stripped)",
      "",
      "```",
      logText ? stripAnsi(logText) : `(log not found at ${logPath})`,
      "```",
      "",
      "## Uncommitted changes (`git diff HEAD`)",
      "",
      "```diff",
      await git.diffHead(),
      "```",
      "",
      "## Recent commits (last 10)",
      "",
      "```",
      await git.logOneline("HEAD", 10),
      "```",
      "",
    );
    await writeFile(lastFailurePath, lines.join("\n"), "utf8");
  }

  async function dryRun(): Promise<RunSummary> {
    await log.init();
    const current = await git.currentBranch();
    const porcelain = await git.porcelain();
    const dirty = filterIgnoredPaths(splitPorcelain(porcelain), ignored);
    const state = isContinue ? null : await readState(statePath);
    out(`🌙 overnight dry run — nothing will be executed, committed, pushed or notified.`);
    out(`project:   ${cfg.project_path} (on '${current}')`);
    out(
      `branch:    ${branch} (base ${cfg.base_branch})${mode === "continue" ? " — continue mode: stays on current branch" : ""}`,
    );
    out(`prompts:   ${total} from ${promptsFile}`);
    out(`model:     ${defaultModel ?? "claude default (no --model flag)"}`);
    out(
      `CI gate:   ${waitForCi ? `on (vercel=${ci.vercel}, github_checks=${ci.github_checks}, timeout ${ci.timeout_seconds}s, fix attempts ${ci.fix_max_attempts})` : "off"}`,
    );
    out(
      `merge:     ${mergeStrategy}${mergeStrategy === "none" ? " (PR opened, never merged)" : " (gh pr merge --auto)"}`,
    );
    out(
      `notify:    ${(env["OVERNIGHT_DISCORD_WEBHOOK_URL"] ?? cfg.discord_webhook_url) ? "discord " : ""}${(env["OVERNIGHT_SLACK_WEBHOOK_URL"] ?? cfg.slack_webhook_url) ? "slack" : ""}`.trimEnd() ||
        "notify:    (none configured)",
    );
    out(
      `digest:    ${digest ? digest.url : cfg.digest ? `${cfg.digest.url} (no token: set OVERNIGHT_DIGEST_TOKEN)` : "(not configured)"}`,
    );
    out(
      `state:     ${state ? `${statePath} (${state.completions.filter((c) => c.status === "completed").length} completed, status ${state.status})` : "none — fresh run"}`,
    );
    out(
      `tree:      ${dirty.length === 0 ? "clean" : `${dirty.length} uncommitted file(s) outside ignored paths → a real run would halt (use --auto-stash/--auto-recover)`}`,
    );
    out(`log dir:   ${logDir}`);
    await log.event({ type: "batch.start", message: "dry run", data: { total, dryRun: true } });
    for (let i = 0; i < total; i++) {
      const p = prompts[i]!;
      const model = p.model ?? defaultModel;
      const done = state?.completions.find((c) => c.index === i && c.status === "completed");
      out(
        `\n[${i + 1}/${total}] ${done ? "⏭" : "▶"} ${p.id} — ${p.label}${done ? ` (already complete: ${done.sha || "noop"})` : ""}`,
      );
      if (p.depends_on?.length) out(`    depends on: ${p.depends_on.join(", ")}`);
      out(
        `    claude -p${model ? ` --model ${model}` : ""} --permission-mode bypassPermissions --dangerously-skip-permissions "<${renderPromptText(p).length} chars>"`,
      );
      const firstLine = p.prompt.split("\n")[0] ?? "";
      out(`    prompt: ${firstLine.length > 110 ? `${firstLine.slice(0, 107)}...` : firstLine}`);
      if (p.acceptance?.length)
        out(`    acceptance: ${p.acceptance.length} criteria (first: ${p.acceptance[0]})`);
      out(
        `    then: classify (commit / noop / halt)${waitForCi ? " → push → wait for CI → fix loop on red" : ""}`,
      );
      await log.event({
        type: "prompt.dry_run",
        prompt: { id: p.id, label: p.label, index: i, total },
        outcome: done ? "skip" : "would-run",
        data: { model: model ?? null },
      });
    }
    out(
      `\nAfter the last prompt: push '${branch}', gh pr create --title "${cfg.pr_title}" --base ${cfg.base_branch}${mergeStrategy === "none" ? "" : `, gh pr merge --auto --${mergeStrategy.replace("auto-", "")}`}.`,
    );
    out(
      `Dry run complete. events.jsonl written to ${log.eventsPath}. Run for real with: overnight run ${promptsFile}`,
    );
    return { status: "dry_run", branch, logDir, total, ran: 0 };
  }
}

/** `run-<stamp>`, or `run-<stamp>-2`, `-3`… when two runs start in the same second. */
async function uniqueLogDir(root: string, stamp: string): Promise<string> {
  const base = join(root, `run-${stamp}`);
  let candidate = base;
  for (let n = 2; ; n++) {
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    candidate = `${base}-${n}`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface HaltPayloadInput {
  human: number;
  total: number;
  id: string;
  label: string;
  reason: string;
  prevLine: string;
  tail: string;
  logPath: string;
  summaryPath: string;
  recPath: string;
}

/** The in-prompt halt message: tail shrinks first, then drops, so reason/paths always fit 2000 chars. */
export function buildHaltPayload(i: HaltPayloadInput): string {
  const TAIL_MAX = 400;
  const PAYLOAD_MAX = 2000;
  let tail = i.tail.length > TAIL_MAX ? `...${i.tail.slice(-TAIL_MAX)}` : i.tail;
  const recLine = i.recPath ? `\nRecovery: ${i.recPath}` : "";
  const full = (t: string) =>
    `🛑 HALT [${i.human}/${i.total}] ${i.label} (id=${i.id})\nReason: ${i.reason}\nLast success: ${i.prevLine}\nResponse tail:\n${t}\nLog: ${i.logPath}\nSummary: ${i.summaryPath}${recLine}`;
  let payload = full(tail);
  while (payload.length > PAYLOAD_MAX && tail.length > 50) {
    tail = `${tail.slice(0, tail.length - 100)}...`;
    payload = full(tail);
  }
  if (payload.length > PAYLOAD_MAX) {
    payload = `🛑 HALT [${i.human}/${i.total}] ${i.label} (id=${i.id})\nReason: ${i.reason}\nLast success: ${i.prevLine}\nLog: ${i.logPath}\nSummary: ${i.summaryPath}${recLine}`;
  }
  return payload;
}
