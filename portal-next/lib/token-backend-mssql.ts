/**
 * token-backend-mssql.ts — MSSQL implementation of TokenBackend.
 * Provisions a `c365t_tenant_tokens` table on first connect.
 */

import sql, { type ConnectionPool } from 'mssql';
import type { TokenBackend, TenantTokens, ConnectionStatus } from './token-backend';

// ─── Schema ───────────────────────────────────────────────────────────────────

async function provisionTokenSchema(pool: ConnectionPool): Promise<void> {
  // Rename old unprefixed table for existing installs
  await pool.request().query(`
    IF OBJECT_ID('dbo.tenant_tokens', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
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
}

// ─── Pool management ──────────────────────────────────────────────────────────

let _pool: ConnectionPool | null = null;
let _connStr = '';

async function getPool(connectionString: string): Promise<ConnectionPool> {
  if (_pool?.connected && _connStr === connectionString) return _pool;
  if (_pool) { try { await _pool.close(); } catch { /* ignore */ } }
  const pool = await sql.connect(connectionString);
  await provisionTokenSchema(pool);
  _pool   = pool;
  _connStr = connectionString;
  return pool;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createMssqlTokenBackend(connectionString: string): Promise<TokenBackend> {
  // Eagerly connect to provision schema
  const pool = () => getPool(connectionString);

  return {
    async saveTenantTokens(slug: string, tokens: TenantTokens): Promise<void> {
      const { encryptToken } = await import('./token-crypto');
      const p = await pool();
      const now = new Date().toISOString();
      await p.request()
        .input('slug',  sql.NVarChar, slug)
        .input('at',    sql.NVarChar, encryptToken(tokens.accessToken))
        .input('rt',    sql.NVarChar, encryptToken(tokens.refreshToken))
        .input('exp',   sql.NVarChar, tokens.expiresAt)
        .input('scope', sql.NVarChar, tokens.scope)
        .input('now',   sql.NVarChar, now)
        .query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET
            accessTokenEnc=@at, refreshTokenEnc=@rt, expiresAt=@exp, scope=@scope, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,updatedAt)
            VALUES (@slug,@at,@rt,@exp,@scope,@now);
        `);
    },

    async getTenantTokens(slug: string): Promise<TenantTokens | null> {
      const { decryptToken } = await import('./token-crypto');
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, slug)
        .query<{ accessTokenEnc: string; refreshTokenEnc: string; expiresAt: string; scope: string }>(
          'SELECT accessTokenEnc,refreshTokenEnc,expiresAt,scope FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug'
        );
      const row = r.recordset[0];
      if (!row) return null;
      return {
        accessToken:  decryptToken(row.accessTokenEnc),
        refreshToken: decryptToken(row.refreshTokenEnc),
        expiresAt:    row.expiresAt,
        scope:        row.scope,
      };
    },

    async deleteTenantTokens(slug: string): Promise<boolean> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, slug)
        .query('DELETE FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug');
      return (r.rowsAffected[0] ?? 0) > 0;
    },

    async savePendingDeviceCode(slug: string, deviceCode: string): Promise<void> {
      const p = await pool();
      await p.request()
        .input('slug', sql.NVarChar, slug)
        .input('dc',   sql.NVarChar, deviceCode)
        .input('now',  sql.NVarChar, new Date().toISOString())
        .query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET deviceCode=@dc, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,deviceCode,updatedAt)
            VALUES (@slug,'','','','',@dc,@now);
        `);
    },

    async getPendingDeviceCode(slug: string): Promise<string | null> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, slug)
        .query<{ deviceCode: string | null }>('SELECT deviceCode FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug');
      return r.recordset[0]?.deviceCode ?? null;
    },

    async getTenantConnectionStatus(slug: string): Promise<ConnectionStatus> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, slug)
        .query<{ expiresAt: string; updatedAt: string; accessTokenEnc: string }>(
          'SELECT expiresAt,updatedAt,accessTokenEnc FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug'
        );
      const row = r.recordset[0];
      if (!row || !row.accessTokenEnc) return { connected: false, expiresAt: null, updatedAt: null };
      const expiry    = new Date(row.expiresAt);
      const connected = !isNaN(expiry.getTime()) && expiry > new Date();
      return { connected, expiresAt: row.expiresAt, updatedAt: row.updatedAt };
    },

    async saveMdeRefreshToken(slug: string, refreshTokenEnc: string): Promise<void> {
      const p = await pool();
      await p.request()
        .input('slug', sql.NVarChar, slug)
        .input('mrt',  sql.NVarChar, refreshTokenEnc)
        .input('now',  sql.NVarChar, new Date().toISOString())
        .query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET mdeRefreshTokenEnc=@mrt, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,mdeRefreshTokenEnc,updatedAt)
            VALUES (@slug,'','','','',@mrt,@now);
        `);
    },

    async getMdeRefreshToken(slug: string): Promise<string | null> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, slug)
        .query<{ mdeRefreshTokenEnc: string }>(
          'SELECT mdeRefreshTokenEnc FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug'
        );
      return r.recordset[0]?.mdeRefreshTokenEnc || null;
    },
  };
}
