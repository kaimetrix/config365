#!/usr/bin/env bash
# pack-app-release.sh — Build config365-app-{VERSION}.tar.gz for GitHub Releases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(cat "$ROOT/VERSION")}"
OUT_DIR="${2:-/tmp/config365-app-pack}"
# VERSION is EPOCH.PLATFORM.APP (e.g. 1.2.10) — the platform (Docker) digit is
# the 2nd component. There is no separate PLATFORM_VERSION file anymore.
PLATFORM_VERSION="$(echo "$VERSION" | cut -d. -f2)"
BUMP_TYPE="${BUMP_TYPE:-app}"
REQUIRED_SCHEMA="${REQUIRED_SCHEMA_VERSION:-$(python3 -c "
import re, pathlib
root = pathlib.Path('${ROOT}/portal-next/lib/server')
def v(name, path):
    m = re.search(r'export const ' + name + r' = (\d+)', path.read_text())
    return int(m.group(1)) if m else 0
print(max(v('MSSQL_SCHEMA_VERSION', root / 'db-mssql-schema.ts'),
          v('SQLITE_SCHEMA_VERSION', root / 'db-sqlite-schema.ts')) or 1)
")}"

echo "[pack-app-release] v${VERSION} platform v${PLATFORM_VERSION} bump=${BUMP_TYPE}"

STAGING="$OUT_DIR/staging"
rm -rf "$STAGING"
mkdir -p "$STAGING/portal"

if [ ! -f "$ROOT/portal-next/.next/standalone/server.js" ]; then
  echo "Building portal..."
  (cd "$ROOT/portal-next" && npm ci && npm run build)
fi

rsync -a "$ROOT/portal-next/.next/standalone/" "$STAGING/portal/"
rsync -a "$ROOT/portal-next/.next/static" "$STAGING/portal/.next/"
if [ -d "$ROOT/portal-next/public" ]; then
  rsync -a "$ROOT/portal-next/public/" "$STAGING/portal/public/"
fi

for artifact in token-api-server.mjs run-migrations.mjs; do
  src="$ROOT/portal-next/$artifact"
  ts="${artifact%.mjs}.ts"
  if [ ! -f "$src" ]; then
    echo "Building $artifact..."
    (cd "$ROOT/portal-next" && npx esbuild "$ts" \
      --bundle --platform=node --format=esm \
      --external:better-sqlite3 --external:mssql \
      --external:@azure/identity --external:@azure/keyvault-secrets --external:@azure/storage-blob \
      --alias:server-only=./server-only-shim.js \
      --outfile="$artifact")
  fi
  cp "$ROOT/portal-next/$artifact" "$STAGING/"
done

# Exclude underscore-prefixed debug/temp scripts (see .dockerignore) — they must
# never ship in the public release tarball, same invariant as the Docker image.
rsync -a --exclude='_*' "$ROOT/runner/scripts/" "$STAGING/scripts-staging/"
rsync -a "$ROOT/pipeline-templates/" "$STAGING/pipeline-templates-staging/"
echo "$VERSION" > "$STAGING/VERSION"

export STAGING VERSION PLATFORM_VERSION REQUIRED_SCHEMA BUMP_TYPE
python3 <<'PY'
import hashlib, json, os
staging = os.environ["STAGING"]
checks = {}
for label, rel in [
    ("portal", "portal"),
    ("token-api-server.mjs", "token-api-server.mjs"),
    ("run-migrations.mjs", "run-migrations.mjs"),
    ("scripts-staging", "scripts-staging"),
    ("pipeline-templates-staging", "pipeline-templates-staging"),
]:
    path = os.path.join(staging, rel)
    h = hashlib.sha256()
    if os.path.isdir(path):
        # Sort the full flat list of relative paths (not per-directory) so this
        # is independent of os.walk's unspecified subdirectory traversal order.
        # Must match hashTree() in portal-next/lib/server/app-updater.ts exactly.
        entries = []
        for root, _, files in os.walk(path):
            for f in files:
                fp = os.path.join(root, f)
                rp = os.path.relpath(fp, staging).replace("\\", "/")
                entries.append((rp, fp))
        for rp, fp in sorted(entries, key=lambda e: e[0]):
            h.update(rp.encode())
            with open(fp, "rb") as fh:
                h.update(fh.read())
    elif os.path.isfile(path):
        with open(path, "rb") as fh:
            h.update(fh.read())
    else:
        h.update(b"missing")
    checks[label] = h.hexdigest()

manifest = {
    "appVersion": os.environ["VERSION"],
    "requiredPlatformVersion": int(os.environ["PLATFORM_VERSION"]),
    "requiredSchemaVersion": int(os.environ["REQUIRED_SCHEMA"]),
    "updateType": "platform" if os.environ["BUMP_TYPE"] == "platform" else "app",
    "sha256": checks,
}
path = os.path.join(staging, "manifest.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest, indent=2))
PY

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/config365-app-${VERSION}.tar.gz"
tar -czf "$TARBALL" -C "$STAGING" .
echo "[pack-app-release] Created $TARBALL"

if [ "$BUMP_TYPE" = "platform" ]; then
  printf '%s\n' "{" \
    "\"platformVersion\": ${PLATFORM_VERSION}," \
    "\"appVersion\": \"${VERSION}\"," \
    "\"updateType\": \"platform\"" \
    "}" > "$OUT_DIR/platform-manifest.json"
fi
