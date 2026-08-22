import type { GitTreeEntry, TreeEntry } from '@/lib/server/gitea';
import { getGitTree } from '@/lib/server/gitea';

const isSidecar = (path: string) =>
  path.endsWith('.monitor.json') || path.endsWith('.config.json');

function toViewerEntry(path: string, entry: Pick<GitTreeEntry, 'size' | 'sha'>): TreeEntry {
  return {
    name: path.split('/').at(-1)!,
    path,
    type: 'file',
    size: entry.size ?? 0,
    sha: entry.sha,
  };
}

function mapBaselineTree(raw: GitTreeEntry[]): TreeEntry[] {
  return raw
    .filter(e =>
      e.path.startsWith('baseline/') &&
      !e.path.startsWith('baseline-remove/') &&
      !isSidecar(e.path),
    )
    .map(e => toViewerEntry(e.path.replace(/^baseline\//, ''), e));
}

function baselinePolicyPaths(raw: GitTreeEntry[]): string[] {
  return raw
    .filter(e =>
      e.path.startsWith('baseline/') &&
      !e.path.startsWith('baseline-remove/') &&
      e.path.endsWith('.json') &&
      !isSidecar(e.path),
    )
    .map(e => e.path.replace(/^baseline\//, ''));
}

function mapTenantBackupTree(raw: GitTreeEntry[]): TreeEntry[] {
  const ignoreEntry = raw.find(e => e.path === '.baseline-ignore');
  return [
    {
      name: '.baseline-ignore',
      path: '.baseline-ignore',
      type: 'file',
      size: ignoreEntry?.size ?? 0,
      sha: ignoreEntry?.sha ?? '',
    },
    ...raw
      .filter(e => e.path.startsWith('backups/') && !isSidecar(e.path))
      .map(e => toViewerEntry(e.path.replace(/^backups\//, ''), e)),
  ];
}

export async function loadViewerTree(opts: {
  scope: 'baseline' | 'tenant';
  baselineOrg: string;
  tenantOrg?: string;
  tenantSlug?: string;
}): Promise<{ tree: TreeEntry[]; baselinePaths: string[] }> {
  if (opts.scope === 'baseline') {
    const raw = await getGitTree(opts.baselineOrg, 'baseline');
    return { tree: mapBaselineTree(raw), baselinePaths: [] };
  }

  const tenantOrg = opts.tenantOrg;
  const tenantSlug = opts.tenantSlug;
  if (!tenantOrg || !tenantSlug) {
    return { tree: [], baselinePaths: [] };
  }

  const [baselineRaw, raw] = await Promise.all([
    getGitTree(opts.baselineOrg, 'baseline'),
    getGitTree(tenantOrg, `tenant-${tenantSlug}`),
  ]);

  return {
    tree: mapTenantBackupTree(raw),
    baselinePaths: baselinePolicyPaths(baselineRaw),
  };
}
