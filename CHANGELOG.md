# Changelog

All notable changes to `@useorgx/openclaw-plugin` are documented in this file.

## 0.7.32 - 2026-04-13

### Release Management
- Switched the GitHub release workflow to npm trusted publishing with provenance so releases do not depend on a missing long-lived npm token secret.
- Patch release bump for npm package, lockfile, and plugin manifest metadata.

## 0.7.31 - 2026-04-13

### Release Management
- Patch release bump for npm package, lockfile, and plugin manifest metadata.

### Outcome Reporting + Proof Chain
- Fixed `orgx_record_outcome` so coordinator calls include the run context required by OrgX reporting APIs, while preserving explicit `run_id` overrides.
- Added regression coverage for strict MCP schema behavior and outcome payload forwarding.

### Autopilot Continuation Reliability
- Kept closed slice child processes available until reconciliation so the auto-continue engine can read their terminal output before clearing process state.
- Prevented closed slices with stale PIDs from being treated as still alive and falsely killed by stall detection.

## 0.7.30 - 2026-03-28

### Release Management
- Patch release bump for npm package, lockfile, and plugin manifest metadata.

### Trust + Security Hardening
- Made managed OrgX agent-suite provisioning opt-in by default instead of auto-applying after connect.
- Made Claude/Cursor/Codex MCP client autoconfiguration opt-in by default instead of auto-patching local client config files after browser pairing.
- Removed the published plugin's legacy dev fallback that read credentials from `~/Code/orgx/orgx/.env.local`.
- Expanded the public README and skill copy with explicit transparency around local file writes, backups, credential storage, network endpoints, telemetry defaults, and background process behavior.

## 0.7.29 - 2026-03-28

### Release Management
- Patch release bump for npm package + plugin manifest metadata.

### README + Package Surface
- Tightened public README copy to avoid publishing implementation-specific credential details and token-prefix examples.
- Promoted the ClawHub install path now that the package is live, while keeping the npm install path documented as a fallback.

## 0.7.28 - 2026-03-28

### Release Management
- Patch release bump for npm package + plugin manifest metadata.

### Distribution + Positioning
- Renamed the native plugin manifest identity to `orgx` and refreshed the display metadata for package-catalog discovery.
- Repositioned the README around the OpenClaw-specific memory and coordination problem instead of generic orchestration language.
- Added the explicit ClawHub install path alongside the npm install path in the README.

## 0.7.27 - 2026-03-12

### Release Management
- Patch release bump for npm package + plugin manifest metadata.
- Published release tag `v0.7.27`.

### Mission Control Operator UX
- Refined decision and intervention bulk-review trays for the narrow Mission Control rail so multi-select actions stay legible and calm instead of collapsing into dense button rows.
- Elevated blocked-slice decision handoff in the slice detail modal so operators can review the primary pending decision directly from the blocker surface, with a fallback path when only decision counts were emitted.
- Kept grouped scope sections in queue detail views open by default for completed and upcoming work so the work scope is visible immediately.

## 0.7.26 - 2026-03-10

### Release Management
- Patch release bump for npm package + plugin manifest metadata.
- Published release tag `v0.7.26`.

### Runtime Installation Reliability
- Added a sqlite runtime self-heal path so installs that are missing the native `better-sqlite3` binding can repair themselves when the state store initializes.
- Hardened clean-install verification to simulate OpenClaw's scripts-disabled install path and assert the native binding is rebuilt before the package is considered healthy.

## 0.7.25 - 2026-03-10

### Release Management
- Patch release bump for npm package metadata.
- Aligned `openclaw.plugin.json` version with the npm package version so `openclaw plugins list` reports the shipped release correctly.
- Published release tag `v0.7.25`.

## 0.7.24 - 2026-03-10

### Release Management
- Patch release bump for npm package metadata.
- Published release tag `v0.7.24`.

### Mission Control Action Truth
- Reworked `Next Up` startability so `Start` and `Auto on` are driven by dispatchable-task truth instead of optimistic queue assumptions.
- Added reconciled mission-control action results and reason codes so blocked, already-running, and no-dispatchable-task outcomes surface clearly in the UI.

### Activity + Intervention Clarity
- Normalized activity, blocker, and decision detail rendering around human-readable updates, scope, status, artifacts, outcomes, and next steps instead of raw metadata summaries and UUID-heavy copy.
- Extended decision and blocker intervention payloads so modals have the context, evidence, options, and recommendations needed for user judgment.
- Hardened activity dedupe and humanization to reduce duplicate noise and opaque feed entries.

### Completed Work + Demo Coverage
- Added a first-class `Completed` Mission Control surface that shows recent completed hierarchy, artifacts, outcomes, and what work it unlocked next.
- Expanded demo-mode initiatives, timelines, artifacts, blockers, and decisions so active, needs-attention, and completed states cover a broader range of agents and workflows.

## 0.7.23 - 2026-03-07

### Release Management
- Patch release bump for npm package metadata.

### First-Run + Onboarding Truth
- Added the connected-empty first-value runway so a newly connected workspace with zero initiatives lands in a focused creation/import state instead of a dead shell.
- Hardened onboarding truth so stale demo state no longer overrides disconnected or empty-workspace reality.
- Fixed scoped empty-workspace live activity so empty OrgX workspaces render empty instead of leaking global/live-looking data.

### Design System + Intervention Flow
- Deepened the mission-control design audit pass across typography, spacing, and token usage.
- Refined the decision/blocker intervention funnel so blocker and decision moments read more clearly and route into the right intervention surface.

## 0.7.22 - 2026-03-07

### Release Management
- Patch release bump for npm package + git tag metadata.
- Published release tag `v0.7.22`.

### Mission Control UI Polish
- Removed the duplicate agent header from in-progress workstream rows so active work renders with one consistent operator label.

## 0.7.21 - 2026-03-06

### Release Management
- Patch release bump for npm package + git tag metadata.
- Published release tag `v0.7.21`.

### Mission Control + Lifecycle Hardening
- Unified shell-level live-work counts with canonical Mission Control and live snapshot totals so `In Progress`, `Needs attention`, and `Done today` stay aligned with the panels.
- Hardened `Next Up` canonical summary recomputation, workspace-scoped queue invalidation, and local fallback behavior to remove synthetic queue drift.
- Fixed start/auto/reconnect continuity so the UI focuses the actual started run immediately and preserves verified onboarding context during reconnect pairing.
- Tightened Mission Control fallback health math, blocked-work derivation, and live audit selector logic used by local QA verification.

## 0.7.15 - 2026-03-04

### Release Management
- Patch release bump for npm package + plugin manifest versions.
- Published release tag `v0.7.15`.

### Reliability + Scope Canonicalization
- Added `center` header alias support to workspace scope resolution while preserving canonical workspace/command-center behavior.
- Hardened MCP HTTP request body stream handling to settle safely across both `.once` and `.on` event emitter implementations.
- Added targeted regression coverage for workspace-scope center alias handling and streamed MCP JSON-RPC POST bodies.

## 0.7.14 - 2026-03-04

### Release Management
- Patch release bump for npm package + plugin manifest versions.
- Published release tag `v0.7.14`.

### Dashboard + QA Tooling
- Carries forward the latest UX, verification, and architecture-debt cleanup work shipped on this branch.

## 0.7.13 - 2026-03-04

### Release Management
- Patch release bump for npm package + plugin manifest versions.
- Published release tag `v0.7.13`.

### Mission Control + Build Stability
- Carries forward the latest Mission Control lifecycle UX and auto-continue behavior updates.
- Clears dashboard build warnings by fixing Vite manual chunk splitting and release metadata normalization.

## 0.7.9 - 2026-03-03

### Release Management
- Patch release bump for npm package + lockfile metadata.
- Published release tag `v0.7.9`.

### OpenClaw Plugin SDK Compatibility
- Updated plugin HTTP registration to support route-based SDKs (`registerHttpRoute`) with backward compatibility fallback to legacy `registerHttpHandler` when available.
- Restored plugin load on OpenClaw `2026.3.x`, where `registerHttpHandler` was removed.

### Mission Control Lifecycle UX
- Refined Next Up -> In Progress separation by excluding unscoped reporting/control sessions from in-progress fallback rows.
- Updated auto-continue queue intent and cache invalidation flows so queue, run-state, and activity surfaces stay in sync after play/start/stop/tick actions.
- Added workspace-aware auto-continue status resolution when `initiative_id` is omitted, including scoped run selection and deterministic ordering.
- Hardened mission-control initiative graph reads to skip non-UUID local placeholder IDs and fail fast for invalid initiative identifiers.

## 0.7.8 - 2026-03-03

### Release Management
- Patch release bump for npm package + plugin manifest versions.
- Published release tag `v0.7.8`.

### Inclusion Confirmation
- Carries forward the QA capture reliability hardening from `#208` in the released tag line.
- Confirms the automation paths and selectors from that fix set are included in this patch release train.

## 0.7.7 - 2026-03-03

### Release Management
- Patch release bump for npm package + plugin manifest versions.
- Published release tag `v0.7.7`.

### QA Capture Reliability
- Hardened component capture retries with locator re-acquire and viewport fallback when element screenshots timeout.
- Added failed-capture retry pass in addition to warning retries to improve full-run stability.
- Stabilized activity/settings capture selectors and action paths used by QA automation.

## 0.7.2 - 2026-02-28

### Release Management
- Patch release to align npm package versioning and git tags after recent `origin/main` merges.
- No additional runtime or API behavior changes in this release beyond version/changelog metadata.

## 0.7.1 - 2026-02-27

### Mission Control Hierarchy + Queue Clarity
- Added sequence-aware normalization and ordering across live initiatives, initiative details, and mission graph nodes (`I/W/M/T` label consistency).
- Updated Mission Control default initiative sorting to prioritize explicit sequence before status/priority tie-breaks.
- Expanded Next Up to support initiative/workstream/milestone rendering modes with mode-aware counts, empty states, and controls.
- Added explicit Autopilot confirmation and direct dispatch affordances for grouped Next Up cards.

### Canonical Queue Contract Hardening
- Improved canonical Next Up normalization for snake_case pagination and runner fields.
- Added parsing support for JSON-string array payloads (`runner_agents`, `slice_task_ids`) in canonical responses.
- Normalized dependency-wait queue states (for example `waiting_dependency`) to blocked semantics.
- Mapped ambiguous `active` queue state to queued semantics to avoid misleading in-progress UI.

### Test Coverage
- Added/expanded Mission Control next-up tests for noise-threshold behavior, pagination metadata forwarding, runner normalization, dependency-blocked queue states, and blocked-reason surfacing.


## 0.5.0 - 2026-02-20

### Mission Control + Activity UX
- Continued the queue and lifecycle UX overhaul across Activity and Mission Control for clearer play/queue/auto flows and smoother session-to-detail navigation.
- Improved decision/slice handling surfaces and session detail interactions to reduce operator friction across blocked/in-progress/next-up states.

### Agent + Runtime Controls
- Expanded agent behavior/runtime settings plumbing and dashboard configuration support for per-agent control flows.
- Hardened autopilot/dispatch lifecycle and related route handling with broader test coverage around continuation and blocking states.

### Dashboard Performance + Delivery
- Reduced initial dashboard bundle pressure via targeted lazy-loading and telemetry deferral.
- Added dashboard build-time static asset precompression (`.br`/`.gz`) and HTTP content-encoding negotiation with `Vary: Accept-Encoding` for faster live dashboard delivery.

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
