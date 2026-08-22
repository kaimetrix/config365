import { NextResponse } from 'next/server';
import {
  syncScriptsToGitea,
  getScriptsSyncStatus,
} from '@/lib/server/platform-bootstrap';

/**
 * GET /api/health/sync-status
 *
 * Unauthenticated endpoint used by portal-warmup.sh and runner-start.sh
 * to block until the scripts-sync has completed after a Docker image deploy.
 *
 * On the first call it triggers syncScriptsToGitea() (fire-and-forget) so
 * callers don't need a separate "kick" request.
 *
 * Response: { synced: boolean, inProgress: boolean }
 *   synced=true  → sync has run and finished at least once (safe to start runner)
 *   inProgress   → sync is actively running right now
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const before = getScriptsSyncStatus();

  // Trigger sync if it hasn't started or completed yet.
  if (!before.done && !before.inProgress) {
    syncScriptsToGitea().catch(() => {});
  }

  const status = getScriptsSyncStatus();
  return NextResponse.json({ synced: status.done, inProgress: status.inProgress });
}
