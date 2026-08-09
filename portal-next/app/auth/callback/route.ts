/**
 * GET /auth/callback — exchanges PKCE code for tokens, creates iron-session.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { absoluteUrl } from '@/lib/public-origin';
import { exchangeCode, parseIdToken, derivePublicOrigin, sanitizeReturnTo } from '@/lib/server/auth';
import { getSession, type SessionUser } from '@/lib/server/session';
import { getTenantByDomain, getSetting, setSetting } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const origin = derivePublicOrigin(request, url);

  const code       = url.searchParams.get('code');
  const state      = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const errorDesc  = url.searchParams.get('error_description');

  if (errorParam) {
    return errorRedirect(request, '/login', `Azure AD error: ${errorDesc ?? errorParam}`, url);
  }

  if (!code || !state) {
    return errorRedirect(request, '/login', 'Missing code or state parameter.', url);
  }

  const cookieStore    = await cookies();
  const storedVerifier = cookieStore.get('pkce_verifier')?.value;
  const storedState    = cookieStore.get('pkce_state')?.value;

  if (!storedVerifier || !storedState) {
    return errorRedirect(request, '/login', 'PKCE verifier cookie missing. Please try signing in again.', url);
  }

  // Validate state (the part before any | separator)
  const [receivedStateBase] = state.split('|');
  if (receivedStateBase !== storedState) {
    return errorRedirect(request, '/login', 'State mismatch. Possible CSRF attack.', url);
  }

  // Extract returnTo from state
  const stateParts = state.split('|');
  const returnTo   = stateParts.length > 1 ? decodeURIComponent(stateParts.slice(1).join('|')) : '/';

  let idToken: string;
  try {
    const tokenResp = await exchangeCode(code, storedVerifier, origin);
    idToken = tokenResp.id_token;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Token exchange failed';
    return errorRedirect(request, '/login', msg, url);
  }

  const claims = parseIdToken(idToken);

  // Resolve tenant slug from email domain
  let tenantSlug: string | null = null;
  try {
    const emailDomain = claims.email?.split('@')[1] ?? claims.preferred_username?.split('@')[1];
    if (emailDomain) {
      const tenant = await getTenantByDomain(emailDomain);
      if (tenant) tenantSlug = tenant.slug;
    }
  } catch { /* DB not ready — no tenant assigned */ }

  // First admin detection
  try {
    if (!getSetting('first_admin_oid')) {
      setSetting('first_admin_oid', claims.oid);
    }
  } catch { /* DB not ready */ }

  const user: SessionUser = {
    userId:      claims.oid,
    displayName: claims.name ?? '',
    email:       claims.email ?? claims.preferred_username ?? '',
    roles:       claims.roles ?? [],
    tenantSlug,
  };

  const session = await getSession();
  session.user  = user;
  await session.save();

  // Clear PKCE cookies and redirect to the original destination
  const response = NextResponse.redirect(absoluteUrl(sanitizeReturnTo(returnTo), request.headers, url));
  response.cookies.delete('pkce_verifier');
  response.cookies.delete('pkce_state');
  return response;
}

function errorRedirect(request: Request, to: string, message: string, fallbackUrl: URL): Response {
  const dest = absoluteUrl(to.startsWith('/') ? to : `/${to}`, request.headers, fallbackUrl);
  dest.searchParams.set('error', message);
  return NextResponse.redirect(dest);
}
