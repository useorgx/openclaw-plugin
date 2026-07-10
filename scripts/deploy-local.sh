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
ORGX_EXTENSION_DIR="${HOME}/.openclaw/extensions/orgx"
LEGACY_EXTENSIONS_DIR="${HOME}/.openclaw/extensions/openclaw-plugin"
NPM_PLUGIN_DIR="${HOME}/.openclaw/npm/node_modules/@useorgx/openclaw-plugin"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
LAUNCH_AGENT="gui/$(id -u)/ai.openclaw.gateway"

LOCAL_ONLY=false
BUMP_LEVEL=""
STAGING_DIR=""
cleanup_staging() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup_staging EXIT

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

INSTALL_DIRS=()
if [ -d "$NPM_PLUGIN_DIR" ]; then
  INSTALL_DIRS+=("$NPM_PLUGIN_DIR")
elif [ -d "$ORGX_EXTENSION_DIR" ]; then
  INSTALL_DIRS+=("$ORGX_EXTENSION_DIR")
elif [ -d "$LEGACY_EXTENSIONS_DIR" ]; then
  INSTALL_DIRS+=("$LEGACY_EXTENSIONS_DIR")
else
  INSTALL_DIRS+=("$ORGX_EXTENSION_DIR")
fi

if ! $LOCAL_ONLY; then
  TMPDIR=$(mktemp -d)
  (cd "$TMPDIR" && npm pack "@useorgx/openclaw-plugin@${VERSION}" --silent && tar xzf *.tgz)
fi

for INSTALL_DIR in "${INSTALL_DIRS[@]}"; do
  echo "Installing to ${INSTALL_DIR}..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  STAGING_DIR=$(mktemp -d "${INSTALL_DIR}.staging.XXXXXX")

  if $LOCAL_ONLY; then
    cp -R dist openclaw.plugin.json package.json LICENSE README.md "$STAGING_DIR/"
    [ -d dashboard/dist ] && mkdir -p "$STAGING_DIR/dashboard" && cp -R dashboard/dist "$STAGING_DIR/dashboard/"
    [ -d skills ] && cp -R skills "$STAGING_DIR/"
    echo "Installing runtime dependencies for local plugin staging at ${STAGING_DIR}..."
    (cd "$STAGING_DIR" && npm install --omit=dev)
  else
    cp -R "$TMPDIR"/package/* "$STAGING_DIR/"
  fi

  BACKUP_DIR="${INSTALL_DIR}.previous.$$"
  if [ -e "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$BACKUP_DIR"
  fi
  if mv "$STAGING_DIR" "$INSTALL_DIR"; then
    STAGING_DIR=""
    [ ! -e "$BACKUP_DIR" ] || rm -rf "$BACKUP_DIR"
  else
    [ ! -e "$BACKUP_DIR" ] || mv "$BACKUP_DIR" "$INSTALL_DIR"
    exit 1
  fi
done

# --- Update config version ---
if [ -f "$CONFIG_FILE" ]; then
  sed -i '' "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"${VERSION}\"/" "$CONFIG_FILE"
fi

# --- Restart gateway ---
echo "Restarting gateway..."
launchctl kickstart -k "$LAUNCH_AGENT" 2>/dev/null || echo "Gateway not running as LaunchAgent; restart manually."

echo ""
echo "Deployed @useorgx/openclaw-plugin@${VERSION}"
printf "  Installed paths:\\n"
for INSTALL_DIR in "${INSTALL_DIRS[@]}"; do
  printf "    - %s\\n" "$INSTALL_DIR"
done
echo "  Gateway: restarted"
