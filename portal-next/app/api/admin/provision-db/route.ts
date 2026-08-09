/**
 * POST /api/admin/provision-db
 *
 * Explicitly provisions or upgrades MSSQL schemas.
 * Body: { target: 'portal' | 'token' }
 *
 * Portal DB: runs the full migration runner (db-mssql-schema.ts)
 * Token DB:  provisions the tenant_tokens table
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { getDecryptedSetting } from '@/lib/server/settings-store';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  let body: { target?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { target } = body;
  if (!target || !['portal', 'token'].includes(target)) {
    return json({ error: 'target must be "portal" or "token"' }, 400);
  }

  const start = Date.now();

  try {
    if (target === 'portal') {
      const connStr = getDecryptedSetting('mssql_portal_connection_string');
      if (!connStr) return json({ ok: false, error: 'mssql_portal_connection_string not configured' }, 400);

      const sql = (await import('mssql')).default;
      const { provisionSchema } = await import('@/lib/server/db-mssql-schema');
      const { resetDbAdapter }  = await import('@/lib/server/db-factory');

      // Use an explicit ConnectionPool (not sql.connect) to avoid touching the
      // global mssql singleton — otherwise closing this pool after provisioning
      // corrupts any concurrent connection that shares the same global pool.
      const pool = await new sql.ConnectionPool(connStr).connect();
      const result = await provisionSchema(pool);
      await pool.close();

      // Force the factory to re-resolve with the newly provisioned schema
      resetDbAdapter();

      return json({
        ok:                 true,
        migrationsApplied:  result.migrationsApplied,
        schemaVersion:      result.schemaVersion,
        latencyMs:          Date.now() - start,
      });
    }

    if (target === 'token') {
      const connStr = getDecryptedSetting('mssql_token_connection_string');
      if (!connStr) return json({ ok: false, error: 'mssql_token_connection_string not configured' }, 400);

      const sql = (await import('mssql')).default;
      // Explicit pool — see comment in portal branch above
      const pool = await new sql.ConnectionPool(connStr).connect();

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

      const tableCheck = await pool.request().query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='c365t_tenant_tokens'"
      );
      await pool.close();

      // Reset token backend to use the newly provisioned MSSQL table
      const { resetTokenBackend } = await import('@/lib/token-backend');
      resetTokenBackend();

      return json({
        ok:         true,
        detail:     'c365t_tenant_tokens table provisioned.',
        tableReady: (tableCheck.recordset[0]?.n ?? 0) > 0,
        latencyMs:  Date.now() - start,
      });
    }

    return json({ error: 'Unhandled target' }, 500);
  } catch (err: unknown) {
    return json({ ok: false, error: (err as Error).message, latencyMs: Date.now() - start }, 500);
  }
}
