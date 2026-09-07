import { exec, type ExecResult } from "./exec.js";

/** Thin git wrapper bound to one repository. Every call is explicit; nothing is cached. */
export class Git {
  constructor(
    readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  run(args: readonly string[]): Promise<ExecResult> {
    return exec("git", args, { cwd: this.cwd, env: this.env });
  }

  async out(args: readonly string[]): Promise<string> {
    const r = await this.run(args);
    return r.code === 0 ? r.stdout.trimEnd() : "";
  }

  async ok(args: readonly string[]): Promise<boolean> {
    return (await this.run(args)).code === 0;
  }

  isRepo(): Promise<boolean> {
    return this.ok(["rev-parse", "--is-inside-work-tree"]);
  }

  head(): Promise<string> {
    return this.out(["rev-parse", "HEAD"]);
  }

  shortHead(): Promise<string> {
    return this.out(["rev-parse", "--short=7", "HEAD"]);
  }

  currentBranch(): Promise<string> {
    return this.out(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  /** `git status --porcelain --untracked-files=all` */
  porcelain(): Promise<string> {
    return this.out(["status", "--porcelain", "--untracked-files=all"]);
  }

  shortStatus(): Promise<string> {
    return this.out(["status", "--short", "--untracked-files=all"]);
  }

  localBranchExists(branch: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  }

  remoteBranchExists(branch: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  }

  refExists(ref: string): Promise<boolean> {
    return this.ok(["rev-parse", "--verify", "-q", ref]);
  }

  fetch(): Promise<boolean> {
    return this.ok(["fetch", "origin", "--prune"]);
  }

  hasRemote(): Promise<boolean> {
    return this.ok(["remote", "get-url", "origin"]);
  }

  checkout(branch: string): Promise<boolean> {
    return this.ok(["checkout", branch]);
  }

  checkoutNew(branch: string, from: string): Promise<boolean> {
    return this.ok(["checkout", "-b", branch, from]);
  }

  checkoutTracking(branch: string): Promise<boolean> {
    return this.ok(["checkout", "-b", branch, "--track", `origin/${branch}`]);
  }

  pullFfOnly(): Promise<boolean> {
    return this.ok(["pull", "--ff-only"]);
  }

  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.ok(["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  async aheadBehind(branch: string): Promise<{ ahead: number; behind: number }> {
    const ahead = Number(
      (await this.out(["rev-list", "--count", `origin/${branch}..${branch}`])) || 0,
    );
    const behind = Number(
      (await this.out(["rev-list", "--count", `${branch}..origin/${branch}`])) || 0,
    );
    return { ahead, behind };
  }

  logOneline(range: string, limit = 10): Promise<string> {
    return this.out(["log", "--oneline", `-n`, String(limit), range]);
  }

  logFormat(range: string, format: string): Promise<string> {
    return this.out(["log", `--format=${format}`, range]);
  }

  commitSubject(sha: string): Promise<string> {
    return this.out(["log", "-1", "--format=%s", sha]);
  }

  async shortStat(sha: string): Promise<string> {
    const s = await this.out(["show", "--shortstat", "--format=", sha]);
    return s.replace(/\n/g, "").trim();
  }

  diffHead(): Promise<string> {
    return this.out(["diff", "HEAD"]);
  }

  untracked(): Promise<string> {
    return this.out(["ls-files", "--others", "--exclude-standard"]);
  }

  async stashPush(message: string): Promise<boolean> {
    return this.ok(["stash", "push", "-u", "-m", message]);
  }

  async commitAll(message: string): Promise<boolean> {
    if (!(await this.ok(["add", "-A"]))) return false;
    return this.ok(["commit", "-m", message]);
  }

  /**
   * Push and set upstream. `nonFastForward` is reported separately because the runner never
   * force-pushes; the caller halts with the output.
   */
  async push(branch: string): Promise<{ ok: boolean; nonFastForward: boolean; output: string }> {
    const r = await this.run(["push", "-u", "origin", branch]);
    const output = `${r.stdout}${r.stderr}`.trim();
    const nonFastForward =
      r.code !== 0 && /non-fast-forward|rejected.*fetch first|Updates were rejected/i.test(output);
    return { ok: r.code === 0, nonFastForward, output };
  }

  /** `owner/repo` from the origin URL, or null. */
  async originSlug(): Promise<string | null> {
    const url = await this.out(["remote", "get-url", "origin"]);
    const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  }
}
