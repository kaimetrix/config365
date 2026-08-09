import { NextResponse } from 'next/server';
import { getSetting, setSetting, setEncryptedSetting, isSetupComplete } from '@/lib/server/tenant-store';
import { derivePublicOrigin } from '@/lib/server/auth';
import { bootstrapPlatformIfNeeded, syncScriptsToGitea } from '@/lib/server/platform-bootstrap';

export const runtime = 'nodejs';


export async function GET() {
  const complete = isSetupComplete();
  const step     = complete ? 'done' : (getSetting('azure_client_id') ? 'database' : 'azure');

  return NextResponse.json({ step, complete });
}

export async function POST(request: Request) {
  let body: Record<string, string>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { step } = body;

  // ── Step 1: Azure AD ──────────────────────────────────────────────────────
  if (step === 'azure') {
    // Easy Auth mode — Azure App Service handles authentication via injected headers
    if (body.easyAuth === 'true') {
      setSetting('auth_mode', 'easyauth');
      return NextResponse.json({ ok: true, next: 'database' });
    }

    const { clientId, tenantId, clientSecret } = body;
    let { redirectUri } = body;
    if (!clientId || !tenantId) return NextResponse.json({ error: 'clientId and tenantId are required' }, { status: 400 });
    if (!redirectUri?.trim()) {
      const url = new URL(request.url);
      redirectUri = `${derivePublicOrigin(request, url)}/auth/callback`;
    }
    setSetting('azure_client_id',     clientId);
    setSetting('azure_tenant_id',     tenantId);
    setSetting('azure_redirect_uri',  redirectUri.trim());
    if (clientSecret) setEncryptedSetting('azure_client_secret', clientSecret);
    // Clear any previously saved easyauth mode if switching back to OIDC
    setSetting('auth_mode', 'oidc');
    return NextResponse.json({ ok: true, next: 'authenticate' });
  }

  // ── Step 2 (legacy): Gitea — kept for backward compatibility with wizards ──
  // The Gitea token is auto-bootstrapped by the entrypoint in AIO mode.
  if (step === 'gitea') {
    const { giteaToken, giteaBaseUrl } = body;
    if (giteaToken) setSetting('gitea_token', giteaToken);
    if (giteaBaseUrl) setSetting('gitea_base_url', giteaBaseUrl);
    return NextResponse.json({ ok: true, next: 'database' });
  }

  // ── Step 3a: Save database settings and continue ──────────────────────────
  if (step === 'database-save') {
    const { mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl } = body;
    const { normalizeMssqlConnectionString } = await import('@/lib/server/mssql-connstr');

    if (mssqlPortalConn?.trim()) {
      const normalized = normalizeMssqlConnectionString(mssqlPortalConn);
      if (!normalized.ok) return NextResponse.json({ error: normalized.detail }, { status: 400 });
      setEncryptedSetting('mssql_portal_connection_string', normalized.connectionString);
    }

    // Token storage — exclusive choice; clear the unused options so there is
    // no ambiguity about which backend is active.
    const tokenType = tokenStorageType?.trim() || 'sqlite3';
    setSetting('token_storage_type', tokenType);
    if (tokenType === 'mssql') {
      if (tokenMssqlConn?.trim()) {
        const normalized = normalizeMssqlConnectionString(tokenMssqlConn);
        if (!normalized.ok) return NextResponse.json({ error: normalized.detail }, { status: 400 });
        setEncryptedSetting('mssql_token_connection_string', normalized.connectionString);
      }
      setSetting('keyvault_url', '');
    } else if (tokenType === 'keyvault') {
      if (kvUrl?.trim()) setSetting('keyvault_url', kvUrl.trim());
      setSetting('mssql_token_connection_string', '');
    } else {
      // sqlite3 — clear both external options
      setSetting('mssql_token_connection_string', '');
      setSetting('keyvault_url', '');
    }

    const dbType = giteeDbType?.trim() || 'sqlite3';
    setSetting('gitea_db_type', dbType);
    if (dbType !== 'sqlite3') {
      if (giteaDbHost?.trim())     setSetting('gitea_db_host', giteaDbHost.trim());
      if (giteaDbName?.trim())     setSetting('gitea_db_name', giteaDbName.trim());
      if (giteaDbUser?.trim())     setSetting('gitea_db_user', giteaDbUser.trim());
      if (giteaDbPassword?.trim()) setEncryptedSetting('gitea_db_password', giteaDbPassword.trim());
    }

    // Don't advance step — the wizard calls save before test so the settings
    // are persisted. The next navigation is triggered by the wizard's own logic.
    return NextResponse.json({ ok: true, next: 'azure-services' });
  }

  // ── Step 3b: Skip database step ───────────────────────────────────────────
  if (step === 'database-skip') {
    return NextResponse.json({ ok: true, next: 'azure-services' });
  }

  // ── Step 4a: Save Azure services settings and continue ────────────────────
  if (step === 'azure-services-save') {
    const { blobContainer, blobUri, blobConnStr, backupSchedule, backupRetention, giteaExternalDir } = body;

    setSetting('blob_storage_container', blobContainer?.trim() ?? '');
    setSetting('blob_storage_uri', blobUri?.trim() ?? '');
    if (blobConnStr?.trim()) setEncryptedSetting('blob_storage_connection_string', blobConnStr.trim());
    else setSetting('blob_storage_connection_string', '');
    setSetting('gitea_backup_schedule', backupSchedule?.trim() ?? '');
    setSetting('gitea_backup_retention_days', backupRetention?.trim() ?? '');

    // Gitea external file storage — empty string clears/disables the setting
    setSetting('gitea_external_dir', giteaExternalDir?.trim() ?? '');

    return NextResponse.json({ ok: true, next: 'complete' });
  }

  // ── Step 4b: Skip Azure services step ────────────────────────────────────
  if (step === 'azure-services-skip') {
    return NextResponse.json({ ok: true, next: 'complete' });
  }

  // ── Step 5: Finalize ─────────────────────────────────────────────────────
  if (step === 'complete') {
    const setupUrl = new URL(request.url);
    const origin   = derivePublicOrigin(request, setupUrl);
    setSetting('gitea_external_url', `${origin}/gitea/`);
    setSetting('setup_complete', '1');
    // Fire-and-forget: start bootstrap now so the provisioning step in the
    // setup wizard can observe real-time progress immediately on first poll.
    bootstrapPlatformIfNeeded()
      .then(() => syncScriptsToGitea())
      .catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
}
