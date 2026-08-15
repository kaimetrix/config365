/**
 * GET /login/start — generates PKCE pair, stores verifier in cookie, redirects to Azure AD.
 * Linked from the /login page (Microsoft sign-in button).
 */
import { NextResponse } from 'next/server';
import { absoluteUrl } from '@/lib/public-origin';
import { generatePkce, buildAuthorizationUrl, derivePublicOrigin } from '@/lib/server/auth';
import { getSetting } from '@/lib/server/tenant-store';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);

  const origin  = derivePublicOrigin(request, url);
  const returnTo = url.searchParams.get('returnTo') ?? '/';

  // Easy Auth mode — delegate to /auth/easyauth which reads the injected headers
  try {
    if (getSetting('auth_mode') === 'easyauth') {
      const dest = absoluteUrl('/auth/easyauth', request.headers, url);
      if (returnTo !== '/') dest.searchParams.set('returnTo', returnTo);
      return NextResponse.redirect(dest);
    }
  } catch { /* DB not ready — fall through to setup guard */ }

  try {
    if (!getSetting('azure_client_id')) {
      return NextResponse.redirect(absoluteUrl('/setup', request.headers, url));
    }
  } catch {
    return NextResponse.redirect(absoluteUrl('/setup', request.headers, url));
  }

  let authUrl: string;
  let verifier: string;
  let state: string;
  try {
    const pkce = generatePkce();
    verifier = pkce.verifier;
    state    = randomUUID();
    authUrl = buildAuthorizationUrl(state, pkce.challenge, returnTo, origin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Configuration error';
    const dest = absoluteUrl('/login', request.headers, url);
    dest.searchParams.set('error', msg);
    return NextResponse.redirect(dest);
  }

  const secure = process.env.SECURE_COOKIES === 'true';
  const response = NextResponse.redirect(authUrl);
  response.cookies.set('pkce_verifier', verifier, { httpOnly: true, secure, sameSite: 'lax', maxAge: 600, path: '/' });
  response.cookies.set('pkce_state',    state,    { httpOnly: true, secure, sameSite: 'lax', maxAge: 600, path: '/' });
  return response;
}
