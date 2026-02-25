# WS1 Plugin Install Verification Slice (2026-02-25)

## Scope
- Initiative: 855f11a2-3bff-44d8-80a0-eef58a45b790
- Workstream: c50fa847-0987-472c-83d6-6394bafd5739
- Slice: 4e6d1faf-9e53-420d-8cb7-3317c0c82589
- Task target: 44d38508-086c-44b7-9405-fd2b287f7a16

## Change made
- Updated root `package.json` script:
  - from: `npm --prefix dashboard ci`
  - to: `npm --prefix dashboard ci --include=dev`

Rationale: `verify:clean-install` failed because dashboard build invoked `node ./node_modules/typescript/lib/tsc.js` but `typescript` was omitted from install.

## Verification attempts
1. `npm run verify:clean-install`
   - Initial failure: `Cannot find module ... dashboard/node_modules/typescript/lib/tsc.js`
2. Re-ran after script fix
   - Dashboard build progressed successfully
   - Blocked later by npm sandbox/network issue
3. `npm run build:core`
   - Pass
4. `npm_config_cache=/tmp/.npm-cache npm run verify:clean-install`
   - Blocked with registry fetch failures (`ENOTFOUND registry.npmjs.org`) and npm exit handler error in sandbox

## Blocker
- Current execution environment cannot resolve npm registry hosts during clean-install flow, which requires dependency fetches during `npm --prefix dashboard ci --include=dev`.
- Evidence log: `/tmp/.npm-cache/_logs/2026-02-25T03_32_41_748Z-debug-0.log`
