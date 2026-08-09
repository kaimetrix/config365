import { NextRequest, NextResponse } from 'next/server';
import { getTenantBySlug, getMspBySlug, listMsps } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

/**
 * GET /api/internal/tenants/[slug]
 *
 * Used by token-api so it does not duplicate MSSQL/SQLite operational DB access.
 * Auth: Authorization: Bearer <SESSION_SECRET> (same secret as portal session).
 *
 * Returns non-secret tenant fields needed for delegated auth.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const expected = process.env.SESSION_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) {
    return NextResponse.json({ error: 'tenant_not_found' }, { status: 404 });
  }

  // Prefer direct slug lookup when mspId === slug (common); else scan list.
  const mspBySlug = await getMspBySlug(tenant.mspId);
  const msp =
    mspBySlug ??
    (await listMsps()).find((m) => m.id === tenant.mspId) ??
    null;

  return NextResponse.json({
    slug: tenant.slug,
    mspSlug: msp?.slug ?? tenant.mspId,
    mspId: tenant.mspId,
    giteaOrg: tenant.giteaOrg,
    tenantId: tenant.tenantId || null,
    clientId: tenant.clientId || null,
    domain: tenant.domain ?? null,
    displayName: tenant.displayName,
  });
}
