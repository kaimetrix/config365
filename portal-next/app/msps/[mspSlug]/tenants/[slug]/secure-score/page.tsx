import { requireMspContext } from '@/lib/server/page-utils';
import { getTenantBySlug } from '@/lib/server/tenant-store';
import { getFile } from '@/lib/server/gitea';
import { notFound } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import SecureScoreClient from './SecureScoreClient';

export const dynamic = 'force-dynamic';

interface ScoreData {
  currentScore: number;
  maxScore: number;
  activeUserCount: number;
  createdDateTime: string;
  enabledServices: string[];
  backedUpAt: string;
}

interface ControlProfile {
  id: string;
  title: string;
  controlCategory: string;
  service: string;
  maxScore: number;
  currentScore: number | null;
  implementationStatus: string;
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

interface ControlsFile {
  backedUpAt: string;
  count: number;
  controls: ControlProfile[];
}

interface ErrorFile {
  error: string;
  detail: string;
  updatedAt: string;
}

export default async function SecureScorePage({
  params,
}: {
  params: Promise<{ mspSlug: string; slug: string }>;
}) {
  const { mspSlug, slug } = await params;
  const { sidebarProps } = await requireMspContext(mspSlug);

  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.mspId !== mspSlug) notFound();

  const org  = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  // Fetch all three files in parallel — all non-throwing (404 → exists: false)
  const [errorResult, scoreResult, controlsResult] = await Promise.all([
    getFile(org, repo, 'backups/secure-score/error.json').catch(() => ({ exists: false, content: '' })),
    getFile(org, repo, 'backups/secure-score/score.json').catch(() => ({ exists: false, content: '' })),
    getFile(org, repo, 'backups/secure-score/controls.json').catch(() => ({ exists: false, content: '' })),
  ]);

  const hasBackupData = scoreResult.exists || controlsResult.exists;

  // Licence / permission error — only when no successful backup data exists
  if (errorResult.exists && !hasBackupData) {
    let detail = 'SecurityEvents.Read.All permission required for Secure Score.';
    try {
      const err = JSON.parse(errorResult.content) as ErrorFile;
      detail = err.detail ?? detail;
    } catch { /* use default */ }
    return (
      <AppShell title={`Secure Score — ${tenant.displayName}`} {...sidebarProps}>
        <div className="page-header">
          <div className="page-header-text">
            <h1>Secure Score</h1>
            <p>{tenant.displayName}</p>
          </div>
        </div>
        <SecureScoreClient
          tenantName={tenant.displayName}
          mspSlug={mspSlug}
          tenantSlug={slug}
          score={null}
          controls={[]}
          backedUpAt={null}
          licenceWarning={true}
          licenceDetail={detail}
        />
      </AppShell>
    );
  }

  // No backup yet
  if (!scoreResult.exists && !controlsResult.exists) {
    return (
      <AppShell title={`Secure Score — ${tenant.displayName}`} {...sidebarProps}>
        <div className="page-header">
          <div className="page-header-text">
            <h1>Secure Score</h1>
            <p>{tenant.displayName}</p>
          </div>
        </div>
        <SecureScoreClient
          tenantName={tenant.displayName}
          mspSlug={mspSlug}
          tenantSlug={slug}
          score={null}
          controls={[]}
          backedUpAt={null}
          notBacked={true}
        />
      </AppShell>
    );
  }

  let score: ScoreData | null = null;
  let controls: ControlProfile[] = [];
  let backedUpAt: string | null = null;

  if (scoreResult.exists) {
    try {
      score = JSON.parse(scoreResult.content) as ScoreData;
      backedUpAt = score.backedUpAt ?? null;
    } catch { /* malformed */ }
  }

  if (controlsResult.exists) {
    try {
      const cf = JSON.parse(controlsResult.content) as ControlsFile;
      controls = cf.controls ?? [];
      if (!backedUpAt) backedUpAt = cf.backedUpAt ?? null;
    } catch { /* malformed */ }
  }

  return (
    <AppShell title={`Secure Score — ${tenant.displayName}`} {...sidebarProps}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Secure Score</h1>
          <p>{tenant.displayName}</p>
        </div>
      </div>
      <SecureScoreClient
        tenantName={tenant.displayName}
        mspSlug={mspSlug}
        tenantSlug={slug}
        score={score}
        controls={controls}
        backedUpAt={backedUpAt}
      />
    </AppShell>
  );
}
