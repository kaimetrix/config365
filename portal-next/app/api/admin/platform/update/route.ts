import { NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { checkForUpdates } from '@/lib/server/app-updater';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  try {
    const check = await checkForUpdates();
    return json({ ok: true, ...check });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
}
