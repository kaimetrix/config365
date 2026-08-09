import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { listTenants, createTenant, deleteTenant, getMspBySlug, getTenantBySlug, setTenantClientSecret, type TenantInput } from '@/lib/server/tenant-store';
import * as gitea from '@/lib/server/gitea';
import { bootstrapTenantRepo } from '@/lib/server/platform-bootstrap';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);
  return json(await listTenants());
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  let body: TenantInput & { exchangeOrg?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.slug || !body.displayName) return json({ error: 'slug and displayName are required' }, 400);
  if (!body.mspId) return json({ error: 'mspId is required' }, 400);

  const msp = await getMspBySlug(body.mspId);
  if (!msp) return json({ error: `MSP "${body.mspId}" not found` }, 404);

  const slug = body.slug.toLowerCase().trim();

  const existing = await getTenantBySlug(slug);
  if (existing) return json({ error: `A tenant with slug "${slug}" already exists.` }, 409);

  let tenant: Awaited<ReturnType<typeof createTenant>>;
  try { tenant = await createTenant({ ...body, mspId: msp.id }); }
  catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('UNIQUE')) return json({ error: `A tenant with slug "${slug}" already exists.` }, 409);
    return json({ error: msg }, 500);
  }

  // Store tenant-specific app override in DB if provided (used by device code flow)
  if (body.clientId && (body as TenantInput & { clientSecret?: string }).clientSecret) {
    setTenantClientSecret(slug, (body as TenantInput & { clientSecret?: string }).clientSecret!);
  }

  // Fire-and-forget — Gitea provisioning with full log tracking.
  // The UI polls /api/admin/platform/bootstrap-log?scope=tenant:<slug> for live progress.
  bootstrapTenantRepo(msp, tenant).catch(err =>
    console.error(`[POST /api/tenants] bootstrapTenantRepo failed for ${slug}:`, (err as Error).message)
  );

  return json(tenant, 201);
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const slug = request.nextUrl.searchParams.get('slug')?.toLowerCase().trim();
  if (!slug) return json({ error: 'slug query param is required' }, 400);

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return json({ error: `Tenant "${slug}" not found` }, 404);

  try { await gitea.deleteRepo(tenant.giteaOrg, `tenant-${slug}`); }
  catch (err: unknown) { console.warn(`[DELETE /api/tenants] Could not delete repo: ${(err as Error).message}`); }

  const deleted = await deleteTenant(slug);
  if (!deleted) return json({ error: 'Failed to delete tenant record' }, 500);
  return json({ ok: true, slug });
}
