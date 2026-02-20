# Per-Agent Configuration Panels Discovery

Date: 2026-02-20  
Workstream: Platform Settings UI (`efb1da69-081c-4e9d-8f08-99b1ceead047`)  
Scope: Discovery for per-agent panel architecture + pre-save settings preview

## Goal

Define a settings surface where operators can tune one agent at a time, preview expected run behavior before saving, and safely compare draft vs saved configuration.

## Constraints

- Use existing dashboard design language (`dashboard/src/lib/tokens.ts`).
- Keep single-accent emphasis per element (lime or teal, not both).
- Preserve mobile usability at 375px minimum with 44px touch targets.
- Prevent accidental behavior changes by requiring clear draft/save state.

## Operator Jobs To Be Done

- Select an agent quickly and understand current execution policy.
- Change a small subset of controls without losing context.
- Preview how those changes alter a run before saving.
- Revert draft changes if the preview looks wrong.

## Proposed Information Architecture

1. Left rail: agent list with status, role, and "has unsaved changes" indicator.
2. Center panel: per-agent configuration form grouped by:
   - `Execution`: autonomy mode, retry policy, max concurrent tasks.
   - `Guardrails`: allowed tools, escalation thresholds, blocked domains.
   - `Reporting`: progress cadence, artifact verbosity, decision urgency defaults.
3. Right panel: `Run Preview` card showing a synthesized run summary from the current draft.

Mobile behavior:
- Replace 3-column layout with tabbed sections: `Agent`, `Settings`, `Preview`.
- Keep sticky save bar anchored to bottom with `Discard` + `Save`.

## Settings Preview Model (Before Save)

Preview is computed from the in-memory draft, not persisted config.

Required preview blocks:
- `Run Envelope`: initiative/workstream scope, selected agent, expected mode.
- `Execution Trace`: concise sequence of what the run will do first.
- `Risk Flags`: warnings for aggressive or conflicting settings.
- `Expected Outputs`: likely artifacts + progress cadence.

Preview trigger rules:
- Debounce regeneration by 250ms on field edits.
- Manual `Refresh preview` action for expensive preview generation.
- Hard validation errors disable preview and surface field-level remediation.

## Core Interaction States

- `Clean`: draft equals persisted config, preview reflects saved behavior.
- `Dirty`: at least one field changed, save bar visible, preview tagged `Draft`.
- `Invalid`: schema/constraint violation, save disabled, preview shows blockers.
- `Saving`: controls disabled except cancel-safe navigation.
- `Save failed`: retain draft and display error with retry.

## Accessibility And UX Guardrails

- Every control must expose label + hint + validation message linkage.
- Keyboard order: agent list -> settings groups -> preview -> action bar.
- Maintain visible focus ring using existing focus token values.
- Avoid color-only status signaling; pair chips/icons with text.

## Token And Motion Mapping

- Surfaces: `colors.cardBg`, `colors.cardBorder`.
- Accent usage:
  - Dirty state chips/buttons: lime.
  - Informational preview markers: teal.
- Radius:
  - Cards: `radius.xl` (12 max).
  - Controls: `radius.lg` or `radius.controlPill`.
- Motion:
  - State transitions: `motion.durationStandard` (220ms).
  - Preview refresh pulse: `motion.durationFast` (150ms), no bounce.

## Incremental Delivery Plan

1. Build static shell with agent rail, form groups, preview card.
2. Add draft state store and dirty tracking.
3. Add preview synthesizer from draft state.
4. Add validation + blocked save behavior.
5. Add mobile tab layout and sticky action bar.
6. QA pass for keyboard, screen reader labels, and 375px layout.

## Verification Checklist For This Discovery

- Document defines panel IA, states, and preview behavior end-to-end.
- Mobile pattern and touch target minimum are explicit.
- Token constraints are mapped to concrete token names.
- Implementation plan is split into sequenced, shippable increments.

## Handoff Artifact

- Component contract for preview panel: `docs/ux/settings-preview-component-spec.json`
