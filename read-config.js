#!/usr/bin/env node
/**
 * read-config.js — Reads platform_settings from the Config365 SQLite DB
 * and prints shell variable assignments to stdout.
 *
 * Used by entrypoint-aio.sh (before supervisord starts) to:
 *   1. Configure Gitea's app.ini [database] section
 *   2. Conditionally enable the backup-scheduler supervisord program
 *
 * Usage:
 *   eval "$(node /usr/local/bin/read-config.js)"
 *
 * If the DB doesn't exist yet (very first boot) or any setting is absent,
 * the corresponding variable is not printed — the shell falls back to defaults.
 */
'use strict';

const path = require('path');
const DB_PATH = process.env.DB_PATH || process.env.SQLITE_PATH || '/data/db/config365.db';

// Attempt to require better-sqlite3 from /app/node_modules (installed in the image)
let Database;
try {
  Database = require('/app/node_modules/better-sqlite3');
} catch {
  // Not yet available — silently exit, entrypoint will use defaults
  process.exit(0);
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch {
  // DB file doesn't exist yet (first boot) — silently exit
  process.exit(0);
}

function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * Decrypts a setting encrypted with SESSION_SECRET via AES-256-GCM.
 * Returns null if decryption fails or the setting is missing.
 */
function getDecryptedSetting(key) {
  const stored = getSetting(key);
  if (!stored) return null;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return null;

  try {
    const crypto = require('crypto');
    const SALT = Buffer.from('config365-settings-v1', 'utf-8');
    const INFO = Buffer.from('setting-encryption', 'utf-8');
    const aesKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sessionSecret, 'utf-8'), SALT, INFO, 32));
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    return null;
  }
}

const output = [];

function emit(name, value) {
  if (value !== null && value !== undefined && value !== '') {
    // Escape single quotes in the value
    output.push(`export ${name}='${String(value).replace(/'/g, "'\\''")}'`);
  }
}

// ── Gitea settings ─────────────────────────────────────────────────────────
// gitea_external_url is set by the setup wizard (auto-detected public origin)
// or platform admin UI; read-config.js exports it and entrypoint-aio.sh applies
// it to app.ini ROOT_URL on every container start.
emit('GITEA_EXTERNAL_URL', getSetting('gitea_external_url'));
emit('GITEA_DB_TYPE',      getSetting('gitea_db_type'));
emit('GITEA_DB_HOST',      getSetting('gitea_db_host'));
emit('GITEA_DB_NAME',      getSetting('gitea_db_name'));
emit('GITEA_DB_USER',      getSetting('gitea_db_user'));
emit('GITEA_DB_PASSWD',    getDecryptedSetting('gitea_db_password'));
// gitea_external_dir: when set, the entire Gitea work dir (conf, repos, LFS,
// logs, custom) is stored at this path — intended for an Azure Files SMB mount.
// SQLite DB and LevelDB queues are always kept on the internal volume.
emit('GITEA_EXTERNAL_DIR', getSetting('gitea_external_dir'));

// ── Blob storage / backup settings ────────────────────────────────────────
emit('C365_BLOB_CONTAINER',          getSetting('blob_storage_container'));
emit('C365_BLOB_STORAGE_URI',        getSetting('blob_storage_uri'));
emit('C365_BLOB_CONNECTION_STRING',  getDecryptedSetting('blob_storage_connection_string'));
emit('C365_BACKUP_SCHEDULE',         getSetting('gitea_backup_schedule'));
emit('C365_BACKUP_RETENTION_DAYS',   getSetting('gitea_backup_retention_days'));

// ── MSSQL portal connection string (for test/health scripts) ──────────────
const portalConnStr = getDecryptedSetting('mssql_portal_connection_string');
if (portalConnStr) emit('C365_MSSQL_PORTAL_CONNSTR', portalConnStr);

if (output.length > 0) {
  console.log(output.join('\n'));
}

db.close();
