import { requireMspContext } from '@/lib/server/page-utils';
import { getTenantBySlug, getDecryptedSetting } from '@/lib/server/tenant-store';
import { notFound } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import EditTenantForm from '@/app/admin/tenants/[slug]/edit/EditTenantForm';
import TenantAuthStatus from '@/app/admin/tenants/[slug]/edit/TenantAuthStatus';

export const dynamic = 'force-dynamic';

export default async function MspTenantEditPage({
  params,
}: {
  params: Promise<{ mspSlug: string; slug: string }>;
}) {
  const { mspSlug, slug } = await params;
  const { sidebarProps } = await requireMspContext(mspSlug);

  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.mspId !== mspSlug) notFound();

  const hasClientSecret = !!getDecryptedSetting(`tenant:${slug}:clientSecret`);
  const backUrl = `/msps/${mspSlug}`;

  return (
    <AppShell title={`Edit Tenant — ${tenant.displayName}`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Edit Tenant</h1>
          <p>{tenant.slug}</p>
        </div>
        <a href={backUrl} className="btn btn-ghost">← Back</a>
      </div>
      <div style={{ maxWidth: 520 }}>
        <div className="card">
          <EditTenantForm tenant={tenant} msps={[]} hasClientSecret={hasClientSecret} backUrl={backUrl} />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <TenantAuthStatus tenantSlug={slug} mspSlug={mspSlug} />
        </div>
      </div>
    </AppShell>
  );
}
