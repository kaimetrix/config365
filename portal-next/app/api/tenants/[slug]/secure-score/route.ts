/**
 * GET /api/tenants/[slug]/secure-score
 *
 * Returns backed-up Secure Score data for a tenant.
 * Data comes from backups/secure-score/ in the tenant's Gitea repo.
 * No live Graph calls — all data is from the nightly backup.
 *
 * Responses:
 *   200 { score, controls }           — data available
 *   200 { notBacked: true }           — backup hasn't run yet
 *   200 { licenceWarning: true, ... } — 403 during backup (no SecurityEvents.Read.All)
 *   404                               — tenant not found
 *   401                               — unauthenticated
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// ── Types mirroring what Backup-SecureScore.ps1 writes ───────────────────────

export interface SecureScoreControlProfile {
  id: string;
  title: string;
  controlCategory: string;   // Identity | Device | Apps | Data | Infrastructure
  service: string;
  maxScore: number;
  currentScore: number | null;
  implementationStatus: string; // scored | default | ignored | thirdParty | noAction
  actionType: string;
  actionUrl: string | null;
  tier: string;
  userImpact: string;
  implementationCost: string;
  threats: string[];
  remediation: string | null;
  remediationImpact: string | null;
  complianceInformation: unknown[] | null;
  rank: number;
}

export interface SecureScoreData {
  id: string;
  azureTenantId: string;
  activeUserCount: number;
  createdDateTime: string;
  currentScore: number;
  maxScore: number;
  enabledServices: string[];
  averageComparativeScores: unknown[];
  controlScores: unknown[];
  backedUpAt: string;
}

interface ControlsFile {
  backedUpAt: string;
  count: number;
  controls: SecureScoreControlProfile[];
}

interface ErrorFile {
  error: string;
  detail: string;
  updatedAt: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org  = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  const [errorResult, scoreResult, controlsResult] = await Promise.all([
    getFile(org, repo, 'backups/secure-score/error.json'),
    getFile(org, repo, 'backups/secure-score/score.json'),
    getFile(org, repo, 'backups/secure-score/controls.json'),
  ]);

  const hasBackupData = scoreResult.exists || controlsResult.exists;

  if (errorResult.exists && !hasBackupData) {
    try {
      const err = JSON.parse(errorResult.content) as ErrorFile;
      return json({ licenceWarning: true, detail: err.detail, updatedAt: err.updatedAt });
    } catch {
      // malformed error file — fall through
    }
  }

  if (!hasBackupData) {
    return json({ notBacked: true });
  }

  let score: SecureScoreData | null = null;
  let controls: SecureScoreControlProfile[] = [];
  let backedUpAt: string | null = null;

  if (scoreResult.exists) {
    try {
      score = JSON.parse(scoreResult.content) as SecureScoreData;
      backedUpAt = score.backedUpAt ?? null;
    } catch {
      // malformed — return partial
    }
  }

  if (controlsResult.exists) {
    try {
      const cf = JSON.parse(controlsResult.content) as ControlsFile;
      controls = cf.controls ?? [];
      if (!backedUpAt) backedUpAt = cf.backedUpAt ?? null;
    } catch {
      // malformed — return partial
    }
  }

  return json({ score, controls, backedUpAt });
}
