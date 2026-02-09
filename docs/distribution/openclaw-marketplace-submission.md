# OpenClaw Marketplace Submission Runbook (G4)

Task covered:
- Submit to OpenClaw marketplace

This is intentionally procedural to make the submission fast and verifiable.

## Inputs

- Package: `@useorgx/openclaw-plugin` (current version in `package.json`)
- Listing assets: `artifacts/`, `docs/qa/`, and screenshots/gifs as needed

## Pre-submission Verification

1. Clean install
   - `npm run verify:clean-install`
   - Save output to `docs/ops/2026-02-14/openclaw-submission/clean-install.log`

2. Package build
   - `npm run build`

3. Evidence bundle
   - `npm run qa:capture -- --date 2026-02-14`

## Submission Checklist

- Listing title + description
- Install command
- Config schema matches `openclaw.plugin.json`
- Support contact
- Repo URL
- Version matches `package.json`

## Evidence to Preserve

Create directory `docs/ops/2026-02-14/openclaw-submission/` and include:
- `submission-notes.md` with:
  - submission timestamp
  - marketplace listing URL (or draft URL)
  - any reviewer messages
- screenshots of the final submission screens
