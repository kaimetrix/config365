import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { resolveImportTarget } from '@/lib/server/import-commit';
import { createImportJob } from '@/lib/server/import-job-store';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function requireAdmin(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);
  return null;
}

/**
 * POST /api/git/import-jobs
 * Body: { mspSlug?, slug?, scope, path?, message, totalFiles }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  const denied = requireAdmin(session);
  if (denied) return denied;

  try {
    const body = await request.json();
    const mspSlug = (body.mspSlug as string | null) ?? null;
    const slug = (body.slug as string | null) ?? null;
    const scope = (body.scope as string | null) ?? null;
    const pathPrefix = (body.path as string | null) ?? '';
    const message = (body.message as string | null) ?? 'import: zip upload';
    const totalFiles = Number(body.totalFiles);

    if (!Number.isFinite(totalFiles) || totalFiles < 1) {
      return json({ error: 'totalFiles must be a positive number' }, 400);
    }

    const resolved = await resolveImportTarget(scope, mspSlug, slug);
    if (!resolved.ok) return json({ error: resolved.error }, resolved.status);

    const meta = createImportJob({
      mspSlug,
      slug,
      scope,
      pathPrefix,
      message,
      org: resolved.target.org,
      repo: resolved.target.repo,
      totalFiles,
    });

    return json({ jobId: meta.id, totalFiles: meta.totalFiles }, 201);
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
