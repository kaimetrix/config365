import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import OsVersionClient from './OsVersionClient';

export const dynamic = 'force-dynamic';

export default async function OsVersionsPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="OS Version Control" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>OS Version Control</h1>
          <p>View live OS versions and update compliance policy thresholds in the baseline repo</p>
        </div>
      </div>
      <OsVersionClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
