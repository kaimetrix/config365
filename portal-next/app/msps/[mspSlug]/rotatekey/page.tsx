import { requireMspContext } from '@/lib/server/page-utils';
import { getMspInternalKey } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import RotateKeyClient from './RotateKeyClient';

export const dynamic = 'force-dynamic';

export default async function RotateKeyPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps, isAdmin, isMspAdmin, userMspSlug } = await requireMspContext(mspSlug);

  if (!isAdmin && !(isMspAdmin && userMspSlug === mspSlug)) {
    return (
      <AppShell title="Rotate Key" {...sidebarProps}>
        <div className="empty-state">Access denied.</div>
      </AppShell>
    );
  }

  const hasInternalKey = getMspInternalKey(mspSlug) !== null;

  return (
    <AppShell title={`${msp.displayName} — Rotate Key`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Internal Key</h1>
          <p>{msp.giteaOrg}</p>
        </div>
      </div>
      <RotateKeyClient mspSlug={mspSlug} giteaOrg={msp.giteaOrg} hasInternalKey={hasInternalKey} />
    </AppShell>
  );
}
