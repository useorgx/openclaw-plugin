# Changelog

All notable changes to `@useorgx/openclaw-plugin` are documented in this file.

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
