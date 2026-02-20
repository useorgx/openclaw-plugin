# Plugin Config Read/Write Discovery (MCP Plugin Integration)

Date: 2026-02-20  
Initiative: Configurable Agent Behavior System  
Workstream: MCP Plugin Integration

## Scope

Map how this plugin currently reads and writes runtime configuration relevant to configurable agent behavior, and identify minimal integration gaps for a settings surface.

## Verified Read Paths

1. Primary runtime resolution is centralized in `src/config/resolution.ts`.
2. API key precedence currently resolves as:
   1. `plugins.entries.orgx.config.apiKey` (plugin config)
   2. `ORGX_API_KEY` environment
   3. persisted auth store (`persistedApiKey`)
   4. `~/.openclaw/openclaw.json` (`plugins.entries.orgx.config.apiKey`)
   5. legacy local dev `.env.local` fallback
3. User ID and base URL are also resolved from plugin config + env + persisted/openclaw file values in the same module.
4. Runtime refresh is handled by `refreshResolvedConfig` in `src/config/refresh.ts`, which re-resolves config and mutates in-memory runtime fields (`apiKey`, `userId`, `baseUrl`, `docsUrl`, `apiKeySource`).

## Verified Write Paths

1. `refreshResolvedConfig` writes updated effective credentials to runtime via `setCredentials(...)`, and updates onboarding state (`hasApiKey`, `keySource`, `docsUrl`, `installationId`).
2. Skill-pack behavior state is persisted locally via `src/skill-pack-state.ts`:
   1. File: `orgx-skill-pack-state.json` under OpenClaw dir
   2. Atomic writes through `writeFileAtomicSync`
   3. Policy mutation surface via `updateSkillPackPolicy(...)`
   4. Remote reconciliation via `refreshSkillPackState(...)`
3. This establishes an existing durable local write channel for behavior-policy-like settings (freeze/pin/etag/overrides), separate from auth config resolution.

## Integration Observations

1. Config resolution and skill-pack policy persistence are already separated into clean modules.
2. There is no single plugin-facing settings contract that unifies:
   1. resolved runtime config (read-only effective values)
   2. mutable local behavior policy (writeable values)
3. Existing persistence primitives are sufficient for a first implementation without adding new infrastructure.

## Minimal Next Slice (Implementation-Ready)

1. Add a typed settings DTO in plugin HTTP/MCP surface:
   1. `effective` (resolved, source-annotated, read-only)
   2. `behaviorPolicy` (frozen, pinnedChecksum, lastCheckedAt, lastError)
2. Add a narrow write endpoint/tool for behavior policy only:
   1. allow `frozen`, `pinnedChecksum`, `pinToCurrent`, `clearPin`
   2. apply through `updateSkillPackPolicy(...)`
   3. return updated state from `readSkillPackState(...)`
3. Defer auth/baseUrl mutation through this surface for now to avoid precedence conflicts with OpenClaw/plugin/env inputs.

## Verification Notes

Verified by direct code inspection of:

1. `src/config/resolution.ts`
2. `src/config/refresh.ts`
3. `src/skill-pack-state.ts`

No runtime behavior was changed in this slice; this is a discovery artifact only.
