/**
 * Platform & MSP bootstrap — called from middleware / root layout.
 *
 * Workflow YAML templates are loaded from /pipeline-templates/ at runtime
 * (extracted from the embedded strings per the extract-yaml migration plan).
 * If those files are not present, seeding is skipped (safe for existing Gitea deployments).
 */

import 'server-only';
import { getSetting, setSetting, listMsps, listTenants, getMspGraphClientId, getMspInternalKey, generateAndStoreMspInternalKey } from './tenant-store';
import type { Msp, Tenant } from './tenant-store';
import * as gitea from './gitea';
import * as log from './bootstrap-log';
import { existsSync, readFileSync, statSync } from 'fs';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, relative, sep } from 'path';
import { createHash, randomBytes } from 'crypto';

// ─── Template directories ─────────────────────────────────────────────────────

const PIPELINE_TEMPLATES_DIR =
  process.env.PIPELINE_TEMPLATES_DIR ?? '/pipeline-templates-staging';

/** Maintainer debug workflows — repo `.debug/pipeline-templates/` (not in partner snapshots) */
const DEBUG_PIPELINE_TEMPLATES_DIR =
  process.env.DEBUG_PIPELINE_TEMPLATES_DIR ?? '/debug-staging/pipeline-templates';

const SCRIPTS_STAGING_DIR =
  process.env.SCRIPTS_STAGING_DIR ?? '/scripts-staging';

const SCRIPTS_SYNC_INTERVAL_MS = 60 * 60 * 1000;

// ─── Gitea init constants ─────────────────────────────────────────────────────

const GITEA_APP_INI_PATH = process.env.GITEA_APP_INI    ?? '/data/gitea/conf/app.ini';
const GITEA_TOKEN_FILE   = process.env.GITEA_TOKEN_FILE ?? '/data/init-data/portal-token.txt';
const GITEA_SENTINEL     = '/data/init-data/.initialized';
const GITEA_BIN          = '/usr/local/bin/gitea';
const GITEA_WORK_DIR_SH  = '/data/gitea';
const GITEA_ADMIN_USER   = 'config365-admin';
let _scriptsSyncPromise: Promise<void> | null = null;
let _scriptsSyncLastRun = 0;
let _resolvedOrchestratorOrg: string | null = null;

/** Where the shared orchestrator repo actually lives (may differ from GITEA_ORG on legacy installs). */
async function resolveOrchestratorOrg(): Promise<string> {
  if (_resolvedOrchestratorOrg) return _resolvedOrchestratorOrg;

  const envOrg = process.env.GITEA_ORG ?? 'config365';
  try {
    if (await gitea.repoExists(envOrg, 'orchestrator')) {
      _resolvedOrchestratorOrg = envOrg;
      return envOrg;
    }
  } catch { /* ignore */ }

  if (envOrg !== 'config365') {
    try {
      if (await gitea.repoExists('config365', 'orchestrator')) {
        console.warn(
          `[orchestrator] GITEA_ORG=${envOrg} has no orchestrator repo; using config365/orchestrator`,
        );
        _resolvedOrchestratorOrg = 'config365';
        return 'config365';
      }
    } catch { /* ignore */ }
  }

  _resolvedOrchestratorOrg = envOrg;
  return envOrg;
}

/** Maps local filename → Gitea path within {platformOrg}/orchestrator */
const ORCHESTRATOR_WORKFLOW_FILES: Array<{ local: string; gitea: string }> = [
  { local: 'backup-pipeline.yml',          gitea: '.gitea/workflows/backup-pipeline.yml' },
  { local: 'deploy-pipeline.yml',          gitea: '.gitea/workflows/deploy-pipeline.yml' },
  { local: 'maintenance-pipeline.yml',     gitea: '.gitea/workflows/maintenance-pipeline.yml' },
];

const ORCHESTRATOR_DEBUG_WORKFLOW_FILES: Array<{ local: string; gitea: string }> = [
  { local: 'debug-exchange-pipeline.yml', gitea: '.gitea/workflows/debug-exchange-pipeline.yml' },
];

/** Maps local filename → Gitea path within config365/orchestrator (engine workflow templates) */
const ORCHESTRATOR_ENGINE_FILES: Array<{ local: string; gitea: string }> = [];

/** Maps local filename → Gitea path within {mspOrg}/tenant-template */
const TENANT_TEMPLATE_WORKFLOW_FILES: Array<{ local: string; gitea: string }> = [
  { local: 'backup-pipeline.yml',          gitea: '.gitea/workflows/backup.yml' },
  { local: 'deploy-pipeline.yml',          gitea: '.gitea/workflows/deploy.yml' },
  { local: 'maintenance-pipeline.yml',     gitea: '.gitea/workflows/maintenance.yml' },
];

const TENANT_TEMPLATE_DEBUG_WORKFLOW_FILES: Array<{ local: string; gitea: string }> = [
  { local: 'debug-exchange-pipeline.yml', gitea: '.gitea/workflows/debug-exchange.yml' },
  { local: 'debug-defender-connector-backup-pipeline.yml', gitea: '.gitea/workflows/debug-defender-connector-backup.yml' },
  { local: 'debug-defender-connector-deploy-pipeline.yml', gitea: '.gitea/workflows/debug-defender-connector-deploy.yml' },
];

/** Maps local filename → Gitea path within {mspOrg}/engine */
const ENGINE_WORKFLOW_FILES: Array<{ local: string; gitea: string }> = [
  { local: 'engine-sync.yml', gitea: '.gitea/workflows/sync-workflows.yml' },
];

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedFile(org: string, repo: string, filePath: string, content: string): Promise<void> {
  const existing = await gitea.getFile(org, repo, filePath);
  if (existing.exists) return;
  await gitea.putFile(org, repo, filePath, content, `chore: seed ${filePath}`);
}

function gitBlobSha(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.byteLength}\0`);
  return createHash('sha1').update(header).update(buf).digest('hex');
}

const SCRIPTS_SYNC_SKIP_EXT = new Set(['.exe', '.dll', '.bin']);

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await walkDir(full));
    else if (entry.isFile()) {
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
      if (SCRIPTS_SYNC_SKIP_EXT.has(ext)) continue;
      results.push(full);
    }
  }
  return results;
}

function readTemplate(filename: string, templatesDir = PIPELINE_TEMPLATES_DIR): string | null {
  const path = join(templatesDir, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// ─── 1. Platform bootstrap ────────────────────────────────────────────────────
//
// Uses a shared Promise so concurrent callers all await the SAME in-flight
// bootstrap rather than returning immediately when _platformBusy was true.
// This prevents scripts-sync from running against a repo that doesn't exist yet.

let _platformReadyPromise: Promise<void> | null = null;
let _platformBootstrapCooldownUntil = 0;
let _schemasProvisioned = false;

export function bootstrapPlatformIfNeeded(): Promise<void> {
  if (!_platformReadyPromise) {
    if (Date.now() < _platformBootstrapCooldownUntil) {
      return Promise.reject(new Error('[platform-bootstrap] Cooldown active — retry later'));
    }
    _platformReadyPromise = _runPlatformBootstrap().catch(err => {
      _platformReadyPromise = null;
      _platformBootstrapCooldownUntil = Date.now() + 30_000;
      throw err;
    });
  }
  return _platformReadyPromise;
}

// ─── Gitea initialisation helpers ─────────────────────────────────────────────

function _readTokenFile(): string {
  try {
    return existsSync(GITEA_TOKEN_FILE) ? readFileSync(GITEA_TOKEN_FILE, 'utf-8').trim() : '';
  } catch { return ''; }
}

async function _pollGiteaReady(baseUrl: string, maxSeconds: number): Promise<boolean> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/version`);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function _checkGiteaToken(token: string, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/user`, {
      headers: { Authorization: `token ${token}` },
    });
    return res.status !== 401;
  } catch { return false; }
}

type ExecAsyncFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

async function _regenerateGiteaAdminAndToken(execAsync: ExecAsyncFn): Promise<void> {
  const r_admin = log.push('platform', 'Create Gitea admin user');
  try {
    const pass = randomBytes(20).toString('hex');
    await execAsync(
      `su -s /bin/sh git -c "GITEA_WORK_DIR='${GITEA_WORK_DIR_SH}' '${GITEA_BIN}' admin user create` +
      ` --config '${GITEA_APP_INI_PATH}' --admin --username '${GITEA_ADMIN_USER}'` +
      ` --password '${pass}' --email 'admin@config365.local' --must-change-password=false" 2>&1 || true`,
    );
    r_admin('success');
  } catch (err) {
    r_admin('error', (err as Error).message);
  }

  const r_token = log.push('platform', 'Generate portal token');
  try {
    // Delete any existing token with this name first (idempotent)
    await execAsync(
      `su -s /bin/sh git -c "GITEA_WORK_DIR='${GITEA_WORK_DIR_SH}' '${GITEA_BIN}' admin user delete-access-token` +
      ` --config '${GITEA_APP_INI_PATH}' --username '${GITEA_ADMIN_USER}' --name 'config365-portal'" 2>&1 || true`,
    );
    const { stdout } = await execAsync(
      `su -s /bin/sh git -c "GITEA_WORK_DIR='${GITEA_WORK_DIR_SH}' '${GITEA_BIN}' admin user generate-access-token` +
      ` --config '${GITEA_APP_INI_PATH}' --username '${GITEA_ADMIN_USER}' --token-name 'config365-portal' --raw 2>/dev/null"`,
    );
    const token = stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!token) throw new Error('Empty token from generate-access-token');

    await writeFile(GITEA_TOKEN_FILE, token, 'utf-8');
    setSetting('gitea_token', token);

    // System git (workflow run: steps) needs /root/.gitconfig URL rewrite — not just GITEA_TOKEN.
    await execAsync('/usr/local/bin/configure-runner-git-credentials.sh')
      .catch((err) => console.warn('[platform-bootstrap] git credential setup failed:', (err as Error).message));

    // Inject GITEA_TOKEN into runner shard supervisord env (go-git cross-org clones)
    await execAsync(
      `GITEA_TOKEN="${token}" REGISTER=0 /usr/local/bin/setup-runner-shards.sh`,
    ).catch(() => { /* non-fatal outside container */ });
    await execAsync('supervisorctl reread 2>/dev/null || true').catch(() => {});
    await execAsync('supervisorctl update 2>/dev/null || true').catch(() => {});

    r_token('success');
  } catch (err) {
    r_token('error', (err as Error).message);
    throw err;
  }

  // Re-register runner shards (best-effort — non-fatal if unavailable)
  const r_runner = log.push('platform', 'Register Gitea runner shards');
  try {
    const { stdout: rt } = await execAsync(
      `su -s /bin/sh git -c "GITEA_WORK_DIR='${GITEA_WORK_DIR_SH}' '${GITEA_BIN}' actions generate-runner-token` +
      ` --config '${GITEA_APP_INI_PATH}'" 2>/dev/null`,
    );
    const runnerToken = rt.trim().split('\n').pop()?.trim() ?? '';
    if (!runnerToken) { r_runner('skipped'); return; }

    await execAsync('rm -f /data/runner/.runner 2>/dev/null || true');
    await execAsync(
      `RUNNER_TOKEN_VAL="${runnerToken}" REGISTER=1 /usr/local/bin/setup-runner-shards.sh`,
    );
    await execAsync('supervisorctl reread 2>/dev/null || true').catch(() => {});
    await execAsync('supervisorctl update 2>/dev/null || true').catch(() => {});
    r_runner('success');
  } catch (err) {
    r_runner('error', (err as Error).message);
    // Non-fatal — runners can be re-registered on next container restart
  }
}

async function _initializeGitea(): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync: ExecAsyncFn = promisify(exec);

  const giteaInternalUrl = process.env.GITEA_INTERNAL_URL ?? 'http://localhost:3000';
  const isFirstRun = !existsSync(GITEA_SENTINEL);

  if (isFirstRun) {
    // ── First run: Gitea has never started. Configure app.ini, start it, bootstrap admin/token.

    const { getDecryptedSetting } = await import('./settings-store');
    const settingsDbType   = getSetting('gitea_db_type') ?? 'sqlite3';
    const settingsDbHost   = getSetting('gitea_db_host') ?? '';
    const settingsDbName   = getSetting('gitea_db_name') ?? 'gitea';
    const settingsDbUser   = getSetting('gitea_db_user') ?? '';
    const settingsDbPasswd = getDecryptedSetting('gitea_db_password') ?? '';

    // Patch app.ini with the configured DB settings
    const r_cfg = log.push('platform', `Configure Gitea DB → ${settingsDbType}`);
    try {
      if (existsSync(GITEA_APP_INI_PATH)) {
        let ini = readFileSync(GITEA_APP_INI_PATH, 'utf-8');
        ini = ini.replace(/^DB_TYPE\s*=.*$/m,  `DB_TYPE  = ${settingsDbType}`);
        ini = ini.replace(/^HOST\s*=.*$/m,      `HOST     = ${settingsDbHost}`);
        ini = ini.replace(/^NAME\s*=.*$/m,      `NAME     = ${settingsDbName}`);
        ini = ini.replace(/^USER\s*=.*$/m,      `USER     = ${settingsDbUser}`);
        ini = ini.replace(/^PASSWD\s*=.*$/m,    `PASSWD   = ${settingsDbPasswd}`);
        await writeFile(GITEA_APP_INI_PATH, ini, 'utf-8');
      }
      r_cfg('success');
    } catch (err) {
      r_cfg('error', (err as Error).message);
      throw err;
    }

    // Start Gitea via supervisord
    const r_start = log.push('platform', 'Start Gitea');
    try {
      await execAsync('supervisorctl start gitea');
      r_start('success');
    } catch (err) {
      r_start('error', (err as Error).message);
      throw err;
    }

    // Wait for Gitea API to be ready (MSSQL migrations can take up to 15 min)
    const maxWait = settingsDbType === 'sqlite3' ? 60 : 900;
    const waitLabel = settingsDbType !== 'sqlite3'
      ? `Wait for Gitea (${settingsDbType} migrations, up to ${maxWait / 60} min)`
      : 'Wait for Gitea to be ready';
    const r_wait = log.push('platform', waitLabel);
    const ready = await _pollGiteaReady(giteaInternalUrl, maxWait);
    if (!ready) {
      r_wait('error', `Gitea did not respond after ${maxWait}s`);
      throw new Error('Gitea not ready');
    }
    r_wait('success');

    // Create admin user, generate portal token, register runner
    await _regenerateGiteaAdminAndToken(execAsync);

    // Re-enable gitea autostart so future supervisord restarts start it automatically
    await execAsync(
      `sed -i '/^\\[program:gitea\\]/,/^\\[/{s/^autostart=false$/autostart=true/}' /etc/supervisord.conf`,
    ).catch(() => {});

    // Create sentinel to mark Gitea as initialised
    await execAsync(`touch ${GITEA_SENTINEL} && chown git:git ${GITEA_SENTINEL}`).catch(() => {
      // If chown fails (e.g. we're root), just ensure the file exists
      return execAsync(`touch ${GITEA_SENTINEL}`).catch(() => {});
    });
    console.log('[platform-bootstrap] Gitea sentinel created — first-run init complete.');

  } else {
    // ── Subsequent run: Gitea is managed by supervisord. Wait for it, then validate token.

    const r_wait = log.push('platform', 'Wait for Gitea to be ready');
    const ready = await _pollGiteaReady(giteaInternalUrl, 120);
    if (!ready) {
      r_wait('error', 'Gitea did not respond after 120s');
      throw new Error('Gitea not ready');
    }
    r_wait('success');

    // Validate the stored portal token; regenerate if it has become invalid
    const existingToken = getSetting('gitea_token') || _readTokenFile();
    const tokenValid = existingToken
      ? await _checkGiteaToken(existingToken, giteaInternalUrl)
      : false;

    if (!tokenValid) {
      console.warn('[platform-bootstrap] Portal token invalid — regenerating...');
      const hasSupervisorctl = await execAsync('which supervisorctl 2>/dev/null')
        .then(() => true).catch(() => false);
      if (hasSupervisorctl) {
        await _regenerateGiteaAdminAndToken(execAsync);
      } else {
        log.push('platform', 'Token invalid — supervisorctl unavailable, skipping regen')('skipped');
      }
    } else if (existingToken && !getSetting('gitea_token')) {
      // Token came from file but was not yet persisted to the settings store
      setSetting('gitea_token', existingToken);
    }

    // Ensure runner git credentials exist (entrypoint may have run before wizard created the token).
    const tokenForGit = getSetting('gitea_token') || _readTokenFile();
    if (tokenForGit) {
      await execAsync('/usr/local/bin/configure-runner-git-credentials.sh')
        .catch((err) => console.warn('[platform-bootstrap] git credential refresh failed:', (err as Error).message));
    }
  }
}

async function _runPlatformBootstrap(): Promise<void> {
  const org = process.env.GITEA_ORG ?? 'config365';
  log.markScopeStart('platform');
  try {
    await _provisionMssqlSchemas();
    await _initializeGitea();

    if (getSetting('platform_bootstrapped') !== '1') {
      await _bootstrapPlatform();
      setSetting('platform_bootstrapped', '1');
    }
    await seedOrchestratorWorkflows(org);
    await seedOrchestratorEngineFiles(org);
  } catch (err) {
    console.error('[platform-bootstrap] Error:', err instanceof Error ? err.message : err);
    throw err;
  } finally {
    log.markScopeDone('platform');
  }
}

/**
 * Provision MSSQL schemas for portal and token store if connection strings are
 * configured.  This is safe to call on every bootstrap — both operations are
 * fully idempotent (CREATE TABLE IF NOT EXISTS / migration runner skips already-
 * applied migrations).  Uses explicit ConnectionPool instances so the mssql
 * global singleton is never touched.
 */
async function _provisionMssqlSchemas(): Promise<void> {
  if (_schemasProvisioned) return;
  _schemasProvisioned = true;

  const { getDecryptedSetting } = await import('./settings-store');

  const portalConnRaw = getDecryptedSetting('mssql_portal_connection_string');
  const tokenConnRaw  = getDecryptedSetting('mssql_token_connection_string');

  if (!portalConnRaw && !tokenConnRaw) return; // Both SQLite — nothing to do

  const { normalizeMssqlConnectionString, errMessage } = await import('./mssql-connstr');
  const sql = (await import('mssql')).default;

  // ── Portal schema ──────────────────────────────────────────────────────────
  if (portalConnRaw) {
    const resolve = log.push('platform', 'Provision portal MSSQL schema');
    try {
      const normalized = normalizeMssqlConnectionString(portalConnRaw);
      if (!normalized.ok) throw new Error(normalized.detail);
      const { provisionSchema } = await import('./db-mssql-schema');
      const { resetDbAdapter }  = await import('./db-factory');
      const pool   = await new sql.ConnectionPool(normalized.connectionString).connect();
      const result = await provisionSchema(pool);
      await pool.close();
      resetDbAdapter();
      resolve('success', `v${result.schemaVersion}, ${result.migrationsApplied} migration(s)`);
    } catch (err) {
      resolve('error', errMessage(err));
      // Non-fatal — Gitea bootstrap can still proceed; portal may fall back to SQLite
      console.error('[platform-bootstrap] Portal schema provisioning failed:', errMessage(err));
    }
  }

  // ── Token store schema ─────────────────────────────────────────────────────
  if (tokenConnRaw) {
    const resolve = log.push('platform', 'Provision token store MSSQL schema');
    try {
      const normalized = normalizeMssqlConnectionString(tokenConnRaw);
      if (!normalized.ok) throw new Error(normalized.detail);
      const pool = await new sql.ConnectionPool(normalized.connectionString).connect();
      await pool.request().query(`
        IF OBJECT_ID('dbo.tenant_tokens', 'U') IS NOT NULL
           AND OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
          EXEC sp_rename 'dbo.tenant_tokens', 'c365t_tenant_tokens';
      `);
      await pool.request().query(`
        IF OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
        CREATE TABLE dbo.c365t_tenant_tokens (
          tenantSlug         NVARCHAR(255) NOT NULL PRIMARY KEY,
          accessTokenEnc     NVARCHAR(MAX) NOT NULL DEFAULT '',
          refreshTokenEnc    NVARCHAR(MAX) NOT NULL DEFAULT '',
          expiresAt          NVARCHAR(50)  NOT NULL DEFAULT '',
          scope              NVARCHAR(MAX) NOT NULL DEFAULT '',
          deviceCode         NVARCHAR(MAX) NULL,
          mdeRefreshTokenEnc NVARCHAR(MAX) NOT NULL DEFAULT '',
          mdeDeviceCode      NVARCHAR(MAX) NOT NULL DEFAULT '',
          updatedAt          NVARCHAR(50)  NOT NULL
        );
      `);
      await pool.close();
      const { resetTokenBackend } = await import('../token-backend');
      resetTokenBackend();
      resolve('success');
    } catch (err) {
      resolve('error', errMessage(err));
      console.error('[platform-bootstrap] Token schema provisioning failed:', errMessage(err));
    }
  }
}

async function _bootstrapPlatform(): Promise<void> {
  const org = process.env.GITEA_ORG ?? 'config365';
  const orchestratorOrg = await resolveOrchestratorOrg();

  const resolve_org = log.push('platform', `Create org: ${org}`);
  try {
    if (!(await gitea.orgExists(org))) {
      await gitea.createOrg(org, {
        fullName: 'Config365 Platform',
        description: 'Orchestrator: shared reusable workflows and PowerShell scripts for all MSPs',
        visibility: 'private',
      });
      resolve_org('success');
    } else {
      resolve_org('skipped');
    }
  } catch (err) {
    resolve_org('error', (err as Error).message);
    throw err;
  }

  const resolve_repo = log.push('platform', 'Create orchestrator repo');
  try {
    if (!(await gitea.repoExists(orchestratorOrg, 'orchestrator'))) {
      await gitea.createRepo(orchestratorOrg, 'orchestrator', { description: 'Shared PowerShell scripts and reusable Gitea Actions workflow templates', private: true });
      const resolve_readme = log.push('platform', 'Seed orchestrator README');
      try {
        await seedFile(orchestratorOrg, 'orchestrator', 'README.md', `# ${orchestratorOrg}/orchestrator\n\nShared scripts and reusable workflow templates for all MSPs managed by Config365.\n`);
        resolve_readme('success');
      } catch (e) { resolve_readme('error', (e as Error).message); }

      for (const dir of ['graph-configs', 'backup', 'common', 'debug']) {
        const resolve_dir = log.push('platform', `Seed ${dir}/.gitkeep`);
        try {
          await seedFile(orchestratorOrg, 'orchestrator', `${dir}/.gitkeep`, '');
          resolve_dir('success');
        } catch (e) { resolve_dir('error', (e as Error).message); }
      }
      resolve_repo('success');
    } else {
      resolve_repo('skipped');
    }
  } catch (err) {
    resolve_repo('error', (err as Error).message);
    throw err;
  }

  try { await gitea.setOrgVariable(org, 'PLATFORM_ORG', orchestratorOrg); } catch { /* non-fatal */ }
}

async function seedOrchestratorWorkflows(org: string): Promise<void> {
  if (!existsSync(PIPELINE_TEMPLATES_DIR)) return;

  const existingTree = await gitea.getGitTree(org, 'orchestrator').catch(() => [] as gitea.GitTreeEntry[]);
  const existingByPath = new Map(existingTree.map(e => [e.path, e.sha]));

  for (const wf of ORCHESTRATOR_WORKFLOW_FILES) {
    const content = readTemplate(wf.local);
    if (!content) continue;

    const buf       = Buffer.from(content, 'utf-8');
    const localSha  = gitBlobSha(buf);
    const remoteSha = existingByPath.get(wf.gitea);

    if (remoteSha === localSha) continue;

    const resolve = log.push('platform', `Seed pipeline: ${wf.local}`);
    let retried = false;
    while (true) {
      try {
        await gitea.putFile(org, 'orchestrator', wf.gitea, content, `chore: seed ${wf.local}`, remoteSha, 'main');
        resolve('success');
        break;
      } catch (err: unknown) {
        const msg = (err as Error).message ?? '';
        if (!retried && msg.includes('403')) { retried = true; await new Promise(r => setTimeout(r, 1500)); continue; }
        resolve('error', msg);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!existsSync(DEBUG_PIPELINE_TEMPLATES_DIR)) return;

  for (const wf of ORCHESTRATOR_DEBUG_WORKFLOW_FILES) {
    const content = readTemplate(wf.local, DEBUG_PIPELINE_TEMPLATES_DIR);
    if (!content) continue;

    const buf       = Buffer.from(content, 'utf-8');
    const localSha  = gitBlobSha(buf);
    const remoteSha = existingByPath.get(wf.gitea);

    if (remoteSha === localSha) continue;

    const resolve = log.push('platform', `Seed debug pipeline: ${wf.local}`);
    let retried = false;
    while (true) {
      try {
        await gitea.putFile(org, 'orchestrator', wf.gitea, content, `chore: seed ${wf.local}`, remoteSha, 'main');
        resolve('success');
        break;
      } catch (err: unknown) {
        const msg = (err as Error).message ?? '';
        if (!retried && msg.includes('403')) { retried = true; await new Promise(r => setTimeout(r, 1500)); continue; }
        resolve('error', msg);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

async function seedOrchestratorEngineFiles(org: string): Promise<void> {
  if (!existsSync(PIPELINE_TEMPLATES_DIR)) return;

  const existingTree = await gitea.getGitTree(org, 'orchestrator').catch(() => [] as gitea.GitTreeEntry[]);
  const existingByPath = new Map(existingTree.map(e => [e.path, e.sha]));

  for (const wf of ORCHESTRATOR_ENGINE_FILES) {
    const content = readTemplate(wf.local);
    if (!content) continue;

    const buf       = Buffer.from(content, 'utf-8');
    const localSha  = gitBlobSha(buf);
    const remoteSha = existingByPath.get(wf.gitea);

    if (remoteSha === localSha) continue;

    const resolve = log.push('platform', `Seed engine file: ${wf.local}`);
    let retried = false;
    while (true) {
      try {
        await gitea.putFile(org, 'orchestrator', wf.gitea, content, `chore: seed ${wf.local}`, remoteSha, 'main');
        resolve('success');
        break;
      } catch (err: unknown) {
        const msg = (err as Error).message ?? '';
        if (!retried && msg.includes('403')) { retried = true; await new Promise(r => setTimeout(r, 1500)); continue; }
        resolve('error', msg);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ─── 2. MSP bootstrap ─────────────────────────────────────────────────────────

const _mspPromises = new Map<string, Promise<void>>();

export function bootstrapMspIfNeeded(msp: Msp): Promise<void> {
  if (!_mspPromises.has(msp.slug)) {
    const dbKey = `msp_bootstrapped_${msp.slug}`;
    let p: Promise<void>;
    if (getSetting(dbKey) === '1') {
      // Already done in a previous process run; still run engine + workflow sync
      p = _runMspPostBootstrap(msp);
    } else {
      p = _runMspBootstrap(msp);
    }
    _mspPromises.set(msp.slug, p.catch(err => {
      _mspPromises.delete(msp.slug);
      throw err;
    }));
  }
  return _mspPromises.get(msp.slug)!;
}

async function _runMspBootstrap(msp: Msp): Promise<void> {
  const scope = `msp:${msp.slug}`;
  log.markScopeStart(scope);
  try {
    await _bootstrapMsp(msp);
    setSetting(`msp_bootstrapped_${msp.slug}`, '1');
    await _runMspPostBootstrap(msp);
  } catch (err) {
    console.error(`[msp-bootstrap:${msp.slug}] Error:`, err instanceof Error ? err.message : err);
  } finally {
    log.markScopeDone(scope);
  }
}

async function _runMspPostBootstrap(msp: Msp): Promise<void> {
  const scope = `msp:${msp.slug}`;
  log.markScopeStart(scope);
  try {
    await bootstrapMspEngineIfNeeded(msp);
    try { await gitea.markRepoAsTemplate(msp.giteaOrg, 'tenant-template'); } catch { /* non-fatal */ }
    await ensureMspTenantReposExist(msp);
    await syncMspTenantWorkflows(msp);
  } finally {
    log.markScopeDone(scope);
  }
}

/**
 * Ensures every active tenant for this MSP has a Gitea repo.
 * Called during MSP post-bootstrap so that tenants already in the portal DB
 * get their repos recreated after a Gitea wipe / full reset.
 * Uses _provisionTenantRepo (not bootstrapTenantRepo) to avoid a deadlock
 * with the in-flight bootstrapMspIfNeeded promise.
 */
async function ensureMspTenantReposExist(msp: Msp): Promise<void> {
  let tenants: Tenant[] = [];
  try { tenants = (await listTenants(msp.id)).filter(t => t.isActive); }
  catch { return; }

  for (const tenant of tenants) {
    const repoName = `tenant-${tenant.slug}`;
    const exists = await gitea.repoExists(msp.giteaOrg, repoName).catch(() => false);
    if (!exists) {
      const scope = `tenant:${tenant.slug}`;
      log.markScopeStart(scope);
      try {
        await _provisionTenantRepo(msp, tenant);
      } catch (err: unknown) {
        log.push(scope, `Failed to recreate tenant repo`)('error', (err as Error).message);
      } finally {
        log.markScopeDone(scope);
      }
    }
  }
}

async function _bootstrapMsp(msp: Msp): Promise<void> {
  const org = msp.giteaOrg;
  const platformOrg = await resolveOrchestratorOrg();
  const scope = `msp:${msp.slug}`;

  const resolve_org = log.push(scope, `Create MSP org: ${org}`);
  try {
    if (!(await gitea.orgExists(org))) {
      await gitea.createOrg(org, { fullName: msp.displayName, description: `${msp.displayName} — Config365 managed tenants`, visibility: 'private' });
      resolve_org('success');
    } else {
      resolve_org('skipped');
    }
  } catch (err) { resolve_org('error', (err as Error).message); throw err; }

  const resolve_tt = log.push(scope, 'Create tenant-template repo');
  try {
    if (!(await gitea.repoExists(org, 'tenant-template'))) {
      await gitea.createRepo(org, 'tenant-template', { description: `Template forked per managed tenant`, private: true });
      const r_readme = log.push(scope, 'Seed tenant-template README');
      try {
        await seedFile(org, 'tenant-template', 'README.md', `# ${org}/tenant-template\n\nTemplate repository for Config365-managed tenants in ${msp.displayName}.\n`);
        r_readme('success');
      } catch (e) { r_readme('error', (e as Error).message); }

      for (const wf of TENANT_TEMPLATE_WORKFLOW_FILES) {
        const content = readTemplate(wf.local);
        if (content) {
          const r_wf = log.push(scope, `Seed workflow: ${wf.gitea}`);
          try { await seedFile(org, 'tenant-template', wf.gitea, content); r_wf('success'); }
          catch (e) { r_wf('error', (e as Error).message); }
        }
      }
      if (existsSync(DEBUG_PIPELINE_TEMPLATES_DIR)) {
        for (const wf of TENANT_TEMPLATE_DEBUG_WORKFLOW_FILES) {
          const content = readTemplate(wf.local, DEBUG_PIPELINE_TEMPLATES_DIR);
          if (content) {
            const r_wf = log.push(scope, `Seed debug workflow: ${wf.gitea}`);
            try { await seedFile(org, 'tenant-template', wf.gitea, content); r_wf('success'); }
            catch (e) { r_wf('error', (e as Error).message); }
          }
        }
      }
      const r_bi = log.push(scope, 'Seed .baseline-ignore');
      try {
        await seedFile(org, 'tenant-template', '.baseline-ignore', '# Paths to exclude from baseline diff (glob patterns, one per line)\n');
        r_bi('success');
      } catch (e) { r_bi('error', (e as Error).message); }

      resolve_tt('success');
    } else {
      resolve_tt('skipped');
    }
  } catch (err) { resolve_tt('error', (err as Error).message); throw err; }

  const resolve_bl = log.push(scope, 'Create baseline repo');
  try {
    if (!(await gitea.repoExists(org, 'baseline'))) {
      await gitea.createRepo(org, 'baseline', { description: `M365 baseline for ${msp.displayName} tenants`, private: true });
      const r_readme = log.push(scope, 'Seed baseline README');
      try {
        await seedFile(org, 'baseline', 'README.md', `# ${org}/baseline\n\nM365 baseline configurations for ${msp.displayName}.\n`);
        r_readme('success');
      } catch (e) { r_readme('error', (e as Error).message); }

      const dirs = [
        'baseline/conditional-access/policies', 'baseline/conditional-access/named-locations',
        'baseline/intune/device-configurations', 'baseline/intune/compliance-policies',
        'baseline/intune/settings-catalog', 'baseline/intune/mobile-apps',
        'baseline/intune/defender-connector', 'baseline/intune/admx-files', 'baseline/intune/app-protection',
        'baseline/intune/endpoint-security', 'baseline/intune/platform-scripts-powershell',
        'baseline/intune/windows-updates', 'baseline/groups', 'baseline/exchange',
        'baseline/exchange/irm-configuration', 'baseline/exchange/ome-configuration',
        'baseline/exchange/aip-service', 'baseline/exchange/aip-service/configuration',
        'baseline/sharepoint-settings', 'baseline/sharepoint-settings/tenant-configuration', 'baseline/teams', 'baseline/authentication-policies',
        'baseline/entra-id-device-settings', 'baseline/enterprise-apps',
        'baseline/information-protection/sensitivity-labels',
        'baseline/information-protection/label-policies',
        'baseline/information-protection/label-policy-rules',
        'baseline/information-protection/auto-label-policies',
        'baseline/information-protection/auto-label-rules',
        'baseline/information-protection/dlp-policies',
        'baseline/information-protection/dlp-rules',
        'baseline-remove/conditional-access/policies', 'baseline-remove/groups', 'baseline-remove/intune',
        'maintenance',
      ];
      for (const dir of dirs) {
        try { await seedFile(org, 'baseline', `${dir}/.gitkeep`, ''); } catch { /* non-fatal */ }
      }
      resolve_bl('success');
    } else {
      resolve_bl('skipped');
    }
  } catch (err) { resolve_bl('error', (err as Error).message); throw err; }

  const resolve_vars = log.push(scope, 'Set org variables');
  try {
    await gitea.setOrgVariable(org, 'MSP_ORG', org);
    await gitea.setOrgVariable(org, 'PLATFORM_ORG', platformOrg);
    await gitea.setOrgVariable(org, 'CONFIG365_BRANCH', 'main');
    resolve_vars('success');
  } catch (err) { resolve_vars('error', (err as Error).message); }

  const resolve_sec = log.push(scope, 'Set org secrets');
  try {
    const adminToken = gitea.getToken();
    if (adminToken) {
      await gitea.setOrgSecret(org, 'CONFIG365_TOKEN', adminToken);
      resolve_sec('success');
    } else {
      resolve_sec('skipped');
    }
  } catch (err) { resolve_sec('error', (err as Error).message); }

  // Ensure PORTAL_INTERNAL_KEY exists so the token-api can authenticate pipeline
  // requests for tenants belonging to this MSP.  Generated once; never overwritten.
  if (!getMspInternalKey(msp.slug)) {
    const r_key = log.push(scope, 'Generate PORTAL_INTERNAL_KEY');
    try {
      const newKey = generateAndStoreMspInternalKey(msp.slug);
      await gitea.setOrgSecret(org, 'PORTAL_INTERNAL_KEY', newKey);
      r_key('success');
    } catch (err) { r_key('error', (err as Error).message); }
  }
}

// ─── 2b. MSP engine bootstrap ─────────────────────────────────────────────────

const _enginePromises = new Map<string, Promise<void>>();

export async function bootstrapMspEngineIfNeeded(msp: Msp): Promise<void> {
  if (_enginePromises.has(msp.slug)) return _enginePromises.get(msp.slug)!;

  const dbKey = `engine_bootstrapped_${msp.slug}`;
  if (getSetting(dbKey) === '1') return;

  const p = _runEngineBootstrap(msp).catch(err => {
    _enginePromises.delete(msp.slug);
    throw err;
  });
  _enginePromises.set(msp.slug, p);
  return p;
}

async function _runEngineBootstrap(msp: Msp): Promise<void> {
  const scope = `msp:${msp.slug}`;
  await _bootstrapMspEngine(msp);
  setSetting(`engine_bootstrapped_${msp.slug}`, '1');
}

async function _bootstrapMspEngine(msp: Msp): Promise<void> {
  const org = msp.giteaOrg;
  const scope = `msp:${msp.slug}`;

  const resolve_repo = log.push(scope, 'Create engine repo');
  try {
    if (!(await gitea.repoExists(org, 'engine'))) {
      await gitea.createRepo(org, 'engine', {
        description: `MSP-level automation workflows for ${msp.displayName}`,
        private: true,
      });
      const r_readme = log.push(scope, 'Seed engine README');
      try {
        await seedFile(org, 'engine', 'README.md',
          `# ${org}/engine\n\nMSP-level Gitea Actions for ${msp.displayName}.\n\n` +
          `Workflow files (except \`sync-workflows.yml\`) are kept up-to-date automatically\n` +
          `by the nightly \`sync-workflows.yml\` run which pulls from \`config365/orchestrator/engine-workflows/\`.\n`
        );
        r_readme('success');
      } catch (e) { r_readme('error', (e as Error).message); }
      resolve_repo('success');
    } else {
      resolve_repo('skipped');
    }
  } catch (err) { resolve_repo('error', (err as Error).message); throw err; }

  if (!existsSync(PIPELINE_TEMPLATES_DIR)) return;
  for (const wf of ENGINE_WORKFLOW_FILES) {
    const content = readTemplate(wf.local);
    if (!content) continue;
    const resolve_wf = log.push(scope, `Seed engine workflow: ${wf.gitea}`);
    try { await seedFile(org, 'engine', wf.gitea, content); resolve_wf('success'); }
    catch (e) { resolve_wf('error', (e as Error).message); }
  }
}

// ─── One-time tenant workflow sync ────────────────────────────────────────────

const WORKFLOW_SYNC_VERSION = 'v18';

const _tenantSyncPromises = new Map<string, Promise<void>>();

/** Idempotent — always refresh MSP_ORG / PLATFORM_ORG and internal URLs for pipelines. */
async function ensureMspPipelineOrgVariables(msp: Msp): Promise<void> {
  const platformOrg = await resolveOrchestratorOrg();
  const org = msp.giteaOrg;
  try { await gitea.setOrgVariable(org, 'MSP_ORG', org); } catch { /* non-fatal */ }
  try { await gitea.setOrgVariable(org, 'PLATFORM_ORG', platformOrg); } catch { /* non-fatal */ }
  // Internal URLs for docker job mode (harmless default on host/sharded mode)
  const giteaInternal = process.env.GITEA_INTERNAL_URL ?? 'http://localhost:3000';
  const tokenApiInternal = process.env.TOKEN_API_INTERNAL_URL ?? 'http://localhost:4322';
  try { await gitea.setOrgVariable(org, 'GITEA_INTERNAL_URL', giteaInternal); } catch { /* non-fatal */ }
  try { await gitea.setOrgVariable(org, 'TOKEN_API_INTERNAL_URL', tokenApiInternal); } catch { /* non-fatal */ }
}

export async function syncMspTenantWorkflows(msp: Msp): Promise<void> {
  if (_tenantSyncPromises.has(msp.slug)) return _tenantSyncPromises.get(msp.slug)!;

  // Always run the sync body. A previous one-shot flag left new tenant repos
  // (created after the first sync) without backup/deploy/maintenance workflows.
  const p = (async () => {
    await ensureMspPipelineOrgVariables(msp);
    await _syncMspTenantWorkflows(msp);
    setSetting(`msp_tenant_workflows_synced_${WORKFLOW_SYNC_VERSION}_${msp.slug}`, '1');
  })().catch(err => {
    _tenantSyncPromises.delete(msp.slug);
    throw err;
  });
  _tenantSyncPromises.set(msp.slug, p);
  return p;
}

async function _syncMspTenantWorkflows(msp: Msp): Promise<void> {
  const scope = `msp:${msp.slug}`;

  if (!existsSync(PIPELINE_TEMPLATES_DIR)) {
    const r = log.push(scope, 'Sync tenant workflows');
    r('skipped');
    return;
  }

  const tenants = (await listTenants(msp.id)).filter(t => t.isActive);
  if (tenants.length === 0) {
    const r = log.push(scope, 'Sync tenant workflows');
    r('skipped');
    return;
  }

  // Seed MSP-level Gitea org variables / secrets
  const graphClientId = getMspGraphClientId(msp.slug);
  const internalKey   = getMspInternalKey(msp.slug);
  if (graphClientId) {
    const r = log.push(scope, 'Set AZURE_CLIENT_ID org variable');
    try { await gitea.setOrgVariable(msp.giteaOrg, 'AZURE_CLIENT_ID', graphClientId); r('success'); }
    catch (err: unknown) { r('error', (err as Error).message); }
  }
  if (internalKey) {
    const r = log.push(scope, 'Set PORTAL_INTERNAL_KEY org secret');
    try { await gitea.setOrgSecret(msp.giteaOrg, 'PORTAL_INTERNAL_KEY', internalKey); r('success'); }
    catch (err: unknown) { r('error', (err as Error).message); }
  }

  for (const tenant of tenants) {
    const repoName = `tenant-${tenant.slug}`;
    if (!(await gitea.repoExists(msp.giteaOrg, repoName).catch(() => false))) continue;

    try {
      await gitea.setRepoVariable(msp.giteaOrg, repoName, 'TENANT_SLUG', tenant.slug);
      if (tenant.tenantId) {
        await gitea.setRepoVariable(msp.giteaOrg, repoName, 'AZURE_TENANT_ID', tenant.tenantId);
      }
    } catch (err: unknown) {
      console.warn(`[tenant-workflow-sync:${msp.slug}] Could not set repo variables for ${repoName}: ${(err as Error).message}`);
    }

    let existingTree: gitea.GitTreeEntry[];
    try {
      existingTree = await gitea.getGitTree(msp.giteaOrg, repoName);
    } catch {
      continue;
    }
    const existingByPath = new Map(existingTree.map(e => [e.path, e.sha]));

    for (const wf of TENANT_TEMPLATE_WORKFLOW_FILES) {
      const content = readTemplate(wf.local);
      if (!content) continue;

      const buf      = Buffer.from(content, 'utf-8');
      const localSha = gitBlobSha(buf);
      const remoteSha = existingByPath.get(wf.gitea);

      if (remoteSha === localSha) continue;

      const r = log.push(scope, `Update ${repoName}/${wf.gitea}`);
      try {
        await gitea.putFile(msp.giteaOrg, repoName, wf.gitea, content,
          `sync: update ${wf.gitea} from config365/orchestrator`, remoteSha, 'main');
        r('success');
      } catch (err: unknown) {
        r('error', (err as Error)?.message ?? String(err));
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!existsSync(DEBUG_PIPELINE_TEMPLATES_DIR)) continue;

    for (const wf of TENANT_TEMPLATE_DEBUG_WORKFLOW_FILES) {
      const content = readTemplate(wf.local, DEBUG_PIPELINE_TEMPLATES_DIR);
      if (!content) continue;

      const buf      = Buffer.from(content, 'utf-8');
      const localSha = gitBlobSha(buf);
      const remoteSha = existingByPath.get(wf.gitea);

      if (remoteSha === localSha) continue;

      const r = log.push(scope, `Update ${repoName}/${wf.gitea} (debug)`);
      try {
        await gitea.putFile(msp.giteaOrg, repoName, wf.gitea, content,
          `sync: update ${wf.gitea} from config365 debug templates`, remoteSha, 'main');
        r('success');
      } catch (err: unknown) {
        r('error', (err as Error)?.message ?? String(err));
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

export async function bootstrapAllMspsIfNeeded(): Promise<void> {
  let msps: Msp[] = [];
  try { msps = await listMsps(); } catch { return; }
  await Promise.all(msps.map(m => bootstrapMspIfNeeded(m).catch(() => {})));
}

// ─── 3. Scripts sync ──────────────────────────────────────────────────────────

export function syncScriptsToGitea(): Promise<void> {
  // Return the existing in-flight promise if sync is already running.
  // This prevents concurrent callers (e.g. multiple simultaneous requests)
  // from each starting their own sync and causing Git ref-lock conflicts.
  if (_scriptsSyncPromise) return _scriptsSyncPromise;

  const now = Date.now();
  if (now - _scriptsSyncLastRun < SCRIPTS_SYNC_INTERVAL_MS) return Promise.resolve();

  _scriptsSyncPromise = _runScriptsSync().finally(() => {
    _scriptsSyncPromise = null;
  });
  return _scriptsSyncPromise;
}

/**
 * Returns a snapshot of the current scripts-sync state.
 * Used by /api/health/sync-status so portal-warmup.sh and runner-start.sh
 * can block until the sync has completed after a fresh Docker image deploy.
 */
export function getScriptsSyncStatus(): { inProgress: boolean; done: boolean } {
  return {
    inProgress: _scriptsSyncPromise !== null,
    done: _scriptsSyncLastRun > 0 && _scriptsSyncPromise === null,
  };
}

async function _runScriptsSync(): Promise<void> {
  // Wait for platform bootstrap to fully complete before pushing scripts.
  await bootstrapPlatformIfNeeded();

  if (!existsSync(SCRIPTS_STAGING_DIR)) return;

  log.clearScope('scripts-sync');
  log.markScopeStart('scripts-sync');
  const org  = await resolveOrchestratorOrg();
  const repo = 'orchestrator';

  try {
    // 1. Fetch the full remote tree once — used for SHA comparison and skipping
    const existingEntries = await gitea.getGitTree(org, repo).catch(() => [] as gitea.GitTreeEntry[]);
    const existingShaMap  = new Map<string, string>(existingEntries.map(e => [e.path, e.sha]));

    // 2. Diff local files against remote — collect only files that changed.
    //    Uses async readdir/readFile and yields between files to avoid
    //    monopolising the Node.js event loop while scanning large script trees.
    const localFiles = await walkDir(SCRIPTS_STAGING_DIR);
    type Resolver = ReturnType<typeof log.push>;
    const toUpload: Array<{ relPath: string; content: string; remoteSha?: string; resolve: Resolver }> = [];
    let skipped = 0;

    for (const localPath of localFiles) {
      // Yield to the event loop between files so concurrent requests
      // (static chunks, API calls) are not blocked by this scan.
      await new Promise<void>(r => setImmediate(r));

      const relPath   = relative(SCRIPTS_STAGING_DIR, localPath).split(sep).join('/');
      const buf       = await readFile(localPath);
      const localSha  = gitBlobSha(buf);
      const remoteSha = existingShaMap.get(relPath);

      if (remoteSha === localSha) { skipped++; continue; }

      const resolve = log.push('scripts-sync', relPath);
      toUpload.push({ relPath, content: buf.toString('utf-8'), remoteSha, resolve });
    }

    if (toUpload.length === 0) {
      log.push('scripts-sync', `Sync complete — skipped ${skipped} (all up to date)`)('success');
      console.log(`[scripts-sync] Nothing to push — all ${skipped} files up to date`);
      _scriptsSyncLastRun = Date.now();
      return;
    }

    // 3. Push all changed files — batched commits via Gitea POST /contents (multi-file API).
    //    Falls back to sequential putFile only if batch API fails.
    const commitMsg = `sync: update ${toUpload.length} script${toUpload.length === 1 ? '' : 's'}`;
    let failedCount = 0;

    try {
      await gitea.batchPutFiles(
        org, repo,
        toUpload.map(f => ({ path: f.relPath, content: f.content })),
        commitMsg,
      );
      for (const f of toUpload) f.resolve('success');
    } catch (batchErr) {
      const batchMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      log.push('scripts-sync', 'Batch commit unavailable — switching to sequential fallback')('skipped');
      console.warn('[scripts-sync] batchPutFiles failed — falling back to sequential putFile:', batchMsg);
      for (const f of toUpload) {
        try {
          await gitea.putFile(org, repo, f.relPath, f.content, `sync: ${f.relPath}`, f.remoteSha);
          f.resolve('success');
        } catch (putErr) {
          const putMsg = putErr instanceof Error ? putErr.message : String(putErr);
          f.resolve('error', putMsg);
          failedCount++;
        }
      }
    }

    const pushed  = toUpload.length - failedCount;
    const summary = `Pushed ${pushed}, skipped ${skipped}${failedCount > 0 ? `, failed ${failedCount}` : ''}`;
    log.push('scripts-sync', `Sync complete — ${summary}`)( failedCount > 0 ? 'error' : 'success');

    console.log(`[scripts-sync] Done — ${summary} (${localFiles.length} total)`);
    if (failedCount === 0) _scriptsSyncLastRun = Date.now();

    // Also keep pipeline template YAMLs in sync so a Docker rebuild automatically
    // updates the Gitea workflow files without needing a manual API push or re-bootstrap.
    await seedOrchestratorWorkflows(org).catch(err =>
      console.error('[scripts-sync] Pipeline template sync error:', err instanceof Error ? err.message : err)
    );
    await seedOrchestratorEngineFiles(org).catch(err =>
      console.error('[scripts-sync] Engine file sync error:', err instanceof Error ? err.message : err)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scripts-sync] Error:', msg);
    log.push('scripts-sync', `Sync failed: ${msg}`)('error');
    // Don't advance the throttle timer on failure so the next request retries
  } finally {
    log.markScopeDone('scripts-sync');
  }
}

// ─── 4. Tenant repo bootstrap ─────────────────────────────────────────────────
//
// Called from POST /api/tenants. Wraps all Gitea provisioning steps with
// structured logging so the frontend can poll for real-time progress.

export interface TenantRepoOptions {
  tenantId?:    string | null;
  displayName?: string;
}

export async function bootstrapTenantRepo(msp: Msp, tenant: Tenant): Promise<void> {
  const scope = `tenant:${tenant.slug}`;
  log.markScopeStart(scope);
  try {
    await _provisionTenantRepo(msp, tenant);

    // Trigger MSP bootstrap (seeds workflow templates to this new repo among others).
    // Only called from the external entry point — not when called from inside the MSP
    // bootstrap chain (where bootstrapMspIfNeeded is already in-flight and would deadlock).
    const r_msp = log.push(scope, 'Trigger MSP bootstrap');
    try {
      await bootstrapMspIfNeeded(msp);
      r_msp('success');
    } catch (err) {
      r_msp('error', (err as Error).message);
    }
  } finally {
    log.markScopeDone(scope);
  }
}

/**
 * Seeds missing workflow YAML into a tenant (or tenant-template) repo from
 * PIPELINE_TEMPLATES_DIR. Does not overwrite files that already exist.
 */
async function ensureRepoWorkflowFiles(
  org: string,
  repoName: string,
  scope: string,
): Promise<void> {
  if (!existsSync(PIPELINE_TEMPLATES_DIR)) {
    log.push(scope, `Seed workflows into ${repoName}`)('skipped');
    return;
  }

  for (const wf of TENANT_TEMPLATE_WORKFLOW_FILES) {
    const content = readTemplate(wf.local);
    if (!content) continue;
    const r = log.push(scope, `Ensure ${repoName}/${wf.gitea}`);
    try {
      await seedFile(org, repoName, wf.gitea, content);
      r('success');
    } catch (err: unknown) {
      r('error', (err as Error).message);
    }
  }

  try {
    await seedFile(
      org,
      repoName,
      '.baseline-ignore',
      '# Paths to exclude from baseline diff (glob patterns, one per line)\n',
    );
  } catch { /* non-fatal */ }
}

/** Paths copied from {mspOrg}/tenant-template into a tenant repo on demand. */
function isTenantTemplateManagedPath(path: string): boolean {
  return path === '.baseline-ignore' || path.startsWith('.gitea/');
}

export interface SyncTenantFromTemplateResult {
  updated: string[];
  skipped: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Align an existing tenant repo with the MSP's tenant-template:
 * copies `.gitea/**` and `.baseline-ignore` (create or update), re-enables
 * Actions/Issues, and refreshes TENANT_SLUG / AZURE_TENANT_ID variables.
 * Does not touch README or backup data.
 */
export async function syncTenantRepoFromTemplate(
  msp: Pick<Msp, 'giteaOrg'>,
  tenant: { slug: string; tenantId?: string | null },
): Promise<SyncTenantFromTemplateResult> {
  const org = msp.giteaOrg;
  const repoName = `tenant-${tenant.slug}`;
  const templateRepo = 'tenant-template';

  if (!(await gitea.repoExists(org, templateRepo))) {
    throw new Error(`${org}/${templateRepo} does not exist`);
  }
  if (!(await gitea.repoExists(org, repoName))) {
    throw new Error(`${org}/${repoName} does not exist`);
  }

  const templateTree = await gitea.getGitTree(org, templateRepo);
  const paths = templateTree
    .map(e => e.path)
    .filter(isTenantTemplateManagedPath)
    .sort();

  const updated: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const path of paths) {
    try {
      const src = await gitea.getFile(org, templateRepo, path);
      if (!src.exists) continue;

      const dest = await gitea.getFile(org, repoName, path);
      if (dest.exists && dest.sha === src.sha) {
        skipped.push(path);
        continue;
      }

      await gitea.putFile(
        org,
        repoName,
        path,
        src.content,
        `sync: align ${path} with tenant-template`,
        dest.exists ? dest.sha : undefined,
      );
      updated.push(path);
      await new Promise(r => setTimeout(r, 200));
    } catch (err: unknown) {
      errors.push({ path, error: (err as Error).message ?? String(err) });
    }
  }

  try { await gitea.enableRepoActions(org, repoName); } catch { /* non-fatal */ }
  try { await gitea.enableRepoIssues(org, repoName); } catch { /* non-fatal */ }
  try { await gitea.setRepoVariable(org, repoName, 'TENANT_SLUG', tenant.slug); } catch { /* non-fatal */ }
  if (tenant.tenantId) {
    try { await gitea.setRepoVariable(org, repoName, 'AZURE_TENANT_ID', tenant.tenantId); } catch { /* non-fatal */ }
  }

  return { updated, skipped, errors };
}

/**
 * Core tenant repo provisioning — creates the repo, enables Actions/Issues,
 * sets variables and branch protection. Does NOT trigger bootstrapMspIfNeeded,
 * so it is safe to call from inside the MSP bootstrap chain.
 */
async function _provisionTenantRepo(msp: Msp, tenant: Tenant): Promise<void> {
  const scope    = `tenant:${tenant.slug}`;
  const org      = msp.giteaOrg;
  const repoName = `tenant-${tenant.slug}`;

  // Ensure MSP org exists
  const r_org = log.push(scope, `Ensure MSP org: ${org}`);
  try {
    if (!(await gitea.orgExists(org))) {
      await gitea.createOrg(org, { fullName: msp.displayName, visibility: 'private' });
      r_org('success');
    } else { r_org('skipped'); }
  } catch (err) { r_org('error', (err as Error).message); throw err; }

  // Create tenant repo
  const r_repo = log.push(scope, `Create repo: ${repoName}`);
  let createdVia: 'template' | 'createRepo' | 'existing' = 'existing';
  try {
    if (!(await gitea.repoExists(org, repoName))) {
      const templateExists = await gitea.repoExists(org, 'tenant-template');
      if (templateExists) {
        try {
          await gitea.generateFromTemplate(org, 'tenant-template', org, repoName, {
            description: `Config365 tenant repo for ${tenant.displayName}`,
            private: true,
          });
          createdVia = 'template';
        } catch (genErr: unknown) {
          const msg = (genErr as Error).message ?? '';
          console.warn(`[bootstrapTenantRepo] generateFromTemplate failed for ${org}/${repoName}: ${msg}; falling back to createRepo`);
          await gitea.createRepo(org, repoName, {
            description: `Config365 tenant repo for ${tenant.displayName}`,
            private: true,
            autoInit: true,
          });
          createdVia = 'createRepo';
        }
      } else {
        console.warn(`[bootstrapTenantRepo] tenant-template missing in ${org}; createRepo for ${repoName}`);
        await gitea.createRepo(org, repoName, {
          description: `Config365 tenant repo for ${tenant.displayName}`,
          private: true,
          autoInit: true,
        });
        createdVia = 'createRepo';
      }
      r_repo('success');
    } else { r_repo('skipped'); }
  } catch (err) { r_repo('error', (err as Error).message); throw err; }

  // Always ensure workflows exist. generateFromTemplate can fail (then createRepo
  // leaves only README), and a one-shot MSP sync flag previously skipped healing
  // tenants created after the first sync.
  console.log(`[bootstrapTenantRepo] ${org}/${repoName} createdVia=${createdVia}; ensuring workflow files`);
  await ensureRepoWorkflowFiles(org, repoName, scope);

  // Enable Actions and Issues
  const r_actions = log.push(scope, 'Enable Actions & Issues');
  try {
    await gitea.enableRepoActions(org, repoName);
    await gitea.enableRepoIssues(org, repoName);
    r_actions('success');
  } catch (err) { r_actions('error', (err as Error).message); }

  // Set repo variables
  const r_vars = log.push(scope, 'Set TENANT_SLUG variable');
  try {
    await gitea.setRepoVariable(org, repoName, 'TENANT_SLUG', tenant.slug);
    r_vars('success');
  } catch (err) { r_vars('error', (err as Error).message); }

  if (tenant.tenantId) {
    const r_tid = log.push(scope, 'Set AZURE_TENANT_ID variable');
    try {
      await gitea.setRepoVariable(org, repoName, 'AZURE_TENANT_ID', tenant.tenantId);
      r_tid('success');
    } catch (err) { r_tid('error', (err as Error).message); }
  }

  // Branch protection
  const r_bp = log.push(scope, 'Set branch protection');
  try {
    await gitea.enforceBranchProtection(org, repoName);
    r_bp('success');
  } catch (err) { r_bp('error', (err as Error).message); }
}
