import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isoNow } from "./state.js";

/** One line of `events.jsonl` — what the morning digest ingests from the kit. */
export interface KitEvent {
  ts: string;
  type:
    | "batch.start"
    | "batch.complete"
    | "batch.nothing_new"
    | "prompt.skip"
    | "prompt.commit"
    | "prompt.noop"
    | "prompt.failed"
    | "prompt.dry_run"
    | "ci.wait"
    | "ci.passed"
    | "ci.failed"
    | "ci.timeout"
    | "ci.fix_attempt"
    | "pr.opened"
    | "pr.automerge"
    | "halt"
    | "decision";
  branch: string;
  project: string;
  prompt?: { id: string; label: string; index: number; total: number };
  sha?: string;
  outcome?: string;
  reason?: string;
  url?: string;
  message?: string;
  /** Free-form extras (fix attempts, commit subject, shortstat, …). */
  data?: Record<string, unknown>;
}

/** Per-run log directory: prompt logs, decisions.log, notifications.log, events.jsonl. */
export class RunLog {
  readonly decisionsPath: string;
  readonly notificationsPath: string;
  readonly eventsPath: string;

  constructor(
    readonly dir: string,
    private readonly batch: { branch: string; project: string },
  ) {
    this.decisionsPath = join(dir, "decisions.log");
    this.notificationsPath = join(dir, "notifications.log");
    this.eventsPath = join(dir, "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  promptLogPath(id: string): string {
    return join(this.dir, `prompt-${id}.log`);
  }

  ciFixLogPath(sha: string, attempt: number): string {
    return join(this.dir, `ci-fix-${sha}-${attempt}.log`);
  }

  async decision(
    index: number,
    total: number,
    id: string,
    outcome: string,
    reason: string,
  ): Promise<void> {
    await appendFile(
      this.decisionsPath,
      `${isoNow()} [${index + 1}/${total}] id=${id} outcome=${outcome} reason=${reason}\n`,
      "utf8",
    );
  }

  async note(line: string): Promise<void> {
    await appendFile(this.notificationsPath, `${isoNow()} ${line}\n`, "utf8");
  }

  async event(e: Omit<KitEvent, "ts" | "branch" | "project">): Promise<void> {
    const full: KitEvent = {
      ts: isoNow(),
      branch: this.batch.branch,
      project: this.batch.project,
      ...e,
    };
    await appendFile(this.eventsPath, `${JSON.stringify(full)}\n`, "utf8");
  }

  async readPromptLog(id: string): Promise<string | null> {
    try {
      return await readFile(this.promptLogPath(id), "utf8");
    } catch {
      return null;
    }
  }
}

export async function readEventsJsonl(path: string): Promise<KitEvent[]> {
  const text = await readFile(path, "utf8");
  const out: KitEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as KitEvent);
    } catch {
      // skip torn lines
    }
  }
  return out;
}
