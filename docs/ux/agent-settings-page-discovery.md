# Agent Settings Page Discovery

Date: 2026-02-20
Initiative: Configurable Agent Behavior System (`d35e5cbc-5ec7-44c9-84ee-ea2fe6344d92`)
Workstream: Platform Settings UI (`efb1da69-081c-4e9d-8f08-99b1ceead047`)
Slice: `9403eebc-9dad-4ad6-84a6-a72c8937c4da`

## Scope

Define the settings-page behavior for per-agent configuration, with explicit dry-run validation via a `Test This Config` action before save.

## Inputs Reviewed

- `dashboard/src/components/settings/SettingsModal.tsx`
- `dashboard/src/components/settings/AgentSuitePanel.tsx`
- `dashboard/src/lib/tokens.ts`
- `docs/ux/per-agent-configuration-panels-discovery.md`
- `docs/ux/settings-preview-component-spec.json`

## Key Decisions

1. Keep settings flow in three states: `Draft`, `Testing`, `Ready to Save`.
2. `Test This Config` performs a non-persistent dry-run against a sample task.
3. Save remains disabled when schema validation fails; testing can run only on valid drafts.
4. Dry-run results persist on screen until the next test starts, so users can compare edits.
5. Mobile (375px) keeps action bar sticky with 44px minimum targets for `Discard`, `Test This Config`, and `Save`.

## `Test This Config` Interaction Contract

- Trigger location: action row in per-agent settings panel.
- Preconditions:
  - Agent selected.
  - Draft exists and passes validation.
  - Sample task is selected (default fallback allowed).
- Response model:
  - `outcome`: `success | warning | blocked`
  - `expectedTrace[]`: ordered list of first actions
  - `riskFlags[]`: human-readable warnings with remediation hints
  - `generatedAt`: timestamp for recency context
- Failure model:
  - Keep previous successful result visible.
  - Show failure banner with retriable action.
  - Preserve draft without mutation.

Detailed component handoff: `docs/ux/test-this-config-component-spec.json`

## Accessibility And Visual Constraints

- Focus order: agent selector -> settings groups -> test action -> result region -> save controls.
- Dry-run summary updates should be announced with `aria-live="polite"`.
- Use existing token system only (`colors`, `radius`, `interaction.minTouchTarget`, `motion.durationStandard`).
- No color-only status indicators; pair state chips with text labels.

## Implementation Sequence

1. Add `Test This Config` action shell with loading/disabled states.
2. Wire dry-run API contract to current draft model.
3. Render result region with outcome, trace, and risk flags.
4. Add mobile sticky action row behavior and keyboard QA checks.
5. Connect save gating to validation and most recent dry-run status.

## Verification Checklist

- Action runs without mutating persisted configuration.
- Result region renders success/warning/blocked states with explicit text labels.
- Touch targets remain >=44px at 375px viewport.
- Keyboard-only flow can trigger test, inspect results, and return to save controls.

## Handoff Artifact

- Component contract for tabbed settings page:
  - `docs/ux/agent-settings-page-component-spec.json`
