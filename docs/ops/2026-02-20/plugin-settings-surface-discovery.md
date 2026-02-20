# Plugin Settings Surface Discovery (MCP Plugin Integration)

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)  
Workstream: MCP Plugin Integration (`b0640d83-66b9-4f25-a050-1afd92eddc29`)

## Scope

Map the current settings surface in this plugin (dashboard UI, HTTP API, MCP tools), identify what is truly configurable today, and call out gaps that block a complete "Configurable Agent Behavior System" experience.

## Findings

1. Dashboard settings now expose three tabs: `OrgX`, `Agent behavior`, and `Provider keys` via `SettingsModal`.
   - Evidence: `dashboard/src/components/settings/SettingsModal.tsx`

2. `Agent behavior` currently renders a per-agent configuration view, but most rows are derived labels from agent domain and are not persisted user edits.
   - The panel computes values from helper functions (for example provider, autonomy mode, retry policy) and displays them as read-only rows.
   - Evidence: `dashboard/src/components/settings/AgentBehaviorPanel.tsx`

3. The actionable behavior controls are currently in `AgentSuitePanel` under the `OrgX` tab, not inside `AgentBehaviorPanel`.
   - Present controls: behavior presets (Conservative/Balanced/Autonomous), dry-run test (`Test This Config`), refresh/apply flows.
   - Policy writes are sent to `POST /orgx/api/skill-pack/policy`.
   - Evidence: `dashboard/src/components/settings/AgentSuitePanel.tsx`, `dashboard/src/hooks/useAgentSuite.ts`

4. HTTP settings APIs include BYOK and skill-pack policy read/write:
   - `GET|POST /orgx/api/settings/byok`
   - `GET /orgx/api/settings/byok/health`
   - `GET|POST /orgx/api/skill-pack/policy`
   - `GET /orgx/api/agent-suite/status`, `POST /orgx/api/agent-suite/install`
   - Evidence: `src/http/routes/settings-byok.ts`, `src/http/routes/agent-suite.ts`, `src/http/index.ts`

5. MCP exposes a behavior-config contract (`list_agent_configs`, `get_agent_config`, `update_agent_config`) that maps to the same skill-pack policy state.
   - `update_agent_config` supports policy mutation fields: `frozen`, `pinned_checksum`, `pin_to_current`, `clear_pin`, and template `startup-speed`.
   - Domain-scoped MCP allows `update_agent_config` only for `operations` and `orchestration`; other scopes are read-only for config.
   - Evidence: `src/tools/core-tools.ts`, `src/mcp-http-handler.ts`

## Current Capability Summary

- Configurable today:
  - Skill-pack policy controls (freeze/pin/unpin and preset mapping).
  - Provider keys (BYOK).
  - Agent-suite install/dry-run operations.

- Not yet configurable in this surface:
  - Per-agent persisted behavior edits for values shown in `AgentBehaviorPanel` (autonomy, retry, concurrency, tool allowlist, escalation threshold).
  - Distinct behavior profiles per domain beyond global skill-pack policy.

## Integration Gap (for this workstream)

The UI now signals a rich per-agent behavior model, but persistence and mutation currently exist at the shared skill-pack policy layer. This can create a mismatch between what users think they are editing and what the system actually stores/applies.

## Recommended Next Slice

Implement a narrow read/write contract for one persisted per-agent behavior field (for example `max_concurrent_tasks`) and wire:

1. MCP tool payload (`update_agent_config`) schema extension for that field.
2. HTTP route parity (`/orgx/api/skill-pack/policy` or a new agent-config route).
3. `AgentBehaviorPanel` editable control + optimistic refresh from the persisted source.
4. Targeted tests in `tests/mcp` and `tests/http` for round-trip behavior.
