#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CI=1
export HUSKY=0
export npm_config_audit=false
export npm_config_fund=false

node --version
npm --version

npm ci --include=dev
npm --prefix dashboard ci --include=dev
npm run typecheck
node ./scripts/run-targeted-test.mjs tests/contracts-client-api-compat.test.mjs
npm run build
