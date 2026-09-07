import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baselineVercelUrl,
  buildFixPrompt,
  summarizeCheckRuns,
  topVercelDeployment,
  waitForGithubChecks,
  waitForVercel,
} from "./ci.js";
import { ciConfigSchema } from "./config.js";

let dir: string;
let bin: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "overnight-ci-"));
  bin = join(dir, "bin");
  await rm(bin, { recursive: true, force: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(bin, { recursive: true }));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A stub CLI that answers with responses/<n>.json in order (last one repeats). */
async function stubSequence(name: string, responses: unknown[]): Promise<void> {
  const rdir = join(dir, `${name}-responses`);
  await import("node:fs/promises").then((fs) => fs.mkdir(rdir, { recursive: true }));
  await Promise.all(
    responses.map((r, i) => writeFile(join(rdir, `${i + 1}.json`), JSON.stringify(r))),
  );
  await writeFile(
    join(bin, name),
    `#!/bin/sh
c="${rdir}/count"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$c"
f="${rdir}/$n.json"; [ -f "$f" ] || f="${rdir}/${responses.length}.json"
echo "$@" >> "${rdir}/args"
cat "$f"
`,
    { mode: 0o755 },
  );
}

const ctx = (over: Partial<ReturnType<typeof ciConfigSchema.parse>> = {}) => {
  const lines: string[] = [];
  let t = 0;
  return {
    lines,
    ctx: {
      cwd: dir,
      cfg: ciConfigSchema.parse({
        poll_seconds: 1,
        timeout_seconds: 30,
        skip_grace_seconds: 5,
        ...over,
      }),
      log: async (l: string) => {
        lines.push(l);
      },
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    },
  };
};

describe("vercel parsing", () => {
  const payload = {
    deployments: [
      { url: "old.vercel.app", state: "READY", createdAt: 1, meta: { githubCommitRef: "feat" } },
      { url: "other.vercel.app", state: "READY", createdAt: 9, meta: { githubCommitRef: "main" } },
      { url: "new.vercel.app", state: "BUILDING", createdAt: 5, meta: { githubCommitRef: "feat" } },
    ],
  };
  it("picks the newest deployment for the branch and the newest terminal one as baseline", () => {
    expect(topVercelDeployment(payload, "feat")).toEqual({
      url: "new.vercel.app",
      state: "BUILDING",
    });
    expect(baselineVercelUrl(payload, "feat")).toBe("old.vercel.app");
    expect(topVercelDeployment(payload, "nope")).toBeNull();
    expect(baselineVercelUrl({}, "feat")).toBe("none");
  });
});

describe("waitForVercel", () => {
  it("returns ready once a new deployment for the branch is READY", async () => {
    const dep = (url: string, state: string, createdAt: number) => ({
      url,
      state,
      createdAt,
      meta: { githubCommitRef: "feat" },
    });
    await stubSequence("vercel", [
      { deployments: [dep("base.vercel.app", "READY", 1)] },
      { deployments: [dep("base.vercel.app", "READY", 1), dep("new.vercel.app", "QUEUED", 2)] },
      { deployments: [dep("base.vercel.app", "READY", 1), dep("new.vercel.app", "BUILDING", 2)] },
      { deployments: [dep("base.vercel.app", "READY", 1), dep("new.vercel.app", "READY", 2)] },
    ]);
    const c = ctx();
    expect(await waitForVercel("feat", c.ctx)).toEqual({
      status: "ready",
      url: "https://new.vercel.app",
    });
    expect(c.lines[0]).toBe("vercel-baseline branch=feat baseline_url=base.vercel.app");
  });
  it("reports error deployments and distinguishes the two timeouts", async () => {
    const dep = (url: string, state: string) => ({
      url,
      state,
      createdAt: 2,
      meta: { githubCommitRef: "feat" },
    });
    await stubSequence("vercel", [
      { deployments: [] },
      { deployments: [dep("bad.vercel.app", "ERROR")] },
    ]);
    expect(await waitForVercel("feat", ctx().ctx)).toEqual({
      status: "error",
      url: "https://bad.vercel.app",
    });

    await stubSequence("vercel", [{ deployments: [] }]);
    const c1 = ctx();
    expect((await waitForVercel("feat", c1.ctx)).status).toBe("timeout_no_deployment");
    expect(c1.lines.some((l) => l.startsWith("vercel-skip-grace-warning"))).toBe(true);

    await stubSequence("vercel", [
      { deployments: [] },
      { deployments: [dep("stuck.vercel.app", "BUILDING")] },
    ]);
    expect((await waitForVercel("feat", ctx().ctx)).status).toBe("timeout_building");
  });
});

describe("github checks", () => {
  it("summarises check-runs", () => {
    const s = summarizeCheckRuns({
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "in_progress" },
        { status: "completed", conclusion: "failure", name: "ci" },
      ],
    });
    expect(s).toMatchObject({ total: 3, pending: 1 });
    expect(s.failed[0]!.name).toBe("ci");
  });
  it("passes when every check completed and the combined status is not pending", async () => {
    // gh is called alternately for check-runs and status
    await stubSequence("gh", [
      { check_runs: [{ status: "in_progress", name: "ci" }] },
      { state: "pending", statuses: [] },
      { check_runs: [{ status: "completed", conclusion: "success", name: "ci" }] },
      { state: "success", statuses: [{ state: "success", context: "vercel" }] },
    ]);
    const r = await waitForGithubChecks("o/r", "abc1234", ctx().ctx);
    expect(r).toEqual({ status: "ready", url: "https://github.com/o/r/commit/abc1234" });
  });
  it("fails fast on a failed check and reports no_checks when nothing surfaces", async () => {
    await stubSequence("gh", [
      {
        check_runs: [
          { status: "completed", conclusion: "failure", name: "ci", html_url: "https://gh/run/1" },
        ],
      },
      { state: "pending", statuses: [] },
    ]);
    expect(await waitForGithubChecks("o/r", "abc", ctx().ctx)).toEqual({
      status: "error",
      url: "https://gh/run/1",
      details: "ci: failure",
    });
    await stubSequence("gh", [{ check_runs: [] }, { state: "pending", statuses: [] }]);
    expect((await waitForGithubChecks("o/r", "abc", ctx().ctx)).status).toBe("no_checks");
  });
});

describe("fix prompt", () => {
  it("names the system, sha, attempt and diagnosis file", () => {
    const p = buildFixPrompt({
      sha: "abc",
      branch: "feat",
      label: "L",
      url: "u",
      attempt: 2,
      max: 3,
      logs: "LOGS",
      diagnosisFile: "/tmp/d.txt",
      system: "GitHub Checks",
    });
    expect(p).toMatch(/^GitHub Checks build failed on commit abc for branch feat/);
    expect(p).toMatch(/fix\(ci-attempt-2\)/);
    expect(p).toMatch(/\/tmp\/d\.txt/);
  });
});
