import { requireAdmin } from '@/lib/server/page-utils';
import { getMspBySlug, getMspGraphClientId } from '@/lib/server/tenant-store';
import { notFound } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import EditMspForm from './EditMspForm';

export const dynamic = 'force-dynamic';

export default async function EditMspPage({ params }: { params: Promise<{ slug: string }> }) {
  const { sidebarProps } = await requireAdmin();
  const { slug } = await params;
  const msp = await getMspBySlug(slug);
  if (!msp) notFound();
  const graphClientId = getMspGraphClientId(msp.slug) ?? '';
  return (
    <AppShell title={`Edit MSP — ${msp.displayName}`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Edit MSP</h1>
          <p>{msp.giteaOrg}</p>
        </div>
        <a href="/admin" className="btn btn-ghost">← Back</a>
      </div>
      <div style={{ maxWidth: 520 }}>
        <div className="card">
          <EditMspForm msp={msp} graphClientId={graphClientId} />
        </div>
      </div>
    </AppShell>
  );
}
