/**
 * settings-store.ts — SQLite-backed platform_settings.
 *
 * This is the single source of truth for all Config365 configuration.
 * It is ALWAYS backed by SQLite (the config DB at DB_PATH), even when
 * operational data (msps, tenants, iam) lives in MSSQL.
 *
 * Sensitive settings can be stored encrypted via setEncryptedSetting /
 * getDecryptedSetting — they use AES-256-GCM keyed from SESSION_SECRET.
 */
import 'server-only';

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encryptSetting, tryDecryptSetting } from './config-crypto';

// ─── DB path ──────────────────────────────────────────────────────────────────

// DB_PATH: portal uses DB_PATH; token-api uses MAIN_DB_PATH — keep defaults identical
export const DB_PATH = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? process.env.SQLITE_PATH ?? './data/config365.db';

let _db: Database.Database | null = null;

export function getSettingsDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  maybeRestoreSettings(_db);
  return _db;
}

// ─── Settings backup / restore ────────────────────────────────────────────────
// On Azure App Service, also mirror to CONFIG365_PERSIST_DIR (/home/config365-data)
// so settings survive even if the SQLite file path is wrong on first boot.

function settingsBackupPath(): string {
  const persist = process.env.CONFIG365_PERSIST_DIR;
  if (persist) return join(persist, 'settings-backup.json');
  return join(dirname(DB_PATH), 'settings-backup.json');
}

function backupSettings(): void {
  try {
    const rows = getSettingsDb()
      .prepare<[], { key: string; value: string }>('SELECT key, value FROM platform_settings')
      .all();
    const obj: Record<string, string> = {};
    for (const r of rows) obj[r.key] = r.value;
    const payload = JSON.stringify(obj, null, 2);
    writeFileSync(settingsBackupPath(), payload, 'utf-8');
    // Keep a co-located copy when persist dir differs from DB dir
    const localBackup = join(dirname(DB_PATH), 'settings-backup.json');
    if (localBackup !== settingsBackupPath()) {
      writeFileSync(localBackup, payload, 'utf-8');
    }
  } catch { /* best-effort */ }
}

function maybeRestoreSettings(db: Database.Database): void {
  const count = (db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM platform_settings').get())?.n ?? 0;
  if (count > 0) return;

  const candidates = [
    settingsBackupPath(),
    join(dirname(DB_PATH), 'settings-backup.json'),
    '/home/config365-data/settings-backup.json',
  ];
  const backup = candidates.find((p) => existsSync(p));
  if (!backup) return;

  try {
    const obj = JSON.parse(readFileSync(backup, 'utf-8')) as Record<string, string>;
    const ins = db.prepare('INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)');
    const restore = db.transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) ins.run(k, v);
    });
    restore(Object.entries(obj));
    console.log(`[settings-store] Restored ${Object.keys(obj).length} settings from ${backup}.`);
  } catch (e) {
    console.error('[settings-store] Settings restore failed:', e);
  }
}

// ─── Plain settings ───────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getSettingsDb()
    .prepare<[string], { value: string }>('SELECT value FROM platform_settings WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getSettingsDb()
    .prepare('INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
  backupSettings();
}

export function deleteSetting(key: string): void {
  getSettingsDb()
    .prepare('DELETE FROM platform_settings WHERE key = ?')
    .run(key);
  backupSettings();
}

// ─── Encrypted settings ───────────────────────────────────────────────────────

/**
 * Stores a sensitive value encrypted with SESSION_SECRET.
 * Retrieve with getDecryptedSetting().
 */
export function setEncryptedSetting(key: string, plain: string): void {
  setSetting(key, encryptSetting(plain));
}

/**
 * Returns the decrypted value, or null if the key does not exist.
 * Returns null (and logs a warning) if decryption fails — this can happen
 * after SESSION_SECRET rotation; the admin UI should prompt for re-entry.
 */
export function getDecryptedSetting(key: string): string | null {
  const stored = getSetting(key);
  if (!stored) return null;
  const plain = tryDecryptSetting(stored);
  if (plain !== null) return plain;
  // Plaintext (pre-encryption) or decrypt failure — return raw so callers can
  // still work; encrypted values that fail to decrypt are indistinguishable from
  // legacy plaintext without a format check, so prefer raw over null.
  if (stored.includes(':') && stored.split(':').length === 3) {
    console.warn(`[settings-store] Decryption failed for key "${key}" — SESSION_SECRET may have changed.`);
    return null;
  }
  return stored;
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

export function isSetupComplete(): boolean {
  return getSetting('setup_complete') === '1';
}

// ─── Rejected run tracking ────────────────────────────────────────────────────
// When a user rejects a deployment from the portal, the workflow exits with
// code 1 (so the apply job never runs), but Gitea records conclusion: failure.
// We record the rejection here so the portal can display it as 'cancelled'.

export function recordRejectedRun(runId: number): void {
  setSetting(`rejected_run:${runId}`, '1');
}

export function isRejectedRun(runId: number): boolean {
  return getSetting(`rejected_run:${runId}`) === '1';
}

// ─── Stuck "Set up job" unstick tracking ──────────────────────────────────────

export function wasUnstickAttempted(runId: number): boolean {
  return getSetting(`unstick_run:${runId}`) === '1';
}

export function recordUnstickAttempt(runId: number): void {
  setSetting(`unstick_run:${runId}`, '1');
}

export function lastWorkflowUnstickAt(org: string, repo: string, workflow: string): number | null {
  const raw = getSetting(`unstick_wf:${org}:${repo}:${workflow}`);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function recordWorkflowUnstick(org: string, repo: string, workflow: string, at = new Date()): void {
  setSetting(`unstick_wf:${org}:${repo}:${workflow}`, at.toISOString());
}

/**
 * Loads the Gitea portal token from /init-data/portal-token.txt into platform_settings.
 * @param force When true, overwrite any existing DB token with the file contents.
 */
export function bootstrapGiteaToken(force = false): 'ok' | 'not-ready' {
  if (!force && getSetting('gitea_token')) return 'ok';
  const initDataDir = process.env.INIT_DATA_DIR ?? '/data/init-data';
  const tokenFile = `${initDataDir}/portal-token.txt`;
  try {
    const raw = readFileSync(tokenFile, 'utf-8');
    const token = raw.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
    if (!token) return 'not-ready';
    setSetting('gitea_token', token);
    return 'ok';
  } catch {
    return 'not-ready';
  }
}

/**
 * Auto-generates and stores the token encryption key on first call.
 * Priority: platform_settings (auto-generated on first use) → generate new.
 * Legacy TOKEN_ENCRYPTION_KEY env var is still honoured once for migration, then persisted.
 * Returns a raw 32-byte Buffer.
 */
export function getOrCreateTokenEncryptionKey(): Buffer {
  // Legacy env var (migration path — imported once then no longer needed)
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length === 32) {
      // Persist to settings so env var is no longer required after first boot
      if (!getSetting('token_encryption_key')) {
        setEncryptedSetting('token_encryption_key', fromEnv);
      }
      return key;
    }
  }

  const stored = getDecryptedSetting('token_encryption_key');
  if (stored) {
    const key = Buffer.from(stored, 'base64');
    if (key.length === 32) return key;
  }

  // Generate a new key and persist it
  const newKeyB64 = randomBytes(32).toString('base64');
  setEncryptedSetting('token_encryption_key', newKeyB64);
  console.log('[settings-store] Generated new token encryption key.');
  return Buffer.from(newKeyB64, 'base64');
}
