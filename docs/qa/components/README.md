# Component QA Fast Lane

This harness gives component-level screenshots with an auto-growing registry, fast changed-only runs, and generated HTML indexes.

## Goals

- Capture UI at component granularity.
- Keep capture targets current as new components are added.
- Reduce audit time with changed-only sampling and parallel capture.
- Keep a repeatable artifact trail under `docs/qa/components/runs/`.

## Registry

- Registry file: `docs/qa/component-registry.json`
- Schema: `docs/qa/component-registry.schema.json`
- Unmapped components are auto-discovered and appended to `unmapped`.

Each mapped entry defines:

- `componentPath`
- `selector`
- `scenarios[]` with `openAction`
- `viewports` (`desktop`, `mobile`)
- `tags` (`critical`, `activity`, `mission-control`, etc.)

## Commands

```bash
# Discover newly added component files into unmapped list
npm run qa:components:discover

# Capture mapped components (desktop/mobile as defined in registry)
npm run qa:components

# Capture only changed component owners + dependents (+ critical fallback)
npm run qa:components:changed

# Build HTML index for latest run and root run list
npm run qa:components:index

# Critical live lane (fast smoke for highest-value surfaces)
npm run qa:live:critical
```

## Useful flags

All capture scripts accept scoped flags:

- `--workspace-id <uuid>`
- `--command-center-id <uuid>`
- `--center <uuid>`
- `--base-url http://127.0.0.1:18789`
- `--route /orgx/live`
- `--tags critical,activity`
- `--workers 6`
- `--limit 10`
- `--dry-run`
- `--headful`

Examples:

```bash
node scripts/capture-components.mjs --changed --workspace-id <uuid> --tags critical
node scripts/capture-live-critical.mjs --workspace-id <uuid> --headful
```

## Output

Per run:

- `docs/qa/components/runs/<run-id>/manifest.components.json`
- `docs/qa/components/runs/<run-id>/components/<component-id>/*.png`
- `docs/qa/components/runs/<run-id>/index.html`

Aggregate:

- `docs/qa/components/runs/index.html`

`manifest.components.json` contains:

- run metadata
- capture stats
- per-capture hashes and baseline diff status (`same`, `changed`, `new`)
- failure details with failure screenshots

## Baseline and diffs

- Baseline defaults to latest successful run (`failed === 0`).
- Diff status is hash-based.
- Use changed-only runs for rapid iteration, then run full critical lane before shipping.

## Recommended workflow

1. `npm run qa:components:discover`
2. Map newly discovered entries from `unmapped` to `components`.
3. `npm run qa:components:changed` while iterating.
4. `npm run qa:live:critical` before merge.
5. Attach `runs/<run-id>/index.html` and `manifest.components.json` in PR verification notes.
