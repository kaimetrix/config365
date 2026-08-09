/**
 * token-backend-sqlite.ts — SQLite implementation of TokenBackend.
 * Uses better-sqlite3 at TOKEN_DB_PATH (default /data/db/tokens.db).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenBackend, TenantTokens, ConnectionStatus } from './token-backend';

const TOKEN_DB_PATH = process.env.TOKEN_DB_PATH ?? './data/tokens.db';

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(TOKEN_DB_PATH), { recursive: true });
  _db = new Database(TOKEN_DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_tokens (
      tenantSlug         TEXT PRIMARY KEY,
      accessTokenEnc     TEXT NOT NULL DEFAULT '',
      refreshTokenEnc    TEXT NOT NULL DEFAULT '',
      expiresAt          TEXT NOT NULL DEFAULT '',
      scope              TEXT NOT NULL DEFAULT '',
      deviceCode         TEXT,
      mdeRefreshTokenEnc TEXT NOT NULL DEFAULT '',
      mdeDeviceCode      TEXT NOT NULL DEFAULT '',
      updatedAt          TEXT NOT NULL
    );
  `);
  return _db;
}

export const sqliteTokenBackend: TokenBackend = {
  async saveTenantTokens(slug: string, tokens: TenantTokens): Promise<void> {
    const { encryptToken } = await import('./token-crypto');
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET
        accessTokenEnc  = excluded.accessTokenEnc,
        refreshTokenEnc = excluded.refreshTokenEnc,
        expiresAt       = excluded.expiresAt,
        scope           = excluded.scope,
        updatedAt       = excluded.updatedAt
    `).run(
      slug,
      encryptToken(tokens.accessToken),
      encryptToken(tokens.refreshToken),
      tokens.expiresAt,
      tokens.scope,
      now,
    );
  },

  async getTenantTokens(slug: string): Promise<TenantTokens | null> {
    const { decryptToken } = await import('./token-crypto');
    const row = getDb().prepare<[string], {
      accessTokenEnc: string; refreshTokenEnc: string; expiresAt: string; scope: string;
    }>('SELECT accessTokenEnc, refreshTokenEnc, expiresAt, scope FROM tenant_tokens WHERE tenantSlug = ?')
      .get(slug);
    if (!row) return null;
    return {
      accessToken:  decryptToken(row.accessTokenEnc),
      refreshToken: decryptToken(row.refreshTokenEnc),
      expiresAt:    row.expiresAt,
      scope:        row.scope,
    };
  },

  async deleteTenantTokens(slug: string): Promise<boolean> {
    const result = getDb().prepare<[string]>(
      'DELETE FROM tenant_tokens WHERE tenantSlug = ?'
    ).run(slug);
    return result.changes > 0;
  },

  async savePendingDeviceCode(slug: string, deviceCode: string): Promise<void> {
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, deviceCode, updatedAt)
      VALUES (?, '', '', '', '', ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET deviceCode=excluded.deviceCode, updatedAt=excluded.updatedAt
    `).run(slug, deviceCode, now);
  },

  async getPendingDeviceCode(slug: string): Promise<string | null> {
    const row = getDb().prepare<[string], { deviceCode: string | null }>(
      'SELECT deviceCode FROM tenant_tokens WHERE tenantSlug = ?'
    ).get(slug);
    return row?.deviceCode ?? null;
  },

  async getTenantConnectionStatus(slug: string): Promise<ConnectionStatus> {
    const row = getDb().prepare<[string], {
      expiresAt: string; updatedAt: string; accessTokenEnc: string;
    }>('SELECT expiresAt, updatedAt, accessTokenEnc FROM tenant_tokens WHERE tenantSlug = ?')
      .get(slug);
    if (!row || !row.accessTokenEnc) {
      return { connected: false, expiresAt: null, updatedAt: null };
    }
    const expiry    = new Date(row.expiresAt);
    const connected = !isNaN(expiry.getTime()) && expiry > new Date();
    return { connected, expiresAt: row.expiresAt, updatedAt: row.updatedAt };
  },

  async saveMdeRefreshToken(slug: string, refreshTokenEnc: string): Promise<void> {
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, mdeRefreshTokenEnc, updatedAt)
      VALUES (?, '', '', '', '', ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET mdeRefreshTokenEnc=excluded.mdeRefreshTokenEnc, updatedAt=excluded.updatedAt
    `).run(slug, refreshTokenEnc, now);
  },

  async getMdeRefreshToken(slug: string): Promise<string | null> {
    const row = getDb().prepare<[string], { mdeRefreshTokenEnc: string }>(
      'SELECT mdeRefreshTokenEnc FROM tenant_tokens WHERE tenantSlug = ?'
    ).get(slug);
    return row?.mdeRefreshTokenEnc || null;
  },
};
