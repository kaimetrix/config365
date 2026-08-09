import { requireAdmin } from '@/lib/server/page-utils';
import { listMsps, listIamAssignments } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import IamManager from './IamManager';

export const dynamic = 'force-dynamic';

export default async function IamPage() {
  const { sidebarProps } = await requireAdmin();
  const msps        = await listMsps();
  const assignments = await listIamAssignments();

  return (
    <AppShell title="IAM" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Identity &amp; Access Management</h1>
          <p>Platform admins and MSP admin assignments</p>
        </div>
      </div>
      <IamManager msps={msps} assignments={assignments} />
    </AppShell>
  );
}
