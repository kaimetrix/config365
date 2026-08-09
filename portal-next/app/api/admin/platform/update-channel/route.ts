import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { getUpdateChannelSettings, setUpdateChannelSettings, type UpdateChannel } from '@/lib/server/app-updater';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  return json({ ok: true, ...getUpdateChannelSettings() });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  let body: { channel?: UpdateChannel; repoOverride?: string | null };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  try {
    const settings = setUpdateChannelSettings(body);
    return json({ ok: true, ...settings });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 400);
  }
}
