import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import { getWorkflowRuns, getCommits, getFile, tenantRepo, withWorkflowProgress } from '@/lib/server/gitea';
import type { WorkflowRun, GitCommit } from '@/lib/server/gitea';
import AppShell from '@/components/layout/AppShell';
import DashboardClient from './DashboardClient';
import DashboardTable from './DashboardTable';
export const dynamic = 'force-dynamic';

interface TenantRow {
  slug: string;
  displayName: string;
  giteaOrg: string;
  deploy:      WorkflowRun | null;
  backup:      WorkflowRun | null;
  maintenance: WorkflowRun | null;
  latestCommit: GitCommit | null;
  error: string | null;
  lastActivity: string | null;
  secureScore: number | null;
  secureScoreMax: number | null;
}

export default async function MspDashboard({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);

  const tenants = await listTenants(msp.id);

  const rows: TenantRow[] = await Promise.all(
    tenants.map(async (t) => {
      const org  = t.giteaOrg;
      const repo = tenantRepo(t.slug);
      try {
        const [deployRuns, backupRuns, maintRuns, commits, scoreFile] = await Promise.all([
          getWorkflowRuns(org, repo, { workflowId: 'deploy.yml',      limit: 1 }),
          getWorkflowRuns(org, repo, { workflowId: 'backup.yml',      limit: 1 }),
          getWorkflowRuns(org, repo, { workflowId: 'maintenance.yml', limit: 1 }),
          getCommits(org, repo, { limit: 1 }),
          getFile(org, repo, 'backups/secure-score/score.json').catch(() => ({ exists: false, content: '' })),
        ]);
        const [deploy, backup, maintenance] = await Promise.all([
          withWorkflowProgress(org, repo, deployRuns[0] ?? null),
          withWorkflowProgress(org, repo, backupRuns[0] ?? null),
          withWorkflowProgress(org, repo, maintRuns[0] ?? null),
        ]);
        const latestCommit = commits[0]    ?? null;
        const lastActivity =
          latestCommit?.commit.author.date ||
          deploy?.created_at ||
          null;

        let secureScore: number | null = null;
        let secureScoreMax: number | null = null;
        if (scoreFile.exists) {
          try {
            const s = JSON.parse(scoreFile.content) as { currentScore?: number; maxScore?: number };
            secureScore    = typeof s.currentScore === 'number' ? Math.round(s.currentScore) : null;
            secureScoreMax = typeof s.maxScore     === 'number' ? Math.round(s.maxScore)     : null;
          } catch { /* malformed — leave null */ }
        }

        return {
          slug: t.slug, displayName: t.displayName, giteaOrg: org,
          deploy, backup, maintenance, latestCommit, error: null, lastActivity,
          secureScore, secureScoreMax,
        };
      } catch (err: unknown) {
        const msg = (err as Error).message ?? '';
        return {
          slug: t.slug, displayName: t.displayName, giteaOrg: org,
          deploy: null, backup: null, maintenance: null, latestCommit: null,
          error: msg.includes('404') ? 'repo not found' : msg.slice(0, 80),
          lastActivity: null,
          secureScore: null, secureScoreMax: null,
        };
      }
    })
  );

  const totalTenants    = rows.length;
  const activePipelines = rows.filter(r =>
    [r.deploy, r.backup, r.maintenance].some(w => w?.status === 'running' || w?.status === 'waiting')
  ).length;
  const issues = rows.filter(r =>
    [r.deploy, r.backup, r.maintenance].some(w => w?.status === 'failure')
  ).length;
  // pendingApprovals loaded client-side via ApprovalsSection

  return (
    <AppShell title={`${msp.displayName} Dashboard`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>{msp.displayName}</h1>
          <p>Gitea org: <code>{msp.giteaOrg}</code></p>
        </div>
        <DashboardClient
          mspSlug={mspSlug}
          tenants={tenants.map(t => ({ slug: t.slug, displayName: t.displayName }))}
        />
      </div>

      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-val">{totalTenants}</div>
          <div className="stat-label">Tenants</div>
        </div>
        <div className="stat-card">
          <div className="stat-val" style={{ color: activePipelines > 0 ? 'var(--info-fg)' : undefined }}>
            {activePipelines}
          </div>
          <div className="stat-label">Active pipelines</div>
        </div>
        <div className="stat-card">
          <div className="stat-val" style={{ color: issues > 0 ? 'var(--danger-fg)' : undefined }}>
            {issues}
          </div>
          <div className="stat-label">Issues</div>
        </div>
      </div>

      {/* Tenant table — approval sub-rows rendered inline below each tenant */}
      {rows.length === 0 ? (
        <div className="card empty-state">
          <p>No tenants yet.</p>
          <a href={`/admin/tenants/new?mspId=${msp.id}`} className="btn" style={{ marginTop: 12, display: 'inline-flex' }}>
            Add first tenant
          </a>
        </div>
      ) : (
        <DashboardTable rows={rows} mspSlug={mspSlug} mspOrg={msp.giteaOrg} mspId={msp.id} />
      )}
    </AppShell>
  );
}
