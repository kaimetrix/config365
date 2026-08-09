import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import AppsClient from './AppsClient';

export const dynamic = 'force-dynamic';

export default async function AppsPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="Apps" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Intune Apps</h1>
          <p>Manage Chocolatey, WinGet, and Custom app configurations for {msp.displayName}</p>
        </div>
      </div>
      <AppsClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
