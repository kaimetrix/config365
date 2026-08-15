import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { stageImportBatch } from '@/lib/server/import-job-store';

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
 * POST /api/git/import-jobs/[id]/files
 * Body: { files: [{ path, content }] } — max 10 files per batch
 */
export async function POST(request: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  const denied = requireAdmin(session);
  if (denied) return denied;

  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const raw = body.files;

    if (!Array.isArray(raw) || raw.length === 0) {
      return json({ error: 'files array is required' }, 400);
    }

    const files = raw.map((item: { path?: string; content?: string; encoding?: string }) => {
      if (!item?.path || typeof item.content !== 'string') {
        throw new Error('Each file entry requires path and content');
      }
      return {
        path: item.path,
        content: item.content,
        encoding: item.encoding === 'base64' ? 'base64' as const : 'utf-8' as const,
      };
    });

    const result = stageImportBatch(id, files);
    if ('error' in result) return json({ error: result.error }, result.status);

    return json({
      uploaded: result.meta.uploadedFiles,
      total: result.meta.totalFiles,
      phase: result.meta.phase,
    });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
