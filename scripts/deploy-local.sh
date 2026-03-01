#!/usr/bin/env bash
# deploy-local.sh — Build, publish, install, and restart the openclaw plugin locally.
#
# Usage:
#   ./scripts/deploy-local.sh          # publish to npm (will prompt for OTP) + install + restart
#   ./scripts/deploy-local.sh --local  # skip npm publish, install from local build
#   ./scripts/deploy-local.sh --bump   # bump patch version, commit, tag, publish, install, restart
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSIONS_DIR="${HOME}/.openclaw/extensions/openclaw-plugin"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
LAUNCH_AGENT="gui/$(id -u)/ai.openclaw.gateway"

LOCAL_ONLY=false
BUMP=false
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_ONLY=true ;;
    --bump)  BUMP=true ;;
  esac
done

cd "$REPO_ROOT"

# --- Optional: bump patch version ---
if $BUMP; then
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  NEXT_PATCH=$((PATCH + 1))
  NEXT_VERSION="${MAJOR}.${MINOR}.${NEXT_PATCH}"
  echo "Bumping version: ${CURRENT_VERSION} → ${NEXT_VERSION}"
  sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEXT_VERSION}\"/" package.json
  git add package.json
  git commit -m "chore: bump version to ${NEXT_VERSION}"
  git tag "v${NEXT_VERSION}"
  git push origin main "v${NEXT_VERSION}"
  echo "Tagged and pushed v${NEXT_VERSION}"
fi

VERSION=$(node -p "require('./package.json').version")
echo "Deploying @useorgx/openclaw-plugin@${VERSION}"

# --- Build ---
echo "Building..."
npm run build:core

# --- Publish to npm (unless --local) ---
if ! $LOCAL_ONLY; then
  echo "Publishing to npm..."
  npm publish --access public
  echo "Published @useorgx/openclaw-plugin@${VERSION}"
fi

# --- Install to extensions dir ---
echo "Installing to ${EXTENSIONS_DIR}..."
if [ -d "$EXTENSIONS_DIR" ]; then
  # Remove old contents but keep the directory
  find "$EXTENSIONS_DIR" -mindepth 1 -delete 2>/dev/null || true
fi
mkdir -p "$EXTENSIONS_DIR"

if $LOCAL_ONLY; then
  # Copy from local build
  cp -R dist dashboard/dist openclaw.plugin.json package.json LICENSE README.md "$EXTENSIONS_DIR/"
  [ -d skills ] && cp -R skills "$EXTENSIONS_DIR/"
else
  # Install from npm tarball
  TMPDIR=$(mktemp -d)
  (cd "$TMPDIR" && npm pack "@useorgx/openclaw-plugin@${VERSION}" --silent && tar xzf *.tgz && cp -R package/* "$EXTENSIONS_DIR/")
fi

# --- Update config version ---
if [ -f "$CONFIG_FILE" ]; then
  sed -i '' "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"${VERSION}\"/" "$CONFIG_FILE"
fi

# --- Restart gateway ---
echo "Restarting gateway..."
launchctl kickstart -k "$LAUNCH_AGENT" 2>/dev/null || echo "Gateway not running as LaunchAgent; restart manually."

echo ""
echo "Deployed @useorgx/openclaw-plugin@${VERSION}"
echo "  Extensions: ${EXTENSIONS_DIR}"
echo "  Gateway: restarted"
