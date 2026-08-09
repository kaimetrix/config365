'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { notifyDashboardBurstRefresh } from '@/lib/dashboard-refresh';

interface Tenant { slug: string; displayName: string }

interface Props {
  mspSlug: string;
  tenants: Tenant[];
}

const ALL_DEPLOY_OPTIONS = [
  'allowCreate', 'allowUpdate', 'allowDelete',
  'deployCustomAttributes', 'deployGroups', 'deployEntraIdDeviceSettings', 'deployDefenderConnector',
  'deployConditionalAccess', 'deployTeams', 'deploySharePoint',
  'deployExchange', 'deployIntune', 'deployEnterpriseApps',
  'deployAuthenticationPolicies', 'deployEntraIdConsentpermissions',
  'deploySharePointSettings',   'deployAppsChocolatey', 'deployAppsWinget',
  'deployAppsCustom', 'deployAppsPrinter',
].join(',');

const ALL_MAINT_TASKS = [
  'groupSplits', 'exchangeFonts', 'exchangeGal',
  'intuneDeviceRename', 'intunePrimaryUser', 'entraDeviceCleanup', 'baselineApplyCleanup',
].join(',');

const WORKFLOW_INPUTS: Record<string, Record<string, string>> = {
  'deploy.yml':      { deploy_options: ALL_DEPLOY_OPTIONS },
  'maintenance.yml': { maintenance_tasks: ALL_MAINT_TASKS },
  'backup.yml':      {},
};

function ActionButtonLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <>
      {busy && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </span>
      )}
      <span style={{ visibility: busy ? 'hidden' : 'visible' }}>{children}</span>
    </>
  );
}

function refreshDashboard(router: ReturnType<typeof useRouter>) {
  notifyDashboardBurstRefresh();
  router.refresh();
}

export default function DashboardClient({ mspSlug, tenants }: Props) {
  const router  = useRouter();
  const [busy, setBusy]   = useState<string | null>(null);
  const [error, setError] = useState('');
  const [done, setDone]   = useState('');

  async function bulkTrigger(workflow: string) {
    if (busy) return;
    setBusy(workflow); setError(''); setDone('');
    const inputs = WORKFLOW_INPUTS[workflow] ?? {};
    const failures: string[] = [];
    await Promise.all(tenants.map(async (t) => {
      try {
        const res = await fetch('/api/pipelines/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: t.slug, workflow, inputs }),
        });
        if (!res.ok) failures.push(t.displayName);
      } catch { failures.push(t.displayName); }
    }));
    setBusy(null);
    if (failures.length) {
      setError(`Failed for: ${failures.join(', ')}`);
    } else {
      const label = workflow === 'deploy.yml' ? 'Deploy' : workflow === 'backup.yml' ? 'Backup' : 'Maintenance';
      setDone(`${label} triggered for all ${tenants.length} tenant(s).`);
      refreshDashboard(router);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {error && <span style={{ color: '#fca5a5', fontSize: '0.78rem' }}>{error}</span>}
      {done  && <span style={{ color: '#86efac', fontSize: '0.78rem' }}>{done}</span>}

      {tenants.length > 1 && (
        <>
          {[
            { label: '▶ Deploy All',   wf: 'deploy.yml' },
            { label: '↑ Backup All',   wf: 'backup.yml' },
            { label: '⚙ Maint All',    wf: 'maintenance.yml' },
          ].map(({ label, wf }) => (
            <button
              key={wf}
              disabled={!!busy}
              onClick={() => bulkTrigger(wf)}
              style={{
                position: 'relative',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 12px', fontSize: '0.78rem', fontWeight: 600,
                background: busy === wf ? 'rgba(34,197,94,0.1)' : '#18181b',
                border: '1px solid ' + (busy === wf ? '#22c55e' : '#27272a'),
                color: busy === wf ? '#22c55e' : '#a1a1aa',
                borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy && busy !== wf ? 0.5 : 1, fontFamily: 'inherit',
              }}
            >
              <ActionButtonLabel busy={busy === wf}>{label}</ActionButtonLabel>
            </button>
          ))}
        </>
      )}

      <button
        onClick={() => {
          setBusy('refresh');
          refreshDashboard(router);
          window.dispatchEvent(new CustomEvent('dashboard-refresh'));
          setTimeout(() => setBusy(null), 1500);
        }}
        disabled={!!busy}
        style={{
          position: 'relative',
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '6px 12px', fontSize: '0.78rem', fontWeight: 500,
          background: '#18181b', border: '1px solid #27272a', color: '#71717a',
          borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        }}
      >
        <ActionButtonLabel busy={busy === 'refresh'}>↻ Refresh</ActionButtonLabel>
      </button>

      <a href={`/admin/tenants/new?mspId=${mspSlug}`} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 14px', fontSize: '0.78rem', fontWeight: 600,
        background: '#22c55e', color: '#000', borderRadius: 6, textDecoration: 'none',
      }}>
        + Add Tenant
      </a>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
