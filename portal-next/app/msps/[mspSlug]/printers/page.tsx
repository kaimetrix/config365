import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import PrintersClient from './PrintersClient';

export const dynamic = 'force-dynamic';

export default async function PrintersPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="Printers" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Intune Printers</h1>
          <p>Deploy network printers as Win32 apps with group assignments for {msp.displayName}</p>
        </div>
      </div>
      <PrintersClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
