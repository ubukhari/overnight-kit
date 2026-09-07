import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "./exec.js";
import { runInit } from "./init.js";
import { readEventsJsonl } from "./logs.js";
import { HaltError, runBatch, type RunOptions } from "./runner.js";
import { readState, statePath } from "./state.js";

/**
 * End-to-end: a temp git repo with a bare "origin", a stub `claude` that commits / no-ops /
 * fails per invocation, a stub `gh` that records its arguments. No network, no real Claude.
 */
let dir: string;
let repo: string;
let remote: string;
let bin: string;
let home: string;
let env: NodeJS.ProcessEnv;
const BRANCH = "overnight/feat-x";

async function sh(cmd: string, args: string[], cwd = repo) {
  const r = await exec(cmd, args, { cwd, env });
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function setModes(modes: string[]) {
  await writeFile(join(dir, "modes"), `${modes.join("\n")}\n`);
  await rm(join(dir, "claude-calls"), { force: true });
}

async function ghArgs(): Promise<string> {
  try {
    return await readFile(join(dir, "gh-args"), "utf8");
  } catch {
    return "";
  }
}

function promptsFile(over: Record<string, unknown> = {}, prompts?: unknown[]) {
  return {
    project_path: repo,
    branch_name: BRANCH,
    base_branch: "main",
    pr_title: "Feature X",
    pr_body: "three steps",
    wait_for_ci: false,
    prompts: prompts ?? [
      { id: "01-a", label: "Step A", prompt: "do a" },
      { id: "02-b", label: "Step B", prompt: "do b" },
      { id: "03-c", label: "Step C", prompt: "do c" },
    ],
    ...over,
  };
}

async function writePrompts(file: Record<string, unknown>, name = "prompts.json"): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(file, null, 2));
  return p;
}

function run(promptsPath: string, over: Partial<RunOptions> = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const p = runBatch({
    promptsPath,
    home,
    env,
    stdout: (l) => lines.push(l),
    stderr: (l) => errs.push(l),
    ...over,
  }).then((s) => Object.assign(s, { lines, errs }));
  p.catch(() => undefined);
  return Object.assign(p, { lines, errs });
}

async function lastLogDir(): Promise<string> {
  const dirs = (await readdir(join(home, "logs"))).sort();
  return join(home, "logs", dirs[dirs.length - 1]!);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "overnight-e2e-"));
  repo = join(dir, "repo");
  remote = join(dir, "remote.git");
  bin = join(dir, "bin");
  home = join(dir, "home");
  await mkdir(bin);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    OVERNIGHT_DISABLE_NOTIFY: "1",
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env bash
set -e
calls="${dir}/claude-calls"; n=$(cat "$calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$calls"
mode=$(sed -n "\${n}p" "${dir}/modes" 2>/dev/null); mode="\${mode:-commit}"
prompt="\${@: -1}"
printf '%s\\n' "$@" >> "${dir}/claude-args"
echo "[stub claude] invocation $n mode=$mode cwd=$(pwd)"
echo "[stub claude] prompt: \${prompt:0:120}"
file=".stub-$n-$RANDOM"
case "$mode" in
  commit) echo "marker $RANDOM" > "$file"; git add "$file"; git -c user.name=stub -c user.email=stub@test commit -q -m "stub: \${prompt:0:40}"; echo "All tests passed: 12 of 12 green. Build clean." ;;
  noop) echo "[stub claude] nothing to do here, everything already in place." ;;
  no-commit-dirty) echo "marker" > "$file"; echo "[stub claude] left $file uncommitted on purpose (partial work)" ;;
  fail) echo "[stub claude] deliberate failure (rc=1), nothing committed here at all" >&2; exit 1 ;;
  stream-error) echo "marker" > "$file"; git add "$file"; git -c user.name=stub -c user.email=stub@test commit -q -m "stub: partial"; echo "stream interrupted while reading response from upstream" ;;
  fix) echo "fixed $RANDOM" > "$file"; git add "$file"; git -c user.name=stub -c user.email=stub@test commit -q -m "fix(ci-attempt-1): stub fix"; echo "[stub claude] committed a fix and pushed as instructed by the prompt" ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh-args"
case "$1 $2" in
  "pr create") echo "https://github.com/test/test/pull/7" ;;
  "pr merge") exit 0 ;;
  "api "*) f="${dir}/gh-api.json"; [ -f "$f" ] && cat "$f" || echo '{}' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  await sh("git", ["init", "-q", "--bare", remote], dir);
  await mkdir(repo);
  await sh("git", ["init", "-q", "-b", "main"]);
  await sh("git", ["config", "user.name", "t"]);
  await sh("git", ["config", "user.email", "t@test"]);
  await sh("git", ["remote", "add", "origin", remote]);
  await writeFile(join(repo, "README.md"), "# repo\n");
  await sh("git", ["add", "README.md"]);
  await sh("git", ["commit", "-q", "-m", "initial"]);
  await sh("git", ["push", "-q", "-u", "origin", "main"]);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("runBatch end-to-end", () => {
  it("runs three prompts, commits each, pushes, opens a PR and never merges by default", async () => {
    await setModes(["commit", "commit", "commit"]);
    const p = await writePrompts(promptsFile());
    const r = await run(p);
    expect(r).toMatchObject({
      status: "completed",
      prUrl: "https://github.com/test/test/pull/7",
      ran: 3,
      total: 3,
    });
    const state = await readState(statePath(home, BRANCH));
    expect(state?.status).toBe("completed");
    expect(state?.completions.map((c) => c.kind)).toEqual(["commit", "commit", "commit"]);
    expect(state?.completions.every((c) => c.sha.length === 7)).toBe(true);
    expect(await sh("git", ["rev-parse", "--verify", `refs/heads/${BRANCH}`], remote)).toHaveLength(
      40,
    );
    const gh = await ghArgs();
    expect(gh).toMatch(
      /^pr create --title Feature X --body three steps --base main --head overnight\/feat-x$/m,
    );
    expect(gh).not.toMatch(/pr merge/);
    const events = await readEventsJsonl(join(r.logDir, "events.jsonl"));
    expect(events.map((e) => e.type)).toEqual([
      "batch.start",
      "prompt.commit",
      "prompt.commit",
      "prompt.commit",
      "pr.opened",
      "batch.complete",
    ]);
    expect(events[1]?.data?.["summary"]).toBe("All tests passed: 12 of 12 green. Build clean.");
    expect(await readFile(join(r.logDir, "decisions.log"), "utf8")).toMatch(
      /\[1\/3\] id=01-a outcome=commit reason=HEAD advanced/,
    );
    expect(await readFile(join(home, "recovery", BRANCH, "last-success.md"), "utf8")).toMatch(
      /- id: `03-c`/,
    );
    const args = await readFile(join(dir, "claude-args"), "utf8");
    expect(args).toMatch(
      /^-p\n--permission-mode\nbypassPermissions\n--dangerously-skip-permissions\ndo a$/m,
    );
    expect(await stat(join(home, "locks", `${BRANCH}.pid`)).catch(() => null)).toBeNull();
  });

  it("opts into auto-merge only via merge_strategy / --merge, and passes --model when set", async () => {
    await setModes(["commit"]);
    const p = await writePrompts(
      promptsFile({ default_model: "claude-test-model" }, [
        { id: "01", label: "one", prompt: "x", model: "per-prompt-model" },
      ]),
    );
    await run(p, { merge: "auto-squash" });
    expect(await ghArgs()).toMatch(
      /^pr merge https:\/\/github.com\/test\/test\/pull\/7 --auto --squash$/m,
    );
    expect(await readFile(join(dir, "claude-args"), "utf8")).toMatch(/--model\nper-prompt-model/);
  });

  it("halts on a failing prompt with diagnostics, then resumes past the completed prefix", async () => {
    await setModes(["commit", "fail", "commit"]);
    const p = await writePrompts(promptsFile());
    const first = run(p);
    await expect(first).rejects.toBeInstanceOf(HaltError);
    expect(first.errs.join("\n")).toMatch(
      /HALT: at \[2\/3\] Step B\. Reason: claude -p exited with code 1/,
    );
    let state = await readState(statePath(home, BRANCH));
    expect(state?.status).toBe("halted");
    expect(state?.completions.map((c) => [c.id, c.status])).toEqual([
      ["01-a", "completed"],
      ["02-b", "failed"],
    ]);
    const failure = await readFile(join(home, "recovery", BRANCH, "last-failure.md"), "utf8");
    expect(failure).toMatch(/HEAD did not advance during this prompt/);
    expect(failure).toMatch(/\| 1 \| `01-a` \| Step A \|/);
    expect(failure).toMatch(/\| 3 \| `03-c` \| Step C \|/);
    expect(await ghArgs()).toBe("");

    await setModes(["commit", "commit"]);
    const second = await run(p);
    expect(second.status).toBe("completed");
    expect(second.lines.join("\n")).toMatch(/Implicit resume: state file matches this JSON/);
    expect(second.lines.join("\n")).toMatch(/\[1\/3\] ⏭ Step A — already complete/);
    state = await readState(statePath(home, BRANCH));
    expect(state?.completions.map((c) => c.kind)).toEqual(["commit", "commit", "commit"]);
    const events = await readEventsJsonl(join(second.logDir, "events.jsonl"));
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(["batch.start", "prompt.skip"]);
    expect(await sh("git", ["rev-list", "--count", "main..HEAD"])).toBe("3");
  });

  it("a stream error after a commit still halts, and the summary offers options A/B/C", async () => {
    await setModes(["stream-error"]);
    const p = await writePrompts(promptsFile({}, [{ id: "01", label: "one", prompt: "x" }]));
    await expect(run(p)).rejects.toBeInstanceOf(HaltError);
    const failure = await readFile(join(home, "recovery", BRANCH, "last-failure.md"), "utf8");
    expect(failure).toMatch(/Matched pattern: `stream interrupted`/);
    expect(failure).toMatch(/### Option A/);
    expect(failure).toMatch(/Recommended: Option B/);
    const state = await readState(statePath(home, BRANCH));
    expect(state?.completions[0]).toMatchObject({ status: "failed" });
    expect(state?.completions[0]?.sha).toHaveLength(7);
  });

  it("--skip-current marks the failed prompt completed with its recorded sha", async () => {
    await setModes(["stream-error", "commit"]);
    const p = await writePrompts(
      promptsFile({}, [
        { id: "01", label: "one", prompt: "x" },
        { id: "02", label: "two", prompt: "y" },
      ]),
    );
    await expect(run(p)).rejects.toBeInstanceOf(HaltError);
    const r = await run(p, { skipCurrent: true });
    expect(r.status).toBe("completed");
    const state = await readState(statePath(home, BRANCH));
    expect(state?.completions.map((c) => c.kind)).toEqual(["skip-current", "commit"]);
  });

  it("uncommitted work after a prompt halts with a recovery diff", async () => {
    await setModes(["no-commit-dirty"]);
    const p = await writePrompts(promptsFile({}, [{ id: "01", label: "one", prompt: "x" }]));
    const r = run(p);
    await expect(r).rejects.toBeInstanceOf(HaltError);
    expect(r.errs.join("\n")).toMatch(/staged or modified files but did not commit/);
    expect(r.errs.join("\n")).toMatch(
      /Recovery: .*\/recovery\/overnight\/feat-x\/01-\d{8}-\d{6}\.diff/,
    );
  });

  it("dirty pre-flight halts unless --auto-stash / --auto-recover; ignored paths never halt", async () => {
    await setModes(["commit"]);
    await writeFile(join(repo, "wip.txt"), "unfinished");
    await writeFile(join(repo, "debug.log"), "ignored");
    const p = await writePrompts(promptsFile({}, [{ id: "01", label: "one", prompt: "x" }]));
    const halted = run(p);
    await expect(halted).rejects.toBeInstanceOf(HaltError);
    expect(halted.errs.join("\n")).toMatch(
      /uncommitted changes outside the ignored paths — found:\n\?\? wip.txt/,
    );
    const events = await readEventsJsonl(join(await lastLogDir(), "events.jsonl"));
    expect(events.some((e) => e.type === "decision")).toBe(true);

    await setModes(["commit"]);
    const stashed = await run(p, { autoStash: true });
    expect(stashed.status).toBe("completed");
    expect(await sh("git", ["stash", "list"])).toMatch(/overnight pre-run stash/);
  });

  it("--continue runs on the current branch, writes no state and opens no PR", async () => {
    await setModes(["commit", "noop"]);
    await sh("git", ["checkout", "-q", "-b", "wip/other"]);
    const p = await writePrompts(
      promptsFile({}, [
        { id: "01", label: "one", prompt: "x" },
        { id: "02", label: "two", prompt: "y" },
      ]),
    );
    const r = await run(p, { mode: "continue" });
    expect(r.status).toBe("continue_done");
    expect(await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("wip/other");
    expect(await readState(statePath(home, BRANCH))).toBeNull();
    expect(await ghArgs()).toBe("");
    expect(r.lines.join("\n")).toMatch(/\[2\/2\] ✓ two — no changes needed/);
  });

  it("detects edited completed prompts (mismatch), honours --force-continue, and archives unrelated JSON", async () => {
    await setModes(["commit", "commit", "commit"]);
    const p = await writePrompts(promptsFile());
    await run(p);
    const edited = promptsFile({}, [
      { id: "01-a", label: "Step A", prompt: "do a DIFFERENTLY" },
      { id: "02-b", label: "Step B", prompt: "do b" },
      { id: "03-c", label: "Step C", prompt: "do c" },
    ]);
    const pe = await writePrompts(edited);
    const halted = run(pe);
    await expect(halted).rejects.toBeInstanceOf(HaltError);
    expect(halted.errs.join("\n")).toMatch(/appear modified or reordered/);
    const forced = await run(pe, { forceContinue: true });
    expect(forced.status).toBe("nothing_new");

    await setModes(["commit"]);
    const fresh = promptsFile({}, [{ id: "99-z", label: "Z", prompt: "z" }]);
    const pz = await writePrompts(fresh);
    const r = await run(pz);
    expect(r.status).toBe("completed");
    expect(r.lines.join("\n")).toMatch(/Previous state archived to .*replaced-/);
  });

  it("refuses to run while another runner holds the lock for the branch", async () => {
    await mkdir(join(home, "locks", "overnight"), { recursive: true });
    await writeFile(join(home, "locks", `${BRANCH}.pid`), `${process.pid}\n`);
    const p = await writePrompts(promptsFile());
    const r = run(p);
    await expect(r).rejects.toBeInstanceOf(HaltError);
    expect(r.errs.join("\n")).toMatch(/Another runner is active/);
  });

  it("gates each commit on Vercel when the CLI is present, and fixes a red build", async () => {
    const dep = (url: string, state: string, createdAt: number) => ({
      url,
      state,
      createdAt,
      meta: { githubCommitRef: BRANCH },
    });
    const seq = [
      { deployments: [] },
      { deployments: [dep("d1.vercel.app", "READY", 1)] },
      // second prompt: baseline d1, then a red d2, then (after the fix) a green d3
      { deployments: [dep("d1.vercel.app", "READY", 1)] },
      { deployments: [dep("d1.vercel.app", "READY", 1), dep("d2.vercel.app", "ERROR", 2)] },
      { deployments: [dep("d1.vercel.app", "READY", 1), dep("d2.vercel.app", "ERROR", 2)] },
      {
        deployments: [
          dep("d1.vercel.app", "READY", 1),
          dep("d2.vercel.app", "ERROR", 2),
          dep("d3.vercel.app", "READY", 3),
        ],
      },
    ];
    const rdir = join(dir, "vercel-responses");
    await mkdir(rdir);
    await Promise.all(seq.map((r, i) => writeFile(join(rdir, `${i + 1}.json`), JSON.stringify(r))));
    await writeFile(
      join(bin, "vercel"),
      `#!/bin/sh
case "$1" in
  inspect) echo "build log line: Type error in src/x.ts" >&2; exit 1 ;;
esac
c="${rdir}/count"; n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$c"
f="${rdir}/$n.json"; [ -f "$f" ] || f="${rdir}/${seq.length}.json"
cat "$f"
`,
      { mode: 0o755 },
    );
    await setModes(["commit", "commit", "fix"]);
    const p = await writePrompts(
      promptsFile(
        {
          wait_for_ci: true,
          ci: {
            vercel: true,
            github_checks: false,
            poll_seconds: 1,
            timeout_seconds: 20,
            skip_grace_seconds: 5,
            fix_max_attempts: 2,
          },
        },
        [
          { id: "01", label: "one", prompt: "x" },
          { id: "02", label: "two", prompt: "y" },
        ],
      ),
    );
    const r = await run(p, { sleep: async () => undefined });
    expect(r.status).toBe("completed");
    const state = await readState(statePath(home, BRANCH));
    expect(state?.completions[0]).toMatchObject({ ci_status: "passed" });
    expect(state?.completions[1]).toMatchObject({
      ci_status: "passed_after_fix",
      ci_fix_attempts: 1,
    });
    expect(state?.completions[1]?.ci_fix_commits).toHaveLength(1);
    const events = await readEventsJsonl(join(r.logDir, "events.jsonl"));
    expect(events.map((e) => e.type)).toEqual([
      "batch.start",
      "prompt.commit",
      "ci.wait",
      "ci.passed",
      "prompt.commit",
      "ci.wait",
      "ci.failed",
      "ci.fix_attempt",
      "ci.passed",
      "pr.opened",
      "batch.complete",
    ]);
    const fixPrompt = (await readFile(join(dir, "claude-args"), "utf8")).split("\n").pop() ?? "";
    expect(await readFile(join(dir, "claude-args"), "utf8")).toMatch(
      /Vercel build failed on commit [0-9a-f]{7} for branch overnight\/feat-x\. Original task: two\./,
    );
    expect(fixPrompt).toBe("");
  });

  it("halts on a red build when fix attempts are 0", async () => {
    const rdir = join(dir, "vercel-responses");
    await mkdir(rdir);
    await writeFile(join(rdir, "1.json"), JSON.stringify({ deployments: [] }));
    await writeFile(
      join(rdir, "2.json"),
      JSON.stringify({
        deployments: [
          {
            url: "bad.vercel.app",
            state: "ERROR",
            createdAt: 2,
            meta: { githubCommitRef: BRANCH },
          },
        ],
      }),
    );
    await writeFile(
      join(bin, "vercel"),
      `#!/bin/sh\nc="${rdir}/count"; n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$c"; f="${rdir}/$n.json"; [ -f "$f" ] || f="${rdir}/2.json"; cat "$f"\n`,
      { mode: 0o755 },
    );
    await setModes(["commit"]);
    const p = await writePrompts(
      promptsFile(
        {
          wait_for_ci: true,
          ci: {
            vercel: true,
            github_checks: false,
            poll_seconds: 1,
            timeout_seconds: 20,
            skip_grace_seconds: 5,
          },
        },
        [{ id: "01", label: "one", prompt: "x" }],
      ),
    );
    const r = run(p, { sleep: async () => undefined, ciFixAttempts: 0 });
    await expect(r).rejects.toBeInstanceOf(HaltError);
    expect(r.errs.join("\n")).toMatch(/CI failed for 'overnight\/feat-x' after prompt 01/);
    expect((await readState(statePath(home, BRANCH)))?.completions[0]).toMatchObject({
      status: "completed",
      ci_status: "failed",
    });
  });
});

describe("acceptance: init on a fresh Next.js repo, then --dry-run end to end", () => {
  it("produces prompts.json from a one-paragraph plan and dry-runs it without side effects", async () => {
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        name: "fresh-next",
        scripts: { dev: "next dev", build: "next build", lint: "next lint", test: "vitest run" },
        dependencies: { next: "16.0.0", react: "19.0.0" },
        devDependencies: { typescript: "5.9.0" },
      }),
    );
    await writeFile(join(repo, "pnpm-lock.yaml"), "");
    await sh("git", ["add", "-A"]);
    await sh("git", ["commit", "-q", "-m", "next scaffold"]);
    const lines: string[] = [];
    const init = await runInit({
      cwd: repo,
      plan: "Add a /pricing page listing three tiers from a config file. Add a checkout button per tier that posts to /api/checkout. Then write Playwright tests for the page; finally document the pricing page in the README.",
      useLlm: false,
      env,
      stdout: (l) => lines.push(l),
    });
    expect(init.planner.tasks).toHaveLength(4);
    expect(init.branch).toMatch(/^overnight\/add-a-pricing-page/);
    expect(init.baseBranch).toBe("main");
    const written = JSON.parse(await readFile(init.promptsPath, "utf8")) as {
      prompts: { acceptance: string[]; depends_on?: string[] }[];
      project_path: string;
    };
    expect(written.project_path).toBe(repo);
    expect(written.prompts[0]!.acceptance).toContain(
      "`pnpm test` passes (add tests for new behaviour)",
    );
    expect(written.prompts[1]!.depends_on).toEqual([init.planner.tasks[0]!.id]);
    expect(await readFile(init.skillPath!, "utf8")).toMatch(/^---\nname: overnight/);

    const r = await run(init.promptsPath, { dryRun: true });
    expect(r.status).toBe("dry_run");
    const out = r.lines.join("\n");
    expect(out).toMatch(/overnight dry run — nothing will be executed/);
    expect(out).toMatch(/\[1\/4\] ▶ 01-add-a-pricing-page/);
    expect(out).toMatch(/\[4\/4\] ▶ 04-document-the-pricing-page/);
    expect(out).toMatch(
      /claude -p --permission-mode bypassPermissions --dangerously-skip-permissions "<\d+ chars>"/,
    );
    expect(out).toMatch(/After the last prompt: push 'overnight\/add-a-pricing-page/);
    const events = await readEventsJsonl(join(r.logDir, "events.jsonl"));
    expect(events.filter((e) => e.type === "prompt.dry_run")).toHaveLength(4);
    // no side effects: no state, no lock, no branch, no claude invocation, tree unchanged except the files init wrote
    expect(await readState(statePath(home, init.branch))).toBeNull();
    expect(await stat(join(dir, "claude-calls")).catch(() => null)).toBeNull();
    expect(await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await sh("git", ["branch", "--list", init.branch])).toBe("");
  });
});
