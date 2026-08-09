import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import { updateTenant, deleteTenant, setTenantClientSecret } from '@/lib/server/tenant-store';
import * as gitea from '@/lib/server/gitea';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const { slug } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const updated = await updateTenant(slug, body as Parameters<typeof updateTenant>[1]);
  if (!updated) return json({ error: 'Tenant not found' }, 404);

  const org = updated.giteaOrg, repoName = `tenant-${slug}`;

  // Keep TENANT_SLUG and AZURE_TENANT_ID as repo variables (not secrets)
  await gitea.setRepoVariable(org, repoName, 'TENANT_SLUG', slug);
  if (body.tenantId) await gitea.setRepoVariable(org, repoName, 'AZURE_TENANT_ID', String(body.tenantId));

  // Store tenant-specific app secret in DB so getTenantCreds() can use it
  if (body.clientSecret) setTenantClientSecret(slug, String(body.clientSecret));

  return json(updated);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  const { slug } = await params;
  const deleted = await deleteTenant(slug);
  if (!deleted) return json({ error: 'Tenant not found' }, 404);
  return json({ ok: true });
}
