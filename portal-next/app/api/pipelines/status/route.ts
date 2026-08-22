import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { listTenants } from '@/lib/server/tenant-store';
import { getToken, getBaseUrl, getWorkflowRuns, getWorkflowRun, withWorkflowProgress, type WorkflowRun } from '@/lib/server/gitea';
import { requireMspAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

interface ApprovalItem {
  tenantSlug:  string;
  tenantName:  string;
  mspSlug:     string;
  issueNumber: number;
  title:       string;
  body:        string;
  createdAt:   string;
  issueUrl:    string;
}

interface GiteaIssue {
  number:     number;
  title:      string;
  body:       string;
  state:      string;
  created_at: string;
  html_url:   string;
}

/**
 * GET /api/pipelines/status?mspSlug=X
 *
 * Returns the latest run for each of deploy/backup/maintenance across all
 * tenants in a single server-side aggregation, together with open approval
 * issues that still have an active associated run.
 *
 * Response:
 * {
 *   runs: { [tenantSlug]: { deploy, backup, maintenance } },
 *   approvals: ApprovalItem[]
 * }
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug = request.nextUrl.searchParams.get('mspSlug');
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);

  const mspOrResponse = await requireMspAccess(session.user, mspSlug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  const tenants = await listTenants(msp.id);
  const token   = getToken();
  const base    = getBaseUrl();

  const tenantResults = await Promise.allSettled(
    tenants.map(async (tenant) => {
      const org  = msp.giteaOrg;
      const repo = `tenant-${tenant.slug}`;

      // Fetch runs and open approval issues in parallel
      const [deployRuns, backupRuns, maintRuns, issuesRes] = await Promise.all([
        getWorkflowRuns(org, repo, { workflowId: 'deploy.yml',      limit: 1 }).catch((): WorkflowRun[] => []),
        getWorkflowRuns(org, repo, { workflowId: 'backup.yml',      limit: 1 }).catch((): WorkflowRun[] => []),
        getWorkflowRuns(org, repo, { workflowId: 'maintenance.yml', limit: 1 }).catch((): WorkflowRun[] => []),
        fetch(
          `${base}/api/v1/repos/${org}/${repo}/issues?type=issues&state=open&labels=deployment-approval&limit=5`,
          { headers: { Authorization: `token ${token}` }, cache: 'no-store' }
        ).then(r => r.ok ? r.json() as Promise<GiteaIssue[]> : Promise.resolve([])).catch((): GiteaIssue[] => []),
      ]);

      // Validate each approval issue's run is still active
      const liveApprovals: ApprovalItem[] = [];
      await Promise.allSettled((issuesRes as GiteaIssue[]).map(async (issue) => {
        const match = (issue.body ?? '').match(/<!--\s*run-id:\s*(\d+)\s*-->/);
        if (match) {
          const runId  = match[1];
          const run = await getWorkflowRun(org, repo, parseInt(runId, 10)).catch(() => null);
          if (run) {
            const s   = run.status;
            const isActive = s === 'waiting' || s === 'running' || s === 'blocked';
            if (!isActive) {
              // Auto-close stale approval issue (best-effort)
              fetch(`${base}/api/v1/repos/${org}/${repo}/issues/${issue.number}`, {
                method:  'PATCH',
                headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ state: 'closed' }),
              }).catch(() => {});
              return;
            }
          }
        }
        liveApprovals.push({
          tenantSlug:  tenant.slug,
          tenantName:  tenant.displayName,
          mspSlug,
          issueNumber: issue.number,
          title:       issue.title,
          body:        issue.body,
          createdAt:   issue.created_at,
          issueUrl:    issue.html_url,
        });
      }));

      const [deploy, backup, maintenance] = await Promise.all([
        withWorkflowProgress(org, repo, deployRuns[0] ?? null),
        withWorkflowProgress(org, repo, backupRuns[0] ?? null),
        withWorkflowProgress(org, repo, maintRuns[0] ?? null),
      ]);

      return {
        slug:      tenant.slug,
        runs: { deploy, backup, maintenance },
        approvals: liveApprovals,
      };
    }),
  );

  const runs: Record<string, { deploy: WorkflowRun | null; backup: WorkflowRun | null; maintenance: WorkflowRun | null }> = {};
  const approvals: ApprovalItem[] = [];

  for (const result of tenantResults) {
    if (result.status !== 'fulfilled') continue;
    const { slug, runs: tenantRuns, approvals: tenantApprovals } = result.value;
    runs[slug] = tenantRuns;
    approvals.push(...tenantApprovals);
  }

  return json({ runs, approvals });
}
