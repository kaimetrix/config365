/**
 * GET /auth/easyauth — creates an iron-session from Azure App Service Easy Auth headers.
 *
 * When Azure App Service Authentication (Easy Auth) is enabled, Azure injects
 * X-MS-CLIENT-PRINCIPAL (base64-encoded JSON with user claims) on every
 * authenticated request before they reach Next.js. This route reads those
 * headers and bootstraps the portal session, replacing the OIDC/PKCE flow.
 *
 * Security: the route rejects requests when auth_mode !== 'easyauth' so that
 * the header cannot be spoofed in environments running the standard OIDC flow.
 */
import { NextResponse } from 'next/server';
import { absoluteUrl } from '@/lib/public-origin';
import { getSession, type SessionUser } from '@/lib/server/session';
import { getSetting, setSetting, getTenantByDomain } from '@/lib/server/tenant-store';
import { derivePublicOrigin, sanitizeReturnTo } from '@/lib/server/auth';

export const runtime = 'nodejs';

interface EasyAuthPrincipal {
  claims: Array<{ typ: string; val: string }>;
}

function getClaim(claims: EasyAuthPrincipal['claims'], typ: string): string | undefined {
  return claims.find(c => c.typ === typ)?.val;
}

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const origin = derivePublicOrigin(request, url);

  // Reject if not in Easy Auth mode — prevents header spoofing on non-Easy-Auth deployments
  try {
    if (getSetting('auth_mode') !== 'easyauth') {
      return errorPage('Easy Auth mode is not configured. Complete setup first.', origin);
    }
  } catch {
    return errorPage('Setup is not complete. Please run the setup wizard first.', origin);
  }

  const principalHeader = request.headers.get('x-ms-client-principal');
  if (!principalHeader) {
    return errorPage(
      'No authentication header found (x-ms-client-principal is missing). ' +
      'Ensure Azure App Service Authentication is enabled and the portal is accessed through the Azure App Service URL.',
      origin,
    );
  }

  let principal: EasyAuthPrincipal;
  try {
    principal = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf-8')) as EasyAuthPrincipal;
  } catch {
    return errorPage('Failed to parse authentication header. The x-ms-client-principal value is malformed.', origin);
  }

  const { claims } = principal;

  // Extract user identity from claims
  // OID is the stable, unique identifier for the user in Azure AD
  const oid = getClaim(claims, 'oid') ?? getClaim(claims, 'http://schemas.microsoft.com/identity/claims/objectidentifier');
  if (!oid) {
    return errorPage('Cannot identify user: "oid" claim is missing from Easy Auth principal.', origin);
  }

  const displayName = getClaim(claims, 'name') ?? '';
  const email =
    getClaim(claims, 'preferred_username') ??
    getClaim(claims, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') ??
    getClaim(claims, 'upn') ??
    '';

  // Collect any app role assignments
  const roles = claims
    .filter(c =>
      c.typ === 'roles' ||
      c.typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
    )
    .map(c => c.val);

  // Resolve tenant slug from email domain
  let tenantSlug: string | null = null;
  try {
    const emailDomain = email.split('@')[1];
    if (emailDomain) {
      const tenant = await getTenantByDomain(emailDomain);
      if (tenant) tenantSlug = tenant.slug;
    }
  } catch { /* DB not ready — no tenant assigned */ }

  // First admin detection — same logic as /auth/callback
  try {
    if (!getSetting('first_admin_oid')) {
      setSetting('first_admin_oid', oid);
    }
  } catch { /* DB not ready */ }

  const user: SessionUser = {
    userId: oid,
    displayName,
    email,
    roles,
    tenantSlug,
  };

  const session = await getSession();
  session.user  = user;
  await session.save();

  const returnTo = url.searchParams.get('returnTo');
  return NextResponse.redirect(absoluteUrl(sanitizeReturnTo(returnTo), request.headers, url));
}

function errorPage(message: string, origin: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Authentication Error — Config365</title>
  <style>
    body { margin:0;background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;
           display:flex;align-items:center;justify-content:center;height:100vh; }
    .card { background:#18181b;border:1px solid #27272a;border-radius:12px;padding:40px;max-width:520px;text-align:center; }
    h1 { font-size:1.25rem;margin-bottom:12px;color:#fca5a5; }
    p  { color:#71717a;font-size:0.85rem;margin-bottom:20px;line-height:1.5; }
    a  { color:#3b82f6;font-size:0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Error</h1>
    <p>${message.replace(/</g, '&lt;')}</p>
    <a href="${origin}/setup">Go to setup</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
