# Codex Cloud Environment

Use these repo-local scripts when configuring the Codex cloud environment for `useorgx/openclaw-plugin`.

## Setup script

```bash
bash .codex/setup-cloud.sh
```

## Maintenance script

```bash
bash .codex/maintenance-cloud.sh
```

## Environment notes

- Node 22 or newer is safe for this repository.
- Dashboard dependencies are installed separately from `dashboard/package-lock.json`.
- Setup runs typecheck, the client API compatibility test, and a full build. Run `npm run test:hooks` separately for release signoff because it is a long lifecycle suite.
- Local deployment, publishing, and live OrgX flows require scoped credentials; do not add those as plain environment variables.
- Keep internet access limited to the setup phase unless a task explicitly needs external services.

## Verification commands

```bash
npm run typecheck
node ./scripts/run-targeted-test.mjs tests/contracts-client-api-compat.test.mjs
npm run test:hooks
npm run build
npm run verify:repo-hygiene
```
