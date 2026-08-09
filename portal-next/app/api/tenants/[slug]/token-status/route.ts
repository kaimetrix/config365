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
 * GET /api/tenants/[slug]/token-status
 *
 * Server-side fetch to the internal token API (port 4322).
 * Returns only non-sensitive connection metadata — token values never reach the browser.
 * Authenticates using the per-MSP PORTAL_INTERNAL_KEY from platform_settings.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const { key: internalKey } = await getMspInternalKeyForTenantRecord(tenant);
  if (!internalKey) {
    return json({
      connected: false,
      expiresAt: null,
      updatedAt: null,
      error: 'PORTAL_INTERNAL_KEY not configured for this MSP',
      code: 'msp_key_not_configured',
    });
  }

  try {
    const res = await fetch(
      `${TOKEN_API_URL}/tenant-auth/status?tenantSlug=${encodeURIComponent(slug)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${internalKey}` },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      return json({ connected: false, expiresAt: null, updatedAt: null });
    }

    const data = await res.json() as { connected: boolean; expiresAt: string | null; updatedAt: string | null };
    return json(data);
  } catch {
    return json({ connected: false, expiresAt: null, updatedAt: null });
  }
}

/**
 * DELETE /api/tenants/[slug]/token-status
 *
 * Disconnects the tenant by deleting its stored tokens via the internal token API.
 * Authenticates using the per-MSP PORTAL_INTERNAL_KEY from platform_settings.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const { key: internalKey } = await getMspInternalKeyForTenantRecord(tenant);
  if (!internalKey) {
    return json({ error: 'PORTAL_INTERNAL_KEY not configured for this MSP', code: 'msp_key_not_configured' }, 500);
  }

  try {
    const res = await fetch(`${TOKEN_API_URL}/tenant-auth/disconnect`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${internalKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantSlug: slug }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return json({ error: 'Token API error' }, 502);
    return json({ ok: true });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
