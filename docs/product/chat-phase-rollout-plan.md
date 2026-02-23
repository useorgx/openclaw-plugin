# Chat Phase Rollout Plan

Last updated: 2026-02-23
Scope: seamless chat UX and launch orchestration in `orgx-openclaw-plugin`

## Delivery Principles

- Roll out in additive, non-breaking slices.
- Keep `Send` and `Launch` semantics separate.
- Validate desktop and 375 mobile in every phase.
- Do not advance phase without gate evidence.

## Phase 0: Schema + Contract Readiness

Goals:
- Lock schema mapping with migrations-first truth.
- Define additive `/orgx/api/chat/*` contracts.
- Define additive live snapshot extensions.

Required references:
- `docs/ux/chat-architecture-principles.md`
- `../orgx/orgx/docs/product/chat-orgx-schema-mapping.md`
- `docs/ux/chat-reference-index.md`

Exit criteria:
- Contract spec approved by engineering + product.
- Compatibility notes documented for stale generated DB types.
- No breaking changes to current consumers.

## Phase 1: Composer + Activity Thread Cards

Goals:
- Ship single expandable composer.
- Surface thread cards in Activity feed.

Required references:
- `docs/ux/chat-composer-component-spec.md`
- `docs/ux/chat-thread-card-spec.md`
- `docs/ux/chat-motion-interaction-spec.md`
- `docs/ux/chat-copy-tone-guidelines.md`

Exit criteria:
- Optimistic send + reconcile path stable.
- Thread cards filter/search/sort correctly.
- Desktop + 375 QA for phase scope complete.

## Phase 2: Thread Panel + Explicit Launch

Goals:
- Ship thread detail panel.
- Wire explicit launch path to existing run pipeline.

Required references:
- `docs/ux/chat-thread-panel-spec.md`
- `docs/ux/chat-launch-orchestration-spec.md`
- `docs/ux/chat-agent-mentions-spec.md`

Exit criteria:
- Launch timeline visible and accurate.
- Blocked/failure states actionable.
- Existing session controls show no regressions.

## Phase 3: Initiative Linking + Attachments + Mobile Hardening

Goals:
- Enable unscoped-to-scoped promotion flow.
- Ship metadata-first attachments with deterministic states.
- Harden mobile interaction behavior.

Required references:
- `docs/ux/chat-initiative-linking-spec.md`
- `docs/ux/chat-attachments-spec.md`
- `docs/ux/chat-mobile-375-spec.md`

Exit criteria:
- Linking/relinking/promotion paths stable.
- Attachment warning and retry paths stable.
- Mobile 375 scenario pass for core flows.

## Phase 4: Accessibility + QA + Telemetry Completion

Goals:
- Close accessibility contract.
- Complete high-priority QA evidence.
- Activate KPI and alert thresholds.

Required references:
- `docs/ux/chat-accessibility-spec.md`
- `docs/ux/chat-empty-error-loading-spec.md`
- `docs/ux/chat-qa-checklist.md`
- `docs/product/chat-telemetry-kpis.md`

Exit criteria:
- Keyboard and screen reader checks pass.
- QA checklist complete with evidence capture.
- KPI and alert wiring validated in staging.

## Release Readiness Checklist

1. All required docs updated and reviewed.
2. Phase exit criteria satisfied with evidence.
3. No unresolved major regressions in Activity/Sessions.
4. Rollback strategy documented for chat route and UI toggles.
