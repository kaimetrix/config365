/**
 * Server-side Azure AD OIDC authentication (PKCE flow).
 *
 * Flow:
 *   1. GET /login          → sign-in page (Microsoft button)
 *   2. GET /login/start    → PKCE + redirect to Azure AD
 *   2. GET /auth/callback?code=... → exchanges code for tokens (server-side)
 *   3. ID token claims extracted → stored in iron-session (httpOnly cookie)
 *   4. Browser never receives any tokens
 */

import 'server-only';
import { getSetting, getDecryptedSetting } from './tenant-store';
import { randomBytes, createHash } from 'node:crypto';
import { derivePublicOriginFromHeaders } from '@/lib/public-origin';

// ─── Origin detection ─────────────────────────────────────────────────────────

export function derivePublicOrigin(request: Request, url: URL): string {
  return derivePublicOriginFromHeaders(request.headers, url);
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function getOidcConfig(requestOrigin?: string) {
  const clientId  = getSetting('azure_client_id')  ?? process.env.AZURE_AD_CLIENT_ID;
  const tenantId  = getSetting('azure_tenant_id')  ?? process.env.AZURE_AD_TENANT_ID;
  const redirectUri = requestOrigin
    ? `${requestOrigin.replace(/\/$/, '')}/auth/callback`
    : getSetting('azure_redirect_uri') ??
      process.env.AZURE_AD_REDIRECT_URI ??
      'http://localhost:3000/auth/callback';

  if (!clientId || !tenantId) {
    throw new Error('Azure AD credentials are not configured. Please complete the setup wizard.');
  }

  const clientSecret =
    getDecryptedSetting('azure_client_secret') ||
    process.env.AZURE_AD_CLIENT_SECRET ||
    undefined;

  return {
    clientId,
    clientSecret,
    tenantId,
    redirectUri,
    authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    scopes: ['openid', 'profile', 'email'],
  };
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier  = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  state: string,
  codeChallenge: string,
  returnTo?: string,
  requestOrigin?: string,
): string {
  const cfg = getOidcConfig(requestOrigin);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    state: returnTo ? `${state}|${encodeURIComponent(returnTo)}` : state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
  });
  return `${cfg.authorizationEndpoint}?${params}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

interface TokenResponse {
  id_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  requestOrigin?: string,
): Promise<TokenResponse> {
  const cfg = getOidcConfig(requestOrigin);
  const params: Record<string, string> = {
    client_id: cfg.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  };
  if (cfg.clientSecret) params.client_secret = cfg.clientSecret;

  const res = await fetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} — ${body}`);
  }
  return res.json();
}

// ─── ID token parsing ─────────────────────────────────────────────────────────

export interface IdTokenClaims {
  oid: string;
  name: string;
  email?: string;
  preferred_username?: string;
  roles?: string[];
  tid: string;
}

export function parseIdToken(idToken: string): IdTokenClaims {
  const [, payload] = idToken.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as IdTokenClaims;
}

export function buildLogoutUrl(postLogoutRedirectUri: string): string {
  const cfg = getOidcConfig();
  const params = new URLSearchParams({ post_logout_redirect_uri: postLogoutRedirectUri });
  return `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/logout?${params}`;
}

/**
 * Returns a safe relative path (always starts with '/') to redirect to after
 * authentication. Rejects absolute URLs, protocol-relative URLs, and any value
 * that does not start with a single '/' to prevent open-redirect attacks.
 */
export function sanitizeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo) return '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(returnTo)) return '/';
  if (returnTo.startsWith('//')) return '/';
  if (!returnTo.startsWith('/')) return '/';
  return returnTo;
}
