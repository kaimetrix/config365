import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';
import { buildTimelineEvents } from '@/lib/server/timeline';

export const runtime = 'nodejs';
export const maxDuration = 120;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** GET /api/timeline/events?slug=...&from=YYYY-MM-DD&to=YYYY-MM-DD&branch=main&limit=100 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const p      = request.nextUrl.searchParams;
  const slug   = p.get('slug');
  const from   = p.get('from');
  const to     = p.get('to');
  const branch = p.get('branch') ?? 'main';
  const limit  = Math.min(parseInt(p.get('limit') ?? '100', 10), 100);

  if (!slug) return json({ error: 'slug is required' }, 400);
  if (!from || !to) return json({ error: 'from and to are required (YYYY-MM-DD)' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  try {
    const events = await buildTimelineEvents(tenant.giteaOrg, `tenant-${tenant.slug}`, {
      from,
      to,
      branch,
      limit,
    });
    return json({ events });
  } catch (err: unknown) {
    return json({ error: (err as Error).message ?? 'Failed to load timeline events' }, 500);
  }
}
