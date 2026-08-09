import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import VariablesClient from './VariablesClient';

export const dynamic = 'force-dynamic';

export default async function VariablesPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="Variables" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Variables</h1>
          <p>Create variables and assign values to baseline groups or individual tenants. Use {'{{VAR:Name}}'} in policy files.</p>
        </div>
      </div>
      <VariablesClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
