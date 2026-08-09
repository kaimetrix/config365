import { NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { getIntuneWinPackagerStatus } from '@/lib/server/intunewin-app-util';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** Read-only status for the intunewin CLI baked into the container image. */
export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  return json(getIntuneWinPackagerStatus());
}
