import { getSession } from '@/lib/server/session';
import { listMsps, isSetupComplete } from '@/lib/server/tenant-store';
import { bootstrapPlatformIfNeeded, syncScriptsToGitea } from '@/lib/server/platform-bootstrap';
import { redirectTo } from '@/lib/server/redirect';

// Always render at request time — setup/session state changes after deployment
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Setup check
  let setupDone = false;
  try { setupDone = isSetupComplete(); } catch { /* DB not ready */ }
  if (!setupDone) redirectTo('/setup');

  const session = await getSession();
  if (!session.user) redirectTo('/login');

  // Fire-and-forget bootstrap
  bootstrapPlatformIfNeeded().catch(() => {});
  syncScriptsToGitea().catch(() => {});

  let msps: Array<{ slug: string }> = [];
  try { msps = await listMsps(); } catch { /* DB not ready */ }

  if (msps.length > 0) redirectTo(`/msps/${msps[0].slug}`);
  redirectTo('/admin');
}
