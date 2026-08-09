import { NextRequest, NextResponse } from 'next/server';

import { getSession, isPlatformAdmin } from '@/lib/server/session';

import {

  checkForUpdates,

  executeWizardStep2,

  restartPortalServicesDetached,

} from '@/lib/server/app-updater';

import {

  readUpdateSession,

  appendSessionLog,

  writeUpdateSession,

  clearUpdateSession,

  createUpdateSession,

} from '@/lib/server/update-session';

import { proposeScriptsUpdatePR } from '@/lib/server/scripts-update';



export const runtime = 'nodejs';



function json(data: unknown, status = 200) {

  return NextResponse.json(data, { status });

}



async function runScriptsPrStep() {

  const updateSession = readUpdateSession();

  if (!updateSession) return json({ error: 'No active update session' }, 400);



  updateSession.step = 'step3';

  writeUpdateSession(updateSession);

  appendSessionLog(updateSession, 'Preparing scripts PR...');



  const pr = await proposeScriptsUpdatePR(updateSession.targetVersion);

  if (pr) {

    updateSession.prNumber = pr.prNumber;

    updateSession.prUrl = pr.prUrl;

    updateSession.scriptChanges = pr.changedFiles;

    updateSession.step = 'step4';

    appendSessionLog(updateSession, `PR #${pr.prNumber} created (${pr.changedFiles.length} files)`);

    writeUpdateSession(updateSession);

    return json({ ok: true, session: updateSession });

  }



  updateSession.step = 'complete';

  appendSessionLog(updateSession, 'No script changes — update complete');

  writeUpdateSession(updateSession);

  clearUpdateSession();

  return json({ ok: true, session: { ...updateSession, step: 'complete' } });

}



export async function GET() {

  const session = await getSession();

  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);



  const updateSession = readUpdateSession();

  const check = await checkForUpdates().catch(() => null);

  return json({ ok: true, session: updateSession, check });

}



export async function POST(request: NextRequest) {

  const auth = await getSession();

  if (!auth.user) return json({ error: 'Unauthenticated' }, 401);

  if (!isPlatformAdmin(auth.user)) return json({ error: 'Forbidden' }, 403);



  let body: { action?: string; targetVersion?: string };

  try {

    body = await request.json();

  } catch {

    return json({ error: 'Invalid JSON' }, 400);

  }



  const action = body.action ?? 'start';



  if (action === 'cancel') {

    clearUpdateSession();

    return json({ ok: true, cancelled: true });

  }



  if (action === 'start') {

    const check = await checkForUpdates();

    if (check.blocked) {

      return json({

        ok: false,

        blocked: true,

        reason: check.blockReason,

        requiredPlatformVersion: check.requiredPlatformVersion,

        installedPlatformVersion: check.installedPlatformVersion,

      }, 409);

    }

    if (!check.updateAvailable || !check.latestVersion) {

      return json({ ok: false, error: 'No update available' }, 400);

    }



    const targetVersion = body.targetVersion ?? check.latestVersion;

    const updateSession = createUpdateSession(targetVersion);

    updateSession.releaseNotes = check.releaseNotes;

    updateSession.bumpType = check.bumpType as 'app' | 'platform' | undefined;

    updateSession.manifest = check.manifest as unknown as Record<string, unknown> | undefined;

    writeUpdateSession(updateSession);



    return json({ ok: true, session: updateSession });

  }



  if (action === 'continue') {

    let updateSession = readUpdateSession();

    if (!updateSession) return json({ error: 'No active update session' }, 400);



    if (updateSession.step === 'restarting') {
      return json({ ok: true, session: updateSession, restarting: true });
    }



    // 'failed' is retryable — the wizard's Retry button re-runs step 2 (download is
    // idempotent, checksum-verified, and migrations/swap are safe to re-attempt).
    if (updateSession.step !== 'step1' && updateSession.step !== 'failed') {

      return json({ ok: true, session: updateSession });

    }



    try {

      updateSession = await executeWizardStep2(updateSession);

      await restartPortalServicesDetached();

      appendSessionLog(updateSession, 'Portal services restarting…');

      writeUpdateSession(updateSession);

      return json({ ok: true, session: updateSession, restarting: true });

    } catch (err) {

      updateSession.step = 'failed';

      updateSession.error = (err as Error).message;

      appendSessionLog(updateSession, `Failed: ${updateSession.error}`);

      writeUpdateSession(updateSession);

      return json({ ok: false, error: updateSession.error, session: updateSession }, 500);

    }

  }



  if (action === 'resume') {

    const updateSession = readUpdateSession();

    if (!updateSession) return json({ error: 'No active update session' }, 400);

    if (updateSession.step !== 'restarting') {

      return json({ ok: true, session: updateSession });

    }

    try {

      return await runScriptsPrStep();

    } catch (err) {

      updateSession.step = 'failed';

      updateSession.error = (err as Error).message;

      appendSessionLog(updateSession, `Failed: ${updateSession.error}`);

      writeUpdateSession(updateSession);

      return json({ ok: false, error: updateSession.error, session: updateSession }, 500);

    }

  }



  return json({ error: 'Unknown action' }, 400);

}


