import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile, getGitTree } from '@/lib/server/gitea';
import { getTenantBySlug, getMspBySlug } from '@/lib/server/tenant-store';
import { normalizeForCompare } from '@/lib/normalize-for-compare';
import {
  AUDIT_STATUS_PATH,
  ORG_AUDIT_DISABLED_PATH,
  REMEDIATION_PATH,
  computeMailboxAuditDrift,
  isOrgAuditRemediationEnabled,
  parseJsonContent,
} from '@/lib/mailbox-audit-drift';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const CONCURRENCY = 20;

function isPlatformScriptPath(filePath: string): boolean {
  return /^intune\/platform-scripts-(powershell|bash)\//.test(filePath);
}

function platformScriptSiblingPath(filePath: string): string {
  const ext = filePath.includes('-bash/') ? '.sh' : '.ps1';
  return filePath.replace(/\.json$/i, ext);
}

/**
 * GET /api/git/diff-status?mspSlug=...&slug=...
 *
 * Returns a map of { [path]: boolean } where true = file differs from baseline.
 * Only includes files that exist in both the baseline repo and the tenant backup repo.
 * Comparison is normalized (sorted keys, no monitor-sidecar filtering — that is
 * applied per-file when the user opens a file in the viewer).
 *
 * Identical git blob SHAs short-circuit content fetches. Only paths with differing
 * SHAs (or platform-script JSON that still needs sibling script checks) download bodies.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  const p = request.nextUrl.searchParams;
  const mspSlug = p.get('mspSlug');
  const slug    = p.get('slug');

  if (!mspSlug || !slug) return json({ error: 'mspSlug and slug are required' }, 400);

  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return json({ error: 'Tenant not found' }, 404);

  const baselineOrg = msp.giteaOrg;
  const tenantOrg   = tenant.giteaOrg;
  const tenantRepo  = `tenant-${slug}`;

  // Fetch both full git trees in parallel (two requests total, server-to-server)
  const [baselineTree, tenantTree] = await Promise.all([
    getGitTree(baselineOrg, 'baseline'),
    getGitTree(tenantOrg, tenantRepo),
  ]);

  // Baseline policy files live under the baseline/ subdirectory in the repo.
  // Strip that prefix to get the canonical comparison key (e.g. authentication-policies/foo.json).
  // Exclude .gitkeep placeholders and the baseline-remove/ tree (those are removal manifests, not policies).
  const BASELINE_PREFIX = 'baseline/';
  const TENANT_PREFIX = 'backups/';

  const baselineShaByPath = new Map<string, string>();
  for (const e of baselineTree) {
    if (!e.path.startsWith(BASELINE_PREFIX)) continue;
    baselineShaByPath.set(e.path.slice(BASELINE_PREFIX.length), e.sha);
  }

  const tenantShaByPath = new Map<string, string>();
  for (const e of tenantTree) {
    if (!e.path.startsWith(TENANT_PREFIX)) continue;
    tenantShaByPath.set(e.path.slice(TENANT_PREFIX.length), e.sha);
  }

  const baselinePaths = new Set(
    [...baselineShaByPath.keys()].filter(p => p.endsWith('.json') && !p.endsWith('.gitkeep')),
  );
  const tenantBackupPaths = new Set(
    [...tenantShaByPath.keys()].filter(p => p.endsWith('.json')),
  );

  // Only compare files present in both repos
  const sharedPaths = [...baselinePaths].filter(p => tenantBackupPaths.has(p));

  const results: Record<string, boolean> = {};

  // SHA-identical blobs are byte-identical — no content download needed.
  // Platform-script JSON still needs a sibling script check when the JSON matches.
  const needsContentCompare: string[] = [];
  for (const filePath of sharedPaths) {
    const blSha = baselineShaByPath.get(filePath);
    const tnSha = tenantShaByPath.get(filePath);
    if (blSha && tnSha && blSha === tnSha) {
      if (isPlatformScriptPath(filePath)) {
        const scriptPath = platformScriptSiblingPath(filePath);
        const blScriptSha = baselineShaByPath.get(scriptPath);
        const tnScriptSha = tenantShaByPath.get(scriptPath);
        if (blScriptSha && tnScriptSha) {
          results[filePath] = blScriptSha !== tnScriptSha;
          continue;
        }
        // Sibling present in one repo only, or missing from trees — fall through to content path
        if (blScriptSha || tnScriptSha) {
          needsContentCompare.push(filePath);
          continue;
        }
      }
      results[filePath] = false;
      continue;
    }
    needsContentCompare.push(filePath);
  }

  for (let i = 0; i < needsContentCompare.length; i += CONCURRENCY) {
    const batch = needsContentCompare.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (filePath) => {
      try {
        const [blResult, buResult] = await Promise.all([
          getFile(baselineOrg, 'baseline', `${BASELINE_PREFIX}${filePath}`),
          getFile(tenantOrg, tenantRepo, `${TENANT_PREFIX}${filePath}`),
        ]);
        if (!blResult.exists || !buResult.exists) return;

        const jsonDiffers = normalizeForCompare(blResult.content, filePath) !== normalizeForCompare(buResult.content, filePath);

        if (jsonDiffers) {
          // Before flagging as a conflict, check if the sidecar says deployIfNotExists.
          // If the file already exists in the tenant the deploy intentionally skips it,
          // so the viewer should not show it as an orange conflict dot.
          const sidecarPath = `${BASELINE_PREFIX}${filePath.replace(/\.json$/i, '.config.json')}`;
          const sidecar = await getFile(baselineOrg, 'baseline', sidecarPath).catch(() => ({ exists: false, content: '' }));
          if (sidecar.exists) {
            try {
              const cfg = JSON.parse(sidecar.content ?? '{}') as Record<string, unknown>;
              if (cfg.deployBehavior === 'deployIfNotExists') {
                results[filePath] = false; // deploy won't touch it — not a real conflict
                return;
              }
            } catch { /* ignore malformed sidecar */ }
          }
          results[filePath] = true;
          return;
        }

        // JSON is identical — for platform scripts also compare the sibling script file
        if (isPlatformScriptPath(filePath)) {
          const scriptPath = platformScriptSiblingPath(filePath);
          const blScriptSha = baselineShaByPath.get(scriptPath);
          const tnScriptSha = tenantShaByPath.get(scriptPath);
          if (blScriptSha && tnScriptSha) {
            results[filePath] = blScriptSha !== tnScriptSha;
            return;
          }
          const [blScript, tnScript] = await Promise.all([
            getFile(baselineOrg, 'baseline', `${BASELINE_PREFIX}${scriptPath}`).catch(() => ({ exists: false, content: '' })),
            getFile(tenantOrg, tenantRepo, `${TENANT_PREFIX}${scriptPath}`).catch(() => ({ exists: false, content: '' })),
          ]);
          if (blScript.exists && tnScript.exists) {
            const norm = (s: string) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
            results[filePath] = norm(blScript.content ?? '') !== norm(tnScript.content ?? '');
            return;
          }
        }

        results[filePath] = false;
      } catch { /* skip files that error — they won't appear in results */ }
    }));
  }

  // Derived drift: mailbox audit remediation rules vs tenant backup snapshot
  try {
    const remediationInBaseline = baselinePaths.has(REMEDIATION_PATH);
    const auditStatusInBackup = tenantBackupPaths.has(AUDIT_STATUS_PATH);

    if (remediationInBaseline && auditStatusInBackup) {
      const [remediationFile, orgAuditFile, auditStatusFile] = await Promise.all([
        getFile(baselineOrg, 'baseline', `${BASELINE_PREFIX}${REMEDIATION_PATH}`),
        getFile(baselineOrg, 'baseline', `${BASELINE_PREFIX}${ORG_AUDIT_DISABLED_PATH}`).catch(() => ({ exists: false, content: '' })),
        getFile(tenantOrg, tenantRepo, `${TENANT_PREFIX}${AUDIT_STATUS_PATH}`),
      ]);

      if (remediationFile.exists && auditStatusFile.exists) {
        const orgEnabled = orgAuditFile.exists
          ? isOrgAuditRemediationEnabled(parseJsonContent(orgAuditFile.content ?? ''))
          : false;
        const drift = computeMailboxAuditDrift(
          parseJsonContent(remediationFile.content ?? '') as Parameters<typeof computeMailboxAuditDrift>[0],
          parseJsonContent(auditStatusFile.content ?? ''),
          orgEnabled,
        );

        if (drift.hasDrift) {
          results[AUDIT_STATUS_PATH] = true;
          results[REMEDIATION_PATH] = true;
        } else if (!drift.skipped) {
          results[AUDIT_STATUS_PATH] = false;
          results[REMEDIATION_PATH] = false;
        }
      }
    }
  } catch { /* non-fatal — derived drift is optional */ }

  return json({ results });
}
