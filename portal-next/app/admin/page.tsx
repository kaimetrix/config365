import { requireAdmin } from '@/lib/server/page-utils';
import { listMsps, listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import AdminMspManager from './MspManager';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const { sidebarProps } = await requireAdmin();
  const msps    = await listMsps();
  const tenants = await listTenants();

  return (
    <AppShell title="MSPs & Tenants" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>MSPs &amp; Tenants</h1>
          <p>{msps.length} MSP{msps.length !== 1 ? 's' : ''} · {tenants.length} tenant{tenants.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
      <AdminMspManager msps={msps} tenants={tenants} />
    </AppShell>
  );
}
