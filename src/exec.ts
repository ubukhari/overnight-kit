import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. */
  input?: string;
  timeoutMs?: number;
}

/** Run a command, capture stdout/stderr, never throw on a non-zero exit (spawn errors → code 127). */
export function exec(
  cmd: string,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr });
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      stderr += e.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    if (opts.timeoutMs) {
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
          stderr += `\n(timed out after ${opts.timeoutMs}ms)`;
        }
      }, opts.timeoutMs).unref();
    }
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run a command with combined stdout+stderr streamed to `logFile` (what `claude -p` needs). */
export function execToFile(
  cmd: string,
  args: readonly string[],
  logFile: string,
  opts: Omit<ExecOptions, "input"> & { input?: string } = {},
): Promise<{ code: number }> {
  return new Promise((resolvePromise) => {
    const out = createWriteStream(logFile, { flags: "a" });
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      out.end(() => resolvePromise({ code }));
    };
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => {
      out.write(`\n[overnight] failed to start ${cmd}: ${e.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function commandExists(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = await exec(probe, [cmd], { env });
  return r.code === 0;
}
