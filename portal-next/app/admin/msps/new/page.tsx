import { requireAdmin } from '@/lib/server/page-utils';
import AppShell from '@/components/layout/AppShell';
import NewMspForm from './NewMspForm';

export const dynamic = 'force-dynamic';

export default async function NewMspPage() {
  const { sidebarProps } = await requireAdmin();
  return (
    <AppShell title="New MSP" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Create MSP</h1>
          <p>Add a new Managed Service Provider to the platform.</p>
        </div>
        <a href="/admin" className="btn btn-ghost">← Back</a>
      </div>
      <div style={{ maxWidth: 520 }}>
        <div className="card">
          <NewMspForm />
        </div>
      </div>
    </AppShell>
  );
}
