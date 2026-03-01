#!/usr/bin/env bash
# deploy-local.sh — Build, publish, install, and restart the openclaw plugin locally.
#
# Usage:
#   ./scripts/deploy-local.sh                # publish current version + install + restart
#   ./scripts/deploy-local.sh --local        # skip npm publish, install from local build
#   ./scripts/deploy-local.sh patch          # bump patch (0.7.4 → 0.7.5), tag, publish, install, restart
#   ./scripts/deploy-local.sh minor          # bump minor (0.7.4 → 0.8.0), tag, publish, install, restart
#   ./scripts/deploy-local.sh major          # bump major (0.7.4 → 1.0.0), tag, publish, install, restart
#   ./scripts/deploy-local.sh patch --local  # bump + local only (no npm publish)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSIONS_DIR="${HOME}/.openclaw/extensions/openclaw-plugin"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
LAUNCH_AGENT="gui/$(id -u)/ai.openclaw.gateway"

LOCAL_ONLY=false
BUMP_LEVEL=""
for arg in "$@"; do
  case "$arg" in
    --local)              LOCAL_ONLY=true ;;
    patch|minor|major)    BUMP_LEVEL="$arg" ;;
    --bump)               BUMP_LEVEL="patch" ;;  # backwards compat
    *)                    echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

# --- Optional: bump version ---
if [ -n "$BUMP_LEVEL" ]; then
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  case "$BUMP_LEVEL" in
    patch) NEXT_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
    minor) NEXT_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
    major) NEXT_VERSION="$((MAJOR + 1)).0.0" ;;
  esac
  echo "Bumping ${BUMP_LEVEL}: ${CURRENT_VERSION} → ${NEXT_VERSION}"
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
  find "$EXTENSIONS_DIR" -mindepth 1 -delete 2>/dev/null || true
fi
mkdir -p "$EXTENSIONS_DIR"

if $LOCAL_ONLY; then
  cp -R dist openclaw.plugin.json package.json LICENSE README.md "$EXTENSIONS_DIR/"
  [ -d dashboard/dist ] && mkdir -p "$EXTENSIONS_DIR/dashboard" && cp -R dashboard/dist "$EXTENSIONS_DIR/dashboard/"
  [ -d skills ] && cp -R skills "$EXTENSIONS_DIR/"
else
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
