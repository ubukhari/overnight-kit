import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prompt } from "./config.js";
import {
  Completions,
  classifyStateForResume,
  prefixHash,
  promptsHash,
  readState,
  writeState,
  type RunState,
} from "./state.js";

const P = (id: string, prompt = `do ${id}`): Prompt => ({ id, label: id, prompt });
const prompts = [P("01"), P("02"), P("03")];

function state(over: Partial<RunState> = {}): RunState {
  return {
    branch_name: "b",
    prompts_file: "f",
    prompts_hash: promptsHash(prompts),
    completed_prefix_hash: prefixHash(prompts, 1),
    status: "halted",
    last_completed_id: "02",
    last_completed_index: 1,
    timestamp: "",
    completions: [
      { id: "01", index: 0, status: "completed", sha: "a", kind: "commit" },
      { id: "02", index: 1, status: "completed", sha: "", kind: "noop" },
      { id: "03", index: 2, status: "failed", sha: "", kind: "" },
    ],
    ...over,
  };
}

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "overnight-state-"));
  path = join(dir, "state", "feat", "x.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("hashes", () => {
  it("prefix hash covers the first lci+1 prompts and is key-order independent", () => {
    expect(prefixHash(prompts, -1)).toBe(prefixHash([], -1));
    expect(prefixHash(prompts, 0)).toBe(promptsHash([prompts[0]!]));
    const reordered = [{ label: "01", prompt: "do 01", id: "01" }] as Prompt[];
    expect(prefixHash(reordered, 0)).toBe(prefixHash(prompts, 0));
    expect(prefixHash([P("01", "changed"), prompts[1]!], 1)).not.toBe(prefixHash(prompts, 1));
  });
});

describe("state file", () => {
  it("round-trips atomically into nested branch dirs", async () => {
    await writeState(path, state());
    const back = await readState(path);
    expect(back?.completions).toHaveLength(3);
    expect(await readState(join(dir, "nope.json"))).toBeNull();
  });
});

describe("classifyStateForResume", () => {
  it("A: identical JSON → resume", async () => {
    await writeState(path, state());
    expect(await classifyStateForResume({ state: state(), path, prompts, branch: "b" })).toEqual({
      kind: "resume",
      migrated: false,
    });
  });
  it("B: no id overlap → archive", async () => {
    await writeState(path, state());
    const r = await classifyStateForResume({
      state: state(),
      path,
      prompts: [P("x"), P("y")],
      branch: "b",
      now: new Date(2026, 0, 2, 3, 4, 5),
    });
    expect(r).toMatchObject({ kind: "archived" });
    expect((r as { archive: string }).archive).toMatch(/x\.json\.replaced-20260102-030405$/);
    expect(await readState(path)).toBeNull();
  });
  it("C: prompts appended at the tail → resume", async () => {
    await writeState(path, state());
    expect(
      (
        await classifyStateForResume({
          state: state(),
          path,
          prompts: [...prompts, P("04")],
          branch: "b",
        })
      ).kind,
    ).toBe("resume");
  });
  it("D: completed prompt edited or JSON shortened → mismatch", async () => {
    await writeState(path, state());
    const edited = [P("01", "EDITED"), prompts[1]!, prompts[2]!];
    expect(
      (await classifyStateForResume({ state: state(), path, prompts: edited, branch: "b" })).kind,
    ).toBe("mismatch");
    expect(
      (await classifyStateForResume({ state: state(), path, prompts: [prompts[0]!], branch: "b" }))
        .kind,
    ).toBe("mismatch");
  });
  it("legacy state without a prefix hash is migrated in place", async () => {
    const legacy = state({ completed_prefix_hash: "", prompts_hash: "" });
    await writeState(path, legacy);
    const r = await classifyStateForResume({ state: legacy, path, prompts, branch: "b" });
    expect(r).toEqual({ kind: "resume", migrated: true });
    expect(JSON.parse(await readFile(path, "utf8")).completed_prefix_hash).toBe(
      prefixHash(prompts, 1),
    );
  });
});

describe("Completions", () => {
  it("upsert keeps CI fields across status flips and serialises sorted", () => {
    const c = new Completions();
    c.upsert({ id: "b", index: 1, status: "failed", sha: "", kind: "" });
    c.setCi(1, "failed", 2, ["x"]);
    c.upsert({ id: "a", index: 0, status: "completed", sha: "s", kind: "commit" });
    c.upsert({ id: "b", index: 1, status: "completed", sha: "t", kind: "skip-current" });
    expect(c.toArray()).toEqual([
      { id: "a", index: 0, status: "completed", sha: "s", kind: "commit" },
      {
        id: "b",
        index: 1,
        status: "completed",
        sha: "t",
        kind: "skip-current",
        ci_status: "failed",
        ci_fix_attempts: 2,
        ci_fix_commits: ["x"],
      },
    ]);
    expect(c.lastFailed()).toBeUndefined();
    expect(Completions.fromLegacy(prompts, 1).completedIds()).toEqual(["01", "02"]);
  });
});
