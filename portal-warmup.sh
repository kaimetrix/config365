#!/bin/sh
# portal-warmup.sh — waits for Next.js to be ready, triggers and waits for
# the scripts sync, then sends warmup requests to pre-load the module bundle.
#
# Run once by supervisord (autorestart=false) at priority 20, after the portal
# starts (priority 10) but before the runner (priority 30).

HEALTH_URL="http://localhost:80/api/health"
SYNC_URL="http://localhost:80/api/health/sync-status"
WARMUP_URLS="http://localhost:80/setup http://localhost:80/login"
TIMEOUT_ATTEMPTS=120   # 120 × 2 s = 4 minutes max
SYNC_TIMEOUT=150       # 150 × 4 s = 10 minutes max (bootstrap + upload can be slow)

# ── 1. Wait for Next.js to accept connections ──────────────────────────────
echo "[portal-warmup] Waiting for Next.js to accept connections..."
ATTEMPTS=0
until wget -qO- "${HEALTH_URL}" > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$TIMEOUT_ATTEMPTS" ]; then
    echo "[portal-warmup] ERROR: portal did not become ready after $((TIMEOUT_ATTEMPTS * 2 / 60)) minutes — giving up."
    exit 1
  fi
  sleep 2
done
echo "[portal-warmup] Portal is up (attempt ${ATTEMPTS}). Sending warmup requests..."

# ── 2. Fire warmup GETs to pre-load the module bundle ──────────────────────
for URL in ${WARMUP_URLS}; do
  wget -qO- "${URL}" > /dev/null 2>&1 || true
  echo "[portal-warmup] Warmed: ${URL}"
done

# ── 3. Trigger and wait for scripts sync ───────────────────────────────────
# The first GET to /api/health/sync-status kicks off syncScriptsToGitea().
# We poll until synced=true so the runner never starts with stale scripts.
echo "[portal-warmup] Triggering scripts sync and waiting for completion..."
SYNC_ATTEMPTS=0
while true; do
  SYNC_ATTEMPTS=$((SYNC_ATTEMPTS + 1))
  if [ "$SYNC_ATTEMPTS" -ge "$SYNC_TIMEOUT" ]; then
    echo "[portal-warmup] WARNING: scripts sync did not complete after $((SYNC_TIMEOUT * 4 / 60)) minutes — proceeding anyway."
    break
  fi
  SYNC_RESULT=$(wget -qO- "${SYNC_URL}" 2>/dev/null)
  if echo "${SYNC_RESULT}" | grep -q '"synced":true'; then
    echo "[portal-warmup] Scripts sync complete (attempt ${SYNC_ATTEMPTS})."
    break
  fi
  sleep 4
done

echo "[portal-warmup] Warmup complete. Portal module cache and scripts are ready."
exit 0
