import { NextRequest, NextResponse } from 'next/server';

import { getSession, isPlatformAdmin } from '@/lib/server/session';
import {
  checkForUpdates,
  executeWizardStep2,
  formatBlockedUpdateError,
  formatNoUpdateError,
  restartPortalServicesDetached,
} from '@/lib/server/app-updater';
import { inferRequiredPlatformVersion } from '@/lib/update-source';
import {
  readUpdateSession,
  appendSessionLog,
  appendSessionLogLines,
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
  appendSessionLog(updateSession, 'diff orchestrator scripts vs release scripts-staging / pipeline-templates-staging');

  const pr = await proposeScriptsUpdatePR(updateSession.targetVersion);
  if (pr) {
    updateSession.prNumber = pr.prNumber;
    updateSession.prUrl = pr.prUrl;
    updateSession.scriptChanges = pr.changedFiles;
    updateSession.step = 'step4';
    appendSessionLog(updateSession, `Gitea PR #${pr.prNumber} ${pr.prUrl} (${pr.changedFiles.length} file(s))`);
    for (const change of pr.changedFiles.slice(0, 80)) {
      appendSessionLog(updateSession, `  ${change.status} ${change.path}`);
    }
    writeUpdateSession(updateSession);
    return json({ ok: true, session: updateSession });
  }

  updateSession.step = 'complete';
  appendSessionLog(updateSession, 'no script changes — update complete');
  writeUpdateSession(updateSession);
  clearUpdateSession();
  return json({ ok: true, session: { ...updateSession, step: 'complete' } });
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  // Cheap poll for the wizard log — do not re-hit GitHub on every GET.
  return json({ ok: true, session: readUpdateSession() });
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
    try {
      const check = await checkForUpdates();
      if (check.blocked) {
        const error = formatBlockedUpdateError({
          latestVersion: check.latestVersion ?? 'unknown',
          requiredPlatformVersion: check.requiredPlatformVersion ?? inferRequiredPlatformVersion(check.latestVersion ?? '0.0.0'),
          installedPlatformVersion: check.installedPlatformVersion,
          repo: check.source.repo,
        });
        return json({
          ok: false,
          error,
          blocked: true,
          reason: check.blockReason,
          requiredPlatformVersion: check.requiredPlatformVersion,
          installedPlatformVersion: check.installedPlatformVersion,
          source: check.source,
          trace: check.trace,
        }, 409);
      }

      if (!check.updateAvailable || !check.latestVersion) {
        return json({
          ok: false,
          error: formatNoUpdateError(check.source),
          source: check.source,
          trace: check.trace,
        }, 400);
      }

      const targetVersion = body.targetVersion ?? check.latestVersion;
      const updateSession = createUpdateSession(targetVersion);
      updateSession.releaseNotes = check.releaseNotes;
      updateSession.bumpType = check.bumpType as 'app' | 'platform' | undefined;
      updateSession.manifest = check.manifest as unknown as Record<string, unknown> | undefined;
      appendSessionLogLines(updateSession, check.trace);
      appendSessionLog(updateSession, `will apply v${targetVersion}. next: download tarball, tar -xzf, node run-migrations.mjs, ln -sfn, supervisorctl restart portal token-api`);
      writeUpdateSession(updateSession);

      return json({ ok: true, session: updateSession, source: check.source, trace: check.trace });
    } catch (err) {
      return json({
        ok: false,
        error: `Start failed: ${(err as Error).message}`,
      }, 500);
    }
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
      const running = await executeWizardStep2(updateSession);
      await restartPortalServicesDetached(line => { appendSessionLog(running, line); });
      writeUpdateSession(running);
      return json({ ok: true, session: running, restarting: true });
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
