import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Git } from "./git.js";
import { buildPromptsFile, makePrompts, slugify, type MakePromptsResult } from "./prompt-maker.js";

export interface InitOptions {
  cwd: string;
  /** One-paragraph plan; or read from `planFile`. */
  plan?: string;
  planFile?: string;
  branch?: string;
  baseBranch?: string;
  /** Output path, default `overnight.prompts.json` in cwd. */
  out?: string;
  /** Use the user's `claude` to plan (default: when on PATH). `false` = heuristic planner only. */
  useLlm?: boolean;
  model?: string;
  digestUrl?: string;
  /** Overwrite an existing output file. */
  force?: boolean;
  installSkill?: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
}

export interface InitResult {
  promptsPath: string;
  skillPath?: string;
  planner: MakePromptsResult;
  branch: string;
  baseBranch: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Location of the packaged skill file (works from dist/ and from src/ under vitest). */
export function packagedSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "skills", "overnight", "SKILL.md");
}

/** Copy the `/overnight` skill into `.claude/skills/overnight/SKILL.md` of the repo. */
export async function installSkill(cwd: string): Promise<string> {
  const dest = join(cwd, ".claude", "skills", "overnight", "SKILL.md");
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(packagedSkillPath(), dest);
  return dest;
}

async function detectBaseBranch(git: Git): Promise<string> {
  const head = await git.out(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.startsWith("origin/")) return head.slice("origin/".length);
  for (const b of ["main", "master"]) if (await git.localBranchExists(b)) return b;
  const current = await git.currentBranch();
  return current && current !== "HEAD" ? current : "main";
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const out = opts.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const cwd = resolve(opts.cwd);
  const git = new Git(cwd, opts.env);
  if (!(await git.isRepo()))
    throw new Error(
      `${cwd} is not a git repository — run \`git init\` (and make a first commit) first.`,
    );
  let plan = opts.plan?.trim() ?? "";
  if (!plan && opts.planFile) plan = (await readFile(resolve(cwd, opts.planFile), "utf8")).trim();
  if (!plan)
    throw new Error(
      'A plan is required: `overnight init --plan "<one paragraph>"` or `--plan-file plan.md`.',
    );
  const outPath = resolve(cwd, opts.out ?? "overnight.prompts.json");
  if ((await exists(outPath)) && !opts.force)
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);

  const planner = await makePrompts({
    plan,
    root: cwd,
    ...(opts.useLlm !== undefined ? { useLlm: opts.useLlm } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  for (const w of planner.warnings) out(`warning: ${w}`);
  const baseBranch = opts.baseBranch ?? (await detectBaseBranch(git));
  const branch = opts.branch ?? `overnight/${slugify(plan, 40)}`;
  const file = buildPromptsFile({
    tasks: planner.tasks,
    plan,
    projectPath: cwd,
    branch,
    baseBranch,
    ...(opts.digestUrl ? { digestUrl: opts.digestUrl } : {}),
  });
  await writeFile(outPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  let skillPath: string | undefined;
  if (opts.installSkill !== false) skillPath = await installSkill(cwd);

  out(
    `\nWrote ${outPath} — ${planner.tasks.length} prompts (${planner.source === "llm" ? "planned by your claude" : "heuristic planner"}) on branch '${branch}' from '${baseBranch}'.`,
  );
  out(
    `Repo: ${planner.scan.name} · ${planner.scan.framework} · ${planner.scan.language} · ${planner.scan.packageManager}${planner.scan.testCommand ? ` · tests: ${planner.scan.testCommand}` : ""}`,
  );
  planner.tasks.forEach((t, i) => out(`  ${String(i + 1).padStart(2, " ")}. ${t.id} — ${t.label}`));
  if (skillPath) out(`Installed the /overnight skill at ${skillPath}.`);
  out(
    `\nNext:\n  npx overnight-kit run ${opts.out ?? "overnight.prompts.json"} --dry-run   # see the sequence, touch nothing\n  npx overnight-kit run ${opts.out ?? "overnight.prompts.json"}             # run it (uses your own \`claude\`)\nEdit the prompts first if you like; ids key the resume state. Keep webhook/digest tokens in env (OVERNIGHT_DISCORD_WEBHOOK_URL, OVERNIGHT_DIGEST_TOKEN), not in the file.`,
  );
  return { promptsPath: outPath, ...(skillPath ? { skillPath } : {}), planner, branch, baseBranch };
}
