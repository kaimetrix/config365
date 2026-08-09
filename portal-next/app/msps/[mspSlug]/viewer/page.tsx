import type { TreeEntry } from '@/lib/server/gitea';
import { requireMspContext } from '@/lib/server/page-utils';
import { getGitTree } from '@/lib/server/gitea';
import AppShell from '@/components/layout/AppShell';
import ViewerClient from './ViewerClient';
import { listTenants } from '@/lib/server/tenant-store';

export const dynamic = 'force-dynamic';

const isSidecar = (path: string) =>
  path.endsWith('.monitor.json') || path.endsWith('.config.json');

export default async function ViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ mspSlug: string }>;
  searchParams: Promise<{ tenant?: string; scope?: string }>;
}) {
  const { mspSlug } = await params;
  const { tenant: tenantSlug, scope = 'tenant' } = await searchParams;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);
  const tenants = await listTenants(msp.id);

  let tree: TreeEntry[] = [];
  let baselinePaths: string[] = [];
  let org  = msp.giteaOrg;
  let repo = 'baseline';

  if (scope === 'baseline') {
    try {
      const raw = await getGitTree(msp.giteaOrg, 'baseline');
      tree = raw
        .filter(e =>
          e.path.startsWith('baseline/') &&
          !e.path.startsWith('baseline-remove/') &&
          !isSidecar(e.path)
        )
        .map(e => ({
          name: e.path.split('/').at(-1)!,
          path: e.path.replace(/^baseline\//, ''),
          type: 'file' as const,
          size: e.size ?? 0,
          sha: e.sha,
        }));
    } catch { /* empty */ }
  } else if (tenantSlug) {
    const t = tenants.find(x => x.slug === tenantSlug);
    if (t) { org = t.giteaOrg; repo = `tenant-${t.slug}`; }
    try {
      // Use the recursive git tree API to get all backup files in one request,
      // then strip the backups/ prefix so paths are relative to the backup root.
      // Baseline + tenant trees are fetched in parallel to cut page TTFB.
      const [baselineRaw, raw] = await Promise.all([
        getGitTree(msp.giteaOrg, 'baseline'),
        getGitTree(org, repo),
      ]);
      baselinePaths = baselineRaw
        .filter(e =>
          e.path.startsWith('baseline/') &&
          !e.path.startsWith('baseline-remove/') &&
          e.path.endsWith('.json') &&
          !isSidecar(e.path),
        )
        .map(e => e.path.replace(/^baseline\//, ''));
      tree = raw
        .filter(e => e.path.startsWith('backups/') && !isSidecar(e.path))
        .map(e => ({
          name: e.path.split('/').at(-1)!,
          path: e.path.replace(/^backups\//, ''),
          type: 'file' as const,
          size: e.size ?? 0,
          sha: e.sha,
        }));
    } catch { /* empty */ }
  }

  return (
    <AppShell title="Policy Viewer" fullHeight {...sidebarProps}>
      <ViewerClient mspSlug={mspSlug} tenants={tenants} tree={tree} baselinePaths={baselinePaths} selectedTenantSlug={tenantSlug} scope={scope} giteaOrg={org} repo={repo} />
    </AppShell>
  );
}
