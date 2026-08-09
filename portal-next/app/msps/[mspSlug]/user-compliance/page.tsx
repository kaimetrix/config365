import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import UserComplianceClient from './UserComplianceClient';

export const dynamic = 'force-dynamic';

export default async function UserCompliancePage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  return (
    <AppShell title="User Compliance" {...sidebarProps}>
      <div style={{ padding: '24px 28px 0' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#f4f4f5', margin: 0 }}>User Compliance</h1>
        <p style={{ fontSize: '0.8125rem', color: '#71717a', margin: '4px 0 0' }}>
          Sign-in activity from non-compliant, unmanaged, and personal devices — sourced from nightly backup
        </p>
      </div>
      <UserComplianceClient mspSlug={mspSlug} tenants={tenants.map(t => ({ slug: t.slug, displayName: t.displayName ?? t.slug }))} />
    </AppShell>
  );
}
