/**
 * GET /api/git/baseline-policies?mspSlug=&platform=android|ios|windows|macos
 *
 * Reads OS-version-relevant policy JSON files from the MSP's baseline repo:
 *  - baseline/intune/app-protection/*.json  (Android/iOS — policyGroup: app-protection)
 *  - baseline/intune/compliance-policies/*.json  (all platforms — policyGroup: compliance)
 *
 * Filters compliance files by @odata.type to match the requested platform.
 * Returns: { policies: Array<{ path, name, policyGroup, data: object|null }> }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getGitTree, getFile } from '@/lib/server/gitea';
import { requireMspAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const COMPLIANCE_MARKER: Record<string, string> = {
  android: 'android',
  ios:     'ios',
  windows: 'windows',
  macos:   'macos',
};

const APP_PROTECTION_FILTER: Record<string, RegExp> = {
  android: /android/i,
  ios:     /ios/i,
};

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug  = request.nextUrl.searchParams.get('mspSlug');
  const platform = request.nextUrl.searchParams.get('platform') ?? 'android';

  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const mspOrResponse = await requireMspAccess(session.user, mspSlug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  const org  = msp.giteaOrg;
  const repo = 'baseline';

  try {
    const tree = await getGitTree(org, repo).catch(() => [] as Awaited<ReturnType<typeof getGitTree>>);

    const allPaths = tree
      .filter(e => e.type === 'blob' && e.path.endsWith('.json') && !e.path.endsWith('.assignment.json'))
      .map(e => e.path);

    // Collect candidates
    const isMobile = platform === 'android' || platform === 'ios';
    const candidates: Array<{ path: string; policyGroup: 'app-protection' | 'compliance' }> = [];

    if (isMobile) {
      const apFilter = APP_PROTECTION_FILTER[platform];
      allPaths
        .filter(p => p.includes('intune/app-protection') && apFilter.test(p.split('/').pop() ?? ''))
        .forEach(p => candidates.push({ path: p, policyGroup: 'app-protection' }));
    }

    allPaths
      .filter(p => p.includes('intune/compliance-policies'))
      .forEach(p => candidates.push({ path: p, policyGroup: 'compliance' }));

    // Fetch and parse each file
    const loaded = await Promise.all(candidates.map(async c => {
      try {
        const f = await getFile(org, repo, c.path);
        const data = f.exists ? JSON.parse(f.content) : null;
        const sha = f.exists ? f.sha : undefined;
        return { path: c.path, name: c.path.split('/').pop() ?? c.path, policyGroup: c.policyGroup, sha, data };
      } catch {
        return { path: c.path, name: c.path.split('/').pop() ?? c.path, policyGroup: c.policyGroup, sha: undefined, data: null };
      }
    }));

    // Filter compliance by @odata.type
    const marker = COMPLIANCE_MARKER[platform]?.toLowerCase() ?? platform;
    const policies = loaded.filter(p => {
      if (p.policyGroup === 'app-protection') return true;
      return p.data == null || String(p.data['@odata.type'] ?? '').toLowerCase().includes(marker);
    });

    return json({ policies });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * PUT /api/git/baseline-policies
 * Body: { mspSlug, path, fields: Record<string, string|null>, sha? }
 * Merges `fields` into the policy JSON and commits to baseline repo.
 */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { mspSlug: string; path: string; fields: Record<string, string | null>; sha?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const mspOrResponse = await requireMspAccess(session.user, body.mspSlug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  const { getFile: gf, putFile } = await import('@/lib/server/gitea');
  const org = msp.giteaOrg;
  const repo = 'baseline';

  try {
    const existing = await gf(org, repo, body.path);
    let policy: Record<string, unknown> = {};
    if (existing.exists) {
      try { policy = JSON.parse(existing.content); } catch { /* start fresh */ }
    }

    for (const [key, value] of Object.entries(body.fields)) {
      if (value === null) { delete policy[key]; } else { policy[key] = value; }
    }

    const fileName = body.path.split('/').pop() ?? body.path;
    await putFile(org, repo, body.path, JSON.stringify(policy, null, 2) + '\n',
      `chore: update OS version thresholds in ${fileName}`,
      existing.exists ? existing.sha : undefined);

    return json({ ok: true });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
