/**
 * Standalone migration runner — built to run-migrations.mjs, invoked before portal hot-swap.
 */
import Database from 'better-sqlite3';
import sql from 'mssql';
import { hkdfSync, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

import { provisionSchema, getSchemaVersion } from './lib/server/db-mssql-schema.js';
import { provisionSqliteSchema, getSqliteSchemaVersion } from './lib/server/db-sqlite-schema.js';

const DB_PATH = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? '/data/db/config365.db';

function decryptSettingValue(stored: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET required to decrypt connection strings');
  const key = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf-8'),
    Buffer.from('config365-settings-v1', 'utf-8'),
    Buffer.from('setting-encryption', 'utf-8'),
    32,
  ));
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted setting format');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(ctB64, 'base64')) + decipher.final('utf8');
}

async function decryptSetting(key: string): Promise<string | null> {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare<[string], { value: string }>(
      'SELECT value FROM platform_settings WHERE key = ?',
    ).get(key);
    if (!row?.value) return null;
    if (!row.value.includes(':')) return row.value;
    return decryptSettingValue(row.value);
  } finally {
    db.close();
  }
}

async function runSqlite(): Promise<{ schemaVersion: number; migrationsApplied: number }> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const before = getSqliteSchemaVersion(db);
    const result = provisionSqliteSchema(db);
    console.log(`[run-migrations] SQLite: v${before} → v${result.schemaVersion} (${result.migrationsApplied} applied)`);
    return result;
  } finally {
    db.close();
  }
}

async function runMssqlPortal(connStr: string): Promise<{ schemaVersion: number; migrationsApplied: number }> {
  const pool = await new sql.ConnectionPool(connStr).connect();
  try {
    const before = await getSchemaVersion(pool);
    const result = await provisionSchema(pool);
    console.log(`[run-migrations] MSSQL portal: v${before} → v${result.schemaVersion} (${result.migrationsApplied} applied)`);
    return result;
  } finally {
    await pool.close();
  }
}

async function runMssqlToken(connStr: string): Promise<void> {
  const pool = await new sql.ConnectionPool(connStr).connect();
  try {
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
    console.log('[run-migrations] MSSQL token store provisioned');
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const portalConn = process.env.MSSQL_PORTAL_CONNECTION_STRING ?? await decryptSetting('mssql_portal_connection_string');
  const tokenConn  = process.env.MSSQL_TOKEN_CONNECTION_STRING ?? await decryptSetting('mssql_token_connection_string');

  let schemaVersion = 0;
  let migrationsApplied = 0;

  if (portalConn) {
    const r = await runMssqlPortal(portalConn);
    schemaVersion = Math.max(schemaVersion, r.schemaVersion);
    migrationsApplied += r.migrationsApplied;
  } else {
    const r = await runSqlite();
    schemaVersion = Math.max(schemaVersion, r.schemaVersion);
    migrationsApplied += r.migrationsApplied;
  }

  if (tokenConn) await runMssqlToken(tokenConn);

  const out = { ok: true, schemaVersion, migrationsApplied };
  console.log(JSON.stringify(out));
}

main().catch(err => {
  console.error('[run-migrations] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
