import 'server-only';

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, rmSync,
  readdirSync, statSync, symlinkSync, lstatSync,
} from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';

import { deleteSetting, getDecryptedSetting, getSetting, setSetting } from './settings-store';
import {
  readInstalledAppVersion,
  readInstalledPlatformVersion,
} from './platform-version';
import { MSSQL_SCHEMA_VERSION, getSchemaVersion, listPendingMssqlMigrations } from './db-mssql-schema';
import {
  SQLITE_SCHEMA_VERSION,
  getSqliteSchemaVersion,
  listPendingSqliteMigrations,
} from './db-sqlite-schema';
import {
  appendSessionLog,
  readUpdateSession,
  writeUpdateSession,
  type UpdateSession,
} from './update-session';

const execFileAsync = promisify(execFile);

export interface AppReleaseManifest {
  appVersion: string;
  requiredPlatformVersion: number;
  requiredSchemaVersion: number;
  updateType: 'app' | 'platform';
  sha256?: Record<string, string>;
}

export interface UpdateCheckResult {
  installedAppVersion: string;
  installedPlatformVersion: number;
  installedSchemaVersion: number;
  latestVersion: string | null;
  updateAvailable: boolean;
  blocked: boolean;
  blockReason?: 'platform_required' | 'none';
  requiredPlatformVersion?: number;
  requiredSchemaVersion?: number;
  pendingMigrations: Array<{ version: number; description: string }>;
  releaseNotes?: string;
  bumpType?: string;
  manifest?: AppReleaseManifest;
}

const DATA_APP = '/data/app';
const RELEASES_DIR = join(DATA_APP, 'releases');
const STAGING_DL = join(DATA_APP, 'staging');
const APP_UPDATE_SH = process.env.CONFIG365_APP_UPDATE_SCRIPT ?? '/usr/local/bin/app-update.sh';
const BAKED_NODE_MODULES = '/app/node_modules';

// App-only release tarballs never ship node_modules (better-sqlite3/mssql/@azure-*
// are native or huge, and stay pinned to the image's Node build). ESM `import`
// resolution ignores NODE_PATH, but it does walk up ancestor node_modules dirs the
// same way require() does — so a single symlink here lets run-migrations.mjs and
// the swapped portal/token-api processes (which all live under /data/app/...)
// resolve those externally-installed packages from the baked-in image location.
function ensureAppNodeModulesLink(): void {
  if (!existsSync(BAKED_NODE_MODULES)) return;
  const link = join(DATA_APP, 'node_modules');
  try {
    lstatSync(link);
    return; // already present (symlink, dir, or file) — leave it alone
  } catch {
    /* doesn't exist yet — fall through and create it */
  }
  try {
    mkdirSync(DATA_APP, { recursive: true });
    symlinkSync(BAKED_NODE_MODULES, link, 'dir');
  } catch {
    /* best-effort — resolution failures downstream will surface loudly if this matters */
  }
}

export type UpdateChannel = 'preview' | 'ga';

export interface UpdateChannelSettings {
  channel: UpdateChannel;
  repoOverride: string | null;
  effectiveRepo: string;
}

function repoForChannel(channel: UpdateChannel): string {
  return channel === 'ga' ? 'potsolutions/config365' : 'potsolutions/config365-preview';
}

function currentChannel(): UpdateChannel {
  return getSetting('update_channel') === 'ga' ? 'ga' : 'preview';
}

function defaultRepo(): string {
  const override = getSetting('update_repo');
  if (override) return override;
  return repoForChannel(currentChannel());
}

export function getUpdateChannelSettings(): UpdateChannelSettings {
  const channel = currentChannel();
  const repoOverride = getSetting('update_repo');
  return { channel, repoOverride, effectiveRepo: repoOverride || repoForChannel(channel) };
}

/**
 * Persists the app-update channel/repo. This only changes where **app-layer**
 * (patch/minor) update checks and tarball downloads come from — it has no
 * effect on the running Docker image (platform layer), which stays pinned to
 * whatever `ghcr.io/potsolutions/config365[-preview]:<tag>` was deployed.
 * Callers are responsible for warning admins about that distinction; this
 * function just validates and stores the value.
 */
export function setUpdateChannelSettings(input: { channel?: UpdateChannel; repoOverride?: string | null }): UpdateChannelSettings {
  if (input.channel) {
    if (input.channel !== 'preview' && input.channel !== 'ga') {
      throw new Error(`Invalid update channel "${input.channel}" — must be "preview" or "ga"`);
    }
    setSetting('update_channel', input.channel);
  }
  if (input.repoOverride !== undefined) {
    const trimmed = input.repoOverride?.trim();
    if (trimmed) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
        throw new Error(`Invalid repo override "${trimmed}" — expected "owner/repo"`);
      }
      setSetting('update_repo', trimmed);
    } else {
      deleteSetting('update_repo');
    }
  }
  return getUpdateChannelSettings();
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Config365-Updater',
  };
  const token = getDecryptedSetting('github_release_token') ?? process.env.GITHUB_TOKEN;
  // Token optional — potsolutions release repos and GHCR packages are public.
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function getInstalledSchemaVersion(): Promise<number> {
  const portalConn = getDecryptedSetting('mssql_portal_connection_string');
  if (portalConn) {
    try {
      const sql = (await import('mssql')).default;
      const pool = await new sql.ConnectionPool(portalConn).connect();
      try {
        return await getSchemaVersion(pool);
      } finally {
        await pool.close();
      }
    } catch {
      return 0;
    }
  }
  const dbPath = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? '/data/db/config365.db';
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    return getSqliteSchemaVersion(db);
  } finally {
    db.close();
  }
}

export async function getPendingMigrations(): Promise<Array<{ version: number; description: string }>> {
  const current = await getInstalledSchemaVersion();
  const portalConn = getDecryptedSetting('mssql_portal_connection_string');
  if (portalConn) return listPendingMssqlMigrations(current);
  const dbPath = process.env.DB_PATH ?? '/data/db/config365.db';
  if (!existsSync(dbPath)) {
    return listPendingSqliteMigrations(new Database(':memory:'));
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    return listPendingSqliteMigrations(db);
  } finally {
    db.close();
  }
}

async function fetchLatestRelease(): Promise<{ tag: string; body: string; assets: Array<{ name: string; url: string }> } | null> {
  const repo = defaultRepo();
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}: ${await res.text()}`);
  const json = await res.json() as {
    tag_name: string;
    body: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  return {
    tag: json.tag_name.replace(/^v/, ''),
    body: json.body ?? '',
    assets: json.assets.map(a => ({ name: a.name, url: a.browser_download_url })),
  };
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const installedApp = readInstalledAppVersion();
  const installedPlatform = readInstalledPlatformVersion().platformVersion;
  const installedSchema = await getInstalledSchemaVersion();
  const pendingMigrations = await getPendingMigrations();

  let latest: Awaited<ReturnType<typeof fetchLatestRelease>> = null;
  try {
    latest = await fetchLatestRelease();
  } catch {
    /* offline or unconfigured */
  }

  const result: UpdateCheckResult = {
    installedAppVersion: installedApp,
    installedPlatformVersion: installedPlatform,
    installedSchemaVersion: installedSchema,
    latestVersion: latest?.tag ?? null,
    updateAvailable: false,
    blocked: false,
    pendingMigrations,
    releaseNotes: latest?.body,
  };

  if (!latest?.tag) return result;

  if (compareSemver(latest.tag, installedApp) <= 0) return result;
  result.updateAvailable = true;

  try {
    const manifest = await fetchManifestForVersion(latest.tag, latest.assets);
    result.manifest = manifest;
    result.requiredPlatformVersion = manifest.requiredPlatformVersion;
    result.requiredSchemaVersion = manifest.requiredSchemaVersion;
    result.bumpType = manifest.updateType;

    if (installedPlatform < manifest.requiredPlatformVersion) {
      result.blocked = true;
      result.blockReason = 'platform_required';
    }
  } catch {
    /* manifest optional until download */
  }

  return result;
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchManifestForVersion(version: string, assets?: Array<{ name: string; url: string }>): Promise<AppReleaseManifest> {
  const localManifest = join(RELEASES_DIR, version, 'manifest.json');
  if (existsSync(localManifest)) {
    return JSON.parse(readFileSync(localManifest, 'utf-8')) as AppReleaseManifest;
  }
  const assetName = `config365-app-${version}.tar.gz`;
  const asset = assets?.find(a => a.name === assetName);
  if (!asset) throw new Error(`Release asset ${assetName} not found`);
  const tarPath = join(STAGING_DL, version, assetName);
  mkdirSync(join(STAGING_DL, version), { recursive: true });
  await downloadFile(asset.url, tarPath);
  const extractDir = join(STAGING_DL, version, 'extract');
  mkdirSync(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', tarPath, '-C', extractDir]);
  const manifestPath = join(extractDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('manifest.json missing from release');
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as AppReleaseManifest;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: githubHeaders(), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}`);
  mkdirSync(join(dest, '..'), { recursive: true });
  const file = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, file);
}

export async function downloadRelease(version: string): Promise<string> {
  const existingReleaseDir = join(RELEASES_DIR, version);
  if (existsSync(join(existingReleaseDir, 'manifest.json'))) return existingReleaseDir;

  const repo = defaultRepo();
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, {
    headers: githubHeaders(),
  });
  if (!res.ok) throw new Error(`Release v${version} not found (${res.status})`);
  const json = await res.json() as { assets: Array<{ name: string; browser_download_url: string }> };
  const assetName = `config365-app-${version}.tar.gz`;
  const asset = json.assets.find(a => a.name === assetName);
  if (!asset) throw new Error(`Asset ${assetName} not found`);

  const releaseDir = join(RELEASES_DIR, version);
  mkdirSync(releaseDir, { recursive: true });
  const tarPath = join(STAGING_DL, `${version}.tar.gz`);
  mkdirSync(STAGING_DL, { recursive: true });
  await downloadFile(asset.browser_download_url, tarPath);
  await execFileAsync('tar', ['-xzf', tarPath, '-C', releaseDir]);
  rmSync(tarPath, { force: true });
  return releaseDir;
}

function verifyReleaseChecksums(releaseDir: string, manifest: AppReleaseManifest): void {
  if (!manifest.sha256 || process.env.CONFIG365_SKIP_CHECKSUM_VERIFY === '1') return;
  for (const [label, expected] of Object.entries(manifest.sha256)) {
    const path = join(releaseDir, label);
    const h = createHash('sha256');
    if (!existsSync(path)) throw new Error(`Missing release path: ${label}`);
    if (label.endsWith('.mjs') || label === 'VERSION') {
      h.update(readFileSync(path));
    } else {
      hashTree(h, path, releaseDir);
    }
    const got = h.digest('hex');
    if (got !== expected) throw new Error(`Checksum mismatch for ${label}`);
  }
}

// Sorts the full flat list of relative file paths (not per-directory) so this
// is independent of filesystem traversal order. Must match the Python manifest
// hasher in scripts/pack-app-release.sh exactly.
function collectFiles(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectFiles(full, base, out);
    else out.push(full);
  }
}

function hashTree(h: ReturnType<typeof createHash>, dir: string, base: string): void {
  const files: string[] = [];
  collectFiles(dir, base, files);
  const relPaths = files.map(full => full.slice(base.length + 1).replace(/\\/g, '/'));
  const order = relPaths.map((rel, i) => i).sort((a, b) => (relPaths[a] < relPaths[b] ? -1 : relPaths[a] > relPaths[b] ? 1 : 0));
  for (const i of order) {
    h.update(relPaths[i]);
    h.update(readFileSync(files[i]));
  }
}

export function assertPlatformCompatible(manifest: AppReleaseManifest): void {
  if (process.env.CONFIG365_SKIP_PLATFORM_CHECK === '1') return;
  const installed = readInstalledPlatformVersion().platformVersion;
  if (installed < manifest.requiredPlatformVersion) {
    throw new Error(`Platform v${manifest.requiredPlatformVersion} required (installed v${installed})`);
  }
}

export async function runMigrationsForRelease(releaseDir: string): Promise<{ schemaVersion: number; migrationsApplied: number }> {
  const migrator = join(releaseDir, 'run-migrations.mjs');
  if (!existsSync(migrator)) return { schemaVersion: await getInstalledSchemaVersion(), migrationsApplied: 0 };
  ensureAppNodeModulesLink();
  const { stdout } = await execFileAsync('node', [migrator], {
    env: { ...process.env, SESSION_SECRET: process.env.SESSION_SECRET },
  });
  const lastLine = stdout.trim().split('\n').pop() ?? '{}';
  try {
    return JSON.parse(lastLine) as { schemaVersion: number; migrationsApplied: number };
  } catch {
    return { schemaVersion: await getInstalledSchemaVersion(), migrationsApplied: 0 };
  }
}

export async function swapAppRelease(version: string, releaseDir: string): Promise<void> {
  const currentLink = join(DATA_APP, 'current');
  mkdirSync(DATA_APP, { recursive: true });
  ensureAppNodeModulesLink();
  await execFileAsync('ln', ['-sfn', releaseDir, currentLink]);
  writeFileSync(
    join(DATA_APP, 'installed-version.json'),
    JSON.stringify({ appVersion: version, installedAt: new Date().toISOString() }, null, 2),
  );
}

export async function restartPortalServices(): Promise<void> {
  if (!existsSync('/usr/bin/supervisorctl')) return;
  await execFileAsync('supervisorctl', ['restart', 'portal', 'token-api']).catch(() => {});
}

export async function executeWizardStep2(session: UpdateSession): Promise<UpdateSession> {
  const version = session.targetVersion;
  appendSessionLog(session, `Downloading release v${version}...`);
  session.step = 'step2a';
  writeUpdateSession(session);

  const releaseDir = await downloadRelease(version);
  session.extractPath = releaseDir;
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf-8')) as AppReleaseManifest;
  session.manifest = manifest as unknown as Record<string, unknown>;
  assertPlatformCompatible(manifest);
  verifyReleaseChecksums(releaseDir, manifest);

  appendSessionLog(session, 'Running schema migrations...');
  const mig = await runMigrationsForRelease(releaseDir);
  session.schemaVersion = mig.schemaVersion;
  session.migrationsApplied = mig.migrationsApplied;
  appendSessionLog(session, `Schema v${mig.schemaVersion} (${mig.migrationsApplied} migration(s))`);

  session.step = 'step2b';
  writeUpdateSession(session);
  appendSessionLog(session, 'Swapping portal release...');
  await swapAppRelease(version, releaseDir);
  session.step = 'restarting';
  writeUpdateSession(session);
  appendSessionLog(session, 'Portal release swapped — restart pending');
  return session;
}

export async function restartPortalServicesDetached(): Promise<void> {
  if (!existsSync('/usr/bin/supervisorctl')) return;
  const { spawn } = await import('child_process');
  const child = spawn('supervisorctl', ['restart', 'portal', 'token-api'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export function maxRequiredSchemaVersion(): number {
  return Math.max(MSSQL_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION);
}

export { readUpdateSession, writeUpdateSession, appendSessionLog };
