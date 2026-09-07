import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isoNow } from "./state.js";

/** `min`/`low` → 🔇 prefix, `high` → 🚨, `halt`/`default` → none (callers bake ✅ ℹ️ ⏭ 🛑 into msg). */
export type Priority = "default" | "min" | "low" | "high" | "halt";

export const DISCORD_CONTENT_LIMIT = 2000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotifierOptions {
  discordUrl?: string;
  slackUrl?: string;
  /** notifications.log — every attempt is appended (rc, http, stderr). */
  logFile?: string;
  fetch?: FetchLike;
  /** OVERNIGHT_DISABLE_NOTIFY=1 in tests: no network, still logs. */
  disabled?: boolean;
  /** Called once, on the first failed send, so breakage is visible before you walk away. */
  onFirstFailure?: (info: { outcome: string; status: string; error: string }) => void;
  timeoutMs?: number;
}

export interface Notifier {
  send(message: string, priority?: Priority, outcome?: string, promptId?: string): Promise<void>;
  readonly configured: boolean;
}

export function prefixFor(priority: Priority): string {
  if (priority === "min" || priority === "low") return "🔇 ";
  if (priority === "high") return "🚨 ";
  return "";
}

export function truncateContent(text: string, limit = DISCORD_CONTENT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

/**
 * Discord + Slack webhooks. Failures never halt the batch: every attempt is logged and the
 * run continues. Nothing here throws.
 */
export function createNotifier(opts: NotifierOptions): Notifier {
  const fetchImpl: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let firstDone = false;
  const configured = Boolean(opts.discordUrl || opts.slackUrl);

  async function log(line: string): Promise<void> {
    if (!opts.logFile) return;
    try {
      await mkdir(dirname(opts.logFile), { recursive: true });
      await appendFile(opts.logFile, `${line}\n`, "utf8");
    } catch {
      // logging must never break the run
    }
  }

  async function post(
    url: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: string; error: string }> {
    let lastError = "";
    let lastStatus = "—";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        lastStatus = String(res.status);
        if (res.ok) return { ok: true, status: lastStatus, error: "—" };
        lastError = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: false, status: lastStatus, error: lastError || "send failed" };
  }

  return {
    configured,
    async send(message, priority = "default", outcome = "event", promptId = "—") {
      const content = truncateContent(`${prefixFor(priority)}${message}`);
      if (opts.disabled || !configured) {
        await log(
          `${isoNow()} prompt-id=${promptId} outcome=${outcome} rc=0 http=— stderr=(notify disabled)`,
        );
        return;
      }
      const results: { ok: boolean; status: string; error: string }[] = [];
      if (opts.discordUrl) results.push(await post(opts.discordUrl, { content }));
      if (opts.slackUrl) results.push(await post(opts.slackUrl, { text: content }));
      for (const r of results) {
        await log(
          `${isoNow()} prompt-id=${promptId} outcome=${outcome} rc=${r.ok ? 0 : 1} http=${r.status} stderr=${r.error.replace(/\s+/g, " ").slice(0, 200)}`,
        );
      }
      if (!firstDone) {
        firstDone = true;
        const failed = results.find((r) => !r.ok);
        if (failed) opts.onFirstFailure?.({ outcome, status: failed.status, error: failed.error });
      }
    },
  };
}
