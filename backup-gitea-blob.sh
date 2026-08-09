#!/usr/bin/env bash
# backup-gitea-blob.sh — Orchestrates Gitea backup and upload to Azure Blob Storage.
#
# Flow:
#   1. Load settings from platform_settings (via read-config.js)
#   2. Check that blob storage is configured — exit if not
#   3. Wait until no Gitea Actions are running (up to 10 min)
#   4. Stop Gitea (for consistent dump)
#   5. Run `gitea dump` to create a zip archive
#   6. Restart Gitea
#   7. Upload archive to Azure Blob Storage
#   8. Prune blobs older than retention period
#   9. Append a success/failed record to gitea-backup-history.jsonl
#
# Settings read from platform_settings:
#   C365_BLOB_CONTAINER          — blob container name (required)
#   C365_BLOB_STORAGE_URI        — storage account URI for managed identity auth
#   C365_BLOB_CONNECTION_STRING  — full connection string (key-based auth)
#   C365_BACKUP_RETENTION_DAYS   — days to keep old backups (default: 30)
#   C365_BACKUP_TRIGGER          — "cron" (default) or "manual"
#
# Required tools in container: az (Azure CLI), supervisorctl, gitea

set -euo pipefail

HISTORY_FILE="${HISTORY_FILE:-/data/logs/gitea-backup-history.jsonl}"
HISTORY_MAX="${HISTORY_MAX:-200}"
TRIGGER="${C365_BACKUP_TRIGGER:-cron}"

BACKUP_TRACKED=0
BACKUP_FINALIZED=0
BACKUP_STATUS="failed"
BACKUP_ERROR=""
BACKUP_SIZE_BYTES=""
ARCHIVE_NAME=""
CONTAINER=""

# ── History helpers ───────────────────────────────────────────────────────────
append_history_record() {
  local status="$1"
  local error="${2:-}"
  local size_bytes="${3:-}"
  mkdir -p "$(dirname "${HISTORY_FILE}")"
  ARCHIVE_NAME="${ARCHIVE_NAME}" \
  CONTAINER="${CONTAINER}" \
  C365_BACKUP_TRIGGER="${TRIGGER}" \
  node -e '
const fs = require("fs");
const path = process.argv[1];
const status = process.argv[2];
const sizeRaw = process.argv[3] || "";
const error = process.argv[4] || "";
const max = parseInt(process.argv[5] || "200", 10);
const rec = {
  ts: new Date().toISOString(),
  archiveName: process.env.ARCHIVE_NAME || "",
  status,
  trigger: process.env.C365_BACKUP_TRIGGER || "cron",
  container: process.env.CONTAINER || "",
};
if (sizeRaw) rec.sizeBytes = Number(sizeRaw);
if (error) rec.error = error;
fs.appendFileSync(path, JSON.stringify(rec) + "\n");
try {
  const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > max) {
    fs.writeFileSync(path, lines.slice(-max).join("\n") + "\n");
  }
} catch {}
' "${HISTORY_FILE}" "${status}" "${size_bytes}" "${error}" "${HISTORY_MAX}" 2>/dev/null || true
}

finalize_history() {
  if [ "${BACKUP_TRACKED}" != "1" ] || [ "${BACKUP_FINALIZED}" = "1" ]; then
    return 0
  fi
  BACKUP_FINALIZED=1
  if [ "${BACKUP_STATUS}" = "failed" ] && [ -z "${BACKUP_ERROR}" ]; then
    BACKUP_ERROR="Backup failed"
  fi
  append_history_record "${BACKUP_STATUS}" "${BACKUP_ERROR}" "${BACKUP_SIZE_BYTES}"
}

trap finalize_history EXIT

# ── Load platform config ────────────────────────────────────────────────────
if [ -f "/usr/local/bin/read-config.js" ] && command -v node > /dev/null 2>&1; then
  CONFIG_EXPORTS=$(node /usr/local/bin/read-config.js 2>/dev/null || true)
  if [ -n "${CONFIG_EXPORTS}" ]; then
    eval "${CONFIG_EXPORTS}"
  fi
fi

# ── Validate required settings ──────────────────────────────────────────────
if [ -z "${C365_BLOB_CONTAINER:-}" ]; then
  echo "[backup] ERROR: blob_storage_container not configured — skipping backup."
  exit 0
fi

if [ -z "${C365_BLOB_STORAGE_URI:-}" ] && [ -z "${C365_BLOB_CONNECTION_STRING:-}" ]; then
  echo "[backup] ERROR: Neither blob_storage_uri nor blob_storage_connection_string is configured — skipping."
  exit 0
fi

CONTAINER="${C365_BLOB_CONTAINER}"
RETENTION_DAYS="${C365_BACKUP_RETENTION_DAYS:-30}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/gitea-backup}"
GITEA_DATA="${GITEA_DATA:-/data/gitea}"
GITEA_BIN="${GITEA_BIN:-/usr/local/bin/gitea}"
GITEA_APP_INI="${GITEA_APP_INI:-/data/gitea/conf/app.ini}"

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
ARCHIVE_NAME="gitea-backup-${TIMESTAMP}.zip"
BACKUP_TRACKED=1

echo "[backup] ── Gitea Backup to Azure Blob Storage ────────────────────────"
echo "[backup] Container: ${CONTAINER}"
echo "[backup] Timestamp: ${TIMESTAMP}"
echo "[backup] Retention: ${RETENTION_DAYS} days"
echo "[backup] Trigger: ${TRIGGER}"

# ── Wait for running Gitea Actions to complete ──────────────────────────────
GITEA_URL="${GITEA_URL:-http://localhost:3000}"
GITEA_TOKEN="${GITEA_TOKEN:-}"

# Try to read Gitea token from platform_settings if not set in env
if [ -z "${GITEA_TOKEN}" ] && command -v node > /dev/null 2>&1; then
  GITEA_TOKEN_RAW=$(node -e "
    try {
      const Database = require('/app/node_modules/better-sqlite3');
      const db = new Database(process.env.DB_PATH || process.env.MAIN_DB_PATH || '/data/db/config365.db', { readonly: true });
      const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get('gitea_token');
      if (row) process.stdout.write(row.value);
      db.close();
    } catch {}
  " 2>/dev/null || true)
  GITEA_TOKEN="${GITEA_TOKEN_RAW:-}"
fi

WAIT_INTERVAL=30
MAX_WAIT_SECONDS=600
WAITED=0

if [ -n "${GITEA_TOKEN}" ]; then
  echo "[backup] Checking for running Gitea Actions..."

  # count_running_jobs: lists all repos via Gitea admin API, then checks each
  # for in-progress workflow runs. Returns the total count of running jobs.
  count_running_jobs() {
    node - <<'NODESCRIPT'
const http = require('http');

const BASE    = process.env.GITEA_URL || 'http://localhost:3000';
const TOKEN   = process.env.GITEA_TOKEN || '';
const headers = { Authorization: `token ${TOKEN}`, Accept: 'application/json' };

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${path}`;
    const mod = url.startsWith('https') ? require('https') : http;
    const req = mod.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
  });
}

async function main() {
  let running = 0;
  try {
    // Page through all repos (up to 500)
    for (let page = 1; page <= 10; page++) {
      const data = await get(`/api/v1/repos/search?limit=50&page=${page}&token=${TOKEN}`);
      const repos = data?.data ?? [];
      if (repos.length === 0) break;

      // Check each repo for running workflow runs (status=running)
      await Promise.all(repos.map(async (repo) => {
        try {
          const runs = await get(`/api/v1/repos/${repo.full_name}/actions/runs?status=running&limit=1`);
          if (runs?.workflow_runs?.length > 0) running += runs.workflow_runs.length;
          else if (runs?.total_count > 0) running += runs.total_count;
        } catch { /* repo may not have actions enabled */ }
      }));
    }
  } catch (e) {
    process.stderr.write(`[backup] drain-check error: ${e.message}\n`);
  }
  process.stdout.write(String(running) + '\n');
}

main().catch(() => process.stdout.write('0\n'));
NODESCRIPT
  }

  while [ ${WAITED} -lt ${MAX_WAIT_SECONDS} ]; do
    RUNNING=$(GITEA_URL="${GITEA_URL}" GITEA_TOKEN="${GITEA_TOKEN}" count_running_jobs 2>/dev/null || echo "0")
    RUNNING="${RUNNING//[^0-9]/}"   # strip any stray whitespace
    RUNNING="${RUNNING:-0}"

    if [ "${RUNNING}" = "0" ]; then
      echo "[backup] No running actions detected — proceeding."
      break
    fi
    echo "[backup] ${RUNNING} action(s) still running — waiting ${WAIT_INTERVAL}s..."
    sleep "${WAIT_INTERVAL}"
    WAITED=$((WAITED + WAIT_INTERVAL))
  done

  if [ ${WAITED} -ge ${MAX_WAIT_SECONDS} ]; then
    echo "[backup] WARNING: Timed out waiting for actions to complete (${MAX_WAIT_SECONDS}s). Proceeding anyway."
  fi
else
  echo "[backup] No Gitea token available — skipping action drain check."
fi

# ── Stop Gitea ──────────────────────────────────────────────────────────────
echo "[backup] Stopping Gitea via supervisorctl..."
supervisorctl stop gitea 2>/dev/null || true
sleep 5

# ── Create backup archive ───────────────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"
chown git:git "${BACKUP_DIR}" 2>/dev/null || chmod 1777 "${BACKUP_DIR}" 2>/dev/null || true
cd "${BACKUP_DIR}"

echo "[backup] Running gitea dump (as git user)..."
DUMP_LOG=$(mktemp)
set +e
su -s /bin/bash git -c "GITEA_WORK_DIR=\"${GITEA_DATA}\" \"${GITEA_BIN}\" dump \
  --config \"${GITEA_APP_INI}\" \
  --file \"${BACKUP_DIR}/${ARCHIVE_NAME}\" \
  --type zip" > "${DUMP_LOG}" 2>&1
DUMP_RC=$?
set -e
sed 's/^/[gitea-dump] /' "${DUMP_LOG}"

if [ "${DUMP_RC}" -ne 0 ] || [ ! -f "${BACKUP_DIR}/${ARCHIVE_NAME}" ]; then
  BACKUP_ERROR=$(grep -E '\[F\]|mustNotRunAsRoot|ERROR' "${DUMP_LOG}" | tail -1 | sed 's/^[[:space:]]*//' || true)
  if [ -z "${BACKUP_ERROR}" ]; then
    BACKUP_ERROR="gitea dump failed (exit ${DUMP_RC})"
  fi
  rm -f "${DUMP_LOG}"
  echo "[backup] ERROR: gitea dump did not produce an archive (exit ${DUMP_RC})!"
  supervisorctl start gitea 2>/dev/null || true
  exit 1
fi
rm -f "${DUMP_LOG}"

BACKUP_SIZE_BYTES=$(stat -c%s "${BACKUP_DIR}/${ARCHIVE_NAME}" 2>/dev/null || \
                    stat -f%z "${BACKUP_DIR}/${ARCHIVE_NAME}" 2>/dev/null || echo "")
ARCHIVE_SIZE=$(du -sh "${BACKUP_DIR}/${ARCHIVE_NAME}" | cut -f1)
echo "[backup] Archive created: ${ARCHIVE_NAME} (${ARCHIVE_SIZE})"

# ── Restart Gitea ───────────────────────────────────────────────────────────
echo "[backup] Restarting Gitea..."
supervisorctl start gitea 2>/dev/null || true

# ── Upload to Azure Blob Storage ────────────────────────────────────────────
echo "[backup] Uploading to Azure Blob Storage (${ARCHIVE_SIZE:-unknown size})..."

UPLOAD_LOG=$(mktemp)
set +e
if [ -n "${C365_BLOB_CONNECTION_STRING:-}" ]; then
  az storage blob upload \
    --connection-string "${C365_BLOB_CONNECTION_STRING}" \
    --container-name "${CONTAINER}" \
    --name "${ARCHIVE_NAME}" \
    --file "${BACKUP_DIR}/${ARCHIVE_NAME}" \
    --overwrite \
    > "${UPLOAD_LOG}" 2>&1
  UPLOAD_RC=$?
elif [ -n "${C365_BLOB_STORAGE_URI:-}" ]; then
  az storage blob upload \
    --account-url "${C365_BLOB_STORAGE_URI}" \
    --container-name "${CONTAINER}" \
    --name "${ARCHIVE_NAME}" \
    --file "${BACKUP_DIR}/${ARCHIVE_NAME}" \
    --auth-mode login \
    --overwrite \
    > "${UPLOAD_LOG}" 2>&1
  UPLOAD_RC=$?
else
  UPLOAD_RC=1
  echo "Neither blob_storage_uri nor blob_storage_connection_string is configured" > "${UPLOAD_LOG}"
fi
set -e
sed 's/^/[az-upload] /' "${UPLOAD_LOG}"
if [ "${UPLOAD_RC}" -ne 0 ]; then
  BACKUP_ERROR=$(grep -Ei 'error|failed|denied' "${UPLOAD_LOG}" | tail -1 | sed 's/^[[:space:]]*//' || true)
  if [ -z "${BACKUP_ERROR}" ]; then
    BACKUP_ERROR="Azure Blob upload failed (exit ${UPLOAD_RC})"
  fi
  rm -f "${UPLOAD_LOG}" "${BACKUP_DIR}/${ARCHIVE_NAME}"
  echo "[backup] ERROR: Azure Blob upload failed (exit ${UPLOAD_RC})"
  exit 1
fi
rm -f "${UPLOAD_LOG}"

echo "[backup] Upload complete: ${ARCHIVE_NAME}"

# ── Prune old blobs ─────────────────────────────────────────────────────────
echo "[backup] Pruning blobs older than ${RETENTION_DAYS} days..."
CUTOFF_DATE=$(date -u -d "${RETENTION_DAYS} days ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
              date -u -v-${RETENTION_DAYS}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)

if [ -n "${CUTOFF_DATE}" ]; then
  if [ -n "${C365_BLOB_CONNECTION_STRING:-}" ]; then
    az storage blob list \
      --connection-string "${C365_BLOB_CONNECTION_STRING}" \
      --container-name "${CONTAINER}" \
      --prefix "gitea-backup-" \
      --query "[?properties.lastModified<'${CUTOFF_DATE}'].name" \
      --output tsv 2>/dev/null | while read -r blobName; do
      echo "[backup] Deleting old blob: ${blobName}"
      az storage blob delete \
        --connection-string "${C365_BLOB_CONNECTION_STRING}" \
        --container-name "${CONTAINER}" \
        --name "${blobName}" 2>/dev/null || true
    done
  elif [ -n "${C365_BLOB_STORAGE_URI:-}" ]; then
    az storage blob list \
      --account-url "${C365_BLOB_STORAGE_URI}" \
      --container-name "${CONTAINER}" \
      --prefix "gitea-backup-" \
      --query "[?properties.lastModified<'${CUTOFF_DATE}'].name" \
      --auth-mode login \
      --output tsv 2>/dev/null | while read -r blobName; do
      echo "[backup] Deleting old blob: ${blobName}"
      az storage blob delete \
        --account-url "${C365_BLOB_STORAGE_URI}" \
        --container-name "${CONTAINER}" \
        --name "${blobName}" \
        --auth-mode login 2>/dev/null || true
    done
  fi
fi

# ── Cleanup local archive ───────────────────────────────────────────────────
rm -f "${BACKUP_DIR}/${ARCHIVE_NAME}"
BACKUP_STATUS="success"
BACKUP_ERROR=""
echo "[backup] ✓ Backup complete: ${ARCHIVE_NAME}"
