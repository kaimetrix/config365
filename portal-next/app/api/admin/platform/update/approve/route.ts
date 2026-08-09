import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { readUpdateSession, clearUpdateSession, appendSessionLog, writeUpdateSession } from '@/lib/server/update-session';
import { mergeScriptsPullRequest } from '@/lib/server/scripts-update';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(request: NextRequest) {
  const auth = await getSession();
  if (!auth.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(auth.user)) return json({ error: 'Forbidden' }, 403);

  const session = readUpdateSession();
  if (!session) return json({ error: 'No active update session' }, 400);
  if (session.step !== 'step4' || !session.prNumber) {
    return json({ error: 'No scripts PR pending approval' }, 400);
  }

  try {
    await mergeScriptsPullRequest(session.prNumber);
    appendSessionLog(session, `PR #${session.prNumber} merged`);
    session.step = 'complete';
    writeUpdateSession(session);
    clearUpdateSession();
    return json({ ok: true, message: 'Scripts approved and merged' });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
}
