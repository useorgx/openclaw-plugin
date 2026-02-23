# Chat UX Reference Index

Last updated: 2026-02-23
Scope: `orgx-openclaw-plugin` seamless chat surface
Owner: Product + Design + Engineering + QA

This is the canonical navigation doc for chat UX execution. Treat it as the control plane for implementation and audit.

## How To Use This Index

1. Start in `Phase 0` and do not enter the next phase until all gate checks are satisfied.
2. For each component you touch, read its dedicated spec and linked dependencies before coding.
3. Validate against `docs/ux/chat-qa-checklist.md` after each merged change.
4. Preserve existing design language from `dashboard/src/lib/tokens.ts` and existing Activity/Sessions rationale docs.

## Source Constraints

- Design tokens and interaction constants: `dashboard/src/lib/tokens.ts`
- Existing Activity rationale: `docs/ux/activity-timeline-redesign.md`
- Existing Sessions/Chats rationale: `docs/ux/agents-chats-panel-redesign.md`
- Existing runtime behavior context: `docs/agentic-ux-reality-appendix.md`

## Component Specs

- Foundation: `docs/ux/chat-architecture-principles.md`
- Composer: `docs/ux/chat-composer-component-spec.md`
- Activity thread card: `docs/ux/chat-thread-card-spec.md`
- Thread detail panel: `docs/ux/chat-thread-panel-spec.md`
- Explicit launch UX: `docs/ux/chat-launch-orchestration-spec.md`
- Initiative linking UX: `docs/ux/chat-initiative-linking-spec.md`
- Attachments UX: `docs/ux/chat-attachments-spec.md`
- Agent mentions UX: `docs/ux/chat-agent-mentions-spec.md`
- Mobile 375 behavior: `docs/ux/chat-mobile-375-spec.md`
- Motion/interaction system: `docs/ux/chat-motion-interaction-spec.md`
- Accessibility contract: `docs/ux/chat-accessibility-spec.md`
- Empty/error/loading states: `docs/ux/chat-empty-error-loading-spec.md`
- Copy and tone: `docs/ux/chat-copy-tone-guidelines.md`

## Delivery and Readiness Specs

- QA scenario matrix: `docs/ux/chat-qa-checklist.md`
- Rollout gates: `docs/product/chat-phase-rollout-plan.md`
- Telemetry and KPI thresholds: `docs/product/chat-telemetry-kpis.md`
- OrgX schema mapping (cross-repo): `../orgx/orgx/docs/product/chat-orgx-schema-mapping.md`

## Phase Gates

### Phase 0: Schema + Contracts

Required docs:
- `docs/ux/chat-architecture-principles.md`
- `../orgx/orgx/docs/product/chat-orgx-schema-mapping.md`
- `docs/product/chat-phase-rollout-plan.md`

Gate criteria:
- OrgX schema mapping approved as migrations-first source of truth.
- `/orgx/api/chat/*` route contract draft completed and reviewed.
- Snapshot extension plan marked additive/non-breaking.

### Phase 1: Composer + Activity Thread Cards

Required docs:
- `docs/ux/chat-composer-component-spec.md`
- `docs/ux/chat-thread-card-spec.md`
- `docs/ux/chat-motion-interaction-spec.md`
- `docs/ux/chat-copy-tone-guidelines.md`

Gate criteria:
- Send path stable with optimistic + reconciled update behavior.
- Activity cards participate in filters/search/sort.
- Desktop and 375 smoke checks pass.

### Phase 2: Thread Panel + Explicit Launch

Required docs:
- `docs/ux/chat-thread-panel-spec.md`
- `docs/ux/chat-launch-orchestration-spec.md`
- `docs/ux/chat-agent-mentions-spec.md`

Gate criteria:
- Thread panel supports full message and launch timeline.
- Launch semantics remain explicit (`send != launch`).
- Blocked/failure states include direct recovery action.

### Phase 3: Linking + Attachments + Mobile

Required docs:
- `docs/ux/chat-initiative-linking-spec.md`
- `docs/ux/chat-attachments-spec.md`
- `docs/ux/chat-mobile-375-spec.md`

Gate criteria:
- Unscoped thread -> initiative linking works without data loss.
- Attachment states and retries visible and deterministic.
- 375 flow complete without layout collisions.

### Phase 4: Hardening + Accessibility + QA

Required docs:
- `docs/ux/chat-accessibility-spec.md`
- `docs/ux/chat-empty-error-loading-spec.md`
- `docs/ux/chat-qa-checklist.md`
- `docs/product/chat-telemetry-kpis.md`

Gate criteria:
- Accessibility checks pass for keyboard and screen reader paths.
- All high-priority QA scenarios pass with evidence capture.
- KPI instrumentation and alert thresholds active.

## Non-Negotiables

- Exactly one primary execution agent per launch.
- Launch remains explicit in v1.
- Threads may start unscoped and be linked later.
- Local queue is default execution mode in v1.
- Every visible state has deterministic status text and next action.

## Audit Bar

Each phase and component must score >= 9/10 against:
- AI slop detection
- Cognitive load and decision clarity
- Gestalt hierarchy
- Master designer checks
- Interaction physics
- Spacing and typography rhythm
- Reference parity
- Agent-first legibility
