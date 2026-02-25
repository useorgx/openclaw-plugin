# WS1 Slice 71863be2: Slice Status Consistency Guard

## Scope
Strengthen autopilot slice result parsing so non-completed statuses (`blocked`, `needs_decision`, `error`) require at least one blocking decision, matching the enforced output contract.

## Changes
- Updated `parseSliceResult` consistency checks in `src/http/helpers/autopilot-slice-utils.ts`.
- Expanded targeted parser tests in `tests/http/autopilot-slice-output-parse.test.mjs` to cover:
  - reject `blocked` without blocking decisions
  - reject `needs_decision` without blocking decisions
  - reject `error` without blocking decisions
  - accept all three when blocking decisions are present

## Verification
- `npm run build:core`
- `npm run test:file -- tests/http/autopilot-slice-output-parse.test.mjs`
- Result: 18/18 tests passing.
