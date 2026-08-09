# Deploy CONFIG365 (preview)

This repository is the **preview** distribution of CONFIG365.

| Resource | Location |
|----------|----------|
| GA-stable channel | [potsolutions/config365](https://github.com/potsolutions/config365) |

## Prerequisites

- Docker
- Git

## Quick start

You don't need to clone the source — a pre-built image is published to GHCR on every release (`ghcr.io/potsolutions/config365-preview`, public, no login required).

**Option A — one command, defaults only:**

```bash
docker run -d --name config365-aio --restart unless-stopped \
  -p 8080:80 \
  -v config365-data:/home/config365-data \
  ghcr.io/potsolutions/config365-preview:latest
```

Nothing to download or configure — `SESSION_SECRET`, `GITEA_ORG`, `RUNNER_SHARDS`, etc. all have built-in defaults, and `SESSION_SECRET` is generated on first boot and persisted to the `config365-data` volume. This is the right choice unless you need to change the host port or other settings.

**Option B — Docker Compose, to customize settings via `.env`:**

```bash
mkdir config365 && cd config365
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365-preview/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365-preview/main/docker-compose.ghcr.yml
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365-preview/main/.env.example
cp .env.example .env
# Leave SESSION_SECRET empty — first container start generates one and stores it on the data volume

docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

**Option C — clone and build from source:**

```bash
git clone https://github.com/potsolutions/config365-preview.git
cd config365-preview

cp .env.example .env
# Leave SESSION_SECRET empty — first container start generates one and stores it on the data volume

docker compose up -d --build
```

For Options B and C, **use Docker Compose only** — compose applies port mapping, volumes, and env from `.env` and `docker-compose.yml`. A manual `docker build`/`docker run` against a from-source checkout skips those, which is a common cause of the portal appearing on the wrong port. Option A's `docker run` is safe because it hardcodes the correct port and volume flags itself.

### URLs and ports

| URL | Purpose |
|-----|---------|
| http://localhost:8080/setup | Setup wizard (first boot) |
| http://localhost:8080 | Portal |
| http://localhost:8080/gitea/ | Gitea (admin) |

- **Host port** — `PORTAL_HTTP_PORT` in `.env` (default **8080**).
- **Inside the container** — Caddy on **80**, Next.js on **4321**, Gitea on **3000** (Gitea is not published directly; use `/gitea/` through Caddy).

To use a different host port, set `PORTAL_HTTP_PORT` in `.env` and run `docker compose up -d --build`.

## Updating Config365

Config365 uses a single three-part `VERSION` (`EPOCH.PLATFORM.APP`, e.g. `1.2.10`):

| Digit | Example | What changes | Docker rebuild? |
|-------|---------|---------------|------------------|
| 1st — **epoch** | `1` | Reserved for the next major relaunch, years apart. Bumped by hand only — no release automation touches it. | — |
| 2nd — **platform** | `2` | Node, Gitea, Caddy, PowerShell modules, Docker base image, npm packages | **Yes** |
| 3rd — **app** | `10` | Portal, token-api, runner scripts, pipeline templates | No |

The installed platform digit is compared against each release's `requiredPlatformVersion` — if the deployed image's platform digit is behind what an app release requires, the in-container updater blocks the app install until the platform is updated first.

### App updates (3rd digit) — no Docker rebuild

App releases (bump type `app`) publish a pre-built app tarball on GitHub Releases. The running container downloads and applies it to `/data/app/current` on the persistent volume. **The Docker image is never rebuilt or replaced.**

**Recommended:** Platform Admin → **Software update** → **Start update** (guided wizard: release notes → schema migration → portal swap → scripts PR → approve in portal).

**CLI (portal only — scripts still need Gitea PR approval):**

```bash
docker exec config365-aio app-update.sh --check
docker exec config365-aio app-update.sh --apply 1.2.11
```

Releases and GHCR images on `potsolutions/config365-preview` and `potsolutions/config365` are **public** — no GitHub token is required to download app tarballs or pull container images.

Config365 **never auto-applies** updates. Every apply requires explicit platform-admin action.

### Platform updates (2nd digit) — Docker recreate required

Platform releases (bump type `platform`) bump the 2nd digit of `VERSION` (e.g. `1.2.10` → `1.3.0`), publish a new GHCR image, and include `platform-manifest.json` on the GitHub Release. The in-container updater **blocks** app installs until the platform version is new enough.

Apply a platform update by pointing App Service at the new public GHCR image and restarting (data under `/home` is preserved).

**Azure App Service (recommended for partners):**

Configure GitHub Actions on your fork with OIDC secrets (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) and variables (`APP_NAME`, `RESOURCE_GROUP`). Merging a platform upstream release triggers `.github/workflows/deploy.yml`, which runs:

```bash
az webapp config container set --docker-custom-image-name ghcr.io/potsolutions/config365-preview:VERSION
az webapp restart
```

Or run **Deploy** manually from the Actions tab. No GHCR login is required — images are public.

**Self-hosted Docker (local / lab) — Option A install (`docker run`):**

```bash
docker pull ghcr.io/potsolutions/config365-preview:latest
docker rm -f config365-aio
# re-run the same docker run command from Quick start — same volume name preserves data
```

**Self-hosted Docker (local / lab) — Option B install (Compose):**

```bash
# Set CONFIG365_IMAGE_TAG=1.2.10 in .env (or use latest)
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d --force-recreate
```

**Build from source on the host:**

```bash
docker compose up -d --build --force-recreate
```

After platform update, apply the bundled app version from Platform Admin if needed.

### Rebuild after local git changes (development)

```bash
docker compose up -d --build
```

To fully recreate the container (same volume, fresh container):

```bash
docker compose down
docker compose up -d --build
```

### Verify services started

Wait ~40 seconds, then:

```bash
docker logs config365-aio 2>&1 | tail -30
```

Look for `success: gitea`, `success: token-api`, `success: portal`, and `success: runner-1` (and `runner-2` … if `RUNNER_SHARDS` > 1) in `RUNNING state`.

## Parallel tenant deploys

By default the AIO container runs **4 sharded host-mode runners** (`RUNNER_SHARDS=4`). Each shard is an independent `act_runner` daemon with `capacity: 1`; Gitea distributes waiting jobs across shards so multiple tenants can deploy in parallel.

| Setting | Default | Where |
|---------|---------|--------|
| `RUNNER_SHARDS` | `4` | Docker Compose env / Azure App Service application setting |
| Parallel workers UI | Platform Admin → Act Runner | Persists to `/data/init-data/runner-shards.txt` |

**Azure:** set `RUNNER_SHARDS=4` (or 1–8) in App Service **Configuration → Application settings**. No Docker socket required.

**Local docker job mode (optional):** for per-job container isolation during dev, use the docker.sock overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.runner-docker.yml up -d --build
```

Production Azure deployments use sharded host mode, not docker job mode.

## Fork sync (CIPP-style Pull app) + Azure deploy

Production partners run Config365 on **Azure Linux App Service**. The fork deploy workflow updates the container image on platform releases only (2nd digit of `VERSION`).

1. **Fork** [potsolutions/config365-preview](https://github.com/potsolutions/config365-preview) (or GA repo).
2. Provision a **Linux Web App** (custom container) pointing at `ghcr.io/potsolutions/config365-preview:latest` (or your chosen tag).
3. Install the [**Pull** GitHub App](https://github.com/apps/pull) on your fork.
4. Configure GitHub **secrets** and **variables** on the fork:

   | Secret / variable | Purpose |
   |-------------------|---------|
   | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | OIDC login for deploy workflow |
   | `APP_NAME` | Azure Web App name |
   | `RESOURCE_GROUP` | Resource group name |
   | `GHCR_IMAGE` (optional) | Default `ghcr.io/potsolutions/config365-preview`; use `ghcr.io/potsolutions/config365` for GA |

5. On each upstream release, Pull opens a **PR** — **review and merge manually**.
6. `.github/workflows/deploy.yml` runs on `push` to `main`:
   - **App (3rd digit):** no Azure change — apply via Platform Admin → Software update.
   - **Platform (2nd digit):** `az webapp config container set` with the new GHCR tag + restart.

App-only Pull app PRs are for visibility; the live instance updates from **Platform Admin → Software update**, not from merging those PRs alone.

## Azure App Service

On Linux App Service, only paths under **`/home`** persist across restarts (when enabled). Config365 stores all state under **`/home/config365-data`**, symlinked to `/data` at startup — the same layout as local Docker (`config365-data:/home/config365-data`).

**Required app setting** (must be `true`, not unset):

| Setting | Value |
|---------|-------|
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `true` |

Without this, `/home` is ephemeral and setup resets on every reboot. The deploy workflow sets this automatically; verify it in **Configuration → Application settings**.

**Recommended app setting** for login redirects and OAuth callback URLs:

| Setting | Example |
|---------|---------|
| `PUBLIC_URL` | `https://yourapp.azurewebsites.net` |

When set, the portal uses this as its public origin instead of inferring it from proxy headers. On Azure HTTPS this avoids redirects to internal ports (e.g. `:4321`). Omit locally — header detection works with `http://localhost:8080`.

After deploy, container logs should show:

```
[aio-init] Azure App Service: bind-mounted /home/config365-data → /data.
```

Optional: mount Azure Files at `/data` instead — the entrypoint detects an explicit mount and leaves it alone.

App-layer updates work on Azure the same way as self-hosted Docker — the tarball lands on the persistent `/data` volume.

## Preview disclaimer

Preview builds may change frequently and are not guaranteed production-ready. Use the **config365** GA repo when you need a promoted stable release.
