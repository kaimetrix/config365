#!/usr/bin/env bash
# backup-cron-wrapper.sh — Runs backup-gitea-blob.sh on a cron schedule.
#
# Schedule is read from platform_settings `gitea_backup_schedule`.
# Default: "0 2 * * *"  (daily at 02:00 UTC)
#
# This script is run by supervisord as [program:backup-scheduler].
# It loops forever, sleeping until the next scheduled time.

set -euo pipefail

BACKUP_SCRIPT="/usr/local/bin/backup-gitea-blob.sh"
LOG_FILE="/data/logs/gitea-backup.log"

mkdir -p "$(dirname "${LOG_FILE}")"

# Load the schedule from platform_settings
SCHEDULE=""
if command -v node > /dev/null 2>&1 && [ -f "/usr/local/bin/read-config.js" ]; then
  CONFIG_EXPORTS=$(node /usr/local/bin/read-config.js 2>/dev/null || true)
  if [ -n "${CONFIG_EXPORTS}" ]; then
    eval "${CONFIG_EXPORTS}"
  fi
fi

SCHEDULE="${C365_BACKUP_SCHEDULE:-0 2 * * *}"
echo "[backup-cron] Schedule: ${SCHEDULE}"

# Simple cron-like scheduler using `date` and sleep
# Parses cron minute and hour only (day/month/DOW treated as wildcard)
# For full cron support, install `crond` — this handles 95% of use cases.

while true; do
  NOW_EPOCH=$(date +%s)
  NOW_MIN=$(date -u +"%M" | sed 's/^0*//')
  NOW_HOUR=$(date -u +"%H" | sed 's/^0*//')
  NOW_MIN=${NOW_MIN:-0}
  NOW_HOUR=${NOW_HOUR:-0}

  # Parse schedule fields: minute hour ...
  CRON_MIN=$(echo "${SCHEDULE}"  | awk '{print $1}')
  CRON_HOUR=$(echo "${SCHEDULE}" | awk '{print $2}')

  # Resolve target minute/hour
  TARGET_MIN="${CRON_MIN//\*/0}"
  TARGET_HOUR="${CRON_HOUR//\*/0}"

  # Calculate seconds until next run
  NOW_SECS_IN_DAY=$(( NOW_HOUR * 3600 + NOW_MIN * 60 ))
  TARGET_SECS_IN_DAY=$(( TARGET_HOUR * 3600 + TARGET_MIN * 60 ))

  if [ "${CRON_MIN}" = "*" ] && [ "${CRON_HOUR}" = "*" ]; then
    # Run every minute
    SLEEP_SECS=60
  elif [ "${CRON_HOUR}" = "*" ]; then
    # Run every hour at minute X
    CURRENT_SEC_IN_HOUR=$(( NOW_MIN * 60 ))
    TARGET_SEC_IN_HOUR=$(( TARGET_MIN * 60 ))
    if [ "${CURRENT_SEC_IN_HOUR}" -lt "${TARGET_SEC_IN_HOUR}" ]; then
      SLEEP_SECS=$(( TARGET_SEC_IN_HOUR - CURRENT_SEC_IN_HOUR ))
    else
      SLEEP_SECS=$(( 3600 - CURRENT_SEC_IN_HOUR + TARGET_SEC_IN_HOUR ))
    fi
  else
    # Run at specific hour:minute (daily)
    if [ "${NOW_SECS_IN_DAY}" -lt "${TARGET_SECS_IN_DAY}" ]; then
      SLEEP_SECS=$(( TARGET_SECS_IN_DAY - NOW_SECS_IN_DAY ))
    else
      SLEEP_SECS=$(( 86400 - NOW_SECS_IN_DAY + TARGET_SECS_IN_DAY ))
    fi
  fi

  echo "[backup-cron] Next backup in ${SLEEP_SECS}s ($(date -u -d "${SLEEP_SECS} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"))"
  sleep "${SLEEP_SECS}"

  echo "[backup-cron] Starting backup at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" | tee -a "${LOG_FILE}"
  LOCK_FILE="/data/logs/gitea-blob-backup.lock"
  mkdir -p "$(dirname "${LOCK_FILE}")"
  set +e
  flock -n "${LOCK_FILE}" -c "C365_BACKUP_TRIGGER=cron bash '${BACKUP_SCRIPT}'" 2>&1 | tee -a "${LOG_FILE}"
  BACKUP_RC=${PIPESTATUS[0]}
  set -e
  if [ "${BACKUP_RC}" -ne 0 ]; then
    echo "[backup-cron] ERROR: Backup failed or another backup holds the lock (exit ${BACKUP_RC})" | tee -a "${LOG_FILE}"
  fi
  echo "[backup-cron] Backup cycle complete." | tee -a "${LOG_FILE}"

  # Small delay to avoid scheduling drift
  sleep 30
done
