import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import TimelineClient from './TimelineClient';

export const dynamic = 'force-dynamic';

export default async function TimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ mspSlug: string }>;
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { mspSlug } = await params;
  const { tenant: initialTenant } = await searchParams;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = (await listTenants(msp.id)).map(t => ({
    slug: t.slug,
    displayName: t.displayName,
    giteaOrg: t.giteaOrg,
  }));

  return (
    <AppShell title="Timeline" fullHeight {...sidebarProps}>
      <TimelineClient mspSlug={mspSlug} tenants={tenants} initialTenant={initialTenant} />
    </AppShell>
  );
}
