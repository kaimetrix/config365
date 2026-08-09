import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { listOrgRunners, deleteOrgRunner, getRunnerRegistrationToken, getInstanceRunnerRegistrationToken } from '@/lib/server/gitea';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const org = request.nextUrl.searchParams.get('org');
  if (!org) return json({ error: 'org is required' }, 400);

  const runners = await listOrgRunners(org);
  return json(runners);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const org = request.nextUrl.searchParams.get('org');
  if (!org) return json({ error: 'org is required' }, 400);

  try {
    const token = await getRunnerRegistrationToken(org);
    return json({ token });
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const org      = request.nextUrl.searchParams.get('org');
  const runnerId = parseInt(request.nextUrl.searchParams.get('runnerId') ?? '0');
  if (!org || !runnerId) return json({ error: 'org and runnerId are required' }, 400);

  try {
    await deleteOrgRunner(org, runnerId);
    return json({ ok: true });
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
