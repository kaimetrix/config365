#!/bin/sh
# ─── Config365 — All-in-One Container Entrypoint ─────────────────────────────
# Runs sequentially before handing off to supervisord:
#
#   1. Create directory structure under /data
#   2. Generate Gitea app.ini on first run
#   3. Start Gitea temporarily (background)
#   4. Wait for Gitea API to become ready
#   5. First-run: create admin user, portal token, runner registration token
#   6. Register act_runner against Gitea (if not already registered)
#   7. Stop the temporary Gitea process
#   8. exec supervisord → manages gitea, portal, runner as PID 1
#
# Environment variables (pass via Docker / Azure Container Apps):
#   SESSION_SECRET          Required — 32+ char random string for iron-session
#   GITEA_ORG               Gitea org for Config365 (default: config365)
#   GITEA_RUNNER_NAME       Runner display name prefix (default: config365-runner; shards use -1, -2, …)
#   RUNNER_SHARDS           Parallel host-mode workers (default: 4, max 8)
#   RUNNER_MODE             sharded (default) or docker (local dev with docker.sock)
#   PLATFORM_ADMIN_OIDS     Comma-separated Entra ID OIDs for emergency admin access
#   PUBLIC_URL              Public origin (https://… on Azure). Used for OAuth and Secure cookies.
#   SECURE_COOKIES          Optional override (true|false). Unset: true when PUBLIC_URL is https.

set -e

# ── Persist /data via /home/config365-data (local Docker + Azure App Service) ─
if [ -f /usr/local/bin/persist-data.sh ]; then
  # shellcheck disable=SC1091
  . /usr/local/bin/persist-data.sh
fi

DATA_DIR="/data"
GITEA_DATA="${DATA_DIR}/gitea"
GITEA_INTERNAL="${DATA_DIR}/gitea-internal"
INIT_DATA="${DATA_DIR}/init-data"
RUNNER_DIR="${DATA_DIR}/runner"
RUNNER_SHARDS_ROOT="${DATA_DIR}/runner-shards"
RUNNER_MODE="${RUNNER_MODE:-sharded}"
DB_DIR="${DATA_DIR}/db"

# ── Load platform_settings from SQLite config DB ──────────────────────────────
# read-config.js outputs shell exports for Gitea DB, blob storage, etc.
# On first boot the DB doesn't exist yet — the script exits cleanly with no output.
if [ -f "/usr/local/bin/read-config.js" ] && command -v node > /dev/null 2>&1; then
  CONFIG_EXPORTS=$(node /usr/local/bin/read-config.js 2>/dev/null || true)
  if [ -n "${CONFIG_EXPORTS}" ]; then
    eval "${CONFIG_EXPORTS}"
    echo "[aio-init] Loaded platform config from SQLite settings."
  fi
fi

# ── Optional: redirect Gitea work dir to external mount (e.g. Azure Files) ───
# When GITEA_EXTERNAL_DIR is set, conf, repos, LFS, logs, and custom templates
# move to the external mount. SQLite DB and LevelDB queues are always pinned to
# the internal /data/gitea-internal path — SMB shares cannot host either safely.
if [ -n "${GITEA_EXTERNAL_DIR}" ]; then
  GITEA_DATA="${GITEA_EXTERNAL_DIR}"
  echo "[aio-init] Gitea external storage enabled → ${GITEA_EXTERNAL_DIR}"
  if [ ! -d "${GITEA_EXTERNAL_DIR}" ]; then
    echo "[aio-init] WARNING: ${GITEA_EXTERNAL_DIR} does not exist — verify the Azure Files share is mounted before starting."
  elif [ -z "$(ls -A "${GITEA_EXTERNAL_DIR}" 2>/dev/null)" ]; then
    echo "[aio-init] INFO: ${GITEA_EXTERNAL_DIR} is empty — first-run will initialise it."
  fi
fi

SENTINEL="${INIT_DATA}/.initialized"
TOKEN_FILE="${INIT_DATA}/portal-token.txt"
RUNNER_TOKEN_FILE="${INIT_DATA}/runner-token.txt"

GITEA_BIN="/usr/local/bin/gitea"
GITEA_CONFIG="${GITEA_DATA}/conf/app.ini"
ADMIN_USER="config365-admin"
GITEA_API="http://localhost:3000/api/v1"

# ── Create init-data directory early (needed before session secret write) ────
mkdir -p "${INIT_DATA}"

# ── Auto-generate SESSION_SECRET if not supplied ─────────────────────────────
# Persisted to disk so it survives container restarts without losing active
# sessions. Stored under /data (mounted volume) so it's not baked into the image.
SESSION_SECRET_FILE="${INIT_DATA}/session-secret.txt"
if [ -z "${SESSION_SECRET}" ]; then
  if [ -f "${SESSION_SECRET_FILE}" ]; then
    SESSION_SECRET=$(cat "${SESSION_SECRET_FILE}")
    echo "[aio-init] Loaded existing SESSION_SECRET from ${SESSION_SECRET_FILE}."
  else
    SESSION_SECRET=$(cat /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 64)
    echo "[aio-init] Generated new SESSION_SECRET."
  fi
fi
# Always persist (idempotent write)
printf '%s' "${SESSION_SECRET}" > "${SESSION_SECRET_FILE}"
chmod 600 "${SESSION_SECRET_FILE}"

# ── Create directory structure ────────────────────────────────────────────────
echo "[aio-init] Ensuring directory structure under ${DATA_DIR}..."
mkdir -p \
  "${GITEA_DATA}/conf" \
  "${GITEA_DATA}/data" \
  "${GITEA_DATA}/log" \
  "${GITEA_DATA}/custom" \
  "${GITEA_INTERNAL}" \
  "${INIT_DATA}" \
  "${RUNNER_DIR}" \
  "${DB_DIR}"

# ── Generate Gitea app.ini on first run ───────────────────────────────────────
# Must happen before chown so the generated file ends up owned by git
if [ ! -f "${GITEA_CONFIG}" ]; then
  echo "[aio-init] Generating Gitea configuration..."
  cat > "${GITEA_CONFIG}" << 'EOINI'
APP_NAME = Config365

[server]
HTTP_PORT             = 3000
HTTP_ADDR             = 0.0.0.0
ROOT_URL              = %(GITEA_ROOT_URL)s
PUBLIC_URL_DETECTION  = auto
DISABLE_SSH           = true
SSH_DOMAIN            = localhost

[database]
DB_TYPE  = %(GITEA_DB_TYPE_PLACEHOLDER)s
PATH     = /data/gitea/data/gitea.db
HOST     = %(GITEA_DB_HOST_PLACEHOLDER)s
NAME     = %(GITEA_DB_NAME_PLACEHOLDER)s
USER     = %(GITEA_DB_USER_PLACEHOLDER)s
PASSWD   = %(GITEA_DB_PASSWD_PLACEHOLDER)s
SSL_MODE = disable

[repository]
ROOT = data/repositories

[log]
MODE      = console
LEVEL     = info
ROOT_PATH = log

[security]
INSTALL_LOCK   = true
SECRET_KEY     = %(GITEA_SECRET_KEY)s
INTERNAL_TOKEN = %(GITEA_INTERNAL_TOKEN)s

[service]
DISABLE_REGISTRATION              = true
REQUIRE_SIGNIN_VIEW               = false
ENABLE_NOTIFY_MAIL                = false
DEFAULT_KEEP_EMAIL_PRIVATE        = true

[queue]
DATADIR = /data/gitea/data/queues

[actions]
ENABLED              = true
DEFAULT_ACTIONS_URL  = github

[picture]
DISABLE_GRAVATAR = true

[mailer]
ENABLED = false
EOINI

  # Substitute runtime values into the config
  GITEA_SECRET_KEY=$(cat /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 64)
  GITEA_INTERNAL_TOKEN=$(cat /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 64)
  # Default public Gitea URL before setup wizard saves gitea_external_url.
  # PORTAL_HTTP_PORT is the Docker-published host port (8080 local dev; 80 on Azure).
  _config365_default_gitea_root_url() {
    if [ -n "${WEBSITE_SITE_NAME:-}" ]; then
      printf '%s' 'http://localhost/gitea/'
      return
    fi
    _port="${PORTAL_HTTP_PORT:-8080}"
    if [ "${_port}" = "80" ]; then
      printf '%s' 'http://localhost/gitea/'
    else
      printf '%s' "http://localhost:${_port}/gitea/"
    fi
  }
  GITEA_ROOT_URL="${GITEA_EXTERNAL_URL:-$(_config365_default_gitea_root_url)}"

  # Determine database type — default to sqlite3 unless MSSQL is configured
  _GITEA_DB_TYPE="${GITEA_DB_TYPE:-sqlite3}"
  _GITEA_DB_HOST="${GITEA_DB_HOST:-}"
  _GITEA_DB_NAME="${GITEA_DB_NAME:-gitea}"
  _GITEA_DB_USER="${GITEA_DB_USER:-}"
  _GITEA_DB_PASSWD="${GITEA_DB_PASSWD:-}"

  sed -i \
    -e "s|%(GITEA_SECRET_KEY)s|${GITEA_SECRET_KEY}|g" \
    -e "s|%(GITEA_INTERNAL_TOKEN)s|${GITEA_INTERNAL_TOKEN}|g" \
    -e "s|%(GITEA_ROOT_URL)s|${GITEA_ROOT_URL}|g" \
    -e "s|%(GITEA_DB_TYPE_PLACEHOLDER)s|${_GITEA_DB_TYPE}|g" \
    -e "s|%(GITEA_DB_HOST_PLACEHOLDER)s|${_GITEA_DB_HOST}|g" \
    -e "s|%(GITEA_DB_NAME_PLACEHOLDER)s|${_GITEA_DB_NAME}|g" \
    -e "s|%(GITEA_DB_USER_PLACEHOLDER)s|${_GITEA_DB_USER}|g" \
    -e "s|%(GITEA_DB_PASSWD_PLACEHOLDER)s|${_GITEA_DB_PASSWD}|g" \
    "${GITEA_CONFIG}"

  echo "[aio-init] Gitea app.ini written (DB type: ${_GITEA_DB_TYPE})."
fi

# Re-apply ROOT_URL on every startup when gitea_external_url is saved in
# platform_settings (setup wizard or admin UI) and exported by read-config.js.
if [ -n "${GITEA_EXTERNAL_URL}" ] && [ -f "${GITEA_CONFIG}" ]; then
  sed -i "s|^ROOT_URL[[:space:]]*=.*|ROOT_URL              = ${GITEA_EXTERNAL_URL}|" "${GITEA_CONFIG}"
  echo "[aio-init] Updated ROOT_URL in app.ini → ${GITEA_EXTERNAL_URL}"
fi

# act_runner talks to Gitea on :3000; artifact upload URLs must not include the
# /gitea/ subpath from ROOT_URL. PUBLIC_URL_DETECTION=auto derives URLs from
# the request Host (internal :3000 vs Caddy /gitea/ in the browser).
if [ -f "${GITEA_CONFIG}" ]; then
  if grep -q '^PUBLIC_URL_DETECTION' "${GITEA_CONFIG}" 2>/dev/null; then
    sed -i 's|^PUBLIC_URL_DETECTION[[:space:]]*=.*|PUBLIC_URL_DETECTION  = auto|' "${GITEA_CONFIG}"
  else
    sed -i '/^ROOT_URL[[:space:]]*=/a PUBLIC_URL_DETECTION  = auto' "${GITEA_CONFIG}"
  fi
  echo "[aio-init] Ensured PUBLIC_URL_DETECTION=auto in app.ini"
fi

# Re-apply database settings on every startup when GITEA_DB_TYPE is configured
# via the setup wizard (saved to platform_settings, exported by read-config.js).
# The app.ini is only written on first boot, so without this block a DB change
# made in the wizard would never take effect after restart.
if [ -n "${GITEA_DB_TYPE}" ] && [ "${GITEA_DB_TYPE}" != "sqlite3" ] && [ -f "${GITEA_CONFIG}" ]; then
  sed -i "s|^DB_TYPE[[:space:]]*=.*|DB_TYPE  = ${GITEA_DB_TYPE}|"   "${GITEA_CONFIG}"
  sed -i "s|^HOST[[:space:]]*=.*|HOST     = ${GITEA_DB_HOST:-}|"    "${GITEA_CONFIG}"
  sed -i "s|^NAME[[:space:]]*=.*|NAME     = ${GITEA_DB_NAME:-gitea}|" "${GITEA_CONFIG}"
  sed -i "s|^USER[[:space:]]*=.*|USER     = ${GITEA_DB_USER:-}|"    "${GITEA_CONFIG}"
  sed -i "s|^PASSWD[[:space:]]*=.*|PASSWD   = ${GITEA_DB_PASSWD:-}|" "${GITEA_CONFIG}"
  echo "[aio-init] Updated Gitea app.ini database config → DB_TYPE=${GITEA_DB_TYPE}, HOST=${GITEA_DB_HOST:-}, NAME=${GITEA_DB_NAME:-gitea}"
fi

# ── When GITEA_EXTERNAL_DIR is set: pin SQLite/queues to internal storage ────
# Run on every boot so these paths are always correct even if app.ini was
# copied from an old install or manually edited.
if [ -n "${GITEA_EXTERNAL_DIR}" ] && [ -f "${GITEA_CONFIG}" ]; then
  # Migrate repo ROOT if it still carries the old absolute internal path
  sed -i "s|^ROOT[[:space:]]*=.*/data/gitea/data/repositories|ROOT = data/repositories|" "${GITEA_CONFIG}"
  # Force SQLite path to internal volume (SMB cannot host SQLite safely)
  sed -i "s|^PATH[[:space:]]*=.*gitea\.db|PATH     = /data/gitea-internal/gitea.db|" "${GITEA_CONFIG}"
  # Force LevelDB queue dir to internal volume (SMB locking breaks queues)
  if grep -q '^\[queue\]' "${GITEA_CONFIG}" 2>/dev/null; then
    sed -i '/^\[queue\]/,/^\[/{s|^DATADIR[[:space:]]*=.*|DATADIR = /data/gitea-internal/queues|}' "${GITEA_CONFIG}"
  else
    printf '\n[queue]\nDATADIR = /data/gitea-internal/queues\n' >> "${GITEA_CONFIG}"
  fi
  echo "[aio-init] External dir: SQLite → /data/gitea-internal/gitea.db, queues → /data/gitea-internal/queues"
fi

# Gitea refuses to run as root — set ownership AFTER generating app.ini so the
# file ends up git-owned and Gitea can write JWT secrets into it on first start.
# When GITEA_EXTERNAL_DIR is set (Azure Files SMB), skip chown on the external
# path — SMB shares do not support POSIX ownership; use uid=/gid= mount options
# on the share itself to ensure the git user (UID 1000) has write access.
chown -R git:git "${GITEA_INTERNAL}" "${INIT_DATA}"
if [ -n "${GITEA_EXTERNAL_DIR}" ]; then
  chown -R git:git "${GITEA_EXTERNAL_DIR}" 2>/dev/null || true
else
  chown -R git:git "${GITEA_DATA}"
fi

# ── Runner shards (parallel host-mode workers) ────────────────────────────────
# Generates /etc/supervisord.d/runners.conf before supervisord starts.
# Registration with Gitea happens during bootstrap when the sentinel exists.
mkdir -p "${RUNNER_SHARDS_ROOT}" /etc/supervisord.d
/usr/local/bin/setup-runner-shards.sh || echo "[aio-init] WARNING: setup-runner-shards failed (non-fatal on first run)."

# ── App layer (/data/app/current) vs baked-in /app ───────────────────────────
APP_PORTAL_DIR="/app"
APP_TOKEN_API="/app/token-api-server.mjs"
SCRIPTS_DIR="/scripts-staging"
PIPELINES_DIR="/pipeline-templates-staging"

# App-only update tarballs never ship node_modules — better-sqlite3/mssql/@azure-*
# stay pinned to the image's baked-in /app/node_modules. Node's bare-specifier
# resolution (CJS require and ESM import alike) walks up ancestor node_modules
# dirs, so this symlink lets anything under /data/app/... (run-migrations.mjs,
# the swapped portal/token-api processes) resolve those packages. Self-healing
# on every boot in case the volume predates this fix or the link was removed.
if [ -d /app/node_modules ] && [ ! -e /data/app/node_modules ]; then
  mkdir -p /data/app
  ln -sfn /app/node_modules /data/app/node_modules
  echo "[aio-init] Linked /data/app/node_modules -> /app/node_modules"
fi

if [ -f /data/app/current/portal/server.js ]; then
  APP_PORTAL_DIR="/data/app/current/portal"
  APP_TOKEN_API="/data/app/current/token-api-server.mjs"
  SCRIPTS_DIR="/data/app/current/scripts-staging"
  PIPELINES_DIR="/data/app/current/pipeline-templates-staging"
  echo "[aio-init] Using app layer at /data/app/current"
fi

PLATFORM_VER="${CONFIG365_PLATFORM_VERSION:-1}"
printf '{"platformVersion":%s,"imageTag":"%s","installedAt":"%s"}\n' \
  "${PLATFORM_VER}" "${CONFIG365_IMAGE_TAG:-}" "$(date -Iseconds)" \
  > "${INIT_DATA}/installed-platform.json"
echo "[aio-init] Platform version v${PLATFORM_VER} stamped."

sed -i "s|command=/usr/bin/node /app/server.js|command=/usr/bin/node ${APP_PORTAL_DIR}/server.js|g" /etc/supervisord.conf
sed -i "s|command=/usr/bin/node /app/token-api-server.mjs|command=/usr/bin/node ${APP_TOKEN_API}|g" /etc/supervisord.conf
sed -i "s|^directory=/app$|directory=${APP_PORTAL_DIR}|g" /etc/supervisord.conf
sed -i "s|CONFIG365_ROOT=\"/app\"|CONFIG365_ROOT=\"${APP_PORTAL_DIR}\"|g" /etc/supervisord.conf
export SCRIPTS_STAGING_DIR="${SCRIPTS_DIR}"
export PIPELINE_TEMPLATES_DIR="${PIPELINES_DIR}"
export CONFIG365_APP_ROOT="${APP_PORTAL_DIR}"

# ── Patch supervisord to use external Gitea work dir (if configured) ─────────
if [ -n "${GITEA_EXTERNAL_DIR}" ]; then
  sed -i "s|--config /data/gitea/conf/app.ini|--config ${GITEA_EXTERNAL_DIR}/conf/app.ini|g" /etc/supervisord.conf
  sed -i "s|^directory=/data/gitea$|directory=${GITEA_EXTERNAL_DIR}|" /etc/supervisord.conf
  sed -i "s|GITEA_WORK_DIR=\"/data/gitea\"|GITEA_WORK_DIR=\"${GITEA_EXTERNAL_DIR}\"|g" /etc/supervisord.conf
  sed -i "s|GITEA_CUSTOM=\"/data/gitea/custom\"|GITEA_CUSTOM=\"${GITEA_EXTERNAL_DIR}/custom\"|g" /etc/supervisord.conf
  sed -i "s|GITEA_DATA=\"/data/gitea\"|GITEA_DATA=\"${GITEA_EXTERNAL_DIR}\"|g" /etc/supervisord.conf
  sed -i "s|GITEA_APP_INI=\"/data/gitea/conf/app.ini\"|GITEA_APP_INI=\"${GITEA_EXTERNAL_DIR}/conf/app.ini\"|g" /etc/supervisord.conf
  echo "[aio-init] Patched supervisord: Gitea work dir → ${GITEA_EXTERNAL_DIR}"
fi

if [ -f "${SENTINEL}" ]; then
  # ── Already initialised — run the full Gitea bootstrap phase ────────────────

  # ── Start Gitea temporarily for bootstrap ───────────────────────────────────
  echo "[aio-init] Starting Gitea for bootstrap phase..."
  su -s /bin/sh git -c \
    "GITEA_WORK_DIR='${GITEA_DATA}' '${GITEA_BIN}' web --config '${GITEA_CONFIG}'" \
    > /tmp/gitea-bootstrap.log 2>&1 &
  GITEA_PID=$!

  # ── Wait for Gitea API ────────────────────────────────────────────────────────
  echo "[aio-init] Waiting for Gitea to become ready..."
  ATTEMPTS=0
  # MSSQL databases can take 10+ minutes on first boot for schema migrations;
  # allow up to 15 minutes (300 × 3 s) before giving up.
  MAX_ATTEMPTS=300
  until wget -qO- "${GITEA_API}/version" > /dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge "${MAX_ATTEMPTS}" ]; then
      echo "[aio-init] ERROR: Gitea did not become ready after $((MAX_ATTEMPTS * 3 / 60)) minutes."
      echo "[aio-init] Last Gitea output:"
      tail -20 /tmp/gitea-bootstrap.log || true
      kill "$GITEA_PID" 2>/dev/null || true
      exit 1
    fi
    sleep 3
  done
  echo "[aio-init] Gitea is ready (attempt ${ATTEMPTS})."

  echo "[aio-init] Already initialized — skipping admin/token bootstrap."

  # Regenerate runner token file if it disappeared (e.g. /data remounted fresh)
  if [ ! -f "${RUNNER_TOKEN_FILE}" ]; then
    echo "[aio-init] Runner token file missing — regenerating..."
    RUNNER_TOKEN=$(
      su -s /bin/sh git -c \
        "GITEA_WORK_DIR='${GITEA_DATA}' '${GITEA_BIN}' actions generate-runner-token \
          --config '${GITEA_CONFIG}'" 2>/dev/null | tail -1 | tr -d '\n\r'
    )
    if [ -n "${RUNNER_TOKEN}" ]; then
      printf '%s' "${RUNNER_TOKEN}" > "${RUNNER_TOKEN_FILE}"
      chown git:git "${RUNNER_TOKEN_FILE}"
      chmod 640 "${RUNNER_TOKEN_FILE}"
      echo "[aio-init] Runner token regenerated."
    fi
  fi

  # ── Register act_runner shards (if not already registered) ─────────────────
  RUNNER_TOKEN_VAL=$(cat "${RUNNER_TOKEN_FILE}" 2>/dev/null | tr -d '\n\r' || echo "")
  if [ -n "${RUNNER_TOKEN_VAL}" ]; then
    if [ "${RUNNER_MODE}" = "docker" ]; then
      echo "[aio-init] Docker runner mode — registering single docker job runner..."
      DOCKER_RUNNER_DIR="${DATA_DIR}/runner-docker"
      mkdir -p "${DOCKER_RUNNER_DIR}"
      DOCKER_CFG="${DOCKER_RUNNER_DIR}/config.yml"
      if [ ! -f "${DOCKER_CFG}" ]; then
        cp /etc/act_runner/config-docker.yml "${DOCKER_CFG}"
      fi
      if [ ! -f "${DOCKER_RUNNER_DIR}/.runner" ]; then
        FRESH_RUNNER_TOKEN=$(
          su -s /bin/sh git -c \
            "GITEA_WORK_DIR='${GITEA_DATA}' '${GITEA_BIN}' actions generate-runner-token \
              --config '${GITEA_CONFIG}'" 2>/dev/null | tail -1 | tr -d '\n\r'
        )
        if [ -n "${FRESH_RUNNER_TOKEN}" ]; then
          printf '%s' "${FRESH_RUNNER_TOKEN}" > "${RUNNER_TOKEN_FILE}"
          RUNNER_TOKEN_VAL="${FRESH_RUNNER_TOKEN}"
        fi
        cd "${DOCKER_RUNNER_DIR}"
        act_runner register \
          --no-interactive \
          --instance "http://localhost:3000" \
          --token "${RUNNER_TOKEN_VAL}" \
          --name "${GITEA_RUNNER_NAME:-config365-runner}" \
          --labels "self-hosted:docker://config365-runner:latest,ubuntu-latest:docker://config365-runner:latest,ubuntu-22.04:docker://config365-runner:latest" \
          --config "${DOCKER_CFG}"
        echo "[aio-init] Docker runner registered."
      fi
      PORTAL_TOKEN_VAL=$(cat "${TOKEN_FILE}" 2>/dev/null | tr -d '\n\r' || echo "")
      {
        echo "; Auto-generated docker runner — setup-runner-shards.sh not used"
        echo "[program:runner-docker]"
        echo "command=/usr/local/bin/runner-start.sh"
        echo "directory=${DOCKER_RUNNER_DIR}"
        echo "environment=GITEA_INSTANCE_URL=\"http://localhost:3000\",HOME=\"/root\",GIT_TERMINAL_PROMPT=\"0\",PORTAL_TOKEN_API_URL=\"http://localhost:4322\",RUNNER_CONFIG=\"${DOCKER_CFG}\",RUNNER_DIR=\"${DOCKER_RUNNER_DIR}\"${PORTAL_TOKEN_VAL:+,GITEA_TOKEN=\"${PORTAL_TOKEN_VAL}\"}"
        echo "autostart=true"
        echo "autorestart=true"
        echo "startretries=5"
        echo "startsecs=10"
        echo "stdout_logfile=/dev/fd/1"
        echo "stdout_logfile_maxbytes=0"
        echo "stderr_logfile=/dev/fd/2"
        echo "stderr_logfile_maxbytes=0"
        echo "priority=30"
      } > /etc/supervisord.d/runners.conf
    else
      echo "[aio-init] Ensuring act_runner shards are registered..."
      PORTAL_TOKEN_VAL=$(cat "${TOKEN_FILE}" 2>/dev/null | tr -d '\n\r' || echo "")
      RUNNER_TOKEN_VAL="${RUNNER_TOKEN_VAL}" GITEA_TOKEN="${PORTAL_TOKEN_VAL}" REGISTER=1 \
        /usr/local/bin/setup-runner-shards.sh
      echo "[aio-init] Runner shards ready (count=$(cat "${INIT_DATA}/runner-shards.txt" 2>/dev/null || echo 4))."
    fi
  else
    echo "[aio-init] WARNING: Runner token unavailable — runners will not be registered."
  fi

  # ── Stop the temporary Gitea process ─────────────────────────────────────────
  # Kill su + sh + gitea grandchild — pkill catches the grandchild that 'kill $PID' misses.
  echo "[aio-init] Stopping bootstrap Gitea (PID ${GITEA_PID})..."
  pkill -TERM -f "gitea web" 2>/dev/null || true
  kill "${GITEA_PID}" 2>/dev/null || true
  wait "${GITEA_PID}" 2>/dev/null || true
  # Allow OS to fully release socket file descriptors
  sleep 1
  pkill -KILL -f "gitea web" 2>/dev/null || true   # force-kill any stubborn survivor

  # Explicitly remove the LevelDB lock file left by the bootstrap process.
  rm -f "${GITEA_DATA}/data/queues/common/LOCK" 2>/dev/null || true

  # Wait until port 3000 is actually free before handing off to supervisord.
  # Uses /proc/net/tcp + /proc/net/tcp6 — 0BB8 hex = 3000 decimal.
  PORT_FREE_ATTEMPTS=0
  while grep -q ':0BB8 ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; do
    PORT_FREE_ATTEMPTS=$((PORT_FREE_ATTEMPTS + 1))
    if [ "$PORT_FREE_ATTEMPTS" -ge 30 ]; then
      echo "[aio-init] WARNING: port 3000 still in use after 30 s — continuing anyway"
      break
    fi
    sleep 1
  done
  echo "[aio-init] Bootstrap Gitea stopped (port 3000 free after ${PORT_FREE_ATTEMPTS}s)."

  # ── Inject portal token into act_runner supervisord environments ───────────
  PORTAL_TOKEN_VAL=$(cat "${TOKEN_FILE}" 2>/dev/null | tr -d '\n\r' || echo "")
  if [ -n "${PORTAL_TOKEN_VAL}" ] && [ "${RUNNER_MODE}" != "docker" ]; then
    GITEA_TOKEN="${PORTAL_TOKEN_VAL}" REGISTER=0 /usr/local/bin/setup-runner-shards.sh
    echo "[aio-init] Injected GITEA_TOKEN into runner shard supervisord environments."
  elif [ -n "${PORTAL_TOKEN_VAL}" ] && [ "${RUNNER_MODE}" = "docker" ]; then
    echo "[aio-init] GITEA_TOKEN set in docker runner supervisord environment."
  fi

else
  # ── First run — Gitea deferred until portal wizard completes ─────────────────
  # The portal wizard will configure the DB settings and then _initializeGitea()
  # in the platform bootstrap will start Gitea, create the admin user, generate
  # the portal token, and register the runner.
  echo "[aio-init] First run — Gitea startup deferred until wizard completes."
  # Disable gitea autostart so supervisord does not start it now.
  # _initializeGitea() will call 'supervisorctl start gitea' after wizard completion.
  sed -i '/^\[program:gitea\]/,/^\[/{s/^autostart=true$/autostart=false/}' /etc/supervisord.conf
  echo "[aio-init] Gitea autostart disabled in supervisord (will be re-enabled post-wizard)."
fi

# ── Configure git credentials for act_runner (whenever portal token exists) ────
# The setup wizard creates the token at runtime; without this block the first
# backup run would hang on an interactive git clone prompt until container restart.
if [ -f "${TOKEN_FILE}" ]; then
  /usr/local/bin/configure-runner-git-credentials.sh
fi

# ── Resolve PUBLIC_URL for portal (optional — falls back to proxy headers) ────
if [ -z "${PUBLIC_URL:-}" ]; then
  if [ -n "${NEXTAUTH_URL:-}" ]; then
    PUBLIC_URL="${NEXTAUTH_URL}"
  elif [ -n "${APP_BASE_URL:-}" ]; then
    PUBLIC_URL="${APP_BASE_URL}"
  elif [ -n "${WEBSITE_DEFAULT_HOSTNAME:-}" ]; then
    PUBLIC_URL="https://${WEBSITE_DEFAULT_HOSTNAME}"
  fi
fi

# ── Inject SESSION_SECRET into portal and token-api supervisord environments ──
# Both [program:portal] and [program:token-api] start with environment=NODE_ENV=...
# so a single substitution covers both. A previous second sed was removed because
# its back-reference pattern stripped the "environment=" prefix from the token-api
# entry, causing supervisord to ignore all env vars for that process.
sed -i "s|^environment=NODE_ENV=.*|&,SESSION_SECRET=\"${SESSION_SECRET}\"|" /etc/supervisord.conf
if [ -n "${PUBLIC_URL:-}" ]; then
  sed -i "s|^environment=NODE_ENV=.*|&,PUBLIC_URL=\"${PUBLIC_URL}\"|" /etc/supervisord.conf
  echo "[aio-init] Injected PUBLIC_URL into portal supervisord environment: ${PUBLIC_URL}"
else
  echo "[aio-init] PUBLIC_URL unset — portal will derive origin from proxy headers."
fi

# Secure cookies follow the *public* origin (browser HTTPS), not the HTTP hop
# Azure uses from the front door into this container.
if [ -z "${SECURE_COOKIES:-}" ]; then
  case "$(printf '%s' "${PUBLIC_URL:-}" | tr 'A-Z' 'a-z')" in
    https://*) SECURE_COOKIES=true ;;
    *)         SECURE_COOKIES=false ;;
  esac
fi
sed -i "s|^environment=NODE_ENV=.*|&,SECURE_COOKIES=\"${SECURE_COOKIES}\"|" /etc/supervisord.conf
echo "[aio-init] SECURE_COOKIES=${SECURE_COOKIES} (from public URL, not container HTTP)."

if [ -n "${CONFIG365_PERSIST_DIR:-}" ]; then
  sed -i "s|^environment=NODE_ENV=.*|&,CONFIG365_PERSIST_DIR=\"${CONFIG365_PERSIST_DIR}\"|" /etc/supervisord.conf
fi
echo "[aio-init] Injected SESSION_SECRET into portal and token-api supervisord environments."

# ── Conditionally enable backup-scheduler ────────────────────────────────────
# The backup-scheduler is only started when blob storage is configured.
if [ -n "${C365_BLOB_CONTAINER}" ] && { [ -n "${C365_BLOB_STORAGE_URI}" ] || [ -n "${C365_BLOB_CONNECTION_STRING}" ]; }; then
  sed -i "s|^\(autostart=false\)$|autostart=true|" /etc/supervisord.conf
  echo "[aio-init] Backup scheduler enabled (blob storage configured)."
else
  echo "[aio-init] Backup scheduler disabled (no blob storage configured)."
fi

# ── Hand off to supervisord ───────────────────────────────────────────────────
echo "[aio-init] Starting supervisord..."
exec /usr/bin/supervisord -n -c /etc/supervisord.conf
