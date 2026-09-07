import type { CiConfig } from "./config.js";
import { exec } from "./exec.js";

export type GateStatus =
  "ready" | "error" | "timeout_building" | "timeout_no_deployment" | "no_checks";

export interface GateResult {
  status: GateStatus;
  /** Deployment URL (Vercel) or the failing check's URL (GitHub). */
  url?: string;
  details?: string;
}

export interface GateContext {
  cwd: string;
  cfg: CiConfig;
  /** Appends a line to notifications.log. */
  log: (line: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface VercelDeployment {
  url?: string;
  state?: string;
  createdAt?: number;
  meta?: { githubCommitRef?: string; githubCommitSha?: string };
}

/** Most recent deployment for the branch as `{url, state}`; null when none. */
export function topVercelDeployment(
  payload: unknown,
  branch: string,
): { url: string; state: string } | null {
  const deployments = Array.isArray((payload as { deployments?: unknown })?.deployments)
    ? ((payload as { deployments: VercelDeployment[] }).deployments ?? [])
    : [];
  const mine = deployments
    .filter((d) => (d.meta?.githubCommitRef ?? "") === branch)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const top = mine[0];
  return top ? { url: top.url ?? "", state: top.state ?? "" } : null;
}

export function baselineVercelUrl(payload: unknown, branch: string): string {
  const deployments = Array.isArray((payload as { deployments?: unknown })?.deployments)
    ? ((payload as { deployments: VercelDeployment[] }).deployments ?? [])
    : [];
  const terminal = deployments
    .filter((d) => (d.meta?.githubCommitRef ?? "") === branch)
    .filter((d) => d.state === "READY" || d.state === "ERROR")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return terminal[0]?.url ?? "none";
}

const VERCEL_LS = [
  "ls",
  "--format",
  "json",
  "--status",
  "READY,ERROR,BUILDING,QUEUED,INITIALIZING",
];

/**
 * Poll `vercel ls` until a deployment for `branch` that is not the pre-push baseline reaches
 * READY or ERROR, or the timeout fires (two distinct timeouts, both warn-and-continue by default).
 */
export async function waitForVercel(branch: string, ctx: GateContext): Promise<GateResult> {
  const { cwd, cfg } = ctx;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now ?? Date.now;
  const env = ctx.env ?? process.env;

  const base = await exec("vercel", VERCEL_LS, { cwd, env });
  if (base.code !== 0) {
    return {
      status: "error",
      details: `vercel ls failed during baseline capture (rc=${base.code}): ${base.stderr.slice(0, 200)}`,
    };
  }
  const baseline = baselineVercelUrl(safeJson(base.stdout), branch);
  const start = now();
  const deadline = start + cfg.timeout_seconds * 1000;
  await ctx.log(`vercel-baseline branch=${branch} baseline_url=${baseline}`);

  let sawNew = false;
  let graceWarned = false;
  for (;;) {
    const r = await exec("vercel", VERCEL_LS, { cwd, env });
    const elapsed = Math.round((now() - start) / 1000);
    if (r.code !== 0) {
      await ctx.log(
        `vercel-poll branch=${branch} rc=${r.code} stderr=${r.stderr.slice(0, 200)} elapsed=${elapsed}s`,
      );
    } else {
      const top = topVercelDeployment(safeJson(r.stdout), branch);
      await ctx.log(
        `vercel-poll branch=${branch} url=${top?.url ?? "—"} state=${top?.state ?? "—"} baseline=${baseline} elapsed=${elapsed}s`,
      );
      if (top && top.url && top.url !== baseline) {
        sawNew = true;
        const url = `https://${top.url}`;
        if (top.state === "READY") return { status: "ready", url };
        if (top.state === "ERROR") return { status: "error", url };
        if (!["BUILDING", "QUEUED", "INITIALIZING"].includes(top.state)) {
          await ctx.log(
            `vercel-poll-unknown-state branch=${branch} url=${top.url} state=${top.state}`,
          );
        }
      }
    }
    if (!sawNew && !graceWarned && elapsed >= cfg.skip_grace_seconds) {
      graceWarned = true;
      await ctx.log(
        `vercel-skip-grace-warning branch=${branch} elapsed=${elapsed}s msg="No Vercel deployment surfaced after ${elapsed}s — Vercel may be queued or skipping this commit"`,
      );
    }
    if (now() >= deadline) return { status: sawNew ? "timeout_building" : "timeout_no_deployment" };
    await sleep(cfg.poll_seconds * 1000);
  }
}

/** Last 500 lines of `vercel inspect <url> --logs` (build logs go to stderr on CLI 53+), ≤ 8 KB. */
export async function fetchVercelLogs(
  url: string,
  cwd: string,
  env = process.env,
): Promise<string> {
  const r = await exec("vercel", ["inspect", url, "--logs"], { cwd, env });
  const lines = `${r.stdout}\n${r.stderr}`.split("\n");
  let raw = lines.slice(-500).join("\n");
  if (raw.length > 8192)
    raw = `...(truncated, original size ${raw.length} bytes)...\n${raw.slice(-8192)}`;
  return raw;
}

interface CheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
}

export function summarizeCheckRuns(payload: unknown): {
  total: number;
  pending: number;
  failed: CheckRun[];
} {
  const runs = Array.isArray((payload as { check_runs?: unknown })?.check_runs)
    ? ((payload as { check_runs: CheckRun[] }).check_runs ?? [])
    : [];
  const pending = runs.filter((r) => r.status !== "completed").length;
  const failed = runs.filter(
    (r) =>
      r.status === "completed" &&
      ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
        r.conclusion ?? "",
      ),
  );
  return { total: runs.length, pending, failed };
}

/**
 * Poll GitHub check-runs + the combined commit status for `sha` via `gh api`. Passes when every
 * check completed without failure and no status is pending; `no_checks` when nothing ever surfaced.
 */
export async function waitForGithubChecks(
  slug: string,
  sha: string,
  ctx: GateContext,
): Promise<GateResult> {
  const { cwd, cfg } = ctx;
  const sleep = ctx.sleep ?? defaultSleep;
  const now = ctx.now ?? Date.now;
  const env = ctx.env ?? process.env;
  const start = now();
  const deadline = start + cfg.timeout_seconds * 1000;
  let graceWarned = false;
  for (;;) {
    const elapsed = Math.round((now() - start) / 1000);
    const checks = await exec("gh", ["api", `repos/${slug}/commits/${sha}/check-runs`], {
      cwd,
      env,
    });
    const status = await exec("gh", ["api", `repos/${slug}/commits/${sha}/status`], { cwd, env });
    if (checks.code !== 0) {
      await ctx.log(
        `github-poll sha=${sha.slice(0, 7)} rc=${checks.code} stderr=${checks.stderr.slice(0, 200)} elapsed=${elapsed}s`,
      );
    } else {
      const sum = summarizeCheckRuns(safeJson(checks.stdout));
      const combined = safeJson(status.stdout) as {
        state?: string;
        statuses?: { state?: string; target_url?: string; context?: string }[];
      } | null;
      const statusState = status.code === 0 ? (combined?.state ?? "pending") : "pending";
      const statusCount = combined?.statuses?.length ?? 0;
      await ctx.log(
        `github-poll sha=${sha.slice(0, 7)} checks=${sum.total} pending=${sum.pending} failed=${sum.failed.length} status=${statusState}(${statusCount}) elapsed=${elapsed}s`,
      );
      if (sum.failed.length > 0) {
        const f = sum.failed[0]!;
        return {
          status: "error",
          url: f.html_url ?? f.details_url ?? "",
          details: sum.failed
            .map((r) => `${r.name ?? "check"}: ${r.conclusion ?? "failed"}`)
            .join("; "),
        };
      }
      if (statusState === "failure" || statusState === "error") {
        const failing = combined?.statuses?.find(
          (s) => s.state === "failure" || s.state === "error",
        );
        return {
          status: "error",
          url: failing?.target_url ?? "",
          details: `commit status ${statusState}: ${failing?.context ?? ""}`,
        };
      }
      const anything = sum.total > 0 || statusCount > 0;
      const allDone = sum.pending === 0 && statusState !== "pending";
      if (anything && allDone)
        return { status: "ready", url: `https://github.com/${slug}/commit/${sha}` };
      if (!anything && !graceWarned && elapsed >= cfg.skip_grace_seconds) {
        graceWarned = true;
        await ctx.log(
          `github-skip-grace-warning sha=${sha.slice(0, 7)} elapsed=${elapsed}s msg="No check-runs or statuses surfaced yet"`,
        );
      }
      if (!anything && elapsed >= cfg.skip_grace_seconds * 2) return { status: "no_checks" };
    }
    if (now() >= deadline) return { status: "timeout_building" };
    await sleep(cfg.poll_seconds * 1000);
  }
}

/** Failure context for the fix prompt: annotations of failed check-runs and `gh run view --log-failed` where possible. */
export async function fetchGithubFailureLogs(
  slug: string,
  sha: string,
  cwd: string,
  env = process.env,
): Promise<string> {
  const checks = await exec("gh", ["api", `repos/${slug}/commits/${sha}/check-runs`], { cwd, env });
  const sum = summarizeCheckRuns(safeJson(checks.stdout));
  const parts: string[] = [];
  for (const run of sum.failed.slice(0, 3)) {
    parts.push(`## ${run.name ?? "check"} (${run.conclusion ?? "failed"}) ${run.html_url ?? ""}`);
    if (run.id) {
      const ann = await exec("gh", ["api", `repos/${slug}/check-runs/${run.id}/annotations`], {
        cwd,
        env,
      });
      const list = safeJson(ann.stdout);
      if (Array.isArray(list)) {
        for (const a of list.slice(0, 20) as {
          path?: string;
          start_line?: number;
          message?: string;
        }[]) {
          parts.push(`${a.path ?? ""}:${a.start_line ?? ""} ${a.message ?? ""}`);
        }
      }
    }
    const m = /\/actions\/runs\/(\d+)/.exec(run.html_url ?? run.details_url ?? "");
    if (m) {
      const logs = await exec("gh", ["run", "view", m[1]!, "--log-failed"], { cwd, env });
      parts.push(`${logs.stdout}\n${logs.stderr}`.split("\n").slice(-300).join("\n"));
    }
  }
  let raw = parts.join("\n");
  if (raw.length > 8192) raw = `...(truncated)...\n${raw.slice(-8192)}`;
  return raw;
}

export interface FixPromptInput {
  sha: string;
  branch: string;
  label: string;
  url: string;
  attempt: number;
  max: number;
  logs: string;
  diagnosisFile: string;
  system: "Vercel" | "GitHub Checks";
}

/** The fix-loop prompt (claude-runner's template, generalised to either CI system). */
export function buildFixPrompt(i: FixPromptInput): string {
  return `${i.system} build failed on commit ${i.sha} for branch ${i.branch}. Original task: ${i.label}.

Failed run: ${i.url || "(no url)"}
Build logs (tail):
${i.logs}

Make the minimal fix needed to make the build pass. Commit with message "fix(ci-attempt-${i.attempt}): <short description>" and push to ${i.branch}.

Constraints:
- Make the smallest possible change
- Do not modify unrelated files
- If this is NOT a code problem (missing env var, deleted secret, service outage, expired credential, platform issue), do NOT attempt a code fix. Write a one-paragraph diagnosis to ${i.diagnosisFile} explaining why this is not a code problem, then exit without committing.`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
