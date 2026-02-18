# Changelog

All notable changes to `@useorgx/openclaw-plugin` are documented in this file.

## 0.4.9 - 2026-02-18

### Pairing + Mission Control Reliability
- Hardened HTTP mission-control action handling and auto-continue guard behavior to reduce false starts and improve routing consistency.
- Expanded auto-continue guarding tests for mission-control flows and edge-case execution paths.

### Dashboard UX Updates
- Refined app shell/session views and settings interactions for clearer mission state and smoother operator workflows.
- Improved activity timeline and agent chat panel behavior to better surface current run context.

## 0.4.8 - 2026-02-16

### Activity Timeline Clarity
- Distinguish blocking vs non-blocking decisions in autopilot slice result metadata and surface both counts in Activity detail.
- Updated Activity outcome messaging to show `Completed + follow-up` for non-blocking decisions instead of `Needs decision`.
- Expanded low-signal sync suppression to hide noisy `changeset.applied/replayed` activity by default.
- Stabilized activity sort tie-breakers to reduce list churn/flicker during frequent polling/snapshot refreshes.

### Runtime + In-Progress Reconciliation
- Downgrade stale runtime-backed sessions from live-running to queued/paused semantics so stale work does not appear active.
- Tightened Mission Control In Progress filtering to exclude stale/stopped sessions and dedupe repeated rows by active workstream.
- Updated agents/session live-status rules to avoid showing queued backlog items as active runs in Live view.

### Autopilot Worker Scoping
- Added scoped Codex MCP overrides per slice to disable unrelated `orgx-openclaw-*` domain servers by default and keep only the target domain server enabled.

## 0.4.7 - 2026-02-16

### Activity + Performance
- Reduced live activity feed payload/render pressure by lowering dashboard activity limits and paging batch sizes.
- Reduced Activity timeline initial render and incremental render step sizes to smooth scrolling and reduce visual churn.
- Added a clearer detail outcome state in Activity modal (blocked/needs decision/completed/in-progress) with direct quick actions.

### Artifact Reliability
- Hardened artifact detail retrieval with local fallback support when upstream OrgX artifact lookup is unavailable.
- Added filesystem-aware fallback links/path handling in artifact detail UX so local evidence can still be opened and copied.

### Agent Identity + Ordering
- Improved OrgX agent identity canonicalization using additional session node hints (group/title/runtime/summary).
- Prioritized canonical OrgX groups in Agents panel ordering and tightened child provider label presentation.

## 0.4.6 - 2026-02-14

### Runtime + Reliability
- Hardened outbox replay and status updates: normalize common status synonyms and improve replay/compatibility for status-only updates.
- Improved `/orgx/api/live/stream` SSE proxy reliability with upstream reconnect/backoff while keeping the client connection stable.

### Activity + UX
- Made activity timeline labels human-readable.
- Updated autopilot instructions to prefer `orgx_report_progress` for progress updates (when available).

## 0.4.5 - 2026-02-12

### Plugin Runtime
- Fixed outbox replay reliability and improved resiliency during reconnection.
- Added a local MCP bridge to support more robust local operations and tooling.

### Dashboard UX
- Elevated Agents, Decisions, and Mission Control UX polish.
- Added bulk modals for header metrics to enable cleaner batch actions.

### Docs and QA Artifacts
- Clarified local MCP bridge setup, configuration, and ops controls.
- Refreshed Mission Control UX audit fixtures and snapshot artifacts.

## 0.4.4 - 2026-02-12

### Dispatch and Reliability
- Added resume support, resource guards, and stuck-worker recovery to the Codex dispatch job.
- Enforced spawn-guard parity across agent launch/restart/fallback routes.
- Made dispatch reporting best-effort so transient reporting/API errors do not abort execution.

### Telemetry
- Added PostHog telemetry hooks for improved operational visibility.

### Docs and Tooling
- Added auth flow investigation notes and ADR for identity normalization (Clerk external id → Supabase UUID).
- Added a manual marketing-agent dispatch “golden prompt” and a live dashboard marketing copy pack.
- Refined dispatch tooling and tests for more hermetic execution.

## 0.4.3 - 2026-02-12

### Security and IP Hardening
- Hardened dashboard delivery with stricter HTTP response security headers:
  - `Content-Security-Policy`
  - `Permissions-Policy`
  - `Cross-Origin-Opener-Policy`
  - `X-Robots-Tag` and related anti-indexing controls
- Blocked source-map access for `/orgx/live` asset requests at runtime.
- Ensured release builds do not emit or ship source maps from core or dashboard outputs.
- Updated production bundling to reduce reverse-engineering signal in artifact names (hash-first output naming).

### Legal and UX Safeguards
- Added reusable legal footer links component and integrated it into onboarding and settings surfaces.
- Added `robots`/`googlebot` anti-indexing meta tags to the dashboard HTML entrypoint.

### Build and Release Hygiene
- Hardened core build script to clear old build output before compiling, preventing stale artifacts from leaking into packages.
- Published patch release flow improvements with explicit version and tag readiness for GitHub releases.

## 0.4.0 - 2026-02-11

### Mission Control UX and Flow
- Reworked initiative row layout for better title truncation, progress visibility, and avatar alignment.
- Improved sticky initiative and hierarchy header behavior for smoother scroll transitions and reduced jitter.
- Added stronger Next Up orchestration UX, including inline/rail transitions and clearer action states.
- Fixed initiative open/focus behavior so targets are revealed even when hidden by active filters.
- Tightened hierarchy toolbar spacing, filter controls, and selection row consistency.

### Design System and Iconography
- Added reusable shared icon primitives:
  - `EntityIcon` for cross-surface entity semantics.
  - `WorkstreamGlyph` for consistent IWMT-style workstream symbol usage.
- Applied icon consistency updates across Mission Control surfaces and related UI touchpoints.

### Onboarding and Pairing
- Rebuilt onboarding explainer into a guided, multi-slide experience with stronger visual hierarchy.
- Redesigned pairing interstitial popup to match OrgX visual language and reduce transition friction.
- Expanded onboarding panel content with clearer capability framing and setup guidance.

### Modal and Layout Polish
- Fixed settings modal structural layout so header/content consistently use full width.
- Updated shared modal container behavior to prevent constrained nested content in settings flows.

### Reliability and Runtime
- Added runtime instance persistence support (`runtime-instance-store`) to improve live state continuity.
- Updated live initiative/session hooks and query key plumbing to support improved Mission Control rendering and controls.
