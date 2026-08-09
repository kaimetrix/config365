import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { listMsps, getMspBySlug, createMsp, updateMsp, deleteMsp, getMspTenantCount, setMspGraphCreds, getMspGraphClientId, getMspGraphClientSecret, type MspInput } from '@/lib/server/tenant-store';
import * as gitea from '@/lib/server/gitea';
import { bootstrapMspIfNeeded } from '@/lib/server/platform-bootstrap';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);
  return json(await listMsps());
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  let body: MspInput & { graphClientId?: string; graphClientSecret?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body.slug || !body.displayName) return json({ error: 'slug and displayName are required' }, 400);

  try {
    const msp = await createMsp(body);

    // Persist Graph / device-code app credentials if supplied at creation time
    if (body.graphClientId && body.graphClientSecret) {
      setMspGraphCreds(msp.slug, body.graphClientId, body.graphClientSecret);
      try {
        await gitea.setOrgVariable(msp.giteaOrg, 'AZURE_CLIENT_ID', body.graphClientId.trim());
      } catch (err: unknown) {
        console.warn(`[POST /api/msps] Could not set AZURE_CLIENT_ID org variable: ${(err as Error).message}`);
      }
    } else if (body.graphClientId) {
      setMspGraphCreds(msp.slug, body.graphClientId, '');
    }

    // Fire-and-forget full MSP bootstrap (creates tenant-template, baseline, engine repos etc.)
    // Progress is streamed via the bootstrap-log API so the UI can poll it.
    bootstrapMspIfNeeded(msp).catch(err =>
      console.error(`[POST /api/msps] bootstrapMspIfNeeded failed for ${msp.slug}:`, (err as Error).message)
    );
    return json(msp, 201);
  } catch (err: unknown) { return json({ error: (err as Error).message }, 500); }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) return json({ error: 'slug query param required' }, 400);

  let body: Partial<MspInput> & { graphClientId?: string; graphClientSecret?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const updated = await updateMsp(slug, body);
  if (!updated) return json({ error: 'MSP not found' }, 404);

  // Persist Graph access app credentials if provided
  if (body.graphClientId && body.graphClientSecret) {
    setMspGraphCreds(updated.slug, body.graphClientId, body.graphClientSecret);

    // Sync AZURE_CLIENT_ID org variable immediately so existing pipelines pick it up
    try {
      await gitea.setOrgVariable(updated.giteaOrg, 'AZURE_CLIENT_ID', body.graphClientId.trim());
    } catch (err: unknown) {
      console.warn(`[PATCH /api/msps] Could not update AZURE_CLIENT_ID org variable: ${(err as Error).message}`);
    }
  } else if (body.graphClientId && !body.graphClientSecret) {
    // Allow updating just the client ID without changing the secret
    const existingSecret = getMspGraphClientSecret(updated.slug);
    if (existingSecret !== null) {
      setMspGraphCreds(updated.slug, body.graphClientId, existingSecret);
      try {
        await gitea.setOrgVariable(updated.giteaOrg, 'AZURE_CLIENT_ID', body.graphClientId.trim());
      } catch { /* non-fatal */ }
    }
  }

  return json(updated);
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) return json({ error: 'slug query param required' }, 400);

  const msp = await getMspBySlug(slug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const tenantCount = await getMspTenantCount(msp.id);
  if (tenantCount > 0) return json({ error: `Cannot delete MSP with ${tenantCount} tenant(s). Remove tenants first.` }, 409);

  await deleteMsp(slug);
  return json({ ok: true });
}
