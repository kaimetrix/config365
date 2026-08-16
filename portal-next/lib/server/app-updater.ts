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

type UpdateLogger = (line: string) => void;

function sessionLogger(session: UpdateSession): UpdateLogger {
  return (line) => { appendSessionLog(session, line); };
}

function splitLogLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').filter(line => line.length > 0);
}

function formatCommand(file: string, args: string[]): string {
  return [file, ...args].map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

async function execLogged(
  log: UpdateLogger,
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  log(`$ ${formatCommand(file, args)}`);
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      ...opts,
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of splitLogLines(stdout)) log(`  ${line}`);
    for (const line of splitLogLines(stderr)) log(`  [stderr] ${line}`);
    if (!stdout.trim() && !stderr.trim()) log('  (no output)');
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    for (const line of splitLogLines(e.stdout ?? '')) log(`  ${line}`);
    for (const line of splitLogLines(e.stderr ?? '')) log(`  [stderr] ${line}`);
    log(`  [exit] ${e.message}`);
    throw err;
  }
}

async function fetchLogged(log: UpdateLogger, url: string, init?: RequestInit): Promise<Response> {
  log(`$ GET ${url}`);
  try {
    const res = await fetch(url, init);
    log(`  HTTP ${res.status} ${res.statusText || ''}`.trim());
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    if (remaining != null) log(`  rate-limit ${remaining}/${limit ?? '?'}`);
    return res;
  } catch (err) {
    log(`  [error] ${(err as Error).message}`);
    throw err;
  }
}
import {
  compareSemver,
  emptySourceDebug,
  formatBlockedUpdateError,
  formatNoUpdateError,
  githubReleaseTagUrl,
  inferRequiredPlatformVersion,
  repoForChannel,
  type UpdateChannel,
  type UpdateSourceDebug,
} from '../update-source';

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
  source: UpdateSourceDebug;
  trace: string[];
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

export type { UpdateChannel, UpdateSourceDebug };
export { formatBlockedUpdateError, formatNoUpdateError };

export interface UpdateChannelSettings {
  channel: UpdateChannel;
  repoOverride: string | null;
  effectiveRepo: string;
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

function githubToken(): string | undefined {
  return getDecryptedSetting('github_release_token') ?? process.env.GITHUB_TOKEN ?? undefined;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Config365-Updater',
  };
  // Token optional — potsolutions release repos and GHCR packages are public.
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function applyGithubResponseMeta(debug: UpdateSourceDebug, res: Response): void {
  debug.httpStatus = res.status;
  debug.rateLimitRemaining = res.headers.get('x-ratelimit-remaining') ?? undefined;
  debug.rateLimitLimit = res.headers.get('x-ratelimit-limit') ?? undefined;
}

function currentSourceDebug(): UpdateSourceDebug {
  return emptySourceDebug(currentChannel(), defaultRepo(), Boolean(githubToken()));
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

async function fetchLatestRelease(log: UpdateLogger): Promise<{
  release: { tag: string; body: string; assets: Array<{ name: string; url: string }> } | null;
  debug: UpdateSourceDebug;
}> {
  const debug = currentSourceDebug();
  let res: Response;
  try {
    res = await fetchLogged(log, debug.releasesUrl, { headers: githubHeaders() });
  } catch (err) {
    debug.error = `Could not reach ${debug.releasesUrl}: ${(err as Error).message}`;
    return { release: null, debug };
  }
  applyGithubResponseMeta(debug, res);
  if (res.status === 404) {
    debug.error = `No releases published on ${debug.repo} (${debug.releasesUrl})`;
    log(`  ${debug.error}`);
    return { release: null, debug };
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    debug.error = `GitHub releases API ${res.status} for ${debug.releasesUrl}: ${body}`;
    log(`  ${debug.error}`);
    return { release: null, debug };
  }
  const json = await res.json() as {
    tag_name: string;
    body: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  const assets = json.assets.map(a => ({ name: a.name, url: a.browser_download_url }));
  log(`  tag ${json.tag_name} · ${assets.length} asset(s): ${assets.map(a => a.name).join(', ') || '(none)'}`);
  return {
    debug,
    release: {
      tag: json.tag_name.replace(/^v/, ''),
      body: json.body ?? '',
      assets,
    },
  };
}

async function fetchLightweightManifest(
  assets: Array<{ name: string; url: string }>,
  log: UpdateLogger,
): Promise<Partial<AppReleaseManifest> | null> {
  const asset = assets.find(a => a.name === 'platform-manifest.json' || a.name === 'manifest.json');
  if (!asset) {
    log('  no platform-manifest.json / manifest.json asset — inferring platform from version tag');
    return null;
  }
  const res = await fetchLogged(log, asset.url, { headers: githubHeaders(), redirect: 'follow' });
  if (!res.ok) {
    log(`  manifest download failed HTTP ${res.status}`);
    return null;
  }
  const json = await res.json() as {
    appVersion?: string;
    requiredPlatformVersion?: number;
    platformVersion?: number;
    requiredSchemaVersion?: number;
    updateType?: 'app' | 'platform';
    sha256?: Record<string, string>;
  };
  log(`  manifest ${asset.name}: platform=${json.requiredPlatformVersion ?? json.platformVersion ?? '?'} type=${json.updateType ?? '?'}`);
  return {
    appVersion: json.appVersion ?? '',
    requiredPlatformVersion: json.requiredPlatformVersion ?? json.platformVersion,
    requiredSchemaVersion: json.requiredSchemaVersion,
    updateType: json.updateType,
    sha256: json.sha256,
  };
}

function applyPlatformRequirement(
  result: UpdateCheckResult,
  requiredPlatformVersion: number,
): void {
  result.requiredPlatformVersion = requiredPlatformVersion;
  if (result.installedPlatformVersion < requiredPlatformVersion) {
    result.blocked = true;
    result.blockReason = 'platform_required';
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const installedApp = readInstalledAppVersion();
  const installedPlatform = readInstalledPlatformVersion().platformVersion;
  const installedSchema = await getInstalledSchemaVersion();
  const pendingMigrations = await getPendingMigrations();
  const source = currentSourceDebug();
  const trace: string[] = [];
  const log: UpdateLogger = line => { trace.push(line); };

  const result: UpdateCheckResult = {
    installedAppVersion: installedApp,
    installedPlatformVersion: installedPlatform,
    installedSchemaVersion: installedSchema,
    latestVersion: null,
    updateAvailable: false,
    blocked: false,
    pendingMigrations,
    source,
    trace,
  };

  log(`check channel=${source.channel} repo=${source.repo} auth=${source.authenticated ? 'token' : 'anonymous'}`);
  log(`installed app=${installedApp} platform=v${installedPlatform} schema=v${installedSchema}`);

  const fetched = await fetchLatestRelease(log);
  Object.assign(source, fetched.debug);
  const latest = fetched.release;

  result.latestVersion = latest?.tag ?? null;
  result.releaseNotes = latest?.body;

  if (!latest?.tag) {
    log(source.error ? `check failed: ${source.error}` : 'no latest release');
    return result;
  }
  if (compareSemver(latest.tag, installedApp) <= 0) {
    log(`v${latest.tag} is not newer than installed ${installedApp} — up to date`);
    return result;
  }
  result.updateAvailable = true;

  // Infer from EPOCH.PLATFORM.APP so a platform bump is blocked even when the
  // tarball/manifest cannot be downloaded during the check (the old path
  // swallowed that failure and left Start update enabled).
  applyPlatformRequirement(result, inferRequiredPlatformVersion(latest.tag));
  result.bumpType = result.blocked ? 'platform' : 'app';
  log(`inferred required platform v${result.requiredPlatformVersion} from tag v${latest.tag}`);

  try {
    const light = await fetchLightweightManifest(latest.assets, log);
    if (light?.requiredPlatformVersion != null) {
      applyPlatformRequirement(result, light.requiredPlatformVersion);
      result.bumpType = light.updateType ?? result.bumpType;
      result.requiredSchemaVersion = light.requiredSchemaVersion;
      if (light.appVersion) {
        result.manifest = {
          appVersion: light.appVersion,
          requiredPlatformVersion: light.requiredPlatformVersion,
          requiredSchemaVersion: light.requiredSchemaVersion ?? 0,
          updateType: light.updateType ?? (result.blocked ? 'platform' : 'app'),
          sha256: light.sha256,
        };
      }
    }
  } catch (err) {
    source.error = `Release listed but manifest fetch failed: ${(err as Error).message}`;
    log(`  [error] ${source.error}`);
  }

  if (result.blocked) {
    log(`blocked: Docker update required (platform v${result.requiredPlatformVersion}, installed v${installedPlatform})`);
  } else {
    log(`app update available: ${installedApp} → ${latest.tag}`);
  }

  return result;
}

async function downloadFile(url: string, dest: string, log: UpdateLogger): Promise<void> {
  const res = await fetchLogged(log, url, { headers: githubHeaders(), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status} from ${url}`);
  mkdirSync(join(dest, '..'), { recursive: true });
  const file = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, file);
  const bytes = existsSync(dest) ? statSync(dest).size : 0;
  log(`  saved ${dest} (${bytes} bytes)`);
}

export async function downloadRelease(version: string, log: UpdateLogger = () => {}): Promise<string> {
  const existingReleaseDir = join(RELEASES_DIR, version);
  if (existsSync(join(existingReleaseDir, 'manifest.json'))) {
    log(`release already extracted at ${existingReleaseDir}`);
    return existingReleaseDir;
  }

  const repo = defaultRepo();
  const url = githubReleaseTagUrl(repo, version);
  const res = await fetchLogged(log, url, {
    headers: githubHeaders(),
  });
  if (!res.ok) throw new Error(`Release v${version} not found at ${url} (${res.status})`);
  const json = await res.json() as { assets: Array<{ name: string; browser_download_url: string }> };
  const assetName = `config365-app-${version}.tar.gz`;
  const asset = json.assets.find(a => a.name === assetName);
  if (!asset) throw new Error(`Asset ${assetName} not found on ${url}`);
  log(`  using asset ${assetName} → ${asset.browser_download_url}`);

  const releaseDir = join(RELEASES_DIR, version);
  mkdirSync(releaseDir, { recursive: true });
  const tarPath = join(STAGING_DL, `${version}.tar.gz`);
  mkdirSync(STAGING_DL, { recursive: true });
  await downloadFile(asset.browser_download_url, tarPath, log);
  await execLogged(log, 'tar', ['-xzf', tarPath, '-C', releaseDir]);
  rmSync(tarPath, { force: true });
  log(`extracted to ${releaseDir}`);
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

export async function runMigrationsForRelease(
  releaseDir: string,
  log: UpdateLogger = () => {},
): Promise<{ schemaVersion: number; migrationsApplied: number }> {
  const migrator = join(releaseDir, 'run-migrations.mjs');
  if (!existsSync(migrator)) {
    log(`no ${migrator} — skipping schema migrations`);
    return { schemaVersion: await getInstalledSchemaVersion(), migrationsApplied: 0 };
  }
  ensureAppNodeModulesLink();
  const { stdout } = await execLogged(log, 'node', [migrator], {
    env: { ...process.env, SESSION_SECRET: process.env.SESSION_SECRET },
  });
  const lastLine = stdout.trim().split('\n').pop() ?? '{}';
  try {
    return JSON.parse(lastLine) as { schemaVersion: number; migrationsApplied: number };
  } catch {
    return { schemaVersion: await getInstalledSchemaVersion(), migrationsApplied: 0 };
  }
}

export async function swapAppRelease(version: string, releaseDir: string, log: UpdateLogger = () => {}): Promise<void> {
  const currentLink = join(DATA_APP, 'current');
  mkdirSync(DATA_APP, { recursive: true });
  ensureAppNodeModulesLink();
  await execLogged(log, 'ln', ['-sfn', releaseDir, currentLink]);
  const installed = join(DATA_APP, 'installed-version.json');
  writeFileSync(
    installed,
    JSON.stringify({ appVersion: version, installedAt: new Date().toISOString() }, null, 2),
  );
  log(`wrote ${installed} appVersion=${version}`);
}

export async function restartPortalServices(): Promise<void> {
  if (!existsSync('/usr/bin/supervisorctl')) return;
  await execFileAsync('supervisorctl', ['restart', 'portal', 'token-api']).catch(() => {});
}

export async function executeWizardStep2(session: UpdateSession): Promise<UpdateSession> {
  const version = session.targetVersion;
  const log = sessionLogger(session);
  const source = currentSourceDebug();
  log(`will apply v${version} from ${githubReleaseTagUrl(source.repo, version)}`);
  session.step = 'step2a';
  writeUpdateSession(session);

  const releaseDir = await downloadRelease(version, log);
  session.extractPath = releaseDir;
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf-8')) as AppReleaseManifest;
  session.manifest = manifest as unknown as Record<string, unknown>;
  log(`manifest requiredPlatform=v${manifest.requiredPlatformVersion} schema=v${manifest.requiredSchemaVersion} type=${manifest.updateType}`);
  assertPlatformCompatible(manifest);
  verifyReleaseChecksums(releaseDir, manifest);
  log('checksums ok');

  const mig = await runMigrationsForRelease(releaseDir, log);
  session.schemaVersion = mig.schemaVersion;
  session.migrationsApplied = mig.migrationsApplied;
  log(`schema now v${mig.schemaVersion} (${mig.migrationsApplied} migration(s))`);

  session.step = 'step2b';
  writeUpdateSession(session);
  await swapAppRelease(version, releaseDir, log);
  session.step = 'restarting';
  writeUpdateSession(session);
  log('portal release swapped — restart pending');
  return session;
}

export async function restartPortalServicesDetached(log: UpdateLogger = () => {}): Promise<void> {
  if (!existsSync('/usr/bin/supervisorctl')) {
    log('supervisorctl not present — skip portal restart');
    return;
  }
  log('$ supervisorctl restart portal token-api  (detached)');
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
