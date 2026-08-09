import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import MaintenanceClient from './MaintenanceClient';

export const dynamic = 'force-dynamic';

export default async function MaintenancePage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="Maintenance" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Maintenance</h1>
          <p>Maintenance window and scheduled tasks configuration</p>
        </div>
      </div>
      <MaintenanceClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
