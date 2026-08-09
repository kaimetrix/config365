#!/bin/sh
# Unified persistence: all state lives under /home/config365-data, exposed as /data.
#
#   Local Docker:  mount a named volume at /home/config365-data
#   Azure App Service: /home persists when WEBSITES_ENABLE_APP_SERVICE_STORAGE=true
#
# Sets CONFIG365_PERSIST_DIR (exported by caller).

set -e

PERSIST_ROOT="${CONFIG365_PERSIST_DIR:-${WEBAPP_STORAGE_HOME:-/home}/config365-data}"
mkdir -p "${PERSIST_ROOT}"

if [ -n "${WEBSITE_SITE_NAME:-}" ] && [ "${WEBSITES_ENABLE_APP_SERVICE_STORAGE:-false}" != "true" ]; then
  echo "[aio-init] WARNING: WEBSITES_ENABLE_APP_SERVICE_STORAGE is not 'true'."
  echo "[aio-init] WARNING: Config365 state under /home will NOT survive restarts."
  echo "[aio-init] WARNING: Set WEBSITES_ENABLE_APP_SERVICE_STORAGE=true in App Service Configuration."
fi

# Detect legacy data (volume or image layer mounted at /data before this layout).
_legacy_data_at_data() {
  [ -f /data/db/config365.db ] && [ "$(stat -c%s /data/db/config365.db 2>/dev/null || echo 0)" -gt 4096 ]
}

_persist_has_data() {
  [ -f "${PERSIST_ROOT}/db/config365.db" ] && [ "$(stat -c%s "${PERSIST_ROOT}/db/config365.db" 2>/dev/null || echo 0)" -gt 4096 ]
}

# One-time migration: legacy /data volume → /home/config365-data
if _legacy_data_at_data && ! _persist_has_data; then
  echo "[aio-init] Migrating legacy /data → ${PERSIST_ROOT}..."
  cp -a /data/. "${PERSIST_ROOT}/" 2>/dev/null || true
  echo "[aio-init] Migration complete."
fi

# Already linked to the persistent root
if [ -L /data ] && [ "$(readlink -f /data 2>/dev/null || readlink /data 2>/dev/null)" = "${PERSIST_ROOT}" ]; then
  echo "[aio-init] /data already linked to ${PERSIST_ROOT}."
  export CONFIG365_PERSIST_DIR="${PERSIST_ROOT}"
  return 0 2>/dev/null || exit 0
fi

# Already bind-mounted to the persistent root
if mountpoint -q /data 2>/dev/null && grep -q "${PERSIST_ROOT}" /proc/mounts 2>/dev/null; then
  echo "[aio-init] /data already bind-mounted to ${PERSIST_ROOT}."
  export CONFIG365_PERSIST_DIR="${PERSIST_ROOT}"
  return 0 2>/dev/null || exit 0
fi

# /data is a legacy Docker volume mount — bind persistent root over it
if mountpoint -q /data 2>/dev/null; then
  if mount --bind "${PERSIST_ROOT}" /data 2>/dev/null; then
    echo "[aio-init] Bind-mounted ${PERSIST_ROOT} → /data."
  else
    echo "[aio-init] ERROR: bind mount ${PERSIST_ROOT} → /data failed."
    return 1 2>/dev/null || exit 1
  fi
else
  rm -rf /data
  ln -sf "${PERSIST_ROOT}" /data
  echo "[aio-init] Symlinked /data → ${PERSIST_ROOT}."
fi

export CONFIG365_PERSIST_DIR="${PERSIST_ROOT}"
echo "[aio-init] Persistent data root: ${CONFIG365_PERSIST_DIR}"
