import { requireMspContext } from '@/lib/server/page-utils';
import AppShell from '@/components/layout/AppShell';
import ViewerClient from './ViewerClient';
import { listTenants } from '@/lib/server/tenant-store';

export const dynamic = 'force-dynamic';

export default async function ViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ mspSlug: string }>;
  searchParams: Promise<{ tenant?: string; scope?: string }>;
}) {
  const { mspSlug } = await params;
  const { tenant: tenantSlug, scope = 'tenant' } = await searchParams;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="Policy Viewer" fullHeight {...sidebarProps}>
      <ViewerClient
        mspSlug={mspSlug}
        tenants={tenants}
        initialTenantSlug={tenantSlug}
        initialScope={scope}
      />
    </AppShell>
  );
}
