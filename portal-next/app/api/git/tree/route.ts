import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { getTenantBySlug, getMspBySlug } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const url      = request.nextUrl;
  const scope    = url.searchParams.get('scope');
  const slug     = url.searchParams.get('slug');
  const mspSlug  = url.searchParams.get('mspSlug');
  const path     = url.searchParams.get('path') ?? '';
  const ref      = url.searchParams.get('ref') ?? 'main';
  const platformOrg = process.env.GITEA_ORG ?? 'config365';

  let org: string, repo: string;
  if (scope === 'baseline') {
    if (mspSlug) { const msp = await getMspBySlug(mspSlug); org = msp?.giteaOrg ?? platformOrg; } else { org = platformOrg; }
    repo = 'baseline';
  } else if (slug) {
    const t = await getTenantBySlug(slug);
    if (!t) return json({ error: 'Tenant not found' }, 404);
    org = t.giteaOrg; repo = `tenant-${t.slug}`;
  } else {
    return json({ error: 'Provide slug or scope=baseline' }, 400);
  }

  try {
    const tree = await gitea.getTree(org, repo, path, ref);
    return json(tree);
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
