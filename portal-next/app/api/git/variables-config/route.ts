/**
 * /api/git/variables-config
 *
 * GET  ?mspSlug=  → read variables.json from MSP baseline repo
 * PUT             → write variables.json to MSP baseline repo
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspBySlug } from '@/lib/server/tenant-store';
import { getFile, putFile } from '@/lib/server/gitea';
import { readVariablesConfig } from '@/lib/server/variables-config';
import { VARIABLES_CONFIG_PATH } from '@/lib/server/variables-config-paths';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

function validateVariables(variables: Record<string, unknown>): string | null {
  for (const name of Object.keys(variables)) {
    if (!NAME_PATTERN.test(name)) {
      return `Invalid variable name "${name}". Use letters, numbers, underscore, dot, or hyphen only.`;
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug = request.nextUrl.searchParams.get('mspSlug');
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  try {
    const variables = await readVariablesConfig(msp.giteaOrg);
    return json({ variables });
  } catch {
    return json({ variables: {} });
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const body = await request.json() as { mspSlug: string; variables: Record<string, unknown> };
  const { mspSlug, variables } = body;
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const validationError = validateVariables(variables ?? {});
  if (validationError) return json({ error: validationError }, 400);

  try {
    const existing = await getFile(msp.giteaOrg, 'baseline', VARIABLES_CONFIG_PATH);
    const sha = existing.exists ? existing.sha : undefined;
    const content = JSON.stringify({ variables }, null, 2);
    await putFile(
      msp.giteaOrg,
      'baseline',
      VARIABLES_CONFIG_PATH,
      content,
      'chore: update variables.json',
      sha,
    );
    return json({ success: true });
  } catch (e: unknown) {
    return json({ error: e instanceof Error ? e.message : 'Failed to save' }, 500);
  }
}
