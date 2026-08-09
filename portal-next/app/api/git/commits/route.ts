import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { getMspBySlug } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const url     = request.nextUrl;
  const scope   = url.searchParams.get('scope');
  const mspSlug = url.searchParams.get('mspSlug');
  const branch  = url.searchParams.get('branch') ?? 'main';
  const limit   = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
  const sha     = url.searchParams.get('sha');
  const slug    = url.searchParams.get('slug');

  let org: string;
  let repo: string;
  const platformOrg = process.env.GITEA_ORG ?? 'config365';

  if (scope === 'baseline') {
    if (mspSlug) {
      const msp = await getMspBySlug(mspSlug);
      org = msp?.giteaOrg ?? platformOrg;
    } else {
      org = platformOrg;
    }
    repo = 'baseline';
  } else if (slug) {
    const { getTenantBySlug } = await import('@/lib/server/tenant-store');
    const tenant = await getTenantBySlug(slug);
    if (!tenant) return json({ error: 'Tenant not found' }, 404);
    org  = tenant.giteaOrg;
    repo = `tenant-${tenant.slug}`;
  } else {
    return json({ error: 'No tenant context. Provide slug or scope=baseline' }, 400);
  }

  try {
    if (sha) {
      const commit = await gitea.getCommit(org, repo, sha);
      return json(commit);
    }
    const commits = await gitea.getCommits(org, repo, { branch, limit });
    return json(commits);
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('409') || msg.toLowerCase().includes('empty')) return json([]);
    return json({ error: msg }, 500);
  }
}
