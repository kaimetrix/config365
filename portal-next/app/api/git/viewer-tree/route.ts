import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireMspAccess, requireTenantAccess } from '@/lib/server/authz';
import { loadViewerTree } from '@/lib/server/viewer-tree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  const p = request.nextUrl.searchParams;
  const mspSlug = p.get('mspSlug');
  const scope = p.get('scope') === 'baseline' ? 'baseline' : 'tenant';
  const slug = p.get('slug');

  if (!mspSlug) return json({ error: 'mspSlug is required' }, 400);

  const msp = await requireMspAccess(session.user, mspSlug);
  if (msp instanceof NextResponse) return msp;

  try {
    if (scope === 'baseline') {
      const result = await loadViewerTree({ scope: 'baseline', baselineOrg: msp.giteaOrg });
      return json(result);
    }

    if (!slug) return json({ error: 'slug is required for tenant scope' }, 400);

    const tenant = await requireTenantAccess(session.user, slug);
    if (tenant instanceof NextResponse) return tenant;
    if (tenant.mspId !== msp.id) return json({ error: 'Forbidden' }, 403);

    const result = await loadViewerTree({
      scope: 'tenant',
      baselineOrg: msp.giteaOrg,
      tenantOrg: tenant.giteaOrg,
      tenantSlug: tenant.slug,
    });
    return json(result);
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
