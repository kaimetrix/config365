import { NextRequest, NextResponse } from 'next/server';
import { getCommitDiff } from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { getMspBySlug, getTenantBySlug } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const url      = request.nextUrl;
  const sha      = url.searchParams.get('sha');
  const scope    = url.searchParams.get('scope');    // 'baseline' | 'tenant'
  const mspSlug  = url.searchParams.get('mspSlug');
  const slug     = url.searchParams.get('slug');     // tenant slug

  if (!sha) return json({ error: 'sha is required' }, 400);

  let owner: string;
  let repo: string;
  const platformOrg = process.env.GITEA_ORG ?? 'config365';

  if (scope === 'baseline') {
    const msp = mspSlug ? await getMspBySlug(mspSlug) : null;
    owner = msp?.giteaOrg ?? platformOrg;
    repo  = 'baseline';
  } else if (slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);
    owner = tenant.giteaOrg;
    repo  = `tenant-${tenant.slug}`;
  } else {
    return json({ error: 'Provide scope=baseline or slug=<tenantSlug>' }, 400);
  }

  try {
    const diff = await getCommitDiff(owner, repo, sha);
    return json(diff);
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
