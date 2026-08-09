#!/bin/sh
# Download or refresh Microsoft IntuneWinAppUtil.exe (Win32 content prep tool).
# Used at Docker build and container startup. Falls back to bundled copy on failure.
#
# Environment:
#   INTUNE_WIN_APP_UTIL_UPDATE_TIMEOUT  Seconds for wget connect/read (default: 30)
#   INTUNE_WIN_APP_UTIL_DEST            Install path (default: /usr/local/share/config365/tools/IntuneWinAppUtil.exe)

set -e

URL="${INTUNE_WIN_APP_UTIL_URL:-https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/raw/master/IntuneWinAppUtil.exe}"
TIMEOUT="${INTUNE_WIN_APP_UTIL_UPDATE_TIMEOUT:-30}"
DEST="${INTUNE_WIN_APP_UTIL_DEST:-/usr/local/share/config365/tools/IntuneWinAppUtil.exe}"
FALLBACK="${INTUNE_WIN_APP_UTIL_FALLBACK:-/usr/local/share/config365/tools-fallback/IntuneWinAppUtil.exe}"

DEST_DIR="$(dirname "$DEST")"
mkdir -p "$DEST_DIR"

log() { echo "[intunewin-tool] $*"; }

use_fallback() {
  if [ -f "$FALLBACK" ]; then
    cp "$FALLBACK" "$DEST"
    chmod 755 "$DEST"
    log "Using bundled fallback copy at $FALLBACK"
    return 0
  fi
  if [ -f "$DEST" ]; then
    log "Update failed — keeping existing copy at $DEST"
    return 0
  fi
  log "ERROR: download failed and no bundled copy exists at $DEST or $FALLBACK"
  return 1
}

TMP="${DEST}.download.$$"
if wget -q --timeout="$TIMEOUT" --tries=1 -O "$TMP" "$URL" 2>/dev/null; then
  if [ ! -s "$TMP" ]; then
    rm -f "$TMP"
    log "Download returned empty file"
    use_fallback || exit 1
    exit 0
  fi
  mv "$TMP" "$DEST"
  chmod 755 "$DEST"
  log "Updated IntuneWinAppUtil.exe → $DEST"
  exit 0
fi

rm -f "$TMP"
log "Download timed out or failed (timeout=${TIMEOUT}s)"
use_fallback || exit 1
