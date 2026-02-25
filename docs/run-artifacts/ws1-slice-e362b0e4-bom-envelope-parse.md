# WS1 Slice e362b0e4: BOM Envelope Parse Hardening

## Scope
Hardened `parseSliceResult` to accept UTF-8 BOM-prefixed JSON when payloads are nested as string envelopes (`final_output`, `structured_output`, or `result`).

## Changes
- `src/http/helpers/autopilot-slice-utils.ts`
  - Added shared `parseSliceJsonText` helper.
  - Applied BOM normalization for nested string payload parsing, not only top-level raw parsing.
- `tests/http/autopilot-slice-output-parse.test.mjs`
  - Added regression test for BOM-prefixed `final_output` string envelope.
  - Added regression test for BOM-prefixed Claude `result` string envelope.

## Verification
- Build step: `npm run build:core`
- Targeted test: `npm run test:file -- tests/http/autopilot-slice-output-parse.test.mjs`
- Result: 25 passed, 0 failed.
