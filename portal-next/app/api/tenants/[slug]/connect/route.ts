import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspInternalKeyForTenantRecord } from '@/lib/server/tenant-store';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

const TOKEN_API_URL = process.env.TOKEN_API_INTERNAL_URL ?? 'http://localhost:4322';

/**
 * POST /api/tenants/[slug]/connect
 *
 * Starts the OAuth2 Device Code Flow for the tenant.
 * Returns { user_code, verification_uri, expires_in } — all safe to show in the UI.
 * The actual token exchange happens inside the internal token API (port 4322).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const { key: internalKey, mspSlug } = await getMspInternalKeyForTenantRecord(tenant);
  if (!internalKey) {
    return json({
      error: 'PORTAL_INTERNAL_KEY not configured for this MSP. Generate it first.',
      code: 'msp_key_not_configured',
      mspSlug,
    }, 422);
  }

  const endpoint = `${TOKEN_API_URL}/tenant-auth/device-start`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${internalKey}`,
        'Content-Type': 'application/json',
      },
      // Pass portal-resolved tenant fields so token-api does not need a second
      // operational-DB lookup (it was returning tenant_not_found while the UI listed pot).
      body: JSON.stringify({
        tenantSlug: slug,
        mspSlug: mspSlug ?? undefined,
        tenantId: tenant.tenantId || undefined,
        clientId: tenant.clientId || undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; detail?: string };
      const errCode = body.error ?? '';
      // Token-api returns 403 msp_key_not_configured when the MSP internal key
      // is missing (or the tenant→MSP lookup failed). Surface as 422 so the UI
      // shows "Generate MSP Key" only for that specific code.
      if (res.status === 403 && (errCode === 'msp_key_not_configured' || errCode.includes('msp_key'))) {
        return json({
          error: 'PORTAL_INTERNAL_KEY not configured for this MSP. Generate it first.',
          code: 'msp_key_not_configured',
        }, 422);
      }
      if (res.status === 404 && errCode === 'tenant_not_found') {
        return json({
          error: body.detail
            ?? `Token API could not find tenant "${slug}" in the portal database. With MSSQL portal DB enabled, the tenant must exist in c365p_tenants (Key Vault only stores OAuth tokens).`,
          code: 'tenant_not_found',
        }, 404);
      }
      return json({ error: body.detail ?? body.error ?? 'Token API error', code: errCode || undefined }, res.status);
    }

    const data = await res.json() as {
      user_code:        string;
      verification_uri: string;
      expires_in:       number;
      message?:         string;
    };

    return json({
      user_code:        data.user_code,
      verification_uri: data.verification_uri,
      expires_in:       data.expires_in,
      message:          data.message,
    });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * GET /api/tenants/[slug]/connect
 *
 * Polls the internal token API for device code completion.
 * Returns { status: 'pending' | 'success' | 'expired' | 'error' | 'tenant_mismatch', expected?, got? }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const { key: internalKey, mspSlug } = await getMspInternalKeyForTenantRecord(tenant);
  if (!internalKey) {
    return json({ status: 'error', error: 'MSP key not configured', code: 'msp_key_not_configured' }, 422);
  }

  const pollQs = new URLSearchParams({ tenantSlug: slug });
  if (mspSlug) pollQs.set('mspSlug', mspSlug);
  const pollEndpoint = `${TOKEN_API_URL}/tenant-auth/device-poll?${pollQs.toString()}`;

  try {
    const res = await fetch(pollEndpoint, {
      headers: { Authorization: `Bearer ${internalKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return json({ status: 'error' }, res.status);
    const data = await res.json() as { status: string; reason?: string; expected?: string; got?: string };
    return json(data);
  } catch (err: unknown) {
    return json({ status: 'error', error: (err as Error).message }, 500);
  }
}
