/**
 * Dirty-path filtering — which uncommitted files are allowed to exist without halting.
 * Entries ending in `/` are directory prefixes; everything else is a bash-style glob
 * (`*`, `?`, `[...]`; `*` matches `/` too, exactly like `[[ $path == $glob ]]`).
 */
export const DEFAULT_IGNORED_DIRTY_PATHS: readonly string[] = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".next/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  "*.log",
];

/** Broader heuristic used only to flag a probable false-positive halt in last-failure.md. */
export const COMMON_REGEN_PATTERNS: readonly string[] = [
  "*.log",
  "*.lock",
  "*-lock.json",
  "*-lock.yaml",
  "*-lock.yml",
  "*.tsbuildinfo",
  "*.snap",
  "*generated*",
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  "__snapshots__/",
  "*/results/*.json",
  "*/test-results/*",
  "*/playwright-report/*",
  "*/.cache/*",
];

export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

export function pathMatchesAny(path: string, patterns: readonly string[]): boolean {
  for (const entry of patterns) {
    if (entry.endsWith("/")) {
      if (path.startsWith(entry)) return true;
    } else if (globToRegExp(entry).test(path)) return true;
  }
  return false;
}

/** Path of a `git status --porcelain` line (renames match on the new path). */
export function porcelainPath(line: string): string {
  let p = line.slice(3);
  const arrow = p.lastIndexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4);
  return p;
}

export function splitPorcelain(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

/** Drop porcelain lines whose path is covered by `ignored`. */
export function filterIgnoredPaths(lines: readonly string[], ignored: readonly string[]): string[] {
  return lines.filter((l) => !pathMatchesAny(porcelainPath(l), ignored));
}

/**
 * Porcelain lines present after the prompt that were not present before, minus ignored
 * paths — i.e. files Claude actually touched. Pre-existing dirt never halts a prompt.
 */
export function computeDirtyDelta(
  before: string,
  after: string,
  ignored: readonly string[] = DEFAULT_IGNORED_DIRTY_PATHS,
): string[] {
  const pre = new Set(splitPorcelain(before));
  const delta = splitPorcelain(after).filter((l) => !pre.has(l));
  return filterIgnoredPaths(delta, ignored);
}

/** True when the tree is dirty AND every dirty file matches a common regeneration pattern. */
export function allDirtyMatchCommonRegen(porcelain: string): boolean {
  const lines = splitPorcelain(porcelain);
  if (lines.length === 0) return false;
  return lines.every((l) => pathMatchesAny(porcelainPath(l), COMMON_REGEN_PATTERNS));
}

/** Resolve the ignore list: defaults, or OVERNIGHT_IGNORED_DIRTY_PATHS (comma-separated) replacing them, plus OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA appended. */
export function resolveIgnoredPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env["OVERNIGHT_IGNORED_DIRTY_PATHS"]
    ? env["OVERNIGHT_IGNORED_DIRTY_PATHS"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_IGNORED_DIRTY_PATHS];
  const extra = env["OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA"]
    ? env["OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return [...base, ...extra];
}
