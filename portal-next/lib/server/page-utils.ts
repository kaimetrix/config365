import 'server-only';
import { getSession, isPlatformAdmin, getMspAdminInfo, type SessionUser } from '@/lib/server/session';
import { listMsps, getMspBySlug, isSetupComplete, type Msp } from '@/lib/server/tenant-store';
import { bootstrapPlatformIfNeeded, bootstrapMspIfNeeded, syncScriptsToGitea } from '@/lib/server/platform-bootstrap';
import { redirectTo } from '@/lib/server/redirect';
import type { SidebarProps } from '@/components/layout/Sidebar';

export interface PageContext {
  user: SessionUser;
  isAdmin: boolean;
  isMspAdmin: boolean;
  userMspSlug: string | null;
  msp?: Msp;
  sidebarProps: SidebarProps;
}

/** Call at the top of every protected Server Component page/layout. */
export async function requireAuth(): Promise<PageContext> {
  // Setup gate
  let setupDone = false;
  try { setupDone = isSetupComplete(); } catch { /* DB not ready */ }
  if (!setupDone) redirectTo('/setup');

  const session = await getSession();
  if (!session.user) redirectTo('/login');

  const user       = session.user!;
  const isAdmin    = isPlatformAdmin(user);
  const mspInfo    = await getMspAdminInfo(user);

  let msps: Array<{ slug: string; displayName: string }> = [];
  try { msps = await listMsps(); } catch { /* DB not ready */ }

  // Fire-and-forget
  bootstrapPlatformIfNeeded().catch(() => {});
  syncScriptsToGitea().catch(() => {});

  const sidebarProps: SidebarProps = {
    msps,
    isAdmin,
    isMspAdmin:      mspInfo.isMspAdmin,
    userMspSlug:     mspInfo.userMspSlug,
    userDisplayName: user.displayName,
    userEmail:       user.email,
  };

  return { user, isAdmin, isMspAdmin: mspInfo.isMspAdmin, userMspSlug: mspInfo.userMspSlug, sidebarProps };
}

/** requireAuth + resolve MSP from slug param. */
export async function requireMspContext(mspSlug: string): Promise<PageContext & { msp: Msp }> {
  const ctx = await requireAuth();

  const msp = await getMspBySlug(mspSlug);
  if (!msp) redirectTo(`/?error=${encodeURIComponent(`MSP "${mspSlug}" not found.`)}`);

  bootstrapMspIfNeeded(msp!).catch(() => {});

  return {
    ...ctx,
    msp: msp!,
    sidebarProps: { ...ctx.sidebarProps, currentMspSlug: mspSlug },
  };
}

/** requireAuth + admin-only check. */
export async function requireAdmin(): Promise<PageContext> {
  const ctx = await requireAuth();
  if (!ctx.isAdmin) {
    if (ctx.isMspAdmin && ctx.userMspSlug) redirectTo(`/msps/${ctx.userMspSlug}`);
    redirectTo('/');
  }
  return ctx;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
