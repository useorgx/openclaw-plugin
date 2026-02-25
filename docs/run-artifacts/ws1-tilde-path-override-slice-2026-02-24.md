# WS1 Slice Artifact (2026-02-24)

## Summary
Implemented home-directory (`~`) expansion for environment path overrides in `src/paths.ts`.
Added regression test coverage in `tests/paths.test.mjs`.

## Verification
- `npm run build:core` -> pass
- `npm run test:file -- tests/paths.test.mjs` -> 5 passed, 0 failed

## Changed Files
- `src/paths.ts`
- `tests/paths.test.mjs`
