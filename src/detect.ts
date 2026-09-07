/**
 * Output classification — a port of claude-runner's lib/detect.sh. Pure functions, no I/O.
 */

/** Case-insensitive patterns scanned against the per-prompt log. Any match halts the runner. */
export const STREAM_ERROR_PATTERNS: readonly RegExp[] = [
  /stream interrupted/i,
  /partial response/i,
  /connection reset/i,
  /rate limit/i,
  /context length exceeded/i,
  /API error/i,
  /request failed/i,
  /^Error:/im,
];

export const MIN_LOG_BYTES = 50;

export type Outcome = "commit" | "noop" | "failure";

export interface Classification {
  outcome: Outcome;
  /** One-line plain-English reason. */
  reason: string;
  /** The matched stream-error pattern (failures only). */
  pattern?: string;
}

export interface ClassifyInput {
  /** `claude -p` exit code. */
  exitCode: number;
  /** Full log text (ANSI may be present), or null when the file is missing. */
  log: string | null;
  headBefore: string;
  headAfter: string;
  /** Did the prompt leave files uncommitted (per-prompt delta, ignored paths filtered)? */
  deltaDirty: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Order matters: earlier checks shadow later ones. A successful commit never redeems a
 * stream error — the response was incomplete and the work may be partial.
 */
export function classifyResult(input: ClassifyInput): Classification {
  const { exitCode, log, headBefore, headAfter, deltaDirty } = input;
  if (exitCode !== 0)
    return { outcome: "failure", reason: `claude -p exited with code ${exitCode}` };
  if (log === null) return { outcome: "failure", reason: "log file missing" };
  const size = Buffer.byteLength(log, "utf8");
  if (size < MIN_LOG_BYTES) {
    return { outcome: "failure", reason: `log file is empty or near-empty (${size} bytes)` };
  }
  const clean = stripAnsi(log);
  for (const pat of STREAM_ERROR_PATTERNS) {
    const m = pat.exec(clean);
    if (m) {
      const lineNo = clean.slice(0, m.index).split("\n").length;
      const line = clean.split("\n")[lineNo - 1] ?? "";
      return {
        outcome: "failure",
        reason: `stream-error pattern '${pat.source}' matched: ${lineNo}:${line.slice(0, 160)}`,
        pattern: pat.source,
      };
    }
  }
  if (deltaDirty) {
    return {
      outcome: "failure",
      reason: "Claude staged or modified files but did not commit them",
    };
  }
  if (headBefore === headAfter) {
    return { outcome: "noop", reason: "HEAD did not advance and working tree clean (no-op)" };
  }
  return {
    outcome: "commit",
    reason: `HEAD advanced ${headBefore.slice(0, 7)} -> ${headAfter.slice(0, 7)}`,
  };
}

/** Last non-empty line longer than 20 chars, capped at 200 — the one-line "what Claude said". */
export function extractLogSummary(log: string | null): string {
  if (!log) return "";
  const lines = stripAnsi(log)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 20);
  const last = lines[lines.length - 1] ?? "";
  return last.length > 200 ? `${last.slice(0, 197)}...` : last;
}

/**
 * After a halt where HEAD advanced: "A" (mark completed) when the log shows verification
 * passing and no failure marker; otherwise "B" (discard and retry). Conservative on purpose.
 */
export function recommendResumeOption(log: string | null): "A" | "B" {
  if (!log) return "B";
  const s = stripAnsi(log);
  if (
    /[1-9][0-9]* (tests? )?failed|build failed|lint failed|exit code [1-9]|^Error:|^FAIL\b/m.test(s)
  ) {
    return "B";
  }
  if (
    /all tests pass|tests? passed|build succe|lint clean|lint passed|✓ pass|0 (tests? )?failed/i.test(
      s,
    )
  ) {
    return "A";
  }
  return "B";
}
