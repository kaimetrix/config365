import { requireAdmin } from '@/lib/server/page-utils';
import { getTenantBySlug, listMsps, getDecryptedSetting } from '@/lib/server/tenant-store';
import { notFound } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import EditTenantForm from './EditTenantForm';
import TenantAuthStatus from './TenantAuthStatus';

export const dynamic = 'force-dynamic';

export default async function EditTenantPage({ params }: { params: Promise<{ slug: string }> }) {
  const { sidebarProps } = await requireAdmin();
  const { slug } = await params;
  const tenant = await getTenantBySlug(slug);
  if (!tenant) notFound();
  const msps = await listMsps();
  const hasClientSecret = !!getDecryptedSetting(`tenant:${slug}:clientSecret`);
  return (
    <AppShell title={`Edit Tenant — ${tenant.displayName}`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Edit Tenant</h1>
          <p>{tenant.slug}</p>
        </div>
        <a href="/admin" className="btn btn-ghost">← Back</a>
      </div>
      <div style={{ maxWidth: 520 }}>
        <div className="card">
          <EditTenantForm tenant={tenant} msps={msps} hasClientSecret={hasClientSecret} />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <TenantAuthStatus tenantSlug={slug} mspSlug={tenant.mspId} />
        </div>
      </div>
    </AppShell>
  );
}
