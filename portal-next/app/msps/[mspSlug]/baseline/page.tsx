import type { TreeEntry, GitTreeEntry } from '@/lib/server/gitea';
import { requireMspContext } from '@/lib/server/page-utils';
import { getGitTree } from '@/lib/server/gitea';
import { listTenants } from '@/lib/server/tenant-store';
import AppShell from '@/components/layout/AppShell';
import BaselineClient from './BaselineClient';

export const dynamic = 'force-dynamic';

function toTreeEntries(entries: GitTreeEntry[]): TreeEntry[] {
  return entries.map(e => ({
    name: e.path.split('/').at(-1) ?? e.path,
    path: e.path,
    type: 'file' as const,
    size: e.size ?? 0,
    sha: e.sha,
  }));
}

export default async function BaselinePage({ params }: { params: Promise<{ mspSlug: string }> }) {
  const { mspSlug } = await params;
  const { msp, sidebarProps } = await requireMspContext(mspSlug);

  let deployTree: TreeEntry[] = [];
  let removeTree: TreeEntry[] = [];
  try {
    const all = await getGitTree(msp.giteaOrg, 'baseline');
    deployTree = toTreeEntries(all.filter(
      (e) => e.path.startsWith('baseline/')
        && !e.path.startsWith('baseline-remove/')
        && !e.path.startsWith('baseline/baseline-remove/'),
    ));
    removeTree = toTreeEntries(all.filter(e => e.path.startsWith('baseline-remove/')));
  } catch { /* empty repo */ }

  const tenants = (await listTenants(msp.id)).map(t => ({ slug: t.slug, displayName: t.displayName }));

  return (
    <AppShell title="Baseline" fullHeight {...sidebarProps}>
      <BaselineClient mspSlug={mspSlug} deployTree={deployTree} removeTree={removeTree} giteaOrg={msp.giteaOrg} tenants={tenants} />
    </AppShell>
  );
}
