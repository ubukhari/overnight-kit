import { describe, expect, it } from "vitest";
import { classifyResult, extractLogSummary, recommendResumeOption, stripAnsi } from "./detect.js";

const NORMAL = `Reading file foo.bar
Editing the function bar() to handle the new case.
Running tests, all passing.
Committing the change.
Done.
`;

describe("classifyResult", () => {
  const base = {
    exitCode: 0,
    log: NORMAL,
    headBefore: "aaaa111",
    headAfter: "bbbb222",
    deltaDirty: false,
  };
  it("non-zero exit is a failure before anything else", () => {
    expect(classifyResult({ ...base, exitCode: 1 })).toMatchObject({
      outcome: "failure",
      reason: "claude -p exited with code 1",
    });
  });
  it("missing / tiny logs fail", () => {
    expect(classifyResult({ ...base, log: null }).outcome).toBe("failure");
    expect(classifyResult({ ...base, log: "" }).reason).toMatch(/near-empty \(0 bytes\)/);
    expect(classifyResult({ ...base, log: "short" }).outcome).toBe("failure");
  });
  it("stream-error patterns halt even when HEAD advanced and the tree is clean", () => {
    const r = classifyResult({
      ...base,
      log: `${NORMAL}\nstream interrupted while reading response\n`,
    });
    expect(r.outcome).toBe("failure");
    expect(r.pattern).toBe("stream interrupted");
    expect(r.reason).toMatch(
      /^stream-error pattern 'stream interrupted' matched: 7:stream interrupted/,
    );
  });
  it("Error: only matches at line start, case-insensitively for the rest", () => {
    expect(classifyResult({ ...base, log: `${NORMAL}\nError: boom\n` }).outcome).toBe("failure");
    expect(
      classifyResult({
        ...base,
        log: `${NORMAL}\nthis mentions an error: not a marker line at all here\n`,
      }).outcome,
    ).toBe("commit");
    expect(
      classifyResult({ ...base, log: `${NORMAL}\nHit the RATE LIMIT for the org\n` }).pattern,
    ).toBe("rate limit");
  });
  it("ANSI escapes are stripped before matching", () => {
    expect(
      classifyResult({ ...base, log: `${NORMAL}\n\x1B[31mAPI error\x1B[0m: 500\n` }).outcome,
    ).toBe("failure");
  });
  it("dirty delta after the prompt is a failure even with a commit", () => {
    expect(classifyResult({ ...base, deltaDirty: true })).toMatchObject({
      outcome: "failure",
      reason: "Claude staged or modified files but did not commit them",
    });
  });
  it("same HEAD + clean tree = noop; advanced HEAD = commit", () => {
    expect(classifyResult({ ...base, headAfter: "aaaa111" }).outcome).toBe("noop");
    expect(classifyResult(base)).toMatchObject({
      outcome: "commit",
      reason: "HEAD advanced aaaa111 -> bbbb222",
    });
  });
});

describe("helpers", () => {
  it("stripAnsi removes CSI and OSC sequences", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[0m \x1B]0;title\x07x")).toBe("bold x");
  });
  it("extractLogSummary takes the last long line, capped at 200", () => {
    expect(extractLogSummary(`x\n${"a".repeat(30)}\nshort\n`)).toBe("a".repeat(30));
    expect(extractLogSummary("b".repeat(300))).toHaveLength(200);
    expect(extractLogSummary(null)).toBe("");
  });
  it("recommendResumeOption is conservative", () => {
    expect(recommendResumeOption("All tests passed: 24 of 24 green.")).toBe("A");
    expect(recommendResumeOption("Tests passed: 42 passed, 0 failed.")).toBe("A");
    expect(recommendResumeOption("3 tests failed\nbut tests passed earlier")).toBe("B");
    expect(recommendResumeOption("nothing conclusive")).toBe("B");
    expect(recommendResumeOption(null)).toBe("B");
  });
});
