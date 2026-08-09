/**
 * GET /api/tenants/[slug]/group-membership?groupName=<safeFileName>
 *
 * Returns the backed-up user member IDs for a given security group.
 * Data comes from backups/group-membership/{groupName}.json in the tenant repo.
 * No live Graph calls.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

interface MemberEntry {
  id: string;
  userPrincipalName: string;
  displayName: string;
}

interface GroupMembershipBackup {
  groupDisplayName: string;
  groupId: string;
  backedUpAt: string;
  memberCount: number;
  members: MemberEntry[];
}

function toSafeFileName(name: string): string {
  // Must exactly match Get-SafeFileName in Backup-Common.ps1:
  //   $Name -replace '[\\/:*?"<>|\[\]]', '_'
  // Only the listed special chars are replaced; spaces and hyphens are preserved as-is.
  return name.replace(/[\\/:*?"<>|[\]]/g, '_');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;
  const { searchParams } = request.nextUrl;
  const groupName = searchParams.get('groupName');

  if (!groupName) return json({ error: 'groupName query parameter required' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org      = tenant.giteaOrg;
  const repo     = `tenant-${tenant.slug}`;
  const fileName = toSafeFileName(groupName);
  const path     = `backups/group-membership/${fileName}.json`;

  const result = await getFile(org, repo, path);
  if (!result.exists) {
    // Backup hasn't run yet or group has no membership file
    return json({ memberIds: [], notBacked: true });
  }

  try {
    const data = JSON.parse(result.content) as GroupMembershipBackup;
    const memberIds = (data.members ?? []).map((m) => m.id).filter(Boolean);
    return json({ memberIds, backedUpAt: data.backedUpAt ?? null });
  } catch {
    return json({ memberIds: [], error: 'Failed to parse membership backup' });
  }
}
