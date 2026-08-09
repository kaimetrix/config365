import { requireMspContext } from '@/lib/server/page-utils';
import AppShell from '@/components/layout/AppShell';
import AdmxClient from './AdmxClient';

export const dynamic = 'force-dynamic';

export default async function AdmxPage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { sidebarProps } = await requireMspContext(mspSlug);

  return (
    <AppShell title="ADMX Files" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>ADMX Files</h1>
          <p>Manage custom ADMX policy templates in the baseline repo</p>
        </div>
      </div>
      <AdmxClient mspSlug={mspSlug} />
    </AppShell>
  );
}
