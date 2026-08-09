import { requireAdmin } from '@/lib/server/page-utils';
import { defaultOrg, orgExists, repoExists, getGiteaAdminUser } from '@/lib/server/gitea';
import AppShell from '@/components/layout/AppShell';
import PlatformStatus from './PlatformStatus';
import UpdateWizard from './UpdateWizard';
import UpdateChannelSettings from './UpdateChannelSettings';
import { existsSync, readFileSync } from 'fs';

export const dynamic = 'force-dynamic';

// Runners live under the sharded layout (/data/runner-shards/{1..N}/.runner) —
// setup-runner-shards.sh actively deletes the old single-runner marker
// (/data/runner/.runner) when migrating, so checking that legacy path always
// reports "not registered" post-migration even when every shard is healthy.
function countRegisteredRunnerShards(): { registered: number; total: number } {
  let total = 4;
  try {
    const raw = readFileSync('/data/init-data/runner-shards.txt', 'utf-8').trim();
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) total = parsed;
  } catch {
    /* file not written yet — assume default shard count */
  }
  let registered = 0;
  for (let i = 1; i <= total; i++) {
    if (existsSync(`/data/runner-shards/${i}/.runner`)) registered++;
  }
  return { registered, total };
}

export default async function PlatformPage() {
  const { sidebarProps } = await requireAdmin();
  const platformOrg = defaultOrg();
  const isAio       = process.env.NODE_ENV === 'production';
  // In production (AIO), Gitea is proxied under /gitea/ via Caddy — use that path.
  // In development, fall back to the direct internal URL.
  const baseUrl     = isAio ? '/gitea/' : (process.env.GITEA_BASE_URL ?? process.env.GITEA_INTERNAL_URL ?? 'http://localhost:3000');
  const adminUser   = getGiteaAdminUser();

  const [orgReady, hasOrchestrator] = await Promise.all([
    orgExists(platformOrg).catch(() => false),
    repoExists(platformOrg, 'orchestrator').catch(() => false),
  ]);

  const runnerShardStatus = isAio ? countRegisteredRunnerShards() : { registered: 0, total: 0 };
  const aioRunnerRegistered = runnerShardStatus.registered > 0 && runnerShardStatus.registered === runnerShardStatus.total;

  return (
    <AppShell title="Platform" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Platform</h1>
          <p>Gitea org <code>{platformOrg}</code> — runners, settings &amp; administration</p>
        </div>
        <a href={baseUrl} target="_blank" rel="noopener" className="btn btn-ghost">
          Open Gitea ↗
        </a>
      </div>

      {/* Quick-status cards */}
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-val" style={{ fontSize: '1.1rem', color: orgReady ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
            {orgReady ? '✓' : '✗'}
          </div>
          <div className="stat-label">Org: {platformOrg}</div>
        </div>
        <div className="stat-card">
          <div className="stat-val" style={{ fontSize: '1.1rem', color: hasOrchestrator ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
            {hasOrchestrator ? '✓' : '✗'}
          </div>
          <div className="stat-label">Orchestrator repo</div>
        </div>
        {isAio && (
          <div className="stat-card">
            <div className="stat-val" style={{ fontSize: '1.1rem', color: aioRunnerRegistered ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
              {aioRunnerRegistered ? '✓' : '✗'}
            </div>
            <div className="stat-label">
              Runners registered ({runnerShardStatus.registered}/{runnerShardStatus.total})
            </div>
          </div>
        )}
      </div>

      <UpdateChannelSettings />
      <UpdateWizard />

      {/* Main admin panels */}
      <PlatformStatus
        org={platformOrg}
        adminUser={adminUser}
        baseUrl={baseUrl}
        isAio={isAio}
      />
    </AppShell>
  );
}
