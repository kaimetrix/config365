#!/bin/sh
# Download or refresh the cross-platform intunewin CLI (Linux-native Win32 packager).
# Used at Docker build and from Platform Admin. Falls back to existing copy on failure.
#
# Environment:
#   INTUNEWIN_CLI_UPDATE_TIMEOUT   Seconds for wget connect/read (default: 60)
#   INTUNEWIN_CLI_DEST             Install path (default: /usr/local/share/config365/tools/intunewin)
#   INTUNEWIN_CLI_VERSION_JSON     Metadata file (default: tools-fallback/intunewin.version.json)

set -e

TIMEOUT="${INTUNEWIN_CLI_UPDATE_TIMEOUT:-60}"
DEST="${INTUNEWIN_CLI_DEST:-/usr/local/share/config365/tools/intunewin}"
VERSION_JSON="${INTUNEWIN_CLI_VERSION_JSON:-/usr/local/share/config365/tools-fallback/intunewin.version.json}"
FALLBACK_DIR="$(dirname "$VERSION_JSON")"

log() { echo "[intunewin-cli] $*"; }

read_metadata() {
  if [ ! -f "$VERSION_JSON" ]; then
    log "ERROR: version metadata not found at $VERSION_JSON"
    return 1
  fi
  URL="$(node -e "const j=require(process.argv[1]); process.stdout.write(j.sourceUrl||'');" "$VERSION_JSON")"
  CHECKSUM="$(node -e "const j=require(process.argv[1]); process.stdout.write(j.checksumSha256||'');" "$VERSION_JSON")"
  INNER="$(node -e "const j=require(process.argv[1]); process.stdout.write(j.archiveInnerBinary||'intunewin');" "$VERSION_JSON")"
  if [ -z "$URL" ]; then
    log "ERROR: sourceUrl missing in $VERSION_JSON"
    return 1
  fi
}

verify_checksum() {
  file="$1"
  expected="$2"
  if [ -z "$expected" ]; then
    log "WARN: no checksum in metadata — skipping verification"
    return 0
  fi
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    log "ERROR: checksum mismatch (expected $expected, got $actual)"
    return 1
  fi
  log "Checksum verified"
  return 0
}

use_existing() {
  if [ -x "$DEST" ]; then
    log "Update failed — keeping existing copy at $DEST"
    return 0
  fi
  log "ERROR: download failed and no executable exists at $DEST"
  return 1
}

install_from_archive() {
  archive="$1"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT INT TERM

  tar -xzf "$archive" -C "$tmpdir"
  bin="$tmpdir/$INNER"
  if [ ! -f "$bin" ]; then
    bin="$(find "$tmpdir" -maxdepth 2 -type f -name "$INNER" | head -n 1)"
  fi
  if [ -z "$bin" ] || [ ! -f "$bin" ]; then
    log "ERROR: binary '$INNER' not found inside archive"
    return 1
  fi

  mkdir -p "$(dirname "$DEST")"
  cp "$bin" "$DEST"
  chmod 755 "$DEST"
  log "Installed intunewin CLI → $DEST"
}

read_metadata || exit 1

TMP="${DEST}.download.$$"
if wget -q --timeout="$TIMEOUT" --tries=1 -O "$TMP" "$URL" 2>/dev/null; then
  if [ ! -s "$TMP" ]; then
    rm -f "$TMP"
    log "Download returned empty file"
    use_existing || exit 1
    exit 0
  fi
  if ! verify_checksum "$TMP" "$CHECKSUM"; then
    rm -f "$TMP"
    use_existing || exit 1
    exit 0
  fi
  if install_from_archive "$TMP"; then
    rm -f "$TMP"
    exit 0
  fi
  rm -f "$TMP"
  use_existing || exit 1
  exit 0
fi

rm -f "$TMP"
log "Download timed out or failed (timeout=${TIMEOUT}s)"
use_existing || exit 1
