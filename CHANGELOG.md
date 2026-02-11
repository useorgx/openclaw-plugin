# Changelog

All notable changes to `@useorgx/openclaw-plugin` are documented in this file.

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
