import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { getEntries, isInProgress } from '@/lib/server/bootstrap-log';
import { bootstrapPlatformIfNeeded, syncScriptsToGitea } from '@/lib/server/platform-bootstrap';
import { isSetupComplete } from '@/lib/server/tenant-store';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 });
  if (!isPlatformAdmin(session.user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const scope = request.nextUrl.searchParams.get('scope') ?? undefined;

  // Lazy bootstrap trigger: if setup is complete but bootstrap hasn't started yet
  // (e.g. the provisioning step is polling but the process restarted), kick it off.
  // bootstrapPlatformIfNeeded() is idempotent and Promise-deduplicated — safe to call on every poll.
  // syncScriptsToGitea() is chained here only if platform bootstrap isn't already in flight,
  // to avoid a second concurrent sync when setup/route.ts already triggered it.
  if (isSetupComplete() && !isInProgress('platform') && getEntries('platform').length === 0) {
    bootstrapPlatformIfNeeded()
      .then(() => syncScriptsToGitea())
      .catch(() => {});
  } else if (isSetupComplete() && !isInProgress('scripts-sync') && getEntries('scripts-sync').length === 0) {
    // Platform is done but scripts haven't run yet — kick off scripts sync alone.
    syncScriptsToGitea().catch(() => {});
  }

  // When no scope provided, return all scopes that have activity
  const entries    = getEntries(scope);
  const inProgress = scope ? isInProgress(scope) : false;

  return NextResponse.json({ entries, inProgress }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
