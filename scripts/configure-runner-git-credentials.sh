#!/bin/sh
# Configure /root git credentials so act_runner host-mode workflow steps can
# `git clone http://localhost:3000/...` without interactive prompts.
#
# Usage: configure-runner-git-credentials.sh [portal-token]
#   If token is omitted, reads /data/init-data/portal-token.txt.

set -e

TOKEN_FILE="${GITEA_TOKEN_FILE:-/data/init-data/portal-token.txt}"
ADMIN_USER="${GITEA_ADMIN_USER:-config365-admin}"
GITEA_HOST="${GITEA_INTERNAL_HOST:-localhost:3000}"

TOKEN="${1:-}"
if [ -z "${TOKEN}" ] && [ -f "${TOKEN_FILE}" ]; then
  TOKEN=$(tr -d '\n\r' < "${TOKEN_FILE}")
fi

if [ -z "${TOKEN}" ]; then
  echo "[git-creds] No portal token — skipping git credential configuration."
  exit 0
fi

mkdir -p /root
chmod 700 /root

cat > /root/.netrc << NETRC
machine localhost
login ${ADMIN_USER}
password ${TOKEN}
NETRC
chmod 600 /root/.netrc

printf 'http://%s:%s@%s\n' "${ADMIN_USER}" "${TOKEN}" "${GITEA_HOST}" > /root/.git-credentials
chmod 600 /root/.git-credentials
# Rewrite .gitconfig in full — `git config --global url.*.insteadOf` appends, and a
# stale token left from a previous regen makes every `git clone http://localhost:3000/...` fail.
cat > /root/.gitconfig << GITCONFIG
[credential]
	helper = store
[url "http://${ADMIN_USER}:${TOKEN}@${GITEA_HOST}/"]
	insteadOf = http://${GITEA_HOST}/
[safe]
	directory = *
GITCONFIG
chmod 600 /root/.gitconfig

echo "[git-creds] Configured git credentials for act_runner (user=${ADMIN_USER}, host=${GITEA_HOST})."
