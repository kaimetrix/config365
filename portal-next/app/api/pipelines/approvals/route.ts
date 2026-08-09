import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { listTenants, recordRejectedRun } from '@/lib/server/tenant-store';
import { getToken, getBaseUrl, cancelWorkflowRun } from '@/lib/server/gitea';
import { requireMspAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

interface GiteaIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  created_at: string;
  html_url: string;
  labels: { name: string }[];
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

// ─── GET /api/pipelines/approvals?mspSlug=X ──────────────────────────────────
// Returns all open deployment-approval issues across all tenant repos for an MSP.
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

  const results = await Promise.allSettled(
    tenants.map(async (tenant): Promise<ApprovalItem[]> => {
      const repo = `${msp.giteaOrg}/tenant-${tenant.slug}`;
      const url  = `${base}/api/v1/repos/${repo}/issues?type=issues&state=open&labels=deployment-approval&limit=5`;
      const res  = await fetch(url, {
        headers: { Authorization: `token ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) return [];
      const issues: GiteaIssue[] = await res.json() as GiteaIssue[];

      // For each open approval issue, verify the associated run is still waiting.
      // If the run has failed/completed/cancelled, auto-close the issue so the banner disappears.
      const live: ApprovalItem[] = [];
      await Promise.allSettled(issues.map(async (issue) => {
        const match = (issue.body ?? '').match(/<!--\s*run-id:\s*(\d+)\s*-->/);
        if (match) {
          const runId  = match[1];
          const runRes = await fetch(`${base}/api/v1/repos/${repo}/actions/runs/${runId}`, {
            headers: { Authorization: `token ${token}` },
            cache: 'no-store',
          });
          if (runRes.ok) {
            const run = await runRes.json() as { status?: string; conclusion?: string };
            const s   = run.status ?? '';
            const c   = run.conclusion ?? '';
            const isActive = s === 'in_progress' || s === 'running' || s === 'waiting' || s === 'queued'
              || (s === 'in_progress' && !c);
            const isOver   = s === 'completed' || s === 'cancelled' || s === 'failure' || s === 'success'
              || (!isActive && s !== '');
            if (isOver) {
              // Best-effort close — run failed or completed without going through approval
              fetch(`${base}/api/v1/repos/${repo}/issues/${issue.number}`, {
                method:  'PATCH',
                headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ state: 'closed' }),
              }).catch(() => {});
              return; // exclude from live list
            }
          }
        }
        live.push({
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
      return live;
    }),
  );

  const approvals: ApprovalItem[] = results
    .filter((r): r is PromiseFulfilledResult<ApprovalItem[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  return json({ approvals });
}

// ─── POST /api/pipelines/approve or /api/pipelines/reject ────────────────────
// Body: { mspSlug, tenantSlug, issueNumber, action: 'approve' | 'reject' }
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const body = await request.json() as {
    mspSlug:     string;
    tenantSlug:  string;
    issueNumber: number;
    action:      'approve' | 'reject';
  };

  const { mspSlug, tenantSlug, issueNumber, action } = body;
  if (!mspSlug || !tenantSlug || !issueNumber || !action) {
    return json({ error: 'mspSlug, tenantSlug, issueNumber and action are required' }, 400);
  }

  const mspOrResponse = await requireMspAccess(session.user, mspSlug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  const token   = getToken();
  const base    = getBaseUrl();
  const repo    = `${msp.giteaOrg}/tenant-${tenantSlug}`;
  const comment = action === 'approve' ? 'approved' : 'denied';

  try {
    // 1. Post the comment so the polling step can also detect it
    const res = await fetch(`${base}/api/v1/repos/${repo}/issues/${issueNumber}/comments`, {
      method:  'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ body: comment }),
    });
    if (!res.ok) {
      const err = await res.text();
      return json({ error: `Gitea API error: ${err}` }, 500);
    }

    // 2. For rejections, cancel the workflow run and close the issue immediately
    //    so we don't wait for the 30-second poll cycle.
    //    The run ID is embedded in the issue body as <!-- run-id: N -->.
    if (action === 'reject') {
      const issueRes = await fetch(`${base}/api/v1/repos/${repo}/issues/${issueNumber}`, {
        headers: { Authorization: `token ${token}` },
      });
      if (issueRes.ok) {
        const issue = await issueRes.json() as { body?: string };

        // Record the rejection so the dashboard shows it as 'cancelled' not 'failed',
        // then cancel the workflow run (best-effort — cancel API may not be available).
        const match = (issue.body ?? '').match(/<!--\s*run-id:\s*(\d+)\s*-->/);
        if (match) {
          const runId = parseInt(match[1], 10);
          recordRejectedRun(runId);
          const [org, repoName] = repo.split('/');
          cancelWorkflowRun(org, repoName, runId).catch(() => {});
        }
      }

      // Close the issue so it disappears from the approval list immediately
      fetch(`${base}/api/v1/repos/${repo}/issues/${issueNumber}`, {
        method:  'PATCH',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ state: 'closed' }),
      }).catch(() => {});
    }

    return json({ ok: true, action, issueNumber });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : 'Failed to post comment' }, 500);
  }
}
