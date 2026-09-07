import { describe, expect, it } from "vitest";
import { ConfigError, normalizeLegacy, parsePromptsJson, renderPromptText } from "./config.js";

const minimal = {
  project_path: "/tmp/x",
  branch_name: "feat/x",
  base_branch: "main",
  pr_title: "t",
  pr_body: "b",
  prompts: [{ id: "01-a", label: "A", prompt: "do a" }],
};

describe("prompts.json parsing", () => {
  it("applies defaults", () => {
    const { config } = parsePromptsJson(JSON.stringify(minimal));
    expect(config.merge_strategy).toBe("none");
    expect(config.wait_for_ci).toBe(true);
    expect(config.ci).toMatchObject({
      vercel: true,
      github_checks: true,
      timeout_seconds: 900,
      fix_max_attempts: 3,
    });
  });
  it("accepts claude-runner legacy field names", () => {
    const legacy = {
      ...minimal,
      wait_for_vercel: false,
      vercel_fix_max_attempts: 1,
      vercel_fix_model: "m",
      vercel_skip_grace_seconds: 5,
      ntfy_topic: "old",
    };
    const { config, warnings } = parsePromptsJson(JSON.stringify(legacy));
    expect(config.wait_for_ci).toBe(false);
    expect(config.ci.fix_max_attempts).toBe(1);
    expect(config.ci.fix_model).toBe("m");
    expect(config.ci.skip_grace_seconds).toBe(5);
    expect(warnings[0]).toMatch(/ntfy_topic/);
    expect(normalizeLegacy({ a: 1 }).data).toEqual({ a: 1 });
  });
  it("rejects duplicate ids, bad JSON, missing fields, bad merge strategy", () => {
    expect(() =>
      parsePromptsJson(
        JSON.stringify({ ...minimal, prompts: [minimal.prompts[0], minimal.prompts[0]] }),
      ),
    ).toThrow(/Duplicate prompt id\(s\).*01-a/);
    expect(() => parsePromptsJson("{nope")).toThrow(ConfigError);
    expect(() => parsePromptsJson(JSON.stringify({ ...minimal, pr_title: "" }))).toThrow(
      /pr_title/,
    );
    expect(() => parsePromptsJson(JSON.stringify({ ...minimal, merge_strategy: "yolo" }))).toThrow(
      /merge_strategy/,
    );
    expect(() => parsePromptsJson(JSON.stringify({ ...minimal, prompts: [] }))).toThrow(/prompts/);
    expect(() =>
      parsePromptsJson(
        JSON.stringify({ ...minimal, prompts: [{ id: "bad id", label: "x", prompt: "y" }] }),
      ),
    ).toThrow(/filename-safe/);
  });
  it("renders acceptance criteria into the prompt text", () => {
    expect(renderPromptText({ id: "a", label: "a", prompt: "Do it." })).toBe("Do it.");
    expect(
      renderPromptText({ id: "a", label: "a", prompt: "Do it.\n", acceptance: ["x", "y"] }),
    ).toBe("Do it.\n\nAcceptance criteria:\n- x\n- y");
  });
});
