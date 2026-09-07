import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

/** Allowed values for `merge_strategy` — the runner never merges unless you opt in. */
export const MERGE_STRATEGIES = ["none", "auto-squash", "auto-merge", "auto-rebase"] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export const promptSchema = z.object({
  /** Filename-safe; also the state-file key. */
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "id must be filename-safe ([A-Za-z0-9._-])"),
  label: z.string().min(1),
  prompt: z.string().min(1),
  /** Per-prompt model override passed to `claude --model`. */
  model: z.string().min(1).optional(),
  /** Ids this prompt builds on (prompt-maker output; order in the array is what runs). */
  depends_on: z.array(z.string()).optional(),
  /** Acceptance criteria the prompt-maker attached; appended to the prompt text at run time. */
  acceptance: z.array(z.string()).optional(),
});
export type Prompt = z.infer<typeof promptSchema>;

export const ciConfigSchema = z.object({
  /** Poll `vercel ls` for a new deployment of the branch after every commit. */
  vercel: z.boolean().default(true),
  /** Poll GitHub check-runs / commit statuses for the pushed sha after every commit. */
  github_checks: z.boolean().default(true),
  timeout_seconds: z.number().int().positive().default(900),
  poll_seconds: z.number().int().positive().default(10),
  /** After this many seconds with nothing surfaced, log a one-shot "nothing yet" warning. */
  skip_grace_seconds: z.number().int().nonnegative().default(120),
  /** On a red build, let Claude try to fix it this many times (0 = halt immediately). */
  fix_max_attempts: z.number().int().nonnegative().default(3),
  /** Model for fix attempts; default = the batch default model. */
  fix_model: z.string().min(1).optional(),
  /** Halt on every timeout instead of warning and continuing. */
  strict_timeout: z.boolean().default(false),
});
export type CiConfig = z.infer<typeof ciConfigSchema>;

export const digestConfigSchema = z.object({
  /** Ingest endpoint of the morning digest, e.g. https://agentwares-digest.vercel.app/api/ingest */
  url: z.url(),
  /** Ingest token for that source. Prefer the OVERNIGHT_DIGEST_TOKEN env var over the file. */
  token: z.string().min(1).optional(),
});

export const promptsFileSchema = z.object({
  project_path: z.string().min(1),
  branch_name: z.string().min(1),
  base_branch: z.string().min(1),
  pr_title: z.string().min(1),
  pr_body: z.string().default(""),
  merge_strategy: z.enum(MERGE_STRATEGIES).default("none"),
  /** Batch-wide model; omitted = whatever the user's `claude` defaults to. */
  default_model: z.string().min(1).optional(),
  /** Webhooks may also come from OVERNIGHT_DISCORD_WEBHOOK_URL / OVERNIGHT_SLACK_WEBHOOK_URL. */
  discord_webhook_url: z.url().optional(),
  slack_webhook_url: z.url().optional(),
  /** Master switch for the per-commit CI gate (push + wait). */
  wait_for_ci: z.boolean().default(true),
  ci: ciConfigSchema.prefault({}),
  digest: digestConfigSchema.optional(),
  prompts: z.array(promptSchema).min(1),
});
export type PromptsFile = z.infer<typeof promptsFileSchema>;

export class ConfigError extends Error {
  readonly code = "INVALID_PROMPTS_FILE";
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Accept the claude-runner (bash) field names so existing prompts.json files keep working.
 * Returns warnings for anything ignored.
 */
export function normalizeLegacy(raw: Record<string, unknown>): {
  data: Record<string, unknown>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const data: Record<string, unknown> = { ...raw };
  const ci: Record<string, unknown> =
    typeof data["ci"] === "object" && data["ci"] !== null
      ? { ...(data["ci"] as Record<string, unknown>) }
      : {};
  if ("wait_for_vercel" in data) {
    data["wait_for_ci"] = data["wait_for_vercel"];
    delete data["wait_for_vercel"];
  }
  const move = (from: string, to: string) => {
    if (from in data) {
      ci[to] = data[from];
      delete data[from];
    }
  };
  move("vercel_fix_max_attempts", "fix_max_attempts");
  move("vercel_fix_model", "fix_model");
  move("vercel_skip_grace_seconds", "skip_grace_seconds");
  if (Object.keys(ci).length > 0) data["ci"] = ci;
  if ("ntfy_topic" in data) {
    warnings.push(
      "'ntfy_topic' is deprecated and ignored; use discord_webhook_url or slack_webhook_url.",
    );
    delete data["ntfy_topic"];
  }
  return { data, warnings };
}

export interface LoadedPrompts {
  file: string;
  config: PromptsFile;
  warnings: string[];
}

/** Parse + validate a prompts.json (legacy field names accepted, duplicate ids rejected). */
export function parsePromptsJson(text: string, file = "prompts.json"): LoadedPrompts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      `${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      "fix the JSON syntax and re-run",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} must be a JSON object`, "see examples/sample-prompts.json");
  }
  const { data, warnings } = normalizeLegacy(raw as Record<string, unknown>);
  const parsed = promptsFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${file}: ${issues}`, "see examples/sample-prompts.json for every field");
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of parsed.data.prompts) {
    if (seen.has(p.id)) dupes.add(p.id);
    seen.add(p.id);
  }
  if (dupes.size > 0) {
    throw new ConfigError(
      `Duplicate prompt id(s) in ${file}: ${[...dupes].join(" ")}`,
      "make ids unique and re-run (ids key the state file)",
    );
  }
  return { file, config: parsed.data, warnings };
}

export async function loadPromptsFile(path: string): Promise<LoadedPrompts> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    throw new ConfigError(`Prompts file not found: ${abs}`, "pass the path to a prompts.json");
  }
  const loaded = parsePromptsJson(text, abs);
  if (!isAbsolute(loaded.config.project_path)) {
    loaded.config.project_path = resolve(abs, "..", loaded.config.project_path);
  }
  return loaded;
}

/** The text actually sent to `claude -p`: the prompt plus its acceptance criteria. */
export function renderPromptText(p: Prompt): string {
  if (!p.acceptance || p.acceptance.length === 0) return p.prompt;
  return `${p.prompt.trimEnd()}\n\nAcceptance criteria:\n${p.acceptance.map((a) => `- ${a}`).join("\n")}`;
}
