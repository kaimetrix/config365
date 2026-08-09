/**
 * GET /api/admin/test-connection?resource=<type>
 *
 * Tests connectivity to an external service. Returns:
 *   { ok, detail, latencyMs, schemaVersion? }
 *
 * resource values:
 *   mssql-portal       — portal operational DB
 *   mssql-token        — token storage DB
 *   mssql-gitea        — Gitea DB (connection string from platform_settings)
 *   keyvault           — Azure Key Vault
 *   blob               — Azure Blob Storage
 *   gitea-files-mount  — Azure Files SMB mount (checks path accessibility in container)
 *   easyauth           — Azure App Service Easy Auth (checks X-MS-CLIENT-PRINCIPAL header)
 */
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, statSync } from 'fs';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import {
  errMessage,
  formatMssqlError,
  normalizeMssqlConnectionString,
} from '@/lib/server/mssql-connstr';
import { getDecryptedSetting, getSetting } from '@/lib/server/settings-store';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

/** Always include `detail` so the admin UI never renders "✗ undefined". */
function testFail(detail: string, latencyMs = 0, status = 200) {
  return json({ ok: false, detail, error: detail, latencyMs }, status);
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return testFail('Unauthenticated — sign in again and retry the connection test.', 0, 401);
  if (!isPlatformAdmin(session.user)) return testFail('Forbidden — platform admin role required.', 0, 403);

  const resource = request.nextUrl.searchParams.get('resource');
  if (!resource) return testFail('resource query param required', 0, 400);

  const start = Date.now();

  try {
    switch (resource) {
      case 'mssql-portal': {
        const connStr = getDecryptedSetting('mssql_portal_connection_string');
        if (!connStr) return testFail('mssql_portal_connection_string not configured — save an ADO.NET connection string first.', 0);
        const result = await testMssql(connStr, 'portal');
        return json({ ...result, latencyMs: Date.now() - start });
      }

      case 'mssql-token': {
        const connStr = getDecryptedSetting('mssql_token_connection_string');
        if (!connStr) return testFail('mssql_token_connection_string not configured — save an ADO.NET connection string first.', 0);
        const result = await testMssql(connStr, 'token');
        return json({ ...result, latencyMs: Date.now() - start });
      }

      case 'mssql-gitea': {
        const dbType = getSetting('gitea_db_type');
        if (!dbType || dbType === 'sqlite3') {
          return json({ ok: true, detail: 'Gitea is using SQLite (no external DB configured)', latencyMs: 0 });
        }
        const host   = getSetting('gitea_db_host')   ?? '';
        const dbName = getSetting('gitea_db_name')   ?? '';
        const user   = getSetting('gitea_db_user')   ?? '';
        const passwd = getDecryptedSetting('gitea_db_password') ?? '';
        if (!host || !user) return json({ ok: false, detail: 'Gitea DB host/user not configured', latencyMs: 0 });
        const connStr = buildMssqlConnStr(host, dbName, user, passwd);
        const result  = await testMssql(connStr, 'gitea');
        return json({ ...result, latencyMs: Date.now() - start });
      }

      case 'keyvault': {
        const vaultUrl = getSetting('keyvault_url');
        if (!vaultUrl) return json({ ok: false, detail: 'keyvault_url not configured', latencyMs: 0 });
        const result = await testKeyVault(vaultUrl);
        return json({ ...result, latencyMs: Date.now() - start });
      }

      case 'blob': {
        const blobUri    = getSetting('blob_storage_uri');
        const blobConn   = getDecryptedSetting('blob_storage_connection_string');
        const blobContainer = getSetting('blob_storage_container');
        if (!blobContainer) return json({ ok: false, detail: 'blob_storage_container not configured', latencyMs: 0 });
        if (!blobUri && !blobConn) return json({ ok: false, detail: 'blob_storage_uri or blob_storage_connection_string not configured', latencyMs: 0 });
        const result = await testBlob(blobContainer, blobUri ?? null, blobConn ?? null);
        if (result.ok) {
          const { ensureBackupSchedulerRunning } = await import('@/lib/server/backup-scheduler');
          const sched = await ensureBackupSchedulerRunning();
          return json({
            ...result,
            detail: `${result.detail} ${sched.detail}.`,
            latencyMs: Date.now() - start,
            schedulerStarted: sched.started,
          });
        }
        return json({ ...result, latencyMs: Date.now() - start });
      }

      case 'gitea-files-mount': {
        const mountPath = getSetting('gitea_external_dir') || request.nextUrl.searchParams.get('path');
        if (!mountPath) return json({ ok: false, detail: 'gitea_external_dir not configured', latencyMs: 0 });
        try {
          if (!existsSync(mountPath)) {
            return json({ ok: false, detail: `Path "${mountPath}" does not exist in the container. Verify the Azure Files volume is mounted.`, latencyMs: Date.now() - start });
          }
          const stat = statSync(mountPath);
          if (!stat.isDirectory()) {
            return json({ ok: false, detail: `"${mountPath}" exists but is not a directory.`, latencyMs: Date.now() - start });
          }
          return json({ ok: true, detail: `"${mountPath}" is accessible and is a directory.`, latencyMs: Date.now() - start });
        } catch (err: unknown) {
          return testFail(errMessage(err), Date.now() - start);
        }
      }

      case 'easyauth': {
        const principal = request.headers.get('x-ms-client-principal');
        if (!principal) {
          return json({
            ok: false,
            detail: 'X-MS-CLIENT-PRINCIPAL header not found. Ensure Azure App Service Authentication is enabled and requests are reaching the portal through the App Service URL.',
            latencyMs: Date.now() - start,
          });
        }
        try {
          const decoded = JSON.parse(Buffer.from(principal, 'base64').toString('utf-8')) as {
            claims?: Array<{ typ: string; val: string }>;
          };
          const claims = decoded.claims ?? [];
          const oid  = claims.find(c => c.typ === 'oid' || c.typ === 'http://schemas.microsoft.com/identity/claims/objectidentifier')?.val;
          const name = claims.find(c => c.typ === 'name')?.val ?? 'Unknown';
          const email = claims.find(c => c.typ === 'preferred_username' || c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress')?.val ?? '';
          if (!oid) {
            return json({ ok: false, detail: 'Easy Auth header found but the OID claim is missing. The Azure AD token may be incomplete.', latencyMs: Date.now() - start });
          }
          const identity = email ? `${name} (${email})` : name;
          return json({ ok: true, detail: `Easy Auth verified — signed in as: ${identity}`, latencyMs: Date.now() - start });
        } catch {
          return json({ ok: false, detail: 'X-MS-CLIENT-PRINCIPAL header found but could not be parsed. It may be malformed.', latencyMs: Date.now() - start });
        }
      }

      default:
        return testFail(`Unknown resource type: ${resource}`, 0, 400);
    }
  } catch (err: unknown) {
    console.error(`[test-connection] unexpected error for resource=${resource}`, err);
    return testFail(errMessage(err, 'Unexpected connection test failure'), Date.now() - start);
  }
}

// ─── MSSQL test ───────────────────────────────────────────────────────────────

async function testMssql(
  connectionString: string,
  target: 'portal' | 'token' | 'gitea',
): Promise<{ ok: boolean; detail: string; schemaVersion?: number }> {
  const normalized = normalizeMssqlConnectionString(connectionString);
  if (!normalized.ok) {
    console.error(`[test-connection] mssql-${target} invalid connection string`, { detail: normalized.detail });
    return { ok: false, detail: normalized.detail };
  }

  const { connectionString: connStr, summary, normalized: wasNormalized } = normalized;
  console.log(`[test-connection] mssql-${target} connecting`, { ...summary, normalized: wasNormalized });

  const sql = (await import('mssql')).default;

  // Use an explicit ConnectionPool (not sql.connect) so this smoke test does not
  // touch / close the global mssql singleton used by the portal DB adapter.
  let pool: import('mssql').ConnectionPool | undefined;
  try {
    pool = await new sql.ConnectionPool(connStr).connect();
    await pool.request().query('SELECT 1 AS ping');

    let schemaVersion: number | undefined;
    if (target === 'portal') {
      try {
        const r = await pool.request().query<{ version: number }>(
          'SELECT ISNULL(MAX(version),0) AS version FROM dbo.schema_version'
        );
        schemaVersion = r.recordset[0]?.version ?? 0;
      } catch { schemaVersion = 0; }
    } else if (target === 'token') {
      const tableExists = await pool.request().query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='tenant_tokens'"
      );
      schemaVersion = (tableExists.recordset[0]?.n ?? 0) > 0 ? 1 : 0;
    }

    console.log(`[test-connection] mssql-${target} ok`, { ...summary, schemaVersion });
    const rewriteNote = wasNormalized ? ' (connection string was normalized)' : '';
    return {
      ok: true,
      detail: `Connected to ${target} database (${summary.server}/${summary.database} as ${summary.user}).${rewriteNote}`,
      schemaVersion,
    };
  } catch (err: unknown) {
    // Log a plain summary — never JSON.stringify the Error (loses .message).
    const detail = formatMssqlError(err, summary);
    console.error(`[test-connection] mssql-${target} failed`, {
      ...summary,
      detail,
      errName: err instanceof Error ? err.name : typeof err,
      errMessage: errMessage(err),
      errCode: (err as { code?: string })?.code,
    });
    return { ok: false, detail };
  } finally {
    try { await pool?.close(); } catch { /* ignore */ }
  }
}

// ─── Key Vault test ───────────────────────────────────────────────────────────

async function testKeyVault(vaultUrl: string): Promise<{ ok: boolean; detail: string }> {
  const { SecretClient }           = await import('@azure/keyvault-secrets');
  const { DefaultAzureCredential } = await import('@azure/identity');
  try {
    const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
    // Use getSecret on a sentinel name rather than listPropertiesOfSecrets.
    // List requires the "List" Key Vault policy; Get is sufficient for the
    // token store and is the minimum permission we actually need.
    // A 404 (secret not found) means the vault is reachable and Get access works.
    await client.getSecret('config365-connectivity-test');
    return { ok: true, detail: 'Key Vault connection and Get permission verified.' };
  } catch (err: unknown) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      // Secret doesn't exist — vault is reachable and Get permission works
      return { ok: true, detail: 'Key Vault reachable and Get permission verified.' };
    }
    const msg = errMessage(err);
    if (code === 403 || msg.includes('403') || msg.includes('Forbidden')) {
      return { ok: false, detail: 'Key Vault reachable but access denied (403). Ensure the managed identity has the "Get" secret permission on this vault.' };
    }
    return { ok: false, detail: msg };
  }
}

// ─── Blob Storage test ────────────────────────────────────────────────────────

async function testBlob(
  container: string,
  storageUri: string | null,
  connectionString: string | null,
): Promise<{ ok: boolean; detail: string }> {
  if (/DefaultEndpointsProtocol=|AccountKey=/i.test(container)) {
    return {
      ok: false,
      detail: 'blob_storage_container currently holds a connection string. Re-save Blob Storage with Container Name + Connection String in the correct fields.',
    };
  }
  if (connectionString && !/DefaultEndpointsProtocol=|AccountName=/i.test(connectionString)) {
    return {
      ok: false,
      detail: 'blob_storage_connection_string is not a valid Azure Storage connection string. Re-enter it under Connection String (key auth).',
    };
  }
  if (!connectionString && storageUri && !/^https?:\/\//i.test(storageUri)) {
    return {
      ok: false,
      detail: `Storage Account URI must be a full URL (got "${storageUri}"). Example: https://mystorageaccount.blob.core.windows.net/`,
    };
  }

  const { BlobServiceClient } = await import('@azure/storage-blob');
  const { DefaultAzureCredential } = await import('@azure/identity');
  try {
    let blobServiceClient: import('@azure/storage-blob').BlobServiceClient;
    if (connectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      blobServiceClient = new BlobServiceClient(storageUri!, new DefaultAzureCredential());
    }
    const containerClient = blobServiceClient.getContainerClient(container);
    const exists = await containerClient.exists();
    if (!exists) return { ok: false, detail: `Container "${container}" does not exist.` };
    return { ok: true, detail: `Blob Storage connection verified. Container "${container}" exists.` };
  } catch (err: unknown) {
    const msg = errMessage(err);
    if (/Invalid URL/i.test(msg)) {
      return {
        ok: false,
        detail: 'Invalid URL — check Blob Storage fields: container name, Storage Account URI (https://….blob.core.windows.net/), or connection string.',
      };
    }
    return { ok: false, detail: msg };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMssqlConnStr(host: string, database: string, user: string, password: string): string {
  const [server, portStr] = host.split(',');
  const port = portStr ? parseInt(portStr.trim(), 10) : 1433;
  return [
    `Server=${server.trim()},${port}`,
    `Database=${database || 'gitea'}`,
    `User Id=${user}`,
    `Password=${password}`,
    'Encrypt=true',
    'TrustServerCertificate=false',
  ].join(';');
}
