import { describe, expect, it } from "vitest";
import {
  allDirtyMatchCommonRegen,
  computeDirtyDelta,
  filterIgnoredPaths,
  globToRegExp,
  pathMatchesAny,
  resolveIgnoredPaths,
} from "./paths.js";

describe("glob matching (bash [[ == ]] semantics)", () => {
  it("* crosses directory separators, ? matches one char, [..] classes work", () => {
    expect(globToRegExp("*.log").test("deep/dir/x.log")).toBe(true);
    expect(globToRegExp("src/results/*.json").test("src/results/a.json")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("abbc")).toBe(false);
    expect(globToRegExp("file[0-9].txt").test("file7.txt")).toBe(true);
    expect(globToRegExp("*.log").test("x.logs")).toBe(false);
  });
  it("trailing slash entries are directory prefixes", () => {
    expect(pathMatchesAny("node_modules/x/y.js", ["node_modules/"])).toBe(true);
    expect(pathMatchesAny("src/node_modules/x", ["node_modules/"])).toBe(false);
    expect(pathMatchesAny("pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
  });
});

describe("porcelain filtering", () => {
  it("filters ignored paths and matches renames on the new path", () => {
    const lines = [
      " M src/a.ts",
      "?? dist/out.js",
      "R  old.log -> new.log",
      " M package-lock.json",
    ];
    expect(filterIgnoredPaths(lines, ["dist/", "*.log", "package-lock.json"])).toEqual([
      " M src/a.ts",
    ]);
  });
  it("delta only counts lines that appeared after the prompt", () => {
    const before = " M carried.ts\n";
    const after = " M carried.ts\n?? new.ts\n?? x.log\n";
    expect(computeDirtyDelta(before, after)).toEqual(["?? new.ts"]);
    expect(computeDirtyDelta("", "")).toEqual([]);
  });
  it("allDirtyMatchCommonRegen flags probable false positives", () => {
    expect(allDirtyMatchCommonRegen(" M pnpm-lock.yaml\n?? out.log\n")).toBe(true);
    expect(allDirtyMatchCommonRegen(" M pnpm-lock.yaml\n M src/real.ts\n")).toBe(false);
    expect(allDirtyMatchCommonRegen("")).toBe(false);
  });
  it("env can replace or extend the defaults", () => {
    expect(resolveIgnoredPaths({})).toContain("pnpm-lock.yaml");
    expect(resolveIgnoredPaths({ OVERNIGHT_IGNORED_DIRTY_PATHS: "a/,b.txt" })).toEqual([
      "a/",
      "b.txt",
    ]);
    expect(
      resolveIgnoredPaths({ OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA: "*.snap" }).slice(-1),
    ).toEqual(["*.snap"]);
  });
});
