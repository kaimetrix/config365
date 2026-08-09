import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import CaOptionsClient from './CaOptionsClient';

export const dynamic = 'force-dynamic';

export default async function CaPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="CA Options" fullHeight {...sidebarProps}>
      <CaOptionsClient mspSlug={mspSlug} tenants={tenants} />
    </AppShell>
  );
}
