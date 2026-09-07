import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Prompt, PromptsFile } from "./config.js";
import { exec, commandExists } from "./exec.js";

/** What `overnight init` learns about a repo before writing prompts. */
export interface RepoScan {
  root: string;
  name: string;
  packageManager: "pnpm" | "yarn" | "npm" | "bun" | "unknown";
  framework: string;
  language: string;
  scripts: Record<string, string>;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  hasCi: boolean;
  hasVercel: boolean;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  topLevel: string[];
  readmeHead: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function scanRepo(root: string): Promise<RepoScan> {
  const entries = (await readdir(root).catch(() => [])).filter(
    (e) => !e.startsWith(".") || e === ".github",
  );
  let pkg: {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    // not a node project
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const packageManager: RepoScan["packageManager"] = (await exists(join(root, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(root, "yarn.lock")))
      ? "yarn"
      : (await exists(join(root, "bun.lockb"))) || (await exists(join(root, "bun.lock")))
        ? "bun"
        : (await exists(join(root, "package-lock.json"))) || Object.keys(pkg).length > 0
          ? "npm"
          : "unknown";
  const run = (script: string) =>
    packageManager === "npm"
      ? `npm run ${script}`
      : packageManager === "unknown"
        ? script
        : `${packageManager} ${script}`;
  const framework = deps["next"]
    ? "Next.js"
    : deps["nuxt"]
      ? "Nuxt"
      : deps["@remix-run/react"]
        ? "Remix"
        : deps["astro"]
          ? "Astro"
          : deps["express"]
            ? "Express"
            : deps["react"]
              ? "React"
              : (await exists(join(root, "pyproject.toml"))) ||
                  (await exists(join(root, "requirements.txt")))
                ? "Python"
                : (await exists(join(root, "go.mod")))
                  ? "Go"
                  : (await exists(join(root, "Cargo.toml")))
                    ? "Rust"
                    : "unknown";
  const language =
    deps["typescript"] || (await exists(join(root, "tsconfig.json")))
      ? "TypeScript"
      : Object.keys(pkg).length > 0
        ? "JavaScript"
        : framework === "Python" || framework === "Go" || framework === "Rust"
          ? framework
          : "unknown";
  let readmeHead = "";
  try {
    readmeHead = (await readFile(join(root, "README.md"), "utf8"))
      .split("\n")
      .slice(0, 20)
      .join("\n");
  } catch {
    // no README
  }
  const scan: RepoScan = {
    root,
    name: pkg.name ?? basename(root),
    packageManager,
    framework,
    language,
    scripts,
    hasCi: await exists(join(root, ".github", "workflows")),
    hasVercel: (await exists(join(root, "vercel.json"))) || (await exists(join(root, ".vercel"))),
    hasClaudeMd: await exists(join(root, "CLAUDE.md")),
    hasAgentsMd: await exists(join(root, "AGENTS.md")),
    topLevel: entries.sort(),
    readmeHead,
  };
  if (scripts["test"]) scan.testCommand = run("test");
  else if (framework === "Python") scan.testCommand = "pytest";
  else if (framework === "Go") scan.testCommand = "go test ./...";
  else if (framework === "Rust") scan.testCommand = "cargo test";
  if (scripts["lint"]) scan.lintCommand = run("lint");
  if (scripts["typecheck"]) scan.typecheckCommand = run("typecheck");
  else if (language === "TypeScript")
    scan.typecheckCommand = `${packageManager === "unknown" ? "npx" : packageManager === "npm" ? "npx" : packageManager} tsc --noEmit`;
  if (scripts["build"]) scan.buildCommand = run("build");
  return scan;
}

export const planTaskSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  prompt: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

/** Verification lines every task must satisfy, derived from what the repo actually has. */
export function verificationCriteria(scan: RepoScan): string[] {
  const out: string[] = [];
  if (scan.typecheckCommand) out.push(`\`${scan.typecheckCommand}\` passes`);
  if (scan.lintCommand) out.push(`\`${scan.lintCommand}\` passes`);
  if (scan.testCommand) out.push(`\`${scan.testCommand}\` passes (add tests for new behaviour)`);
  if (scan.buildCommand) out.push(`\`${scan.buildCommand}\` succeeds`);
  out.push("All changes are committed with a descriptive message; the working tree is clean");
  return out;
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "task"
  );
}

/** Split a paragraph into task-sized sentences (numbered lists, semicolons, sentences, "then"). */
export function splitPlan(plan: string): string[] {
  const normalised = plan.replace(/\r/g, "").trim();
  const numbered = normalised
    .split(/\n?\s*(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/m)
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = numbered.length > 1 ? numbered : [normalised];
  const out: string[] = [];
  for (const c of candidates) {
    const pieces = c
      .split(
        /(?<=[.!?])\s+(?=[A-Z0-9`"'(])|;\s+|,?\s+(?:and then|then|after that|afterwards|next|finally)\s+/i,
      )
      .map((s) =>
        s
          .trim()
          .replace(/^(?:and then|and|then|after that|afterwards|next|finally)\s*,?\s+/i, "")
          .replace(/^[a-z]/, (ch) => ch.toUpperCase()),
      )
      .filter((s) => s.length > 8);
    out.push(...(pieces.length > 0 ? pieces : [c]));
  }
  return out.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`));
}

/** Deterministic planner: one task per sentence, sequential dependencies, repo-derived acceptance. */
export function heuristicPlan(plan: string, scan: RepoScan): PlanTask[] {
  const steps = splitPlan(plan);
  const verify = verificationCriteria(scan);
  const conventions: string[] = [];
  if (scan.hasClaudeMd) conventions.push("Follow CLAUDE.md.");
  if (scan.hasAgentsMd) conventions.push("Follow AGENTS.md.");
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  steps.forEach((step, i) => {
    const n = String(i + 1).padStart(2, "0");
    let id = `${n}-${slugify(step, 32)}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const label = step.length > 72 ? `${step.slice(0, 69)}...` : step;
    const prev = tasks[tasks.length - 1];
    tasks.push({
      id,
      label: label.replace(/\.$/, ""),
      prompt: [
        `${step}`,
        conventions.join(" "),
        `This is step ${i + 1} of ${steps.length} in: "${plan.trim().replace(/\s+/g, " ").slice(0, 400)}". Keep the change scoped to this step; do not start later steps.`,
        `Run the verification commands before committing and fix anything they report. Commit when done.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      depends_on: prev ? [prev.id] : [],
      acceptance: [`${step.replace(/\.$/, "")} is implemented`, ...verify],
    });
  });
  return tasks;
}

/** Stable topological order honouring depends_on; throws on unknown ids or cycles. */
export function topoSort(tasks: readonly PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (!byId.has(d)) throw new Error(`task '${t.id}' depends on unknown task '${d}'`);
    }
  }
  const out: PlanTask[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: PlanTask, trail: string[]) => {
    const s = state.get(t.id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`dependency cycle: ${[...trail, t.id].join(" -> ")}`);
    state.set(t.id, "visiting");
    for (const d of t.depends_on) visit(byId.get(d)!, [...trail, t.id]);
    state.set(t.id, "done");
    out.push(t);
  };
  for (const t of tasks) visit(t, []);
  return out;
}

export function plannerPrompt(plan: string, scan: RepoScan): string {
  const verify = verificationCriteria(scan);
  return `You are planning an overnight batch of Claude Code prompts for the repository at ${scan.root}.
Each prompt runs headless (\`claude -p\`) in sequence on one git branch; each must end with a commit.

Repository facts:
- name: ${scan.name}; framework: ${scan.framework}; language: ${scan.language}; package manager: ${scan.packageManager}
- scripts: ${Object.keys(scan.scripts).join(", ") || "(none)"}
- verification: ${verify.join("; ")}
- top-level: ${scan.topLevel.join(", ")}
- CLAUDE.md: ${scan.hasClaudeMd ? "yes" : "no"}; AGENTS.md: ${scan.hasAgentsMd ? "yes" : "no"}; CI workflows: ${scan.hasCi ? "yes" : "no"}
${
  scan.readmeHead
    ? `- README head:\n${scan.readmeHead
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}`
    : ""
}

Plan (from the user):
"""
${plan.trim()}
"""

Produce 3-12 ordered, dependency-aware tasks. Rules:
- Each task is one self-contained prompt a fresh Claude Code session can finish in under an hour with no questions.
- Order so every task's dependencies come earlier; put scaffolding first, tests with the code they test, docs last.
- Each prompt states the files/areas to touch, what NOT to touch, and ends with "Commit when done."
- acceptance: 2-5 checkable criteria per task, always including the verification commands above.
- ids: "NN-kebab-slug"; labels ≤ 60 chars.

Respond with ONLY a JSON array: [{"id","label","prompt","depends_on":[ids],"acceptance":[...]}]. No prose, no code fences.`;
}

/** Pull the first JSON array out of planner output (tolerates fences and claude's JSON envelope). */
export function parsePlannerOutput(text: string): PlanTask[] {
  let body = text.trim();
  try {
    const env = JSON.parse(body) as { result?: unknown };
    if (env && typeof env === "object" && typeof env.result === "string") body = env.result;
  } catch {
    // plain text
  }
  body = body.replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start)
    throw new Error("planner output contained no JSON array");
  const parsed = z
    .array(planTaskSchema)
    .min(1)
    .safeParse(JSON.parse(body.slice(start, end + 1)));
  if (!parsed.success)
    throw new Error(
      `planner output invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  return parsed.data;
}

export interface MakePromptsOptions {
  plan: string;
  root: string;
  /** Use the user's own `claude` binary to plan (never our keys). Default: true when `claude` is on PATH. */
  useLlm?: boolean;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MakePromptsResult {
  tasks: PlanTask[];
  scan: RepoScan;
  source: "llm" | "heuristic";
  warnings: string[];
}

export async function makePrompts(opts: MakePromptsOptions): Promise<MakePromptsResult> {
  const env = opts.env ?? process.env;
  const scan = await scanRepo(opts.root);
  const warnings: string[] = [];
  const wantLlm = opts.useLlm ?? (await commandExists("claude", env));
  if (wantLlm) {
    if (!(await commandExists("claude", env))) {
      warnings.push(
        "`claude` is not on PATH; using the heuristic planner. Install Claude Code to get LLM-planned prompts.",
      );
    } else {
      const args = ["-p", "--output-format", "json"];
      if (opts.model) args.push("--model", opts.model);
      const r = await exec("claude", args, {
        cwd: opts.root,
        env,
        input: plannerPrompt(opts.plan, scan),
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      if (r.code === 0) {
        try {
          const tasks = topoSort(parsePlannerOutput(r.stdout)).map((t) => ({
            ...t,
            acceptance: [
              ...t.acceptance,
              ...verificationCriteria(scan).filter((v) => !t.acceptance.includes(v)),
            ],
          }));
          return { tasks, scan, source: "llm", warnings };
        } catch (e) {
          warnings.push(
            `planner output unusable (${e instanceof Error ? e.message : String(e)}); using the heuristic planner.`,
          );
        }
      } else {
        warnings.push(
          `claude -p exited ${r.code}; using the heuristic planner. ${r.stderr.slice(0, 200)}`.trim(),
        );
      }
    }
  }
  return { tasks: topoSort(heuristicPlan(opts.plan, scan)), scan, source: "heuristic", warnings };
}

export interface BuildPromptsFileInput {
  tasks: readonly PlanTask[];
  plan: string;
  projectPath: string;
  branch: string;
  baseBranch: string;
  prTitle?: string;
  digestUrl?: string;
}

export function buildPromptsFile(i: BuildPromptsFileInput): PromptsFile {
  const firstSentence = i.plan.trim().split(/(?<=[.!?])\s+/)[0] ?? i.plan.trim();
  const prompts: Prompt[] = i.tasks.map((t) => ({
    id: t.id,
    label: t.label,
    prompt: t.prompt,
    ...(t.depends_on.length ? { depends_on: t.depends_on } : {}),
    ...(t.acceptance.length ? { acceptance: t.acceptance } : {}),
  }));
  return {
    project_path: i.projectPath,
    branch_name: i.branch,
    base_branch: i.baseBranch,
    pr_title: (i.prTitle ?? firstSentence).replace(/\.$/, "").slice(0, 100),
    pr_body: `${i.plan.trim()}\n\nImplemented overnight in ${prompts.length} sequential Claude Code prompts (overnight-kit).`,
    merge_strategy: "none",
    wait_for_ci: true,
    ci: {
      vercel: true,
      github_checks: true,
      timeout_seconds: 900,
      poll_seconds: 10,
      skip_grace_seconds: 120,
      fix_max_attempts: 3,
      strict_timeout: false,
    },
    ...(i.digestUrl ? { digest: { url: i.digestUrl } } : {}),
    prompts,
  };
}
