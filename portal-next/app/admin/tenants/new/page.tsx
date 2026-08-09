import { requireAdmin } from '@/lib/server/page-utils';
import { listMsps } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import NewTenantForm from './NewTenantForm';

export const dynamic = 'force-dynamic';

export default async function NewTenantPage({ searchParams }: { searchParams: Promise<{ mspId?: string }> }) {
  const { sidebarProps } = await requireAdmin();
  const { mspId } = await searchParams;
  const msps = await listMsps();
  return (
    <AppShell title="New Tenant" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Add Tenant</h1>
          <p>Register a new tenant under an MSP.</p>
        </div>
        <a href="/admin" className="btn btn-ghost">← Back</a>
      </div>
      <div style={{ maxWidth: 560 }}>
        <div className="card">
          <NewTenantForm msps={msps} defaultMspId={mspId} />
        </div>
      </div>
    </AppShell>
  );
}
