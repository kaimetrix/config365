## [1.3.0] - 2026-08-16

Platform rebuild: OS version control (MDM vs App Protection impact), Windows/macOS Intune-only preview, update-source and live update logs.

### Changes
- fix(ui): score mobile compliance against MDM devices only
- feat(ui): scope mobile OS impact by MAM vs compliance and show block reason
- fix(ui): count only Intune-managed Windows and macOS in OS impact
- fix(ui): treat macOS versions with Darwin build suffixes as allowed
- feat(ui): filter OS impact preview by last activity window
- fix(ui): resolve Windows OS versions from Intune and Defender builds
- feat(update): surface GitHub release source and live update logs
- feat(ui): select OS threshold policies and show allowed device counts

## [1.2.0] - 2026-08-15

Platform rebuild: new GHCR image with monitor exclude merge fix and prod changes since v1.1.2. Current preview image/setup does not work.

### Changes
- No commits found since last release

## [1.1.3] - 2026-08-15

### Changes
- fix(exchange): keep file and folder monitor excludes as separate keys
- fix(ui): save monitor sidecar on apply and rewrite runner gitconfig
- fix(exchange): honor file-level monitor exclude when merging folder sidecar
- Ignore Exchange DirectoryObjectVersion so deploy does not send a read-only backup field to Set-HostedContentFilterPolicy.
- fix(setup): allow OIDC sign-in during wizard and drop factory reset

## [1.1.2] - 2026-08-01

### Changes
- fix(ui): confirm group actions and recommend SQLite on Azure
- chore(docker): temporarily pin Gitea 1.26.1 on_dev for perf
- fix(docker): symlink /usr/bin/node after tarball install
- fix(docker): use Node linux-x64 tar.gz (no xz required)
- fix(docker): install Node from nodejs.org tarball instead of NodeSource
- fix(user-compliance): merge pending group queues and subtract only processed users

## [1.1.1] - 2026-07-26

### Changes
- ci: make Trivy advisory on stage/prod (do not block deploy)
- fix(dashboard): prevent overlapping pipeline-status polling requests
- chore(versioning): redefine VERSION as EPOCH.PLATFORM.APP, drop PLATFORM_VERSION file
- fix(backup): protect failed backup items from false-deletion
- fix(gitea): prefer SQLite on Azure; harden bootstrap after DB wipe
- fix(gitea): recommend PostgreSQL; Azure SQL is unsupported
- feat(setup): recommend MSSQL over SQLite, especially on Azure
- feat(admin): add live Gitea database switch with repo adoption
- fix(dashboard): prevent overlapping pipeline-status polling requests
- chore(versioning): redefine VERSION as EPOCH.PLATFORM.APP, drop PLATFORM_VERSION file
- fix(backup): protect failed backup items from false-deletion; dependency updates
- fix: enhance icon upload handling and streamline Graph token acquisition
- fix: bump next to 15.5.21 and pin sharp to 0.35.x (Trivy HIGH gate)
- fix: resolve Intune icon upload failures and unreliable Graph token acquisition
- chore: add ad-hoc compose file for testing published GHCR preview image

## [1.0.15] - 2026-07-22

### Changes
- fix: stop GHCR prune from deleting provenance-referenced image manifests
- fix: include .env.example in public source mirror

## [1.0.14] - 2026-07-21

### Changes
- feat: admin control for app-update channel (preview vs GA)
- fix: correct runner-shard status display; simplify Docker deploy docs

## [1.0.13] - 2026-07-21

### Changes
- docs: add MIT license, expand README deploy instructions

## [1.0.12] - 2026-07-21

### Changes
- fix: app-only updates can't resolve native/external node_modules

## [1.0.11] - 2026-07-21

### Changes
- fix: deterministic release checksums, exclude debug scripts, bake VERSION
- fix: stop hardcoded DLP auto-deploy; baseline JSON only
- fix: correct icon handling for Intune app submissions
- feat: implement variable token resolution in WhatIfModal
- feat: enhance ViewerClient with loading state and navigation improvements
- chore: update Dockerfile for intunewin and Gitea versions
- refactor: clarify Graph app client ID retrieval in scripts
- feat: add endpoint to retrieve Graph app registration client ID for tenants
- fix: use ResponseInit status for setup MSSQL validation errors
- fix: surface real MSSQL test errors instead of undefined
- feat: update SetupWizard to clarify Azure Files and Blob Storage requirements
- feat: enhance blob storage management in admin panel
- feat: enhance backup process and history tracking
- feat: improve git diff status API and viewer components
- refactor: remove untested warning for MSSQL and Key Vault options in SetupWizard
- feat: configure Git safe.directory for job isolation
- feat: enhance footer and Gitea token management
- fix: accept TenantConfig in syncTenantRepoFromTemplate
- feat: enhance tenant repo provisioning and workflow seeding
- refactor: update Dockerfile and release script for external dependencies
- feat: enhance tenant authentication and API integration
- fix: improve tenant resolution error handling and logging
- fix: improve tenant authentication error handling and key generation logic
- feat: enhance MSSQL connection error handling and logging
- fix: restore better-sqlite3 native bindings in AIO image
- fix: update better-sqlite3 installation process in Dockerfile
- feat: enhance deployment pipeline with tenant variable resolution
- fix: auto-resolve PUBLIC_URL so supervisord starts on App Service
- fix(ci): start stage app before restart and allow 90s startup
- fix(ci): pass Trivy gate on fixable OS/runtime vulns only
- feat: add new baseline label for Any User (internal or external) and adjust priorities
- feat: enhance backup and deployment processes for SharePoint and Information Protection
- refactor: simplify Intune Win32 packager status handling and remove unused code
- refactor: streamline groups configuration handling in API routes
- refactor: update batch file commit process to use Gitea's multi-file API
- fix: improve committed files handling and progress tracking in import processes
- feat: improve ZIP import handling and progress tracking in BaselineClient
- feat: refactor ZIP import logic and enhance baseline path handling
- feat: enhance ZIP import functionality and improve import progress tracking
- feat: add PUBLIC_URL configuration for Azure App Service and enhance public origin handling
- feat: enhance tenant authentication and backup scripts for mobility management
- feat: add organization customization support in Exchange scripts
- feat: enhance deployment pipeline with isolated plan directory and cleanup logic
- feat: enhance runner configuration and deployment capabilities
- feat: add printer apps backup and deployment steps in pipeline templates
- feat: enhance backup and deployment capabilities for Defender Connector and Entra ID settings
- feat: update local development setup and enhance Caddy configuration
- feat: improve Azure App Service data persistence and backup handling
- feat: enhance Azure App Service integration and git credential configuration
- refactor: consolidate configuration and remove deprecated files
- feat: enhance Azure Blob Storage setup in the wizard
- feat: add untested warning for MSSQL and Azure Blob Storage configurations

## [1.0.10] - 2026-06-01

### Changes
- docs: merge partner deploy steps from DEPLOY.md into README
- ci(preview): require delete:packages for GHCR prune

## [1.0.9] - 2026-06-01

### Changes
- ci(preview): prune old GHCR package versions after each release
- docs: SESSION_SECRET auto-generated on AIO first start
- docs: note preview publish wipes partner repo history

## [1.0.8] - 2026-06-01

### Changes
- ci(preview): publish single-commit snapshot; wipe partner repo history

## [1.0.7] - 2026-06-01

### Changes
- chore: consolidate maintainer debug tooling under .debug/

## [1.0.6] - 2026-06-01

### Changes
- chore: remove root one-shot dev scripts from repo
- chore: remove legacy portal.legacy files and configurations

## [1.0.5] - 2026-06-01

### Changes
- docs: partner-facing README; drop root diag scripts from publish

## [1.0.4] - 2026-06-01

### Changes
- fix: keep internal release docs out of published preview snapshot
- docs: private potsolutions repos for testing; fix GHCR login username

## [1.0.3] - 2026-06-01

### Changes
- No commits found since last release

## [1.0.2] - 2026-06-01

### Changes
- No commits found since last release

## [1.0.1] - 2026-06-01

### Changes
- feat: preview/GA release pipelines via GHCR and potsolutions repos
- feat: add Intune device compliance data backup step and enhance user compliance reporting
- Increase Defender device backup step timeout to 30 minutes.
- feat: add cleanup step for stale WhatIf plans and enhance group membership handling
- feat: update backup pipeline and Dockerfile for enhanced functionality
- feat: update ExchangeOnlineManagement module and enhance debugging capabilities
- feat: enhance secure score functionality with history tracking and visualization
- feat: add Baseline Apply Scope Cleanup to maintenance pipeline and UI
- feat: auth methods handling, remove maester tooling, untrack .next
- feat: enhance ADMX file management and Group Policy Configurations in backup scripts
- feat: enhance ADMX and Group Policy Configurations handling in pipeline
- feat: enhance ADMX file handling with BOM stripping and maxLength clamping
- feat: enhance normalization process by stripping encrypted values
- feat: enhance DashboardClient with workflow input handling
- refactor: remove MspAdminClient and associated page for admin management
- feat: enhance pipeline templates and scripts for improved functionality and error handling
- feat: update Dockerfile and pipeline templates for improved script handling and workflow synchronization
- feat: enhance Dockerfile and pipeline templates for new modules and timeout adjustments
- feat: enhance deployment pipeline outputs and error handling
- feat: enhance deployment pipeline with scoped apply functionality
- feat: enhance secure score management and workflow run tracking
- feat: update dependencies and enhance Dockerfile for security and performance
- feat: add SecurityEvents scope to Microsoft Graph API permissions
- fix: improve Trivy scan output and SARIF artifact upload
- chore: update Trivy action version in CI workflows
- feat: add Trivy container scanning to CI workflows
- feat: enhance Gitea and portal initialization with external storage support
- feat: enhance MSP and Tenant forms with Graph API credentials
- refactor: streamline Gitea initialization and configuration handling
- refactor: standardize formatting in Gitea app.ini database configuration updates
- fix: add c365g_ table prefix to Gitea MSSQL database config
- fix: apply Gitea DB settings to app.ini and restart Gitea immediately on wizard save
- fix: copy Caddy from Docker Hub image instead of wget from GitHub releases
- chore: update Caddy version in Dockerfile.aio to 2.11.2 for improved performance and security
- refactor: improve database provisioning logic and cleanup in SetupWizard
- feat: enhance SetupWizard and BootstrapProgress for improved database provisioning and error handling
- feat: enhance Dockerfile and supervisord configuration for portal warmup
- feat: implement batch file push functionality for Gitea integration
- feat: enhance Dockerfile and entrypoint for improved script handling and Gitea integration
- feat: enhance Key Vault access verification and update SetupWizard error handling
- feat: add support for Azure App Service Easy Auth in authentication flow
- feat: enhance maintenance pipeline commit message generation and portal functionality
- feat: enhance maintenance pipeline and portal functionality
- refactor: update login route to check Azure AD configuration
- feat: update setup wizard steps and API responses for Azure authentication
- feat: enhance Caddy reverse proxy configuration for Azure App Service
- feat: enhance Azure AD settings and Caddy configuration
- refactor: update setup steps in the wizard and API to streamline configuration
- feat: integrate Caddy as a reverse proxy and update Gitea external URL handling
- fix: use x-forwarded-host for all redirects, never raw url.host

# Changelog

All notable changes to Config365 are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are `EPOCH.PLATFORM.APP` (e.g. `1.2.10`): 1st digit is a rarely-bumped
epoch (bumped by hand, years apart), 2nd digit is a platform/Docker-image bump,
3rd digit is an app/script update applied by the built-in updater with no
Docker rebuild. See [docs/DEPLOY.md § Updating Config365](docs/DEPLOY.md#updating-config365).

---

<!-- Releases are prepended automatically by release-preview.yml -->
