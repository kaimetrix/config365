/**
 * GET /api/tenants/[slug]/security-groups
 *
 * Returns a list of Entra security groups from the tenant's backed-up
 * backups/groups/ directory in Gitea. No live Graph calls.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getTree, getFile } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

interface GroupBackup {
  id: string;
  displayName: string;
  securityEnabled?: boolean;
  mailEnabled?: boolean;
  groupTypes?: string[];
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

  // List the groups backup directory
  let treeEntries: Array<{ name: string; type: string }> = [];
  try {
    treeEntries = await getTree(org, repo, 'backups/groups');
  } catch {
    // Directory doesn't exist yet (no backup run)
    return json({ groups: [] });
  }

  const jsonFiles = treeEntries.filter((e) => e.type === 'file' && e.name.endsWith('.json'));
  if (jsonFiles.length === 0) return json({ groups: [] });

  // Read all group files in parallel
  const fileResults = await Promise.allSettled(
    jsonFiles.map(async (entry) => {
      const result = await getFile(org, repo, `backups/groups/${entry.name}`);
      if (!result.exists) return null;
      try {
        return JSON.parse(result.content) as GroupBackup;
      } catch {
        return null;
      }
    }),
  );

  const groups = fileResults
    .filter((r): r is PromiseFulfilledResult<GroupBackup | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((g): g is GroupBackup => g !== null && !!g.displayName && g.securityEnabled === true)
    // id may be absent from older backups — portal/runner fall back to display-name resolution
    .map((g) => ({ id: g.id ?? '', displayName: g.displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return json({ groups });
}
