# Config365

Self-hosted Microsoft 365 configuration management. Runs entirely in Docker.

Use it as an MSP managing many customer tenants, or as an enterprise applying one baseline across **dev / test / prod** tenants. Same portal, same Git-backed desired state, same WhatIf → approve → apply flow.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Architecture

```
Browser (operators)
  └── HTTPS → Caddy → Portal (Next.js)
                          ├── SQLite (tenant database)
                          └── Gitea API (internal network only)
                                └── act_runner → PowerShell runner → Microsoft Graph API
```

Operators use only the portal. Gitea and pipelines are not exposed to end users.

## Releases

| Channel | Source repo | Docker image (GHCR) |
|---------|--------------|----------------------|
| Preview | [potsolutions/config365-preview](https://github.com/potsolutions/config365-preview) | `ghcr.io/potsolutions/config365-preview` |
| GA | [potsolutions/config365](https://github.com/potsolutions/config365) | `ghcr.io/potsolutions/config365` |

Both the source repos and their GHCR container images are **public** — no login or token required to clone, `docker pull`, or download a release tarball.

## Deploy your own instance

You do **not** need to clone the source to run Config365 — a pre-built image is published to GHCR on every release. Docker is the only requirement.

**Option A — one command, defaults only:**

```bash
docker run -d --name config365-aio --restart unless-stopped \
  -p 8080:80 \
  -v config365-data:/home/config365-data \
  ghcr.io/potsolutions/config365:latest
```

That's it — no files to download, no `.env` to create. Every setting the container needs (`GITEA_ORG`, `RUNNER_SHARDS`, `SESSION_SECRET`, …) has a built-in default and is generated/persisted on first boot straight into the `config365-data` volume. Swap `config365` for `config365-preview` to run the preview channel instead.

**Option B — Docker Compose, if you want to customize settings via `.env`:**

```bash
mkdir config365 && cd config365
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365/main/docker-compose.ghcr.yml
curl -fsSLO https://raw.githubusercontent.com/potsolutions/config365/main/.env.example
cp .env.example .env

docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

Edit `.env` first (`PORTAL_HTTP_PORT`, `RUNNER_SHARDS`, `PLATFORM_ADMIN_OIDS`, …), then re-run the `up -d` line to apply changes. Use `ghcr.io/potsolutions/config365-preview` in `docker-compose.ghcr.yml` for the preview channel.

**Option C — clone and build from source (customizing the app itself):**

```bash
git clone https://github.com/potsolutions/config365.git
cd config365
cp .env.example .env

docker compose up -d --build
```

On Windows, `./scripts/setup.ps1` generates `.env` for you (`SESSION_SECRET` + `PORTAL_HTTP_PORT=8080`) instead of copying `.env.example` manually. **Always use Docker Compose when building from source** — a bare `docker build`/`docker run` skips the `.env` port and volume settings this repo relies on.

**Option D — fork + Azure App Service (recommended for production partners):**

Fork [potsolutions/config365](https://github.com/potsolutions/config365), point an Azure Linux App Service (custom container) at `ghcr.io/potsolutions/config365:latest`, and install the [Pull](https://github.com/apps/pull) GitHub App on your fork so upstream releases open a PR. A bundled `deploy.yml` workflow then applies platform (2nd digit) updates to your App Service automatically on merge; app (3rd digit) updates still go through Platform Admin → **Software update**. Full setup (OIDC secrets, required app settings, `RUNNER_SHARDS` on Azure) is in [docs/DEPLOY.md § Fork sync + Azure deploy](docs/DEPLOY.md#fork-sync-cipp-style-pull-app--azure-deploy).

| URL | Purpose |
|-----|---------|
| http://localhost:8080/setup | First-time setup wizard |
| http://localhost:8080 | Portal (after setup) |
| http://localhost:8080/gitea/ | Gitea admin UI (via Caddy) |

Host port **8080** is hardcoded in Option A; it comes from `PORTAL_HTTP_PORT` in `.env` for Options B/C (default `8080` in `.env.example`). Caddy listens on port **80 inside the container** either way.

To stop: `docker stop config365-aio` (Option A) or `docker compose down` (Options B/C) — data persists in the `config365-data` volume regardless.

### Updating

Config365's `VERSION` is `EPOCH.PLATFORM.APP` (e.g. `1.2.10`) — see [docs/DEPLOY.md § Updating Config365](docs/DEPLOY.md#updating-config365) for the full breakdown of what each digit means.

| Scenario | Command |
|----------|---------|
| App update (3rd digit) — no container recreate | Platform Admin → **Software update**, or `docker exec config365-aio app-update.sh --apply VERSION` |
| Platform update (2nd digit) — Option A (`docker run`) | `docker pull ghcr.io/potsolutions/config365:latest && docker rm -f config365-aio` then re-run the same `docker run` command (same volume name preserves data) |
| Platform update (2nd digit) — Option B (Compose + GHCR) | `docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull && … up -d --force-recreate` |
| Platform update (2nd digit) — Option C (from source) | `docker compose up -d --build --force-recreate` |
| Platform update (2nd digit) — Option D (fork + Azure) | Merge the Pull app's PR → `deploy.yml` runs `az webapp config container set` + restart automatically |

Config365 **never auto-applies** updates — every apply requires explicit platform-admin action.

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full guide, including Azure App Service setup, the Pull-app fork-sync workflow, and parallel-tenant runner sharding.

## Security

### Static outbound IP + Conditional Access

The Docker host needs a **static outbound IP**. Lock down the Config365 service account in Entra ID:

```
Policy: "Config365 automation — IP lock"
  Applies to: srvc_config365@yourorg.com
  Condition:  Sign-in location NOT IN [your.static.ip.address/32]
  Grant:      Block
```

Stolen credentials cannot be used from another network location.

### Runner image pinning (optional)

After building the runner image, pin by digest in pipeline templates:

```bash
cd runner
./build.sh
# Update pipeline-templates/*.yml with the printed digest
```

## Adding tenants

Use the portal (**Admin → Tenants**). Each record is one Microsoft 365 tenant — a customer, or an environment such as dev, test, or prod. For each tenant the platform:

1. Forks `tenant-template` in Gitea as `tenant-{slug}`
2. Sets per-tenant secrets (`TENANT_ID`, and optional app credentials)
3. Creates the tenant record in SQLite

## Layout

```
Config365/
├── docker-compose.yml          # All-in-one stack (builds Dockerfile.aio)
├── Dockerfile.aio              # Portal + Gitea + runner in one image
├── Caddyfile.aio               # Reverse proxy (baked into the image)
├── .env.example
├── portal-next/                # Next.js portal
├── runner/                     # PowerShell + M365 modules (baked into AIO image)
├── pipeline-templates/         # Gitea Actions workflow templates
├── tenant-template/            # Per-tenant repo template (forked per tenant)
└── .debug/                     # Maintainer debug scripts & workflows (dev repo only; excluded from preview/GA publish)
```

## License

[MIT](LICENSE) © PotSolutions.net
