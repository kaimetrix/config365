import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';
import { getCommitDiff } from '@/lib/server/gitea';
import { getTimelineDiff, type TimelineFileEvent } from '@/lib/server/timeline';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** GET /api/timeline/diff?slug=...&path=...&sha=...&prevSha=...&changeType=modified */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const p          = request.nextUrl.searchParams;
  const slug       = p.get('slug');
  const path       = p.get('path');
  const sha        = p.get('sha');
  const changeType = (p.get('changeType') ?? 'modified') as TimelineFileEvent['changeType'];
  let prevSha      = p.get('prevSha');

  if (!slug) return json({ error: 'slug is required' }, 400);
  if (!path) return json({ error: 'path is required' }, 400);
  if (!sha)  return json({ error: 'sha is required' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org  = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  try {
    if (!prevSha) {
      const diff = await getCommitDiff(org, repo, sha);
      prevSha = diff.parentSha;
    }

    const result = await getTimelineDiff(org, repo, path, sha, prevSha, changeType);
    return json(result);
  } catch (err: unknown) {
    return json({ error: (err as Error).message ?? 'Failed to load diff' }, 500);
  }
}
