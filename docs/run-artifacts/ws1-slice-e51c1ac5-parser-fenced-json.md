# WS1 Slice Evidence: Autopilot Parser Fenced JSON Support

Date: 2026-02-24
Slice: e51c1ac5-f023-474b-b19d-3a1130d72854
Workstream: ws-1

## Change
- Updated `parseSliceResult` in `src/http/helpers/autopilot-slice-utils.ts` to normalize markdown-fenced JSON when parsing envelope string fields:
  - `structured_output` (string form)
  - `result` (string form)
- Added regression tests in `tests/http/autopilot-slice-output-parse.test.mjs` for both fenced string envelope variants.

## Why
Some model wrappers return valid JSON inside code fences within string envelope fields. Previously those envelope string variants were not unwrapped, causing avoidable parse failures.

## Verification
1. `npm run build:core`
2. `npm run test:file -- tests/http/autopilot-slice-output-parse.test.mjs`
3. Confirmed pass: 20 tests, 0 failures.
