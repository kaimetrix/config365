import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { setOrgSecret, resetGiteaAdminPassword, applyGiteaToken, testGiteaToken, generateGiteaPortalToken } from '@/lib/server/gitea';
import { getSetting, setSetting, setEncryptedSetting, getDecryptedSetting, bootstrapGiteaToken, getMspByGiteaOrg } from '@/lib/server/tenant-store';
import { requireMspAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const isAdmin   = isPlatformAdmin(session.user);

  let body: {
    action: string;
    org?: string;
    name?: string;
    value?: string;
    password?: string;
    key?: string;
    token?: string;
    container?: string;
    uri?: string;
    connectionString?: string;
    clearConnectionString?: boolean;
  };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { action } = body;

  if (action === 'set-org-secret') {
    const { org, name, value } = body;
    if (!org || !name || value === undefined) return json({ error: 'org, name, and value are required' }, 400);

    if (!isAdmin) {
      // Resolve the Gitea org to an MSP, then verify the caller owns that MSP
      const targetMsp = await getMspByGiteaOrg(org);
      if (!targetMsp) return json({ error: 'MSP not found for org' }, 404);
      const guard = await requireMspAccess(session.user, targetMsp.slug);
      if (guard instanceof NextResponse) return guard;
    }

    try {
      await setOrgSecret(org, name, value);
      return json({ ok: true });
    } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
  }

  if (action === 'reset-gitea-password') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { password } = body;
    if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400);
    try {
      await resetGiteaAdminPassword(password);
      return json({ ok: true });
    } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
  }

  if (action === 'set-auth-mode') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { mode } = body as { mode?: string };
    if (mode !== 'easyauth' && mode !== 'oidc') return json({ error: 'mode must be easyauth or oidc' }, 400);
    setSetting('auth_mode', mode);
    return json({ ok: true });
  }

  if (action === 'set-azure-settings') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { clientSecret, clientId, tenantId, redirectUri } = body as {
      clientSecret?: string; clientId?: string; tenantId?: string; redirectUri?: string;
    };
    if (clientSecret?.trim()) setEncryptedSetting('azure_client_secret', clientSecret.trim());
    if (clientId?.trim())     setSetting('azure_client_id',     clientId.trim());
    if (tenantId?.trim())     setSetting('azure_tenant_id',     tenantId.trim());
    if (redirectUri?.trim())  setSetting('azure_redirect_uri',  redirectUri.trim());
    return json({ ok: true });
  }

  if (action === 'set-platform-setting') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { key, value } = body;
    if (!key || value === undefined) return json({ error: 'key and value are required' }, 400);
    // Blob Storage needs three distinct fields — reject single-field edits that mix them up.
    if (key === 'blob_storage_container' || key === 'blob_storage_uri' || key === 'blob_storage_connection_string') {
      return json({
        error: 'Use action "set-blob-storage" with container, uri, and/or connectionString — do not save a connection string as the container name.',
      }, 400);
    }
    // Sensitive keys are stored encrypted
    const { setEncryptedSetting } = await import('@/lib/server/settings-store');
    const sensitiveKeys = new Set([
      'mssql_portal_connection_string', 'mssql_token_connection_string',
      'keyvault_client_secret', 'blob_storage_connection_string', 'gitea_db_password',
    ]);
    let valueToStore = String(value);
    if (key === 'mssql_portal_connection_string' || key === 'mssql_token_connection_string') {
      const { normalizeMssqlConnectionString } = await import('@/lib/server/mssql-connstr');
      const normalized = normalizeMssqlConnectionString(valueToStore);
      if (!normalized.ok) return json({ error: normalized.detail }, 400);
      valueToStore = normalized.connectionString;
    }
    if (sensitiveKeys.has(key)) {
      setEncryptedSetting(key, valueToStore);
    } else {
      setSetting(key, valueToStore);
    }
    // Token storage is exclusive: Key Vault XOR MSSQL Token DB (never both).
    if (key === 'keyvault_url' && String(value).trim()) {
      setSetting('mssql_token_connection_string', '');
      setSetting('token_storage_type', 'keyvault');
    } else if (key === 'mssql_token_connection_string' && String(value).trim()) {
      setSetting('keyvault_url', '');
      setSetting('token_storage_type', 'mssql');
    }
    return json({ ok: true });
  }

  if (action === 'set-blob-storage') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { setEncryptedSetting } = await import('@/lib/server/settings-store');
    const container = typeof body.container === 'string' ? body.container.trim() : undefined;
    const uri = typeof body.uri === 'string' ? body.uri.trim() : undefined;
    const connectionString = typeof body.connectionString === 'string' ? body.connectionString.trim() : undefined;
    const clearConnectionString = body.clearConnectionString === true;

    if (container !== undefined) {
      if (/DefaultEndpointsProtocol=|AccountKey=|AccountName=/i.test(container)) {
        return json({
          error: 'That looks like a connection string. Put it in the Connection String field, and use Container Name for the blob container (e.g. config365-admin).',
        }, 400);
      }
      setSetting('blob_storage_container', container);
    }
    if (uri !== undefined) {
      if (uri && !/^https?:\/\//i.test(uri)) {
        return json({
          error: 'Storage Account URI must be a full URL such as https://mystorageaccount.blob.core.windows.net/',
        }, 400);
      }
      setSetting('blob_storage_uri', uri);
    }
    if (clearConnectionString) {
      setSetting('blob_storage_connection_string', '');
    } else if (connectionString !== undefined) {
      if (connectionString) setEncryptedSetting('blob_storage_connection_string', connectionString);
      else setSetting('blob_storage_connection_string', '');
    }
    return json({ ok: true });
  }

  if (action === 'generate-gitea-token') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    try {
      const newToken = await generateGiteaPortalToken();
      const login = await testGiteaToken(newToken);
      return json({ ok: true, login });
    } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
  }

  if (action === 'set-gitea-token') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const { token } = body;
    if (!token?.trim()) return json({ error: 'token is required' }, 400);
    try {
      await applyGiteaToken(token.trim());
      return json({ ok: true });
    } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
  }

  if (action === 'sync-gitea-token-from-file') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    // Force-read the file even if a stale DB token exists
    const result = bootstrapGiteaToken(true);
    if (result !== 'ok') return json({ error: 'Token file not found or empty at /init-data/portal-token.txt' }, 500);
    const token = getSetting('gitea_token') ?? '';
    const login = await testGiteaToken(token);
    if (!login) {
      setSetting('gitea_token', '');
      return json({ error: 'Token from file is invalid — Gitea rejected it. Reset the Gitea admin password, then Generate new token.' }, 400);
    }
    return json({ ok: true, login });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const storedToken = getSetting('gitea_token') ?? '';
  const tokenLogin = storedToken ? await testGiteaToken(storedToken) : null;

  const { getDecryptedSetting } = await import('@/lib/server/settings-store');

  return json({
    azure_client_id:           getSetting('azure_client_id') ?? null,
    azure_tenant_id:           getSetting('azure_tenant_id') ?? null,
    azure_redirect_uri:        getSetting('azure_redirect_uri') ?? null,
    azure_client_secret_set:   !!(getDecryptedSetting('azure_client_secret')),
    auth_mode:                 getSetting('auth_mode') ?? 'oidc',
    gitea_token:               storedToken ? '****' : null,
    gitea_token_valid:         tokenLogin !== null,
    gitea_token_account:       tokenLogin ?? null,
    gitea_external_url:        getSetting('gitea_external_url') ?? null,
    setup_complete:            getSetting('setup_complete'),
    // External service configuration indicators (boolean — no secrets exposed)
    mssql_portal_configured:   !!(getDecryptedSetting('mssql_portal_connection_string')),
    mssql_token_configured:    !!(getDecryptedSetting('mssql_token_connection_string')),
    keyvault_configured:       !!(getSetting('keyvault_url')),
    blob_configured:           !!(getSetting('blob_storage_container') && (getSetting('blob_storage_uri') || getDecryptedSetting('blob_storage_connection_string'))),
    token_storage_type:        getSetting('token_storage_type') ?? 'sqlite3',
  });
}
