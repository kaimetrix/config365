import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { cancelImportJob, deleteImportJob, getImportJob } from '@/lib/server/import-job-store';

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
 * GET /api/git/import-jobs/[id] — poll job status
 * DELETE /api/git/import-jobs/[id] — cancel and cleanup
 */
export async function GET(_request: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  const denied = requireAdmin(session);
  if (denied) return denied;

  const { id } = await ctx.params;
  const meta = getImportJob(id);
  if (!meta) return json({ error: 'Import job not found' }, 404);

  const payload = {
    phase: meta.phase,
    uploaded: meta.uploadedFiles,
    total: meta.totalFiles,
    committed: Math.max(0, Math.min(meta.committedFiles, meta.totalFiles)),
    error: meta.error ?? null,
  };

  if (meta.phase === 'done') deleteImportJob(id);

  return json(payload);
}

export async function DELETE(_request: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  const denied = requireAdmin(session);
  if (denied) return denied;

  const { id } = await ctx.params;
  const meta = cancelImportJob(id);
  if (!meta) return json({ error: 'Import job not found' }, 404);

  return json({ ok: true, phase: meta.phase });
}
