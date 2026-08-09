/**
 * /api/git/groups-config
 *
 * GET  ?mspSlug=  → read groups-config.json from MSP baseline repo
 * PUT             → write groups-config.json to MSP baseline repo
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspBySlug } from '@/lib/server/tenant-store';
import { getFile, putFile } from '@/lib/server/gitea';
import { readGroupsConfig } from '@/lib/server/groups-config';
import { GROUPS_CONFIG_PATH } from '@/lib/server/groups-config-paths';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug = request.nextUrl.searchParams.get('mspSlug');
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  try {
    const groups = await readGroupsConfig(msp.giteaOrg);
    return json({ groups });
  } catch {
    return json({ groups: {} });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const body = await request.json() as { mspSlug: string; groups: Record<string, unknown> };
  const { mspSlug, groups } = body;
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  try {
    const existing = await getFile(msp.giteaOrg, 'baseline', GROUPS_CONFIG_PATH);
    const sha = existing.exists ? existing.sha : undefined;
    const content = JSON.stringify({ groups }, null, 2);
    await putFile(
      msp.giteaOrg,
      'baseline',
      GROUPS_CONFIG_PATH,
      content,
      'chore: update groups-config.json',
      sha,
    );
    return json({ success: true });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : 'Failed to save' }, 500);
  }
}
