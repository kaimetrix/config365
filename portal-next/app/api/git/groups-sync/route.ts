/**
 * /api/git/groups-sync
 *
 * POST { mspSlug, groupName }
 *   → reads groups-config.json, resolves direct membership for groupName,
 *     then updates config/tenant-groups.json in each tenant's Gitea repo.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspBySlug, listTenants } from '@/lib/server/tenant-store';
import { getFile, putFile } from '@/lib/server/gitea';
import { readGroupsConfig } from '@/lib/server/groups-config';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const TENANT_GROUPS_PATH = 'config/tenant-groups.json';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const body = await request.json() as { mspSlug: string; groupName: string };
  const { mspSlug, groupName } = body;
  if (!mspSlug || !groupName) return json({ error: 'mspSlug and groupName required' }, 400);

  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  // Read groups-config.json (repo root; migrates legacy import path if needed)
  let groupsConfig: Record<string, { membership?: { direct?: string[] } }> = {};
  try {
    groupsConfig = (await readGroupsConfig(msp.giteaOrg)) as typeof groupsConfig;
  } catch { /* empty config */ }

  const groupData = groupsConfig[groupName];
  if (!groupData) return json({ error: `Group "${groupName}" not found in groups-config.json` }, 404);

  const directMembers: string[] = groupData.membership?.direct ?? [];
  const tenants = await listTenants(msp.id);

  const updated: string[] = [];
  const errors: string[] = [];

  await Promise.all(tenants.map(async (tenant) => {
    const org  = msp.giteaOrg;
    const repo = tenant.slug;
    try {
      // Read current tenant-groups.json
      let currentGroups: string[] = [];
      let sha: string | undefined;
      const existing = await getFile(org, repo, TENANT_GROUPS_PATH);
      if (existing.exists) {
        sha = existing.sha;
        const parsed = JSON.parse(existing.content);
        currentGroups = parsed.groups ?? [];
      }

      const isMember = directMembers.includes(tenant.slug) || directMembers.includes(tenant.displayName ?? tenant.slug);
      const alreadyMember = currentGroups.includes(groupName);

      if (isMember && !alreadyMember) {
        currentGroups = [...currentGroups, groupName];
      } else if (!isMember && alreadyMember) {
        currentGroups = currentGroups.filter(g => g !== groupName);
      } else {
        return; // No change needed
      }

      const payload = JSON.stringify({ _resolvedAt: new Date().toISOString(), groups: currentGroups }, null, 2);
      await putFile(org, repo, TENANT_GROUPS_PATH, payload, 'chore: update tenant group membership cache [skip ci]', sha);
      updated.push(tenant.slug);
    } catch (e: unknown) {
      errors.push(`${tenant.slug}: ${e instanceof Error ? e.message : 'error'}`);
    }
  }));

  return json({ updated, errors });
}
