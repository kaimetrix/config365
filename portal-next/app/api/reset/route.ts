/**
 * POST /api/reset
 *
 * Unauthenticated factory-reset endpoint protected by a static password.
 * Two modes:
 *   portal — clears all platform_settings; container keeps running.
 *   full   — also wipes /data/gitea and /data/init-data, then kills PID 1 so
 *            the container exits and is restarted by Docker / Azure App Service.
 *
 * Optional: dropMssql: true — drops all portal and token MSSQL tables before
 * clearing settings (connection strings are read first while they are still set).
 */
import { NextResponse } from 'next/server';
import { unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getSettingsDb, DB_PATH } from '@/lib/server/settings-store';

export const runtime = 'nodejs';

const RESET_PASSWORD = 'submit';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// Portal tables in drop order (children before parents to satisfy FK constraints).
// Includes both prefixed and old unprefixed names so either generation is cleaned.
const PORTAL_TABLES = [
  'dbo.c365p_iam_assignments', 'dbo.iam_assignments',
  'dbo.c365p_tenants',         'dbo.tenants',
  'dbo.c365p_msps',            'dbo.msps',
  'dbo.c365p_schema_version',  'dbo.schema_version',
];

const TOKEN_TABLES = [
  'dbo.c365t_tenant_tokens',
  'dbo.tenant_tokens',
];

async function dropMssqlTables(
  connStr: string,
  tables: string[],
): Promise<string[]> {
  const mssql = await import('mssql');
  const pool  = await mssql.connect(connStr);
  const dropped: string[] = [];
  try {
    for (const tbl of tables) {
      try {
        await pool.request().query(
          `IF OBJECT_ID('${tbl}', 'U') IS NOT NULL DROP TABLE ${tbl}`
        );
        dropped.push(tbl);
      } catch { /* table may not exist — ignore */ }
    }
  } finally {
    try { await pool.close(); } catch { /* ignore */ }
  }
  return dropped;
}

export async function POST(request: Request) {
  let body: { password?: string; mode?: string; dropMssql?: boolean };
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.password || body.password !== RESET_PASSWORD) {
    return json({ error: 'Invalid reset password' }, 401);
  }

  const mode      = body.mode === 'full' ? 'full' : 'portal';
  const wantsDrop = !!body.dropMssql;
  const dropLog: string[] = [];

  try {
    // 1. Read MSSQL connection strings BEFORE wiping settings (so we can drop tables).
    let portalConnStr: string | null = null;
    let tokenConnStr:  string | null = null;
    if (wantsDrop) {
      try {
        const { getDecryptedSetting } = await import('@/lib/server/settings-store');
        portalConnStr = getDecryptedSetting('mssql_portal_connection_string') ?? null;
        tokenConnStr  = getDecryptedSetting('mssql_token_connection_string')  ?? null;
      } catch { /* DB not ready — skip */ }
    }

    // 2. Clear all platform_settings — removes setup_complete, Azure AD creds,
    //    DB connection strings, Gitea token, etc.
    const db = getSettingsDb();
    db.prepare('DELETE FROM platform_settings').run();

    // 3. Delete settings backup so settings aren't auto-restored on next DB open.
    try {
      const backupPath = join(dirname(DB_PATH), 'settings-backup.json');
      unlinkSync(backupPath);
    } catch { /* file may not exist */ }

    // 4. Drop MSSQL tables (after wiping SQLite so the app can't reconnect mid-drop).
    if (wantsDrop) {
      if (portalConnStr) {
        const dropped = await dropMssqlTables(portalConnStr, PORTAL_TABLES);
        dropLog.push(...dropped.map(t => `portal: dropped ${t}`));
      }
      if (tokenConnStr) {
        const dropped = await dropMssqlTables(tokenConnStr, TOKEN_TABLES);
        dropLog.push(...dropped.map(t => `token: dropped ${t}`));
      }
    }

    if (mode === 'full') {
      // 5. Wipe Gitea data (repos, users, SQLite gitea.db) and init-data
      //    (sentinel, portal-token.txt, runner-token.txt, session-secret.txt).
      try { rmSync('/data/gitea',     { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync('/data/init-data', { recursive: true, force: true }); } catch { /* ignore */ }

      // 6. Kill PID 1 (supervisord) — Docker / Azure App Service restarts the container.
      const { spawn } = await import('child_process');
      spawn('sh', ['-c', 'sleep 1 && kill 1'], { detached: true, stdio: 'ignore' }).unref();
    }

    return json({ ok: true, mode, dropLog });
  } catch (err: unknown) {
    return json({ error: (err as Error).message ?? 'Reset failed' }, 500);
  }
}
