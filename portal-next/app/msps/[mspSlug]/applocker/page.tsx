import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import ApplockerClient from './ApplockerClient';

export const dynamic = 'force-dynamic';

export default async function ApplockerPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="AppLocker" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>AppLocker</h1>
          <p>Baseline rules plus per-tenant additions and exclusions for {msp.displayName}</p>
        </div>
      </div>
      <ApplockerClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
