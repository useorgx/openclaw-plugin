# OrgX Agents in OpenClaw: Agent Suite + Skill Parity Plan

Updated: 2026-02-13

This document defines the target architecture for making OrgX agents feel "fully instantiated" inside OpenClaw immediately after connection:
- agents exist as real OpenClaw agent profiles (stable `agentId`s + workspaces)
- agents ship with OrgX-owned skills + behavior contracts
- kickoffs are rich and deterministic from the first message
- OrgX can ship updates without clobbering local user edits

Scope spans:
- `Code/orgx/orgx` (OrgX cloud control plane + APIs)
- `Code/orgx-openclaw-plugin` (OpenClaw plugin installer + launch/kickoff compositor)

---

## Problem Statement

Today the plugin can launch an OpenClaw agent turn by calling the OpenClaw CLI with a message that includes:
- `Execution policy: <domain>`
- `Required skills: $orgx-...-agent`

But there is no guaranteed, first-class provisioning for:
- domain-specific OrgX agents as OpenClaw agent profiles/workspaces
- skills parity (cloud skill definitions vs local OpenClaw skills/workspace guidance)
- comprehensive per-agent settings (tool scope, models, budgets, reporting policy)
- safe updates that preserve local modifications
- structured kickoff context (acceptance criteria, constraints, prior decisions, artifacts)

Result: agents arrive “empty-handed” and drift; local installs vary; kickoffs lack the deterministic context needed for reliable execution.

---

## OpenClaw Integration Reality Check (Current Local Substrate)

On a typical OpenClaw install, “agent instantiation” materially means:
- an entry under `~/.openclaw/openclaw.json` `agents.list` with `id`, `name`, and `workspace`
- a workspace directory on disk (ex: `~/clawd/workspaces/orgx/...`) containing instruction files
- per-agent runtime state under `~/.openclaw/agents/<agentId>/...` (sessions, auth-profiles, models)

The architecture below intentionally targets those primitives (so we do not depend on speculative OpenClaw internals).

---

## Goals (What “10x Better” Means)

1. **Instant readiness on connect**
   - Within 1 click (or automatically after pairing), OpenClaw has a complete OrgX agent suite installed.
   - Agents have stable IDs, clear identity, tool scope, and behavior rules.

2. **Skill parity**
   - There is a single source of truth for skill behavior.
   - OpenClaw-local skill files are generated/adapted from the same canonical definitions used in cloud skills.

3. **Rich kickoffs**
   - The first message of a launch includes the complete, structured context (goal, DoD, AC, constraints, inputs, references).
   - The launch message is deterministic and versioned (so “why did the agent do X?” is answerable).

4. **Safe updates + local overrides**
   - OrgX can ship agent/skill updates to users.
   - Users can still customize locally without fear of being overwritten.
   - Updates are idempotent and diffable.

5. **Observability**
   - Every agent launch records provenance: pack version, skill version, kickoff context hash, model tier, tool scope.

---

## Non-Goals

- Replacing OpenClaw’s native configuration system.
- Inventing a bespoke “agent runtime”; OpenClaw remains the runtime, OrgX is the control plane.
- Storing secrets in OrgX-managed files (keys remain local or in OpenClaw auth stores).

---

## What Must Be Defined For Every OrgX Agent (OpenClaw Needs This)

Define a strict, versioned agent profile contract. At minimum:

1. **Identity**
   - `agent_id` (stable, lowercase, no spaces; ex: `orgx-engineering`)
   - `display_name` (ex: `OrgX Engineering`)
   - `domain` (engineering/product/design/marketing/sales/operations/orchestration)
   - “voice”/tone constraints (professional + playful; OrgX spirits/light entities)

2. **Workspace**
   - `workspace_path` (OpenClaw workspace root for this agent)
   - required workspace files (owned by OrgX pack):
     - `AGENTS.md` (guardrails)
     - `TOOLS.md` (allowed tool surface + tool usage rules)
     - `IDENTITY.md` / `SOUL.md` / `USER.md` / `HEARTBEAT.md` (behavior + cadence)

3. **Skills**
   - required skills list (canonical skill IDs, ex: `orgx-engineering-agent`)
   - skill pack version pins and update policy

4. **Execution policy**
   - tool scope policy: allowlist per domain (default deny)
   - reporting contract (two-tool contract: append-only activity + transactional changesets)
   - decision escalation rules (when to block vs continue)

5. **Models + budgets**
   - model tier routing (opus/sonnet/local) driven by OrgX spawn guard
   - per-domain model preferences (hints), without overwriting user global defaults
   - budget constraints (token/time) enforced by OrgX guardrails and plugin launch plumbing

6. **Update & provenance**
   - pack ID + version
   - kickoff context hash
   - skill versions applied
   - compatibility gates (minimum plugin/openclaw versions)

---

## Canonical Skill Source Of Truth (Cloud + OpenClaw)

### Principle
There must be **one canonical skill definition** with thin adapters for runtime-specific details.

### Proposed skill data model (OrgX-owned)
Canonical skill definition includes:
- `id` (stable): `orgx-engineering-agent`
- `domain`
- `version`
- `description`
- `prompt_template` (the real behavior contract)
- `constraints` (anti-patterns, safety, verification discipline)
- `tool_policy` (optional: allow/deny tools per skill)

Adapters:
- **Cloud adapter**: renders `prompt_template` into OrgX “cloud skill” format.
- **OpenClaw adapter**: renders a `SKILL.md` file with:
  - the same behavior contract text
  - a small OpenClaw-local preamble: local paths, local MCP server naming, and “no secret printing” rules

Net: behavior stays the same, only the runtime hints differ.

### Practical implementation approach
- In `Code/orgx/orgx`: store canonical skill definitions and expose them as a signed “skill pack”.
- In `Code/orgx-openclaw-plugin`: fetch the skill pack on connect/update and write OpenClaw `SKILL.md` outputs into the agent workspaces (or a shared OrgX workspace skill dir, depending on OpenClaw loader rules).

---

## Agent Pack (OrgX -> Plugin) Contract

### AgentPack (versioned artifact)
OrgX serves a pack describing the desired OpenClaw agent suite:
- `pack_id`: `orgx-agent-suite`
- `version`: semver or monotonic build ID
- `agents[]`: profiles (identity/workspace/files/skills/policy)
- `skills[]`: canonical skill payloads or references
- `compat`: minimum plugin/openclaw versions
- `etag`/hash + optional signature

### Install semantics
Plugin installs/updates:
- `~/.openclaw/openclaw.json` `agents.list` entries (id/name/workspace)
- workspace file scaffolds per agent
- skill outputs (generated from canonical skills)

All operations must be:
- idempotent
- side-effect minimal (never delete user files)
- safe under partial failure (atomic writes; backups)

---

## Safe Local Overrides (Users Can Edit Without Losing Updates)

Use a simple overlay model that avoids merge complexity:

Per agent workspace:
- `.orgx/managed/<filename>`: upstream (OrgX-managed) content for version V
- `.orgx/local/<filename>`: user-owned overrides (never overwritten)
- `<filename>`: generated composite that OpenClaw reads

Composite rule:
- write upstream content (managed) with a header containing pack version + sha
- append local override block verbatim if present

This supports:
- “update pack” without destroying local edits
- clear diffs (managed vs local)
- “reset to upstream” by deleting `.orgx/local/*`

### Example generated file shape (composite)
The plugin should generate the real OpenClaw-consumed file with a stable delimiter:

```text
# === ORGX MANAGED (pack: orgx-agent-suite@1.2.3, sha: abc123...) ===
... upstream content ...

# === ORGX LOCAL OVERRIDES (do not delete unless you mean it) ===
... user content (optional) ...
```

---

## Rich Kickoff Context (Make Launches Complete)

OrgX should provide a structured kickoff payload, not just “domain + skills”:

`KickoffContext` must include:
- initiative/workstream/task: title, summary, acceptance criteria, constraints, due dates
- relevant artifacts + prior decisions (IDs + short summaries)
- explicit reporting expectations (what constitutes progress updates, what artifacts to attach)
- suggested domain + required skills + tool scope hints
- a deterministic `context_hash`

Plugin responsibilities:
- fetch `KickoffContext` at launch time
- render a deterministic kickoff message with a fixed section layout
- record provenance with the launch (context hash, pack version, skill versions, model tier)

---

## Work Breakdown (Phased)

### Phase 0: Spec + Contracts
- Define AgentPack schema + compatibility/versioning rules.
- Define SkillPack canonical schema + adapters.
- Define KickoffContext schema and message renderer template.

#### SkillPack Manifest (OpenClaw v1)
Server endpoint: `GET/POST /api/client/skill-pack?name=orgx-agent-suite` (ETag: checksum).

`skill_packs.manifest` must include an OpenClaw-specific override map:

```json
{
  "schema_version": "2026-02-13",
  "openclaw_skills": {
    "engineering": "# OrgX Engineering — Skill\n...\n",
    "product": "# OrgX Product — Skill\n...\n",
    "design": "# OrgX Design — Skill\n...\n",
    "marketing": "# OrgX Marketing — Skill\n...\n",
    "sales": "# OrgX Sales — Skill\n...\n",
    "operations": "# OrgX Operations — Skill\n...\n",
    "orchestration": "# OrgX Orchestrator — Skill\n...\n"
  }
}
```

Plugin behavior:
- If an `openclaw_skills[domain]` override is present, it becomes the managed `SKILL.md` content for that agent workspace.
- Otherwise, the plugin generates a baseline `SKILL.md` per domain and still records SkillPack provenance (when available).

### Phase 1: Cloud APIs (Code/orgx/orgx)
- `POST /api/client/kickoff-context` (api-key auth, deterministic `context_hash`)
- `GET/POST /api/client/skill-pack` (api-key auth, ETag/304 via checksum)
- Add tests, ETag support, and rollout flags.

### Phase 2: Plugin Installer (This repo)
- Install/update agent suite on pairing (and a manual “Update agents” action).
- Implement managed/local overlay writing.
- Surface update status + diffs in dashboard.

### Phase 3: Dispatch Upgrade (This repo)
- Upgrade `/orgx/api/agents/launch` to consume KickoffContext.
- Ensure launch always includes skill contract + reporting contract + context.
- Emit provenance in activity metadata.

---

## Verification (Exit Criteria)

Must be demonstrably true in a clean OpenClaw profile:
- Agent suite installed: OpenClaw shows domain agents with correct workspace paths.
- Each agent workspace contains the expected files and the OrgX managed header.
- User local edits persist after an agent pack update.
- Launch kickoff message includes full structured context and references.
- Provenance visible in OrgX activity stream (pack version, context hash, model tier).

---

## Open Questions

- Should we create **one agent per domain** (`orgx-engineering`, `orgx-product`, etc.) or a single `orgx` agent that dynamically adapts? (Plan assumes one per domain for isolation + tool scoping.)
- What is the supported OpenClaw mechanism for per-agent skill attachment? If none, skills must live at workspace/global scope and be enforced via kickoff contract + tool scoping.
- Do we need cryptographic signatures for packs, or is HTTPS + ETag sufficient initially?
