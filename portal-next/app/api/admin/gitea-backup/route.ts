/**
 * GET  /api/admin/gitea-backup — list platform Gitea→Blob backup history
 * POST /api/admin/gitea-backup — start a one-shot platform backup now
 */
import { NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import {
  listGiteaBlobBackupHistory,
  startGiteaBlobBackupNow,
} from '@/lib/server/backup-scheduler';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  return json({ history: listGiteaBlobBackupHistory(50) });
}

export async function POST() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const result = await startGiteaBlobBackupNow();
  if (result.conflict) return json({ ok: false, error: result.detail }, 409);
  if (!result.ok) return json({ ok: false, error: result.detail }, 400);
  return json({ ok: true, detail: result.detail });
}
