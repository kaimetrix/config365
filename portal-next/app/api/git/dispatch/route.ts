import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { slug: string; workflowFile: string; ref?: string; inputs?: Record<string, string> };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const tenantOrResponse = await requireTenantAccess(session.user, body.slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  try {
    await gitea.triggerWorkflow(tenant.giteaOrg, `tenant-${tenant.slug}`, body.workflowFile, body.ref ?? 'main', body.inputs ?? {});
    return json({ ok: true });
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
