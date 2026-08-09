import { requireMspContext } from '@/lib/server/page-utils';
import AppShell from '@/components/layout/AppShell';
import GroupsClient from './GroupsClient';

export const dynamic = 'force-dynamic';

export default async function GroupsPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { sidebarProps } = await requireMspContext(mspSlug);

  return (
    <AppShell title="Groups" fullHeight {...sidebarProps}>
      <GroupsClient mspSlug={mspSlug} />
    </AppShell>
  );
}
