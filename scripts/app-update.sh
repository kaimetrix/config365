#!/usr/bin/env bash
# app-update.sh — In-container app layer update helper (CLI).
# Usage: app-update.sh --check | --apply VERSION | --rollback
set -euo pipefail

DATA_APP="/data/app"
RELEASES="$DATA_APP/releases"
STAGING="$DATA_APP/staging"
CURRENT_LINK="$DATA_APP/current"
INSTALLED_VERSION="$DATA_APP/installed-version.json"
INSTALLED_PLATFORM="/data/init-data/installed-platform.json"
UPDATE_REPO="${CONFIG365_UPDATE_REPO:-potsolutions/config365-preview}"
GITHUB_TOKEN="${GITHUB_TOKEN:-${CONFIG365_GITHUB_TOKEN:-}}"

log() { echo "[app-update] $*"; }

installed_platform_version() {
  if [ -f "$INSTALLED_PLATFORM" ]; then
    python3 -c "import json; print(json.load(open('$INSTALLED_PLATFORM')).get('platformVersion', 1))" 2>/dev/null || echo 1
  else
    echo "${CONFIG365_PLATFORM_VERSION:-1}"
  fi
}

installed_app_version() {
  if [ -f "$INSTALLED_VERSION" ]; then
    python3 -c "import json; print(json.load(open('$INSTALLED_VERSION')).get('appVersion', '0.0.0'))" 2>/dev/null || cat "$DATA_APP/current/VERSION" 2>/dev/null || echo "0.0.0"
  elif [ -f "$DATA_APP/current/VERSION" ]; then
    cat "$DATA_APP/current/VERSION"
  elif [ -f /app/VERSION ]; then
    cat /app/VERSION
  else
    echo "0.0.0"
  fi
}

gh_curl() {
  local url="$1"
  local out="$2"
  local auth=()
  [ -n "$GITHUB_TOKEN" ] && auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  curl -fsSL "${auth[@]}" -H "Accept: application/vnd.github+json" -H "User-Agent: Config365-Updater" -o "$out" "$url"
}

download_release() {
  local version="$1"
  local release_dir="$RELEASES/$version"
  local asset="config365-app-${version}.tar.gz"
  local tar_path="$STAGING/${version}.tar.gz"
  mkdir -p "$RELEASES" "$STAGING"
  if [ -f "$release_dir/manifest.json" ]; then
    log "Release v${version} already extracted at $release_dir"
    return 0
  fi
  log "Downloading v${version} from GitHub…"
  local api="https://api.github.com/repos/${UPDATE_REPO}/releases/tags/v${version}"
  local meta="$STAGING/release-${version}.json"
  gh_curl "$api" "$meta"
  local url
  url=$(python3 -c "import json; assets=json.load(open('$meta')).get('assets',[]); print(next(a['browser_download_url'] for a in assets if a['name']=='$asset',''))")
  [ -n "$url" ] || { log "ERROR: asset $asset not found"; exit 1; }
  gh_curl "$url" "$tar_path"
  mkdir -p "$release_dir"
  tar -xzf "$tar_path" -C "$release_dir"
  rm -f "$tar_path" "$meta"
  log "Extracted to $release_dir"
}

verify_manifest_platform() {
  local manifest="$1"
  local required installed
  required=$(python3 -c "import json; print(json.load(open('$manifest')).get('requiredPlatformVersion', 1))")
  installed=$(installed_platform_version)
  if [ "${CONFIG365_SKIP_PLATFORM_CHECK:-}" = "1" ]; then
    log "WARN: platform check skipped (debug)"
    return 0
  fi
  if [ "$installed" -lt "$required" ]; then
    log "ERROR: required platform v${required}, installed v${installed}"
    return 1
  fi
  return 0
}

# App-only release tarballs never ship node_modules (better-sqlite3/mssql/@azure-*
# stay pinned to the image's baked-in /app/node_modules). ESM `import` ignores
# NODE_PATH but does walk up ancestor node_modules dirs like require() does, so a
# symlink at $DATA_APP/node_modules lets run-migrations.mjs and the swapped
# portal/token-api processes (all under $DATA_APP/...) resolve those packages.
ensure_node_modules_link() {
  if [ -e "$DATA_APP/node_modules" ] || [ -L "$DATA_APP/node_modules" ]; then
    return 0
  fi
  if [ -d /app/node_modules ]; then
    mkdir -p "$DATA_APP"
    ln -sfn /app/node_modules "$DATA_APP/node_modules"
  fi
}

run_migrations() {
  local release_dir="$1"
  local migrator="$release_dir/run-migrations.mjs"
  if [ ! -f "$migrator" ]; then
    log "No run-migrations.mjs in release — skipping schema step"
    return 0
  fi
  ensure_node_modules_link
  log "Running schema migrations..."
  node "$migrator"
}

swap_current() {
  local release_dir="$1"
  local version="$2"
  ensure_node_modules_link
  ln -sfn "$release_dir" "$CURRENT_LINK"
  python3 -c "import json; open('$INSTALLED_VERSION','w').write(json.dumps({'appVersion':'$version','installedAt':'$(date -Iseconds)'}))"
}

restart_portal() {
  if command -v supervisorctl >/dev/null 2>&1; then
    supervisorctl restart portal token-api || true
  fi
}

cmd_check() {
  log "Installed app: $(installed_app_version)"
  log "Installed platform: v$(installed_platform_version)"
}

cmd_apply() {
  local version="${1:-}"
  if [ -z "$version" ]; then
    log "ERROR: version required"
    exit 1
  fi
  download_release "$version"
  local release_dir="$RELEASES/$version"
  local manifest="$release_dir/manifest.json"
  if [ ! -f "$manifest" ]; then
    log "ERROR: manifest.json missing in $release_dir"
    exit 1
  fi
  verify_manifest_platform "$manifest" || exit 1
  run_migrations "$release_dir" || exit 1
  verify_manifest_platform "$manifest" || exit 1
  swap_current "$release_dir" "$version"
  restart_portal
  log "Applied app v${version}"
  log "Run scripts update via Platform Admin wizard (Gitea PR) or merge PR in Gitea manually."
}

cmd_rollback() {
  local prev
  prev=$(ls -1 "$RELEASES" 2>/dev/null | sort -V | tail -2 | head -1 || true)
  if [ -z "$prev" ]; then
    log "ERROR: no previous release"
    exit 1
  fi
  swap_current "$RELEASES/$prev" "$prev"
  restart_portal
  log "Rolled back to v${prev}"
}

case "${1:-}" in
  --check) cmd_check ;;
  --apply) shift; cmd_apply "${1:-}" ;;
  --rollback) cmd_rollback ;;
  *)
    echo "Usage: $0 --check | --apply VERSION | --rollback"
    exit 1
    ;;
esac
