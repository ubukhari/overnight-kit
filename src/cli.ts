import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConfigError, MERGE_STRATEGIES, loadPromptsFile, type MergeStrategy } from "./config.js";
import { pushEvents } from "./digest-client.js";
import { installSkill, runInit } from "./init.js";
import { readEventsJsonl } from "./logs.js";
import { HaltError, runBatch, type RunMode } from "./runner.js";

const VERSION = "0.1.2";

const HELP = `overnight ${VERSION} — run a sequence of Claude Code prompts while you sleep.

Usage:
  overnight init --plan "<one paragraph>" [--plan-file f] [--branch b] [--out overnight.prompts.json] [--no-llm] [--force]
  overnight run <prompts.json> [--dry-run] [--resume | --continue | --fresh] [--force-continue]
                               [--auto-recover | --auto-stash] [--strict-preflight] [--skip-current]
                               [--merge=<none|auto-squash|auto-merge|auto-rebase>]
                               [--no-wait-for-ci] [--no-ci-fix] [--ci-fix-attempts=N] [--strict-ci-timeout]
  overnight validate <prompts.json>
  overnight plan --plan "<paragraph>" [--no-llm]      # print prompts.json to stdout without writing it
  overnight digest push <events.jsonl> --url <ingest url> [--token <t>]   # or OVERNIGHT_DIGEST_TOKEN
  overnight skill install                             # copy the /overnight skill into .claude/skills

The runner calls the \`claude\` binary on your PATH with your own login/key — it never ships or uses any
key of its own. Logs, state and recovery files live under ~/.overnight (OVERNIGHT_HOME).
Env: OVERNIGHT_DISCORD_WEBHOOK_URL, OVERNIGHT_SLACK_WEBHOOK_URL, OVERNIGHT_DIGEST_TOKEN, OVERNIGHT_DEFAULT_MODEL,
     OVERNIGHT_IGNORED_DIRTY_PATHS(_EXTRA), OVERNIGHT_DISABLE_NOTIFY=1.`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "plan":
      return cmdPlan(rest);
    case "run":
      return cmdRun(rest);
    case "validate":
      return cmdValidate(rest);
    case "digest":
      return cmdDigest(rest);
    case "skill":
      return cmdSkill(rest);
    default:
      // `overnight prompts.json` == `overnight run prompts.json`
      if (cmd.endsWith(".json") || cmd.startsWith("--")) return cmdRun(argv);
      fail(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: "string" },
      "plan-file": { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      out: { type: "string" },
      model: { type: "string" },
      "digest-url": { type: "string" },
      "no-llm": { type: "boolean", default: false },
      "no-skill": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  try {
    await runInit({
      cwd: process.cwd(),
      ...(values.plan ? { plan: values.plan } : {}),
      ...(values["plan-file"] ? { planFile: values["plan-file"] } : {}),
      ...(values.branch ? { branch: values.branch } : {}),
      ...(values.base ? { baseBranch: values.base } : {}),
      ...(values.out ? { out: values.out } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values["digest-url"] ? { digestUrl: values["digest-url"] } : {}),
      ...(values["no-llm"] ? { useLlm: false } : {}),
      installSkill: !values["no-skill"],
      force: Boolean(values.force),
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 1);
  }
}

async function cmdPlan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: "string" },
      "plan-file": { type: "string" },
      branch: { type: "string" },
      base: { type: "string" },
      model: { type: "string" },
      "no-llm": { type: "boolean", default: false },
    },
  });
  const { buildPromptsFile, makePrompts, slugify } = await import("./prompt-maker.js");
  const plan =
    values.plan ?? (values["plan-file"] ? await readFile(values["plan-file"], "utf8") : "");
  if (!plan.trim()) fail('A plan is required: --plan "<paragraph>" or --plan-file f');
  const r = await makePrompts({
    plan,
    root: process.cwd(),
    ...(values["no-llm"] ? { useLlm: false } : {}),
    ...(values.model ? { model: values.model } : {}),
  });
  for (const w of r.warnings) process.stderr.write(`warning: ${w}\n`);
  const file = buildPromptsFile({
    tasks: r.tasks,
    plan,
    projectPath: process.cwd(),
    branch: values.branch ?? `overnight/${slugify(plan, 40)}`,
    baseBranch: values.base ?? "main",
  });
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
}

async function cmdValidate(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) fail("usage: overnight validate <prompts.json>");
  try {
    const loaded = await loadPromptsFile(file);
    for (const w of loaded.warnings) process.stderr.write(`warning: ${w}\n`);
    process.stdout.write(
      `OK: ${loaded.file} parsed cleanly (${loaded.config.prompts.length} prompts).\n`,
    );
  } catch (e) {
    if (e instanceof ConfigError) fail(`${e.message}\nfix: ${e.fix}`, 1);
    throw e;
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      continue: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "force-continue": { type: "boolean", default: false },
      "auto-recover": { type: "boolean", default: false },
      "auto-stash": { type: "boolean", default: false },
      "strict-preflight": { type: "boolean", default: false },
      "skip-current": { type: "boolean", default: false },
      merge: { type: "string" },
      "no-wait-for-ci": { type: "boolean", default: false },
      "no-wait-for-vercel": { type: "boolean", default: false },
      "no-ci-fix": { type: "boolean", default: false },
      "no-vercel-fix": { type: "boolean", default: false },
      "ci-fix-attempts": { type: "string" },
      "vercel-fix-attempts": { type: "string" },
      "strict-ci-timeout": { type: "boolean", default: false },
      "strict-vercel-timeout": { type: "boolean", default: false },
      validate: { type: "boolean", default: false },
      home: { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file) fail(`usage: overnight run <prompts.json> [flags]\n\n${HELP}`);
  if (values.validate) return cmdValidate([file]);
  const modes = [
    values.resume && "resume",
    values.continue && "continue",
    values.fresh && "fresh",
  ].filter(Boolean) as RunMode[];
  if (modes.length > 1) fail("Pass at most one of --resume, --continue, --fresh.");
  const mode: RunMode = modes[0] ?? "auto";
  if (values["force-continue"] && (mode === "continue" || mode === "fresh"))
    fail("--force-continue cannot be combined with --continue or --fresh.");
  if (values["auto-recover"] && values["auto-stash"])
    fail("Pass --auto-recover or --auto-stash, not both.");
  let merge: MergeStrategy | undefined;
  if (values.merge !== undefined) {
    if (!(MERGE_STRATEGIES as readonly string[]).includes(values.merge))
      fail(`Invalid --merge value: '${values.merge}' (allowed: ${MERGE_STRATEGIES.join(", ")}).`);
    merge = values.merge as MergeStrategy;
  }
  const attemptsRaw = values["ci-fix-attempts"] ?? values["vercel-fix-attempts"];
  let ciFixAttempts: number | undefined;
  if (attemptsRaw !== undefined) {
    if (!/^\d+$/.test(attemptsRaw)) fail("--ci-fix-attempts requires a non-negative integer.");
    ciFixAttempts = Number(attemptsRaw);
  }
  if (values["no-ci-fix"] || values["no-vercel-fix"]) ciFixAttempts = 0;
  try {
    const summary = await runBatch({
      promptsPath: file,
      mode,
      forceContinue: Boolean(values["force-continue"]),
      autoRecover: Boolean(values["auto-recover"]),
      autoStash: Boolean(values["auto-stash"]),
      strictPreflight: Boolean(values["strict-preflight"]),
      skipCurrent: Boolean(values["skip-current"]),
      dryRun: Boolean(values["dry-run"]),
      ...(merge ? { merge } : {}),
      ...(values["no-wait-for-ci"] || values["no-wait-for-vercel"] ? { waitForCi: false } : {}),
      ...(ciFixAttempts !== undefined ? { ciFixAttempts } : {}),
      ...(values["strict-ci-timeout"] || values["strict-vercel-timeout"]
        ? { strictCiTimeout: true }
        : {}),
      ...(values.home ? { home: values.home } : {}),
    });
    if (summary.status === "dry_run") return;
  } catch (e) {
    if (e instanceof HaltError) process.exit(1);
    if (e instanceof ConfigError) fail(`${e.message}\nfix: ${e.fix}`, 1);
    throw e;
  }
}

async function cmdDigest(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "push")
    fail("usage: overnight digest push <events.jsonl> --url <ingest url> [--token <token>]");
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { url: { type: "string" }, token: { type: "string" } },
  });
  const file = positionals[0];
  const url = values.url ?? process.env["OVERNIGHT_DIGEST_URL"];
  const token = values.token ?? process.env["OVERNIGHT_DIGEST_TOKEN"];
  if (!file || !url)
    fail("usage: overnight digest push <events.jsonl> --url <ingest url> [--token <token>]");
  if (!token) fail("No token: pass --token or set OVERNIGHT_DIGEST_TOKEN (never commit it).");
  const events = await readEventsJsonl(file);
  const r = await pushEvents({ url, token, events });
  if (!r.ok) fail(`push failed: ${r.error ?? r.status}`, 1);
  process.stdout.write(
    `pushed ${events.length} events (${r.accepted ?? "?"} accepted) to ${url}\n`,
  );
}

async function cmdSkill(args: string[]): Promise<void> {
  if (args[0] !== "install") fail("usage: overnight skill install");
  const dest = await installSkill(process.cwd());
  process.stdout.write(`Installed ${dest}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
