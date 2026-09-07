import type { KitEvent } from "./logs.js";

export interface PushOptions {
  url: string;
  token: string;
  events: readonly KitEvent[];
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface PushResult {
  ok: boolean;
  status: number;
  accepted?: number;
  error?: string;
}

/**
 * POST the kit's events.jsonl to the morning digest's ingest endpoint. Never throws; a failed
 * push is reported and the batch continues (the digest is a convenience, not a gate).
 */
export async function pushEvents(opts: PushOptions): Promise<PushResult> {
  const fetchImpl = opts.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ vendor: "overnight", events: opts.events }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let accepted: number | undefined;
    try {
      const body = (await res.json()) as { accepted?: number; cause?: string };
      accepted = body.accepted;
      if (!res.ok)
        return { ok: false, status: res.status, error: body.cause ?? `HTTP ${res.status}` };
    } catch {
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, ...(accepted !== undefined ? { accepted } : {}) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
