import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const url    = request.nextUrl;
  const slug   = url.searchParams.get('slug');
  const runId  = parseInt(url.searchParams.get('runId') ?? '0');
  if (!slug || !runId) return json({ error: 'slug and runId are required' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  try {
    const artifacts = await gitea.getArtifacts(tenant.giteaOrg, `tenant-${tenant.slug}`, runId);
    return json(artifacts);
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
