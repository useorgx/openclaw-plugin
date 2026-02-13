# AGENTS.md — OrgX OpenClaw Plugin

Guidelines for AI agents (Codex, Claude Code, Cursor) working on this repo.

## Project Overview

OpenClaw plugin that bridges OrgX (enterprise agent orchestration) with OpenClaw (AI agent framework). Provides MCP tools, a live dashboard, background sync, and a dispatch job for autonomous agent runs.

- **Package:** `@useorgx/openclaw-plugin` (v0.4.5)
- **Language:** TypeScript (strict mode, ES modules)
- **Runtime:** Node 18+
- **Production deps:** Zero (native `fetch`, no axios/got)
- **Dashboard:** React 18 + Vite + Tailwind v3 + Framer Motion
- **Tests:** Node test runner (`--test`), not Jest

## Repository Structure

```
src/
  index.ts              # Plugin entry (tool registration, bootstrap)
  http-handler.ts       # HTTP API (30+ endpoints, dashboard serving)
  contracts/client.ts   # OrgX API client
  contracts/types.ts    # API contract types
  outbox.ts             # Local event queue for offline resilience
  outbox-replay.ts      # Auto-retry on reconnect
  auth-store.ts         # Persisted credentials
  snapshot-store.ts     # Cached org snapshot
  agent-run-store.ts    # Spawned agent run records
  mcp-http-handler.ts   # Local MCP bridge at /orgx/mcp
  mcp-client-setup.ts   # Auto-config for ~/.claude/mcp.json, ~/.codex/config.toml
  gateway-watchdog.ts   # Local gateway monitor + auto-restart
  byok-store.ts         # Provider key management
dashboard/
  src/components/       # React components (agents, activity, initiatives, decisions)
  src/hooks/            # useLiveData, useConnection, useOnboarding
  src/lib/tokens.ts     # Design tokens (read this before any UI work)
scripts/
  run-codex-dispatch-job.mjs  # Full-auto agent dispatch orchestrator
  capture-qa-evidence.mjs     # Playwright QA automation
tests/                  # Node test suite (hooks, HTTP, MCP, outbox)
docs/                   # ADRs, ops guides, launch checklists
```

## Commands

```bash
npm run typecheck       # TypeScript strict check (must pass before commit)
npm run test:hooks      # Unit + integration tests (must pass before commit)
npm run build           # Build core + dashboard (must succeed before commit)
npm run build:core      # TypeScript -> dist/, copy manifest
npm run build:dashboard # Vite build for React SPA
npm run qa:capture      # Playwright QA evidence screenshots
```

## Key Patterns

### Module System
- ES Modules only (`"type": "module"`). No CommonJS `require()`.
- Exports: root, `/types`, `/api` subpaths.

### Authentication Precedence
plugin config -> `ORGX_API_KEY` env -> persisted auth store -> `.env.local`

### Outbox Reliability
Events (progress, decisions, artifacts) buffered locally during API downtime. Auto-replayed on next successful sync. Merged into dashboard snapshots so users see offline data.

### MCP Tools (14 registered)
Schemas must use `additionalProperties: false`. Return structured JSON, not prose. For MCP Apps: URI scheme `ui://`, MIME `text/html;profile=mcp-app`. Verify tool appears in client after registration.

### Dashboard Serving
SPA served at `/orgx/live` via plugin HTTP handler. SSE streaming for live updates with polling fallback.

---

## Guardrails

Every rule below exists because it was violated in a prior session.

### 1) Read before you write

- Read source files before editing. Read docs/specs before implementing integrations.
- Read `dashboard/src/lib/tokens.ts` before any UI change.
- If a docs URL is given, fetch and read it end-to-end before writing code.

### 2) Use exactly what was specified

- If the user names a specific tool (Nano Banana Pro, Playwright MCP, firecrawl), use that exact tool. Do not substitute.
- If an MCP tool exists for the task, use it — do not reimplement with scripts.

### 3) Don't confuse technologies

- **MCP Apps** != Supabase Apps. Completely unrelated.
- **OpenClaw** = agent framework (gateway). **OrgX** = orchestration platform. **Plugin** = bridge.
- **MCP** = Model Context Protocol. Tools = structured data. Apps = interactive HTML (`text/html;profile=mcp-app`).
- If a term is ambiguous, ask — do not guess.

### 4) Repo + scope hygiene (avoid wrong-repo fixes)

- Always confirm the intended repo and `pwd` before changing code.
  - If the user says “fix it in `Code/orgx`” (or any other repo), stop and switch to that repo before editing.
- Before edits and before committing: run `git status -sb` and make sure you are on the intended branch.
- Default to a feature branch for non-trivial work. Do not work directly on `main` unless explicitly told to.
- If the request spans OrgX platform vs this plugin, split the work and keep changes scoped to the correct repo(s).

### 5) No AI slop in UI

Match the design system from mcp.useorgx.com. Design tokens:

| Token | Value | Usage |
|-------|-------|-------|
| Lime | `#c8e64a` | Primary accent |
| Teal | `#7dd3c0` | Secondary accent |
| Background | `#080808` | Page background |
| Card bg | `#0f0f0f` | Card/panel surfaces |
| Card border | `rgba(255,255,255,0.06)` | Subtle borders |
| Font | Geist | System font stack fallback |

**Never introduce:**
- Colored left borders on cards
- Rainbow gradients or multi-color splashes
- Excessive animation/bounce on every element
- Drop shadows on everything
- Overly rounded corners (max 12px cards, 8px buttons)
- Light mode colors or yellow gradients anywhere

**Do use:**
- `backdrop-blur` with low-opacity backgrounds (glassmorphism)
- Single-accent highlights (lime OR teal, not both on same element)
- `rgba(255,255,255,0.06)` borders — not colored borders
- Framer Motion with restrained timing (200-300ms ease-out)
- Whitespace as a design element

### 6) Verify before claiming done

- Dashboard changes: confirm page loads and components render (not blank).
- New tools: confirm they appear in client tool list and return expected output.
- TypeScript: `npm run typecheck` must pass.
- Tests: `npm run test:hooks` must pass.
- Build: `npm run build` must succeed.
- Test the full user flow, not just that it compiles.
- Never claim "verified" without running a command. If unverified, say so.

### 7) Initiative/blocker verification discipline

When the user asks to “verify blockers/initiatives”, “find one and verify”, or “continue where not verified”:

- Treat OrgX/MCP initiative state as the source of truth for what is “done”.
- Pick exactly one unverified item.
- Write the verification steps (repro + expected behavior).
- Run the verification (tests, Playwright, or a concrete user flow), capture evidence, then mark verified or fix and re-verify.
- Do not batch 10 changes without re-checking; iterate one item at a time.

### 8) Mobile is not optional

- Dashboard has a mobile tabbed nav pattern already built.
- Test at 375px width minimum.
- Touch targets min 44px. Collapsed panels, stacked layouts required.
- Do not ship desktop-only features.

### 9) Do not over-engineer

- Do exactly what was asked. Nothing more.
- Don't add config options, refactor surrounding code, or add docstrings to untouched code.
- Don't add error handling for impossible scenarios.
- If told "it doesn't need it" — remove what you added.

### 10) Preserve context across sessions

- Check `git status -sb` and `git log --oneline -10` before starting work.
- Read files before editing — they may have changed since last session.
- If a session continuation summary is provided, read it and do not redo completed work.
- Outbox, auth, and snapshot stores persist — don't reinitialize them.

### 11) Audit existing infrastructure before proposing new systems

- Before proposing new tables, jobs, or abstractions, check what already exists.
- Code abstraction > new infrastructure. Most "new systems" are solved by routing to existing infrastructure.
- Check `src/index.ts` for registered tools, `src/http-handler.ts` for existing endpoints.

### 12) Deep parsing, not surface-level

- Activity feeds must show real data. Empty feeds when sessions exist = bug.
- Artifacts and decisions must be extracted from conversations, not just inferred.
- Both agent and user messages should be extractable and filterable.
- Session names must be meaningful summaries, not generic IDs.

### 13) Secrets and sensitive data

- Never print or paste API keys, tokens, cookies, or `storageState` contents into logs, PR descriptions, or chat.
- Mask tokens in examples as `oxk_...abcd` (or equivalent).
- Never commit secrets (`.env`, local creds). Prefer `.env.local` and keep it untracked.

---

## Brand Identity

- OrgX agents are **spirits/light entities** — not cartoons, not mascots, not childish.
- Visual metaphors: threads, prisms, workstreams, light, organizational flow.
- Tone: **responsibility + fun** — professional yet approachable, never juvenile.
- OpenClaw's lobster/claw identity is separate. OrgX = "armor on top of the claw" (enhancing, not replacing).
- Color palette from mcp.useorgx.com is the gold standard.

---

## Commit / PR Protocol

1. Run full pipeline before committing: `npm run typecheck && npm run test:hooks && npm run build`
2. Commit in logical chunks. Conventional prefixes encouraged: `feat:`, `fix:`, `chore:`
3. Default to feature branches for non-trivial changes. Do not commit directly to `main` unless told to.
4. PRs: clear title (<70 chars), `## Summary` + `## Test plan` sections.
5. Never commit secrets (`.env`, API keys, tokens). Mask tokens as `oxk_...abcd`.

## Publishing

1. Bump version in `package.json` (semver: patch for fixes, minor for features)
2. Update `CHANGELOG.md`
3. Run full build pipeline
4. `npm publish`
5. Commit version bump
6. Tag: `git tag v{version}`

---

## Codex Dispatch Agent Instructions

When running as a Codex agent via `scripts/run-codex-dispatch-job.mjs`:

- Respect spawn guard results. If blocked, do not proceed.
- Respect resource guard throttling. Back off when CPU/memory is high.
- Report progress via `orgx_report_progress`.
- Use the model tier from spawn guard: Opus for architecture/strategy, Sonnet for implementation.
- State files track task status. Never re-run completed tasks unless `--retry_blocked` is set.
- All work on feature branches. Create PRs with clear titles and test plans.
- Reporting is best-effort — don't abort dispatch on transient API errors.

---

## Playwright MCP

When using Playwright MCP for QA or screenshots:

- Always navigate explicitly with `browser_navigate` before interacting.
- One action per turn — the accessibility tree changes between actions.
- Check for success — verify expected content before proceeding.
- Close tabs when done to prevent memory accumulation.
- Use `--isolated` flag to prevent persistent state pollution.

## Related Repositories

- **OrgX Platform:** `Code/orgx/orgx` (Supabase + Next.js)
- **Global Codex Guardrails:** `~/.codex/AGENTS.md`
- **Agent Skills:** `~/.codex/skills/` (7 domain specialists)
