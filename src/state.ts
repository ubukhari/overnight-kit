import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Prompt } from "./config.js";
import { canonicalJson, sha256Hex } from "./hash.js";

export type CompletionStatus = "completed" | "failed";
/** `commit` / `noop` for real work, `skip` (resumed), `skip-current` (forced), `prior-run` (legacy). */
export type CompletionKind = "commit" | "noop" | "skip" | "skip-current" | "prior-run" | "";
export type CiStatus =
  | "passed"
  | "passed_after_fix"
  | "failed"
  | "fix_declined"
  | "skipped"
  | "skipped_no_deployment"
  | "timeout_continued"
  | "";

export interface Completion {
  id: string;
  index: number;
  status: CompletionStatus;
  sha: string;
  kind: CompletionKind;
  ci_status?: CiStatus;
  ci_fix_attempts?: number;
  ci_fix_commits?: string[];
}

export type RunStatus = "in_progress" | "halted" | "completed";

export interface RunState {
  branch_name: string;
  prompts_file: string;
  /** sha256 of the whole prompts array — diagnostics only. */
  prompts_hash: string;
  /** sha256 of prompts[0..last_completed_index] — what gates a resume. */
  completed_prefix_hash: string;
  status: RunStatus;
  last_completed_id: string;
  last_completed_index: number;
  timestamp: string;
  completions: Completion[];
}

export function statePath(home: string, branch: string): string {
  return join(home, "state", `${branch}.json`);
}

export function promptsHash(prompts: readonly Prompt[]): string {
  return sha256Hex(canonicalJson(prompts));
}

/** Hash of the first `lci + 1` prompts; `[]` when nothing completed yet. */
export function prefixHash(prompts: readonly Prompt[], lci: number): string {
  return sha256Hex(canonicalJson(lci < 0 ? [] : prompts.slice(0, lci + 1)));
}

export async function readState(path: string): Promise<RunState | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const raw = JSON.parse(text) as Partial<RunState>;
  return {
    branch_name: raw.branch_name ?? "",
    prompts_file: raw.prompts_file ?? "",
    prompts_hash: raw.prompts_hash ?? "",
    completed_prefix_hash: raw.completed_prefix_hash ?? "",
    status: raw.status ?? "in_progress",
    last_completed_id: raw.last_completed_id ?? "",
    last_completed_index: raw.last_completed_index ?? -1,
    timestamp: raw.timestamp ?? "",
    completions: Array.isArray(raw.completions) ? raw.completions : [],
  };
}

export async function writeState(path: string, state: RunState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function removeState(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** In-memory per-prompt completion tracking; serialised into the state file on every transition. */
export class Completions {
  private readonly rows: Completion[] = [];

  static from(list: readonly Completion[]): Completions {
    const c = new Completions();
    for (const row of list) c.rows.push({ ...row });
    return c;
  }

  /** Legacy state (no completions list): synthesise entries from last_completed_index. */
  static fromLegacy(prompts: readonly Prompt[], lci: number): Completions {
    const c = new Completions();
    for (let k = 0; k <= lci && k < prompts.length; k++) {
      c.upsert({ id: prompts[k]!.id, index: k, status: "completed", sha: "", kind: "prior-run" });
    }
    return c;
  }

  upsert(row: Omit<Completion, "ci_status" | "ci_fix_attempts" | "ci_fix_commits">): void {
    const found = this.rows.find((r) => r.index === row.index);
    if (found) {
      found.id = row.id;
      found.status = row.status;
      found.sha = row.sha;
      found.kind = row.kind;
      // CI fields are owned by setCi and survive status flips (failed → completed via --skip-current).
    } else {
      this.rows.push({ ...row });
    }
  }

  setCi(index: number, status: CiStatus, attempts = 0, commits: string[] = []): void {
    const found = this.rows.find((r) => r.index === index);
    if (!found) return;
    found.ci_status = status;
    found.ci_fix_attempts = attempts;
    found.ci_fix_commits = commits;
  }

  statusFor(index: number): CompletionStatus | undefined {
    return this.rows.find((r) => r.index === index)?.status;
  }

  shaFor(index: number): string {
    return this.rows.find((r) => r.index === index)?.sha ?? "";
  }

  completedIds(): string[] {
    return this.rows.filter((r) => r.status === "completed").map((r) => r.id);
  }

  allIds(): string[] {
    return this.rows.map((r) => r.id);
  }

  completedCount(): number {
    return this.rows.filter((r) => r.status === "completed").length;
  }

  /** Most recent (highest index) failed entry, for --skip-current. */
  lastFailed(): Completion | undefined {
    return [...this.rows].sort((a, b) => b.index - a.index).find((r) => r.status === "failed");
  }

  toArray(): Completion[] {
    return [...this.rows]
      .sort((a, b) => a.index - b.index)
      .map((r) => {
        const out: Completion = {
          id: r.id,
          index: r.index,
          status: r.status,
          sha: r.sha,
          kind: r.kind,
        };
        if (r.ci_status) {
          out.ci_status = r.ci_status;
          out.ci_fix_attempts = r.ci_fix_attempts ?? 0;
          out.ci_fix_commits = r.ci_fix_commits ?? [];
        }
        return out;
      });
  }
}

export type ResumeDecision =
  | { kind: "resume"; migrated?: boolean }
  | { kind: "archived"; archive: string }
  | { kind: "mismatch"; message: string };

export interface ClassifyStateInput {
  state: RunState;
  path: string;
  prompts: readonly Prompt[];
  branch: string;
  now?: Date;
}

/**
 * Decide what an existing state file means for this run (claude-runner's decision tree):
 *  A. full hash equal              → resume
 *  B. no id overlap with state     → archive old state, run fresh
 *  C. completed-prefix hash equal  → resume (prompts appended at the tail run as pending)
 *  D. otherwise                    → mismatch (caller halts unless --force-continue)
 * Legacy files without a prefix hash are migrated in place (prefix computed from the current JSON).
 */
export async function classifyStateForResume(input: ClassifyStateInput): Promise<ResumeDecision> {
  const { state, path, prompts, branch } = input;
  const currentFull = promptsHash(prompts);
  let migrated = false;
  if (!state.completed_prefix_hash) {
    state.completed_prefix_hash = prefixHash(prompts, state.last_completed_index);
    await writeState(path, state);
    migrated = true;
  }
  if (!state.prompts_hash) return { kind: "resume", migrated };
  if (state.prompts_hash === currentFull) return { kind: "resume", migrated };

  const jsonIds = new Set(prompts.map((p) => p.id));
  const overlap = state.completions.some((c) => c.status === "completed" && jsonIds.has(c.id));
  if (!overlap) {
    const stamp = timestampForFiles(input.now ?? new Date());
    const archive = `${path}.replaced-${stamp}`;
    await rename(path, archive);
    return { kind: "archived", archive };
  }

  const lci = state.last_completed_index;
  const currentPrefix = lci + 1 > prompts.length ? "(short)" : prefixHash(prompts, lci);
  if (state.completed_prefix_hash && currentPrefix === state.completed_prefix_hash) {
    return { kind: "resume", migrated };
  }
  return {
    kind: "mismatch",
    message: `Completed prompt(s) for '${branch}' appear modified or reordered. State may be inconsistent. Pass --fresh to start over, or --force-continue to ignore the mismatch and resume anyway.`,
  };
}

/** `YYYYMMDD-HHMMSS` in local time, matching claude-runner's log/archive names. */
export function timestampForFiles(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function isoNow(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
