# Plugin Packaging & Distribution Discovery (2026-02-24)

## Scope
- Initiative: `aa6d16dc-d450-417f-8a17-fd89bd597195`
- Workstream: `Plugin Packaging & Distribution`
- Slice: `9bf62c4e-514c-4bac-ac7a-5991e04fed90`
- Goal: Validate whether the plugin is currently downloadable/installable from package artifacts and identify immediate distribution risks.

## Evidence Collected

1. Package metadata confirms distributable configuration:
- `package.json` has `name: @useorgx/openclaw-plugin`, version `0.5.1`
- `files` whitelist includes `dist/`, `dashboard/dist/`, `skills/`, `openclaw.plugin.json`, `README.md`
- `prepublishOnly` runs `npm run build`
- `README.md` includes install command: `openclaw plugins install @useorgx/openclaw-plugin`

2. Plugin manifest is present and points to packaged entrypoint:
- `openclaw.plugin.json` exists at repo root
- Manifest `entry` is `./dist/index.js`

3. Pack dry-run succeeded and produced a valid tarball manifest:
- Command: `npm pack --dry-run --cache /tmp/.npm-orgx-cache`
- Tarball: `useorgx-openclaw-plugin-0.5.1.tgz`
- Size: `12.4 MB` (unpacked `15.2 MB`)
- Total files: `325`
- Includes root docs/manifest + compiled `dist/*` + `dashboard/dist/*` + `skills/*`

## Observations
- Download/install path appears functionally ready from packaging metadata and `npm pack` output.
- Packaged size is elevated mainly due to bundled brand images under `dashboard/dist/brand/*.png` (multi-megabyte each).
- Local environment has an npm cache ownership issue (`~/.npm` root-owned artifacts), which can break default pack/publish commands unless cache is overridden.

## Risks
- Large package payload may slow install time and increase bandwidth costs.
- Publishing/release automation could fail on machines with the same npm cache ownership issue if cache path is not overridden.

## Recommended Next Actions
1. Add a lightweight packaging budget check in CI (example: fail if tarball exceeds an agreed threshold).
2. Optimize/resize dashboard brand images or move non-runtime assets out of shipped package.
3. Add a release-note troubleshooting line for npm cache ownership (`npm --cache <writable-dir>` fallback) to reduce maintainer friction.

## Repro Commands
```bash
# Confirm distributable metadata
cat package.json
cat openclaw.plugin.json

# Validate produced package contents without publishing
npm pack --dry-run --cache /tmp/.npm-orgx-cache
```
