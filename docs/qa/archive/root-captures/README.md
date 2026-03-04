# Root Capture Archive

This folder stores legacy QA screenshots/videos that used to live at repo root.

Policy:
- New QA evidence belongs in date-scoped folders under `docs/qa/<YYYY-MM-DD>/...`.
- Ad-hoc local captures belong in ignored local folders (for example `artifacts/` or `screenshots/`), not at repo root.
- Binary media is intentionally git-ignored in this archive; keep only documentation and curated references.
- `npm run verify:repo-hygiene` checks for new root-level media drift.
