# overnight-kit

Run a sequence of Claude Code prompts against your repo while you sleep. One commit per prompt, push, wait for CI (Vercel and/or GitHub Checks), let Claude fix a red build, open a PR — and only auto-merge if you say so. Halts are resumable with the same command.

```sh
npx overnight-kit init --plan "Add a /pricing page with the three tiers from config, a checkout button per tier, Playwright tests, and a README section."
npx overnight-kit run overnight.prompts.json --dry-run   # see exactly what would run; touches nothing
npx overnight-kit run overnight.prompts.json             # go to bed
```

<p align="center"><img src="https://agentwares-digest.vercel.app/sample.svg" alt="The morning digest email: what merged overnight, CI status, cost, failed runs, decisions needed" width="640"></p>

_The morning after, this is what lands in your inbox if you connect the [morning digest](#the-morning-digest-optional-15mo): merged commits, CI results, spend, failed runs and the questions your agents could not answer. The kit itself is free and works without it._

## What it does

Given a `prompts.json` (an ordered list of prompts, a branch, a base branch, a PR title), `overnight run`:

1. Checks out or creates `branch_name` from `base_branch` (adopts an existing branch when the ancestry checks pass; halts on a diverged branch, never force-pushes) and takes a PID lock per branch.
2. Runs each prompt with **your own** `claude` binary:
   `claude -p [--model <model>] --permission-mode bypassPermissions --dangerously-skip-permissions "<prompt + acceptance criteria>"`, capturing output to `~/.overnight/logs/run-<ts>/prompt-<id>.log`.
3. Classifies the outcome — `commit` (HEAD advanced, tree clean), `noop` (nothing to do), or `failure` (non-zero exit, empty log, a stream-error pattern such as `stream interrupted` / `rate limit` / `context length exceeded`, or files left uncommitted). A commit never redeems a stream error: the response was incomplete.
4. After every commit (when `wait_for_ci` is on): pushes, then polls `vercel ls` for a new deployment of the branch and `gh api …/check-runs` + the combined commit status for the sha. Red build → up to `ci.fix_max_attempts` fix prompts (Claude gets the failing logs; a fix commit re-enters the gate; a non-code cause becomes a written diagnosis and a halt). Timeouts warn and continue by default (`ci.strict_timeout` halts).
5. Writes state after every prompt (`~/.overnight/state/<branch>.json`), plus `recovery/<branch>/last-success.md` / `last-failure.md` and a recovery diff when work was left uncommitted. Every classification goes to `decisions.log`; every webhook attempt to `notifications.log`; every event to `events.jsonl`.
6. After the last prompt: push, `gh pr create`, and — only with `merge_strategy` or `--merge` — `gh pr merge --auto --squash|--merge|--rebase`. Sends a 🚨 notification with the PR link.

Everything is observable from your phone: Discord and/or Slack webhooks get a message per prompt (✅ committed with the commit subject, shortstat and Claude's last line; ℹ️ no-op; ⏭ skipped on resume; 🛑 halt with the reason, the last success, the response tail and the paths to the diagnostics).

## Requirements

- Node 22+, `git`, `gh` (authenticated) for PRs and GitHub Checks, `vercel` (logged in, project linked) for the Vercel gate.
- `claude` on your PATH — Claude Code with your own subscription or API key. **The kit ships no keys and calls no API of its own.** overnight-kit is an independent open-source project and is not affiliated with or endorsed by Anthropic.
- macOS, Linux or WSL. (Unlike the bash original it does not wrap itself in `caffeinate`; run `caffeinate -i npx overnight-kit run …` on a laptop.)

## prompts.json

```json
{
  "project_path": "/abs/path/to/repo",
  "branch_name": "overnight/pricing-page",
  "base_branch": "main",
  "pr_title": "Pricing page",
  "pr_body": "Implemented overnight in 4 prompts.",
  "merge_strategy": "none",
  "default_model": "claude-opus-4-8[1m]",
  "wait_for_ci": true,
  "ci": {
    "vercel": true,
    "github_checks": true,
    "timeout_seconds": 900,
    "poll_seconds": 10,
    "skip_grace_seconds": 120,
    "fix_max_attempts": 3,
    "strict_timeout": false
  },
  "digest": { "url": "https://agentwares-digest.vercel.app/api/ingest" },
  "prompts": [
    {
      "id": "01-config",
      "label": "Tier config",
      "prompt": "…Commit when done.",
      "acceptance": ["`pnpm test` passes"]
    },
    {
      "id": "02-page",
      "label": "Pricing page",
      "prompt": "…",
      "depends_on": ["01-config"],
      "model": "claude-sonnet-5"
    }
  ]
}
```

- `id` is filename-safe and keys the resume state — do not rename completed ids. Duplicate ids are rejected before anything runs.
- `acceptance` is appended to the prompt text as a checklist; `depends_on` is informational (array order is what runs) and is validated by the prompt-maker.
- `default_model` / per-prompt `model` are passed to `claude --model`; omit both to use whatever your Claude Code defaults to.
- Secrets do not belong in the file: use `OVERNIGHT_DISCORD_WEBHOOK_URL`, `OVERNIGHT_SLACK_WEBHOOK_URL`, `OVERNIGHT_DIGEST_TOKEN` (the file's `discord_webhook_url` / `slack_webhook_url` / `digest.token` still work for private setups).
- claude-runner field names (`wait_for_vercel`, `vercel_fix_max_attempts`, `vercel_fix_model`, `vercel_skip_grace_seconds`) are accepted and mapped.

## Prompt-maker (`init` / `plan`)

`overnight init --plan "<one paragraph>"` scans the repo (framework, package manager, `test`/`lint`/`typecheck`/`build` scripts, CI, `CLAUDE.md`/`AGENTS.md`) and writes `overnight.prompts.json`:

- with `claude` on PATH it asks **your** Claude Code for 3–12 ordered, dependency-aware tasks with acceptance criteria (validated, topologically sorted, verification commands appended);
- without it (or with `--no-llm`) a deterministic planner makes one task per sentence with sequential dependencies and the same repo-derived acceptance criteria.

It also installs the `/overnight` Claude Code skill at `.claude/skills/overnight/SKILL.md` (`--no-skill` to skip; `overnight skill install` to add it to any repo). `overnight plan --plan "…"` prints the file to stdout instead of writing it.

## Flags

| Flag                                                                               | Effect                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`                                                                        | Walk the whole sequence: print each `claude -p` invocation, CI/merge settings, tree status. Executes nothing, writes no state. |
| _(none)_                                                                           | Fresh run, or implicit resume when a matching state file exists.                                                               |
| `--resume`                                                                         | Explicit resume. Skips completed prompts whose sha is reachable from HEAD, retries failed, runs pending/appended.              |
| `--fresh`                                                                          | Delete the state file and run from prompt 0 (keeps the branch).                                                                |
| `--continue`                                                                       | Run the prompts on the currently checked-out branch; no branch creation, no state, no PR.                                      |
| `--force-continue`                                                                 | Resume even when a completed prompt was edited (prefix-hash mismatch).                                                         |
| `--skip-current`                                                                   | Mark the failed prompt completed (with its recorded sha) and resume.                                                           |
| `--auto-stash` / `--auto-recover`                                                  | Dirty pre-flight tree: stash it (left for review) / commit it as leftover from the previous prompt.                            |
| `--strict-preflight`                                                               | Any dirty file halts, even ignored ones (lockfiles, `dist/`, `*.log`, …).                                                      |
| `--merge=<s>`                                                                      | Override `merge_strategy` for this run.                                                                                        |
| `--no-wait-for-ci` / `--no-ci-fix` / `--ci-fix-attempts=N` / `--strict-ci-timeout` | CI gate overrides (`--no-wait-for-vercel` etc. still accepted).                                                                |

Environment: `OVERNIGHT_HOME` (default `~/.overnight`; `CLAUDE_RUNNER_HOME` honoured), `OVERNIGHT_DEFAULT_MODEL`, `OVERNIGHT_IGNORED_DIRTY_PATHS` (replace) / `OVERNIGHT_IGNORED_DIRTY_PATHS_EXTRA` (append), `OVERNIGHT_DISABLE_NOTIFY=1`.

## Resume rules

The state file stores the sha256 of the whole prompts array and of the **completed prefix**. On re-run: same JSON → resume; prompts appended at the tail → resume, the new ones run as pending; a completed prompt edited or reordered → halt (pass `--fresh` or `--force-continue`); a JSON with no id overlap → old state archived to `<branch>.json.replaced-<ts>` and everything runs. After a halt, `last-failure.md` opens with a resume strategy: plain `--resume` when HEAD did not advance; otherwise Option A (mark done, `--skip-current`), B (`git reset --hard <before>` then `--resume`, recommended unless the log shows tests/lint/build passing) or C (force-skip).

## The morning digest (optional, $15/mo)

`events.jsonl` is the kit's structured log. Point `digest.url` at https://agentwares-digest.vercel.app/api/ingest with your ingest token in `OVERNIGHT_DIGEST_TOKEN` and each batch pushes its events when it finishes or halts (`overnight digest push <events.jsonl>` does it by hand). The digest also accepts session exports from Claude Code / Routines, Codex, Devin and Cursor background agents and emails one 7am summary across all of them. Summarisation runs on **your** Anthropic key (encrypted at rest); the fee covers hosting, history and the email.

## Development

```sh
pnpm --filter overnight-kit test      # 62 offline tests: stub claude/gh/vercel in temp git repos
pnpm --filter overnight-kit build     # dist/cli.js (bin) + dist/index.js (library)
```

MIT. Part of [agentwares](https://github.com/agentwares/overnight-kit); the paid products are [agentcheck](https://agentwares-agentcheck.vercel.app) (monitoring for the agents you ship) and [agentguard](https://agentwares.vercel.app) (spend caps and kill switch for the agents you run).
