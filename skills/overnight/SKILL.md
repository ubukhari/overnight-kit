---
name: overnight
description: Plan and launch an overnight batch of Claude Code prompts with overnight-kit — turn a one-paragraph plan into an ordered, dependency-aware prompts.json, dry-run it, then run it with one commit per prompt, CI polling and resume-safe state. Use when the user says "run this overnight", "batch these prompts", "make a prompts.json", or invokes /overnight.
---

# /overnight — batch prompts that run while you sleep

The kit runs `claude -p` (your own login or API key — it never carries keys of its own) once per prompt on a
dedicated branch, commits per prompt, pushes, waits for CI (Vercel and/or GitHub Checks), tries to fix red
builds, opens a PR, and only auto-merges if the file says so. State lives under `~/.overnight`, so a halted
batch resumes with the same command.

## When invoked

1. **Understand the goal.** Ask for the plan as one paragraph if it is not already in the conversation. Note the
   repo's test/lint/build commands (check `package.json`, `CLAUDE.md`, `AGENTS.md`).
2. **Generate the sequence.** Run:
   ```sh
   npx overnight-kit init --plan "<the paragraph>" --out overnight.prompts.json
   ```
   Without `claude` on PATH the kit falls back to a deterministic sentence-per-task planner; with it, the plan
   is produced by your own Claude Code. Either way, review `overnight.prompts.json`:
   - each prompt is self-contained (files to touch, what not to touch), ends with "Commit when done", and lists
     `acceptance` criteria that include the repo's verification commands;
   - `depends_on` only points at earlier ids; ids are stable (they key the resume state);
   - `merge_strategy` stays `"none"` unless the user explicitly wants auto-merge.
     Edit the file directly to tighten prompts — that is the point of reviewing before bed.
3. **Dry-run it** and show the output to the user:
   ```sh
   npx overnight-kit run overnight.prompts.json --dry-run
   ```
   A dry run walks the whole sequence, prints the exact `claude -p` invocation per prompt, the CI/merge
   settings, and whether the working tree would halt a real run. It executes nothing and writes no state.
4. **Run it** only when the user says go:
   ```sh
   npx overnight-kit run overnight.prompts.json
   ```
   Put webhook and digest tokens in env, never in the file: `OVERNIGHT_DISCORD_WEBHOOK_URL`,
   `OVERNIGHT_SLACK_WEBHOOK_URL`, `OVERNIGHT_DIGEST_TOKEN`.
5. **In the morning:** `~/.overnight/recovery/<branch>/last-success.md` or `last-failure.md` says where it got to;
   `~/.overnight/logs/run-<ts>/events.jsonl` is what the morning digest ingests
   (`npx overnight-kit digest push <events.jsonl> --url <ingest url>`). Resume a halt with
   `npx overnight-kit run overnight.prompts.json --resume` (or `--skip-current` after checking the work).

## Rules for prompts you write or edit

- One outcome per prompt; a fresh session with no memory must be able to finish it in under an hour.
- Name the verification commands and require they pass before the commit.
- Never include secrets, webhook URLs or tokens in prompts.json.
- Prefer `depends_on` over prose like "after the previous step".
