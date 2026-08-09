import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { getTenantBySlug } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) return json({ error: 'slug is required' }, 400);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return json({ error: 'Tenant not found' }, 404);

  try {
    const branches = await gitea.getBranches(tenant.giteaOrg, `tenant-${tenant.slug}`);
    return json(branches);
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
