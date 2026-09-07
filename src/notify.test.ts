import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotifier, prefixFor, truncateContent } from "./notify.js";

let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "overnight-notify-"))));
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("notifier", () => {
  it("posts Discord {content} and Slack {text} with the priority prefix and logs each attempt", async () => {
    const calls: { url: string; body: string }[] = [];
    const n = createNotifier({
      discordUrl: "https://discord.test/hook",
      slackUrl: "https://slack.test/hook",
      logFile: join(dir, "notifications.log"),
      fetch: async (url, init) => {
        calls.push({ url, body: String(init?.body) });
        return new Response(null, { status: 204 });
      },
    });
    await n.send("hello", "min", "noop", "01");
    expect(JSON.parse(calls[0]!.body)).toEqual({ content: "🔇 hello" });
    expect(JSON.parse(calls[1]!.body)).toEqual({ text: "🔇 hello" });
    const log = await readFile(join(dir, "notifications.log"), "utf8");
    expect(log).toMatch(/prompt-id=01 outcome=noop rc=0 http=204/);
    expect(log.split("\n").filter(Boolean)).toHaveLength(2);
  });
  it("never throws; a 404 is logged, reported once, and not retried", async () => {
    let attempts = 0;
    let warned = 0;
    const n = createNotifier({
      discordUrl: "https://discord.test/hook",
      logFile: join(dir, "n.log"),
      fetch: async () => {
        attempts++;
        return new Response("nope", { status: 404 });
      },
      onFirstFailure: () => warned++,
    });
    await n.send("a", "halt", "halt");
    await n.send("b");
    expect(attempts).toBe(2);
    expect(warned).toBe(1);
    expect(await readFile(join(dir, "n.log"), "utf8")).toMatch(/rc=1 http=404 stderr=HTTP 404/);
  });
  it("retries network errors twice", async () => {
    let attempts = 0;
    const n = createNotifier({
      discordUrl: "https://d/h",
      fetch: async () => {
        attempts++;
        throw new Error("ECONNRESET");
      },
    });
    await n.send("x");
    expect(attempts).toBe(3);
  }, 15_000);
  it("disabled or unconfigured notifiers only log", async () => {
    const n = createNotifier({
      discordUrl: "https://d/h",
      disabled: true,
      logFile: join(dir, "d.log"),
      fetch: async () => {
        throw new Error("must not be called");
      },
    });
    await n.send("x");
    expect(await readFile(join(dir, "d.log"), "utf8")).toMatch(/notify disabled/);
    expect(createNotifier({}).configured).toBe(false);
  });
  it("caps content at 2000 chars", () => {
    expect(truncateContent("x".repeat(2500))).toHaveLength(2000);
    expect(truncateContent("x".repeat(2500)).endsWith("...")).toBe(true);
    expect(prefixFor("high")).toBe("🚨 ");
    expect(prefixFor("halt")).toBe("");
  });
});
