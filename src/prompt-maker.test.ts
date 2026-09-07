import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptsFileSchema } from "./config.js";
import {
  buildPromptsFile,
  heuristicPlan,
  makePrompts,
  parsePlannerOutput,
  scanRepo,
  splitPlan,
  topoSort,
  type PlanTask,
} from "./prompt-maker.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "overnight-pm-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "acme-web",
      scripts: { dev: "next dev", build: "next build", test: "vitest run", lint: "eslint ." },
      dependencies: { next: "16.0.0", react: "19" },
      devDependencies: { typescript: "5" },
    }),
  );
  await writeFile(join(dir, "pnpm-lock.yaml"), "");
  await writeFile(join(dir, "CLAUDE.md"), "# rules");
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const PLAN =
  "Add a /pricing page that lists the three tiers from config. Then add a Stripe checkout button per tier that calls the existing createCheckout server action; after that write Playwright tests for the page. Finally update the README with the pricing section.";

describe("scanRepo", () => {
  it("detects framework, package manager and verification commands", async () => {
    const s = await scanRepo(dir);
    expect(s).toMatchObject({
      name: "acme-web",
      framework: "Next.js",
      language: "TypeScript",
      packageManager: "pnpm",
      hasCi: true,
      hasClaudeMd: true,
    });
    expect(s.testCommand).toBe("pnpm test");
    expect(s.lintCommand).toBe("pnpm lint");
    expect(s.typecheckCommand).toBe("pnpm tsc --noEmit");
    expect(s.buildCommand).toBe("pnpm build");
  });
});

describe("heuristic planner", () => {
  it("splits a paragraph into ordered tasks with sequential deps and repo-derived acceptance", async () => {
    expect(splitPlan(PLAN)).toHaveLength(4);
    const tasks = heuristicPlan(PLAN, await scanRepo(dir));
    const ids = tasks.map((t) => t.id);
    expect(ids[0]).toMatch(/^01-add-a-pricing-page/);
    expect(ids[1]).toMatch(/^02-add-a-stripe-checkout/);
    expect(ids[2]).toMatch(/^03-write-playwright-tests/);
    expect(ids[3]).toMatch(/^04-update-the-readme/);
    expect(tasks[1]!.depends_on).toEqual([ids[0]]);
    expect(tasks[0]!.acceptance).toContain("`pnpm test` passes (add tests for new behaviour)");
    expect(tasks[0]!.prompt).toMatch(/Follow CLAUDE.md/);
    expect(tasks[0]!.prompt).toMatch(/Commit when done\.$/);
  });
  it("handles numbered lists and produces unique ids", () => {
    const tasks = heuristicPlan(
      "1. Do the thing properly\n2. Do the thing properly\n3. Ship it to prod",
      {
        root: "/r",
        name: "r",
        packageManager: "unknown",
        framework: "unknown",
        language: "unknown",
        scripts: {},
        hasCi: false,
        hasVercel: false,
        hasClaudeMd: false,
        hasAgentsMd: false,
        topLevel: [],
        readmeHead: "",
      },
    );
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(3);
  });
});

describe("topoSort", () => {
  const t = (id: string, deps: string[] = []): PlanTask => ({
    id,
    label: id,
    prompt: id,
    depends_on: deps,
    acceptance: [],
  });
  it("keeps a valid order stable and moves dependencies first", () => {
    expect(topoSort([t("a"), t("b", ["a"])]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(topoSort([t("b", ["a"]), t("a")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("rejects unknown deps and cycles", () => {
    expect(() => topoSort([t("a", ["zz"])])).toThrow(/unknown task 'zz'/);
    expect(() => topoSort([t("a", ["b"]), t("b", ["a"])])).toThrow(/cycle/);
  });
});

describe("parsePlannerOutput", () => {
  it("accepts a bare array, fenced JSON, and claude's --output-format json envelope", () => {
    const arr = [{ id: "01-x", label: "X", prompt: "do x", depends_on: [], acceptance: ["a"] }];
    expect(parsePlannerOutput(JSON.stringify(arr))).toHaveLength(1);
    expect(
      parsePlannerOutput("Here you go:\n```json\n" + JSON.stringify(arr) + "\n```"),
    ).toHaveLength(1);
    expect(
      parsePlannerOutput(JSON.stringify({ type: "result", result: JSON.stringify(arr) }))[0]!.id,
    ).toBe("01-x");
    expect(() => parsePlannerOutput("no json here")).toThrow(/no JSON array/);
    expect(() => parsePlannerOutput('[{"id":1}]')).toThrow(/invalid/);
  });
});

describe("makePrompts + buildPromptsFile", () => {
  it("uses the heuristic planner without an LLM and yields a valid prompts file", async () => {
    const r = await makePrompts({ plan: PLAN, root: dir, useLlm: false });
    expect(r.source).toBe("heuristic");
    const file = buildPromptsFile({
      tasks: r.tasks,
      plan: PLAN,
      projectPath: dir,
      branch: "overnight/pricing",
      baseBranch: "main",
    });
    expect(promptsFileSchema.safeParse(file).success).toBe(true);
    expect(file.pr_title).toBe("Add a /pricing page that lists the three tiers from config");
    expect(file.merge_strategy).toBe("none");
  });
  it("falls back to the heuristic planner when claude is missing from PATH", async () => {
    const r = await makePrompts({
      plan: PLAN,
      root: dir,
      useLlm: true,
      env: { PATH: "/nonexistent" },
    });
    expect(r.source).toBe("heuristic");
    expect(r.warnings[0]).toMatch(/not on PATH/);
  });
  it("uses a stub claude on PATH and merges verification criteria", async () => {
    const bin = join(dir, "bin");
    await mkdir(bin);
    const tasks = [
      { id: "02-b", label: "B", prompt: "do b", depends_on: ["01-a"], acceptance: ["b works"] },
      { id: "01-a", label: "A", prompt: "do a", depends_on: [], acceptance: [] },
    ];
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ result: JSON.stringify(tasks) })}'\n`,
      { mode: 0o755 },
    );
    const r = await makePrompts({
      plan: PLAN,
      root: dir,
      useLlm: true,
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    expect(r.source).toBe("llm");
    expect(r.tasks.map((t) => t.id)).toEqual(["01-a", "02-b"]);
    expect(r.tasks[1]!.acceptance[0]).toBe("b works");
    expect(r.tasks[1]!.acceptance).toContain("`pnpm test` passes (add tests for new behaviour)");
  });
});
