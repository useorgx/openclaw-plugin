# WS1 Slice Verification - 95399f37-d2bb-424e-9f54-7b608f8f7529

## Scope
Validated the path override hardening behavior covered by `tests/paths.test.mjs`.

## Command
`npm run test:file -- tests/paths.test.mjs`

## Result
Pass (3 tests, 0 failures).

## Assertions covered
- Default config/openclaw/outbox paths resolve under `HOME` when overrides are unset.
- Blank overrides are ignored, valid relative overrides are resolved.
- Control-character and null-byte-like overrides are rejected and safe defaults are used.
