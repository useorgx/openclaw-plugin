# Daily Agents Refresh (Codex + Claude)

This repo includes a small daily background job that:

- Reads the day's Codex sessions from `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- Reads the day's Claude sessions from `~/.claude/projects/**.jsonl` (mtime-based)
- Produces a redacted digest at `~/.codex/reports/agents-refresh/YYYY-MM-DD.json`
- Updates the auto-generated daily notes block in:
  - `~/.codex/AGENTS.md`
  - `~/.claude/AGENTS.md` (created if missing)

The intent is to continuously harden agent guardrails based on what actually happened today.

## Run Manually

```bash
npm run agents:refresh
```

Dry-run (no writes):

```bash
node scripts/daily-agents-refresh.mjs --apply=false
```

## Install As Daily launchd Job (macOS)

Install/update the job:

```bash
npm run agents:install
```

The job definition lives at `scripts/launchd/useorgx.agents-refresh.plist` and defaults to:

- Daily at 02:17 local time
- `--scope=code` (only sessions with `cwd` under `~/Code`)
- `--engine=codex` (uses `codex exec` with `read-only` sandbox)

The committed plist is a template. `npm run agents:install` renders it with absolute paths for your machine.

Logs:

- `~/.codex/reports/agents-refresh/launchd.out.log`
- `~/.codex/reports/agents-refresh/launchd.err.log`

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/useorgx.agents-refresh.plist
rm -f ~/Library/LaunchAgents/useorgx.agents-refresh.plist
```

## Safety Notes

- The job redacts common token formats before passing a digest into Codex.
- By default it only considers sessions with `cwd` under `~/Code` to avoid mixing in personal/non-code sessions.
- The job uses an auto-generated block between markers, so it won't clobber your hand-edited rules.
