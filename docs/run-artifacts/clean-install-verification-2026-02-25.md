# Clean Install Verification Attempt (2026-02-25)

## Scope
- Workstream: `WS1: Plugin Package & Install Verification`
- Candidate task: `Test: openclaw plugins install @useorgx/orgx on fresh macOS instance`
- Repository package under test: `@useorgx/openclaw-plugin` (`package.json` name)

## What Was Verified
- Confirmed canonical package install command in repo docs is:
  - `openclaw plugins install @useorgx/openclaw-plugin`
- Confirmed package metadata:
  - `package.json` name: `@useorgx/openclaw-plugin`
  - OpenClaw plugin manifest is included in package files (`openclaw.plugin.json`).

## Verification Commands
```bash
npm run verify:clean-install
mkdir -p /tmp/npm-cache /tmp/npm-logs && \
  NPM_CONFIG_CACHE=/tmp/npm-cache \
  NPM_CONFIG_LOGS_DIR=/tmp/npm-logs \
  npm run verify:clean-install
```

## Result
- `verify:clean-install` could not complete in this execution sandbox.
- Failure is environment/network bound, not a package code regression:
  - npm fetch attempts failed with `ENOTFOUND` against `https://registry.npmjs.org/...`
  - Log file: `/tmp/npm-logs/2026-02-25T07_55_29_125Z-debug-0.log`

## Evidence
- `scripts/verify-clean-install.mjs` exists and performs:
  - `npm run pack`
  - temp project install of packed tarball
  - runtime import check of `@useorgx/openclaw-plugin`
  - installed file assertions (`openclaw.plugin.json`, `dist/index.js`, `dashboard/dist/index.html`)
- Install command references in `README.md` point to `@useorgx/openclaw-plugin`, not `@useorgx/orgx`.

## Next Unblocking Action
- Re-run `npm run verify:clean-install` in an environment with npm registry DNS/network access (fresh macOS instance as planned).
