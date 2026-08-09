import { requireMspContext } from '@/lib/server/page-utils';
import { listTenants } from '@/lib/server/tenant-store';
import { getFile } from '@/lib/server/gitea';
import { getSecureScoreHistory, aggregateSecureScoreHistory, type SecureScoreHistoryPoint } from '@/lib/server/secure-score-history';
import AppShell from '@/components/layout/AppShell';
import SecureScoreDashboardClient from './SecureScoreDashboardClient';

export type { SecureScoreHistoryPoint };

export const dynamic = 'force-dynamic';

export interface TenantScoreRow {
  slug: string;
  displayName: string;
  currentScore: number | null;
  maxScore: number | null;
  pct: number | null;
  backedUpAt: string | null;
  /** 'ok' | 'error' (licence/403) | 'notBacked' */
  status: 'ok' | 'error' | 'notBacked';
  errorDetail: string | null;
  history: SecureScoreHistoryPoint[];
}

export interface CrossTenantControl {
  tenantSlug: string;
  tenantName: string;
  tenantMaxScore: number | null;  // tenant's overall maxScore for score impact %
  id: string;
  title: string;
  controlCategory: string;
  service: string;
  maxScore: number;
  currentScore: number | null;
  computedStatus?: string;
  statusDescription?: string | null;
  controlStateUpdates?: Array<{ state: string; updatedDateTime?: string | null }> | null;
  implementationStatus?: string | null;
  actionType: string;
  actionUrl: string | null;
  tier: string;
  userImpact: string;
  implementationCost: string;
  threats: string[];
  remediation: string | null;
  remediationImpact: string | null;
  rank: number;
}

export default async function SecureScoreDashboard({
  params,
}: {
  params: Promise<{ mspSlug: string }>;
}) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);

  const tenants = await listTenants(msp.id);

  const tenantData = await Promise.all(
    tenants.map(async (t) => {
      const org  = t.giteaOrg;
      const repo = `tenant-${t.slug}`;
      try {
        const [errorFile, scoreFile, controlsFile, historyResult] = await Promise.all([
          getFile(org, repo, 'backups/secure-score/error.json').catch(() => ({ exists: false, content: '' })),
          getFile(org, repo, 'backups/secure-score/score.json').catch(() => ({ exists: false, content: '' })),
          getFile(org, repo, 'backups/secure-score/controls.json').catch(() => ({ exists: false, content: '' })),
          getSecureScoreHistory(org, repo, 30).catch(() => ({ points: [], availableDates: [] })),
        ]);
        return { t, errorFile, scoreFile, controlsFile, history: historyResult.points };
      } catch {
        return { t, errorFile: { exists: false, content: '' }, scoreFile: { exists: false, content: '' }, controlsFile: { exists: false, content: '' }, history: [] as SecureScoreHistoryPoint[] };
      }
    }),
  );

  const rows: TenantScoreRow[] = [];
  const allControls: CrossTenantControl[] = [];
  const okHistories: SecureScoreHistoryPoint[][] = [];

  for (const { t, errorFile, scoreFile, controlsFile, history } of tenantData) {
    let tenantMaxScore: number | null = null;

    const hasBackupData = scoreFile.exists || controlsFile.exists;

    if (errorFile.exists && !hasBackupData) {
      let detail = 'Permission error (SecurityEvents.Read.All required)';
      try { const e = JSON.parse(errorFile.content) as { detail?: string }; detail = e.detail ?? detail; } catch { /* ignore */ }
      rows.push({ slug: t.slug, displayName: t.displayName, currentScore: null, maxScore: null, pct: null, backedUpAt: null, status: 'error', errorDetail: detail, history: [] });
      continue;
    }

    if (!scoreFile.exists) {
      rows.push({ slug: t.slug, displayName: t.displayName, currentScore: null, maxScore: null, pct: null, backedUpAt: null, status: 'notBacked', errorDetail: null, history: [] });
      continue;
    }

    try {
      const s = JSON.parse(scoreFile.content) as { currentScore?: number; maxScore?: number; backedUpAt?: string };
      const currentScore = typeof s.currentScore === 'number' ? s.currentScore : null;
      const maxScore     = typeof s.maxScore     === 'number' ? s.maxScore     : null;
      tenantMaxScore = maxScore;
      const pct = currentScore !== null && maxScore !== null && maxScore > 0
        ? (currentScore / maxScore) * 100 : null;
      rows.push({ slug: t.slug, displayName: t.displayName, currentScore, maxScore, pct, backedUpAt: s.backedUpAt ?? null, status: 'ok', errorDetail: null, history });
      if (history.length > 0) okHistories.push(history);
    } catch {
      rows.push({ slug: t.slug, displayName: t.displayName, currentScore: null, maxScore: null, pct: null, backedUpAt: null, status: 'notBacked', errorDetail: null, history: [] });
      continue;
    }

    if (controlsFile.exists) {
      try {
        const cf = JSON.parse(controlsFile.content) as { controls?: CrossTenantControl[] };
        if (cf.controls) {
          for (const c of cf.controls) {
            allControls.push({ ...c, tenantSlug: t.slug, tenantName: t.displayName, tenantMaxScore });
          }
        }
      } catch { /* malformed controls — skip */ }
    }
  }

  const aggregateHistory = aggregateSecureScoreHistory(okHistories);

  return (
    <AppShell title="Secure Score" {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Secure Score</h1>
          <p>{msp.displayName} — all tenants</p>
        </div>
      </div>
      <SecureScoreDashboardClient rows={rows} mspSlug={mspSlug} allControls={allControls} aggregateHistory={aggregateHistory} />
    </AppShell>
  );
}
