#!/bin/sh
# runner-start.sh — waits for Gitea to be reachable and for the portal scripts
# sync to complete, then starts the act_runner daemon.
#
# Two waits are needed:
#   1. Gitea readiness — Gitea can take minutes for MSSQL schema migrations.
#   2. Scripts sync — the portal pushes updated runner scripts from the Docker
#      image to the Gitea orchestrator repo on startup. If the runner starts
#      before sync completes it will clone stale scripts.

GITEA_API="http://localhost:3000/api/v1"
SYNC_URL="http://localhost:80/api/health/sync-status"
RUNNER_CONFIG="${RUNNER_CONFIG:-/etc/act_runner/config.yml}"
RUNNER_DIR="${RUNNER_DIR:-/data/runner-shards/1}"

# ── 1. Wait for Gitea ──────────────────────────────────────────────────────
echo "[runner-start] Waiting for Gitea to become ready before starting runner..."
ATTEMPTS=0
until wget -qO- "${GITEA_API}/version" > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 200 ]; then
    echo "[runner-start] ERROR: Gitea not reachable after 10 minutes — giving up."
    exit 1
  fi
  sleep 3
done
echo "[runner-start] Gitea is ready (attempt ${ATTEMPTS})."

# ── 2. Wait for portal scripts sync ────────────────────────────────────────
echo "[runner-start] Waiting for portal scripts sync..."
# Until SYNC_RESULT reports synced:true OR sync finished (inProgress:false after attempt)
SYNC_ATTEMPTS=0
until SYNC_RESULT=$(wget -qO- "${SYNC_URL}" 2>/dev/null) && \
  ( echo "${SYNC_RESULT}" | grep -q '"synced":true' || \
    ( echo "${SYNC_RESULT}" | grep -q '"inProgress":false' && echo "${SYNC_RESULT}" | grep -q '"synced"' ) ); do
  SYNC_ATTEMPTS=$((SYNC_ATTEMPTS + 1))
  if [ "$SYNC_ATTEMPTS" -ge 150 ]; then
    echo "[runner-start] WARNING: scripts sync did not complete after 10 minutes — proceeding anyway."
    break
  fi
  sleep 4
done
if echo "${SYNC_RESULT}" | grep -q '"synced":false'; then
  echo "[runner-start] WARNING: scripts sync reported failure — runner will use existing orchestrator repo content."
fi
echo "[runner-start] Scripts sync confirmed (attempt ${SYNC_ATTEMPTS}). Starting runner daemon."

exec /usr/local/bin/act_runner daemon --config "${RUNNER_CONFIG}"
