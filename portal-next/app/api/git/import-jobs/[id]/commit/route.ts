import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { startImportJobCommit } from '@/lib/server/import-job-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function requireAdmin(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);
  return null;
}

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/git/import-jobs/[id]/commit — start async Gitea commit
 */
export async function POST(_request: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  const denied = requireAdmin(session);
  if (denied) return denied;

  const { id } = await ctx.params;
  const result = startImportJobCommit(id);
  if ('error' in result) return json({ error: result.error }, result.status);

  return json(
    {
      phase: result.meta.phase,
      uploaded: result.meta.uploadedFiles,
      total: result.meta.totalFiles,
    },
    202,
  );
}
