import { NextRequest, NextResponse } from 'next/server';
import * as gitea from '@/lib/server/gitea';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { slug: string; workflow: string; branch?: string; inputs?: Record<string, string> };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.slug) return json({ error: 'slug is required' }, 400);
  if (!body.workflow) return json({ error: 'workflow is required' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, body.slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  try {
    await gitea.triggerWorkflow(tenant.giteaOrg, `tenant-${tenant.slug}`, body.workflow, body.branch ?? 'main', body.inputs ?? {});
    return json({ ok: true, message: `${body.workflow} triggered` });
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}
