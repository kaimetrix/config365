/**
 * GET /api/tenants/[slug]/secure-score/history?days=X
 *
 * Reads daily secure score history from backups/secure-score/history/YYYY-MM-DD.json
 * in the tenant's Gitea repo. No live Graph calls.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';
import { getSecureScoreHistory } from '@/lib/server/secure-score-history';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;
  const days = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10), 1), 365);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org  = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  const [errorResult, scoreResult, controlsResult] = await Promise.all([
    getFile(org, repo, 'backups/secure-score/error.json'),
    getFile(org, repo, 'backups/secure-score/score.json'),
    getFile(org, repo, 'backups/secure-score/controls.json'),
  ]);

  const hasBackupData = scoreResult.exists || controlsResult.exists;
  if (errorResult.exists && !hasBackupData) {
    try {
      const err = JSON.parse(errorResult.content) as { detail?: string };
      return json({ licenceWarning: true, detail: err.detail, days, points: [], availableDates: [] });
    } catch {
      // fall through
    }
  }

  const { points, availableDates } = await getSecureScoreHistory(org, repo, days);

  return json({ days, availableDates, points });
}
