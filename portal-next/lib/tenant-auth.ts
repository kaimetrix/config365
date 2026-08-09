/**
 * tenant-auth.ts — Token API only. Never imported by the Next.js app.
 *
 * Implements Graph 2 delegated auth logic:
 *   - Device code flow (initial tenant connection)
 *   - Get-or-refresh (called per pipeline script invocation)
 *
 * Token values are NEVER logged. On Azure AD errors, only the HTTP status
 * and the `error` field from the response body are surfaced.
 */

import {
  getTenantCreds,
  getTenantTokens,
  getTenantDomain,
  saveTenantTokens,
  savePendingDeviceCode,
  getPendingDeviceCode,
  type TenantCredsHint,
} from './token-store.js';

// ─── Azure AD endpoints ───────────────────────────────────────────────────────

function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

function deviceCodeEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
}

// ─── Fetch with hard timeout ──────────────────────────────────────────────────
// Node.js fetch has no default timeout. Without this, a slow/hung Azure AD
// response keeps the portal's HTTP connection to the runner open indefinitely,
// causing the runner step to hang on Linux where -TimeoutSec is unreliable.

const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`[tenant-auth] Request to ${new URL(url).hostname} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Per-audience scope lists ─────────────────────────────────────────────────
// Each token request (device code, refresh grant) MUST target exactly ONE
// resource (audience). Azure AD rejects requests that mix resources.
//
// The device code flow requests Graph scopes only. The resulting refresh token
// is an Azure AD MRRT (multi-resource refresh token). With admin consent granted
// for Exchange and MDE in the managed tenant, the MRRT can be exchanged for
// per-audience access tokens without a second sign-in:
//   getExchangeTenantToken() → refresh_token grant, scope: outlook.office365.com/.default
//   getMdeTenantToken()      → refresh_token grant, scope: api.securitycenter.microsoft.com/.default
//
// Note: Azure AD v2 device code flow does NOT support multi-resource scope
// requests. Exchange / MDE scopes must be pre-consented via admin consent in
// the managed tenant (Entra portal → Enterprise Apps → Config365 → Grant admin
// consent), NOT added here.

const GRAPH_SCOPES = [
  'https://graph.microsoft.com/DeviceManagementApps.ReadWrite.All',
  'https://graph.microsoft.com/DeviceManagementConfiguration.ReadWrite.All',
  'https://graph.microsoft.com/DeviceManagementManagedDevices.ReadWrite.All',
  'https://graph.microsoft.com/DeviceManagementManagedDevices.PrivilegedOperations.All',
  'https://graph.microsoft.com/DeviceManagementScripts.ReadWrite.All',
  'https://graph.microsoft.com/DeviceManagementServiceConfig.ReadWrite.All',
  'https://graph.microsoft.com/CustomSecAttributeDefinition.ReadWrite.All',
  'https://graph.microsoft.com/Directory.ReadWrite.All',
  'https://graph.microsoft.com/Directory.AccessAsUser.All',
  'https://graph.microsoft.com/Group.ReadWrite.All',
  'https://graph.microsoft.com/Policy.Read.All',
  'https://graph.microsoft.com/Policy.ReadWrite.AuthenticationMethod',
  'https://graph.microsoft.com/Policy.ReadWrite.Authorization',
  'https://graph.microsoft.com/Policy.ReadWrite.ConditionalAccess',
  'https://graph.microsoft.com/Policy.ReadWrite.DeviceConfiguration',
  'https://graph.microsoft.com/Policy.ReadWrite.MobilityManagement',
  'https://graph.microsoft.com/Policy.ReadWrite.PermissionGrant',
  'https://graph.microsoft.com/RoleManagement.ReadWrite.Directory',
  'https://graph.microsoft.com/Application.ReadWrite.All',
  'https://graph.microsoft.com/AuditLog.Read.All',
  'https://graph.microsoft.com/SecurityEvents.Read.All',
  'https://graph.microsoft.com/User.Read.All',
  'https://graph.microsoft.com/MailboxSettings.ReadWrite',
  'offline_access',
].join(' ');

// ─── Safe error extraction ────────────────────────────────────────────────────

async function extractError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string; error_description?: string };
    const code = body.error ?? 'unknown_error';
    const desc = body.error_description?.split('\r\n')[0].trim();  // first line only — full desc can be very long
    return desc ? `${code} (${desc})` : code;
  } catch {
    return 'unparseable_error';
  }
}

// ─── Device code flow ─────────────────────────────────────────────────────────

export interface DeviceCodeStart {
  user_code:        string;
  verification_uri: string;
  expires_in:       number;
  interval:         number;
}

/**
 * Initiates the device code flow for the given tenant.
 * Saves the raw device_code to tokens.db for use by pollDeviceCodeFlow.
 * Returns only user_code + verification_uri — safe to write to pipeline logs.
 */
export async function startDeviceCodeFlow(
  tenantSlug: string,
  hint?: TenantCredsHint,
): Promise<DeviceCodeStart> {
  const { clientId, clientSecret, tenantId } = await getTenantCreds(tenantSlug, hint);

  const params = new URLSearchParams({
    client_id: clientId,
    scope:     GRAPH_SCOPES,
    // Device code flow uses public client mode (no client_secret at the /devicecode endpoint).
    // "Allow public client flows" must be enabled on the Azure AD app registration.
  });

  const res = await fetchWithTimeout(deviceCodeEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });

  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Device code initiation failed: HTTP ${res.status} / ${errCode}`);
  }

  const data = await res.json() as {
    device_code:      string;
    user_code:        string;
    verification_uri: string;
    expires_in:       number;
    interval:         number;
  };

  await savePendingDeviceCode(tenantSlug, data.device_code, hint?.mspSlug ?? undefined);

  return {
    user_code:        data.user_code,
    verification_uri: data.verification_uri,
    expires_in:       data.expires_in,
    interval:         data.interval,
  };
}

export type PollStatus = 'pending' | 'success' | 'expired' | 'error' | 'tenant_mismatch';
export interface PollResult {
  status:    PollStatus;
  reason?:   string;
  expected?: string;  // stored DB tenantId
  got?:      string;  // tid claim from JWT
}

/**
 * Extracts the `tid` claim from a JWT without verifying the signature.
 * Only used to validate that the authenticated tenant matches the DB record.
 */
function extractTid(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return typeof payload.tid === 'string' ? payload.tid : null;
  } catch { return null; }
}

/**
 * Polls Azure AD for device code completion.
 * On success, saves both access_token and refresh_token (encrypted).
 * Returns 'pending', 'success', 'expired', 'error', or 'tenant_mismatch'.
 */
export async function pollDeviceCodeFlow(
  tenantSlug: string,
  hint?: TenantCredsHint,
): Promise<PollResult> {
  const deviceCode = await getPendingDeviceCode(tenantSlug, hint?.mspSlug ?? undefined);
  if (!deviceCode) throw new Error(`[tenant-auth] No pending device code for "${tenantSlug}"`);

  const { clientId, clientSecret, tenantId } = await getTenantCreds(tenantSlug, hint);

  const params = new URLSearchParams({
    client_id:   clientId,
    grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    // No client_secret — device code flow uses public client mode.
  });

  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });

  if (!res.ok) {
    let errCode: string;
    try {
      const body = await res.json() as { error?: string };
      errCode = body.error ?? 'unknown';
    } catch {
      errCode = 'unparseable';
    }

    if (errCode === 'authorization_pending' || errCode === 'slow_down') return { status: 'pending' };
    // expired_token = device code time window elapsed; invalid_grant = device code already used or expired
    if (errCode === 'authorization_declined' || errCode === 'expired_token' || errCode === 'invalid_grant') return { status: 'expired' };

    console.error(`[tenant-auth] Poll failed: HTTP ${res.status} / ${errCode}`);
    return { status: 'error', reason: errCode };
  }

  const data = await res.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
    scope:         string;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  // Guard: verify the authenticated tenant matches the tenantId stored in the DB.
  // Skip when tenantId is blank (first-time setup before the field is populated).
  const jwtTid = extractTid(data.access_token);
  if (jwtTid && tenantId && jwtTid.toLowerCase() !== tenantId.toLowerCase()) {
    await savePendingDeviceCode(tenantSlug, '', hint?.mspSlug ?? undefined);  // discard stale device code
    console.warn(`[tenant-auth] Tenant mismatch for "${tenantSlug}": expected ${tenantId}, got ${jwtTid}`);
    return { status: 'tenant_mismatch', expected: tenantId, got: jwtTid };
  }

  await saveTenantTokens(tenantSlug, {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope:        data.scope ?? GRAPH_SCOPES,
  }, hint?.mspSlug ?? undefined);

  // Clear stored device_code now that auth is complete
  await savePendingDeviceCode(tenantSlug, '', hint?.mspSlug ?? undefined);

  return { status: 'success' };
}

// ─── Get-or-refresh ───────────────────────────────────────────────────────────

const REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// Exchange Online resource — different from Graph, requires a separate token
const EXCHANGE_SCOPE = 'https://outlook.office365.com/.default';

/** SharePoint Online resource scope derived from tenant initial domain prefix. */
export function sharePointScopeFromDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  const onMicrosoft = normalized.match(/^([a-z0-9-]+)\.onmicrosoft\.(com|us|de)$/);
  if (onMicrosoft) {
    return `https://${onMicrosoft[1]}.sharepoint.com/.default`;
  }
  const sharePointHost = normalized.match(/^([a-z0-9-]+)\.sharepoint\.com$/);
  if (sharePointHost) {
    return `https://${sharePointHost[1]}.sharepoint.com/.default`;
  }
  const prefix = normalized.split('.')[0];
  if (!prefix) {
    throw new Error(`[tenant-auth] Cannot derive SharePoint tenant prefix from domain "${domain}"`);
  }
  return `https://${prefix}.sharepoint.com/.default`;
}

export function sharePointAdminUrlFromDomain(domain: string): string | null {
  try {
    const scope = sharePointScopeFromDomain(domain);
    const match = scope.match(/^https:\/\/([a-z0-9-]+)\.sharepoint\.com\/\.default$/);
    if (!match) return null;
    return `https://${match[1]}-admin.sharepoint.com`;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + '='.repeat(padLen);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function userPrincipalNameFromAccessToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  for (const key of ['upn', 'preferred_username', 'unique_name', 'email']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// Microsoft Defender for Endpoint resource
// Explicit delegated scope for MDE API. Using the specific permission name
// instead of .default avoids Azure AD attempting interactive consent expansion,
// which hangs indefinitely in a headless pipeline context.
// .default requests all consented delegated permissions for this resource.
// This works with an MRRT — the Graph device code flow refresh token can be
// exchanged for MDE tokens without a separate sign-in, as long as Machine.Read
// admin consent is granted on the app registration.
const MDE_SCOPE = 'https://api.securitycenter.microsoft.com/.default';

/**
 * Returns a valid access token for the tenant.
 *
 * - If the stored token expires more than 10 minutes from now: decrypts + returns it directly.
 * - If expiring within 10 minutes (or already expired): calls Azure AD refresh_token grant,
 *   saves BOTH the new access_token AND the new refresh_token (rotation), then returns the new token.
 *
 * Token value is never logged.
 */
export async function getOrRefreshTenantToken(tenantSlug: string): Promise<string> {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Run the connect-tenant workflow first.`);
  }

  const expiresAt = new Date(stored.expiresAt);
  const msUntilExpiry = expiresAt.getTime() - Date.now();

  if (msUntilExpiry > REFRESH_THRESHOLD_MS) {
    // Token still valid — return without calling Azure AD
    return stored.accessToken;
  }

  // Refresh — no client_secret: the token was obtained via public client device code flow.
  // "Allow public client flows" must be enabled on the Azure AD app registration.
  const { clientId, tenantId } = await getTenantCreds(tenantSlug);

  const params = new URLSearchParams({
    client_id:     clientId,
    grant_type:    'refresh_token',
    refresh_token: stored.refreshToken,
    scope:         GRAPH_SCOPES, // always use base scopes, not the expanded list Azure returns
  });

  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });

  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Token refresh failed: HTTP ${res.status} / ${errCode}`);
  }

  const data = await res.json() as {
    access_token:   string;
    refresh_token?: string;
    expires_in:     number;
    scope?:         string;
  };

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  // Always save both tokens — Azure AD may rotate the refresh token
  await saveTenantTokens(tenantSlug, {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt:    newExpiresAt,
    scope:        data.scope ?? stored.scope,
  });

  return data.access_token;
}

/**
 * Gets an Exchange Online access token using the stored refresh token (delegated).
 *
 * Requires Exchange.Manage (or equivalent) delegated permission to be consented
 * in the managed tenant. The admin consent step in the portal connect flow
 * (prompt=consent) ensures the tenant always has the latest permissions before
 * the device code sign-in, so this token exchange works without a separate
 * admin consent step.
 *
 * The Exchange token is NOT stored; it is returned directly to the caller.
 */
export async function getExchangeTenantToken(tenantSlug: string): Promise<string> {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Complete the device code flow first.`);
  }

  const { clientId, tenantId } = await getTenantCreds(tenantSlug);

  const params = new URLSearchParams({
    client_id:     clientId,
    grant_type:    'refresh_token',
    refresh_token: stored.refreshToken,
    scope:         EXCHANGE_SCOPE,
  });

  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });

  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Exchange token request failed: HTTP ${res.status} / ${errCode}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  return data.access_token;
}

/**
 * Gets a SharePoint Online access token using the stored refresh token (delegated).
 *
 * Requires SharePoint delegated permissions (e.g. AllSites.FullControl) to be consented
 * in the managed tenant. Token is scoped to https://{tenantPrefix}.sharepoint.com/.default.
 */
export async function getSharePointTenantToken(tenantSlug: string): Promise<string> {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Complete the device code flow first.`);
  }

  const domain = await getTenantDomain(tenantSlug);
  if (!domain) {
    throw new Error(`[tenant-auth] No tenant domain saved for "${tenantSlug}". Set domain in portal tenant settings.`);
  }

  const { clientId, tenantId } = await getTenantCreds(tenantSlug);
  const scope = sharePointScopeFromDomain(domain);

  const params = new URLSearchParams({
    client_id:     clientId,
    grant_type:    'refresh_token',
    refresh_token: stored.refreshToken,
    scope,
  });

  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  });

  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] SharePoint token request failed: HTTP ${res.status} / ${errCode}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  return data.access_token;
}

/**
 * Gets a Microsoft Defender for Endpoint access token using the stored refresh token (delegated).
 */
export async function getMdeTenantToken(tenantSlug: string): Promise<string> {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored?.refreshToken) {
    throw new Error(`[tenant-auth] No token for tenant "${tenantSlug}". Complete the device code flow in the portal first.`);
  }

  const { clientId, tenantId } = await getTenantCreds(tenantSlug);

  const params = new URLSearchParams({
    client_id:     clientId,
    grant_type:    'refresh_token',
    refresh_token: stored.refreshToken,
    scope:         MDE_SCOPE,
  });

  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
  }, 10_000);

  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] MDE token request failed: HTTP ${res.status} / ${errCode}`);
  }

  const data = await res.json() as { access_token: string; refresh_token?: string };
  // Rotate the MRRT if Azure AD issues a new one
  if (data.refresh_token) {
    await saveTenantTokens(tenantSlug, {
      ...stored,
      refreshToken: data.refresh_token,
    });
  }
  return data.access_token;
}
