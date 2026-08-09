import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile, getBinaryFile, putFile, deleteFile } from '@/lib/server/gitea';
import { getTenantBySlug, getMspBySlug } from '@/lib/server/tenant-store';
import { requireTenantAccess, requireMspAccess } from '@/lib/server/authz';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const platformOrg = process.env.GITEA_ORG ?? 'config365';

async function resolveRepo(
  scope: string | null,
  slug: string | null,
  mspSlug: string | null,
): Promise<{ org: string; repo: string; isBaseline: boolean } | null> {
  if (scope === 'baseline') {
    let org = platformOrg;
    if (mspSlug) { const msp = await getMspBySlug(mspSlug); if (msp) org = msp.giteaOrg; }
    return { org, repo: 'baseline', isBaseline: true };
  }
  if (slug) {
    const t = await getTenantBySlug(slug);
    if (!t) return null;
    return { org: t.giteaOrg, repo: `tenant-${t.slug}`, isBaseline: false };
  }
  return null;
}

/** GET /api/git/file?path=...&scope=baseline&mspSlug=...
 *      /api/git/file?path=...&slug=tenantSlug
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  const p = request.nextUrl.searchParams;
  const path    = p.get('path');
  const scope   = p.get('scope');
  const slug    = p.get('slug');
  const mspSlug = p.get('mspSlug');
  const ref     = p.get('ref') ?? undefined;
  const binary  = p.get('binary') === '1';

  if (!path) return json({ error: 'path is required' }, 400);

  const target = await resolveRepo(scope, slug, mspSlug);
  if (!target) return json({ error: 'Provide scope=baseline+mspSlug or slug' }, 400);

  if (target.isBaseline) {
    const guard = await requireMspAccess(session.user, mspSlug ?? '');
    if (guard instanceof NextResponse) return guard;
  } else {
    const guard = await requireTenantAccess(session.user, slug!);
    if (guard instanceof NextResponse) return guard;
  }

  const { org, repo: repoName } = target;

  try {
    if (binary) {
      const result = await getBinaryFile(org, repoName, path, ref);
      if (!result.exists) return json({ exists: false, contentBase64: null, sha: null });
      return json({ exists: true, contentBase64: result.contentBase64, sha: result.sha });
    }
    const result = await getFile(org, repoName, path, ref);
    if (!result.exists) return json({ exists: false, content: null, sha: null });
    return json({ exists: true, content: result.content, sha: result.sha });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('404')) return json({ exists: false, content: null, sha: null });
    return json({ error: msg }, 500);
  }
}

/** PUT /api/git/file — create or update a file */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const path    = body.path    as string | undefined;
  const content = body.content as string | undefined;
  const message = body.message as string | undefined;
  const sha     = body.sha     as string | undefined;
  const scope   = body.scope   as string | undefined;
  const slug    = body.slug    as string | undefined;
  const mspSlug = body.mspSlug as string | undefined;
  const encoding = body.encoding as string | undefined;

  if (!path || content === undefined) return json({ error: 'path and content are required' }, 400);

  const target = await resolveRepo(scope ?? null, slug ?? null, mspSlug ?? null);
  if (!target) return json({ error: 'Provide scope=baseline+mspSlug or slug' }, 400);

  if (target.isBaseline) {
    const guard = await requireMspAccess(session.user, mspSlug ?? '');
    if (guard instanceof NextResponse) return guard;
  } else {
    const guard = await requireTenantAccess(session.user, slug!);
    if (guard instanceof NextResponse) return guard;
  }

  const { org, repo: repoName } = target;

  try {
    await putFile(org, repoName, path, content, message ?? `portal: update ${path}`, sha, 'main', encoding === 'base64');
    return json({ ok: true });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

/** DELETE /api/git/file — delete a file */
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const path    = body.path    as string | undefined;
  const sha     = body.sha     as string | undefined;
  const message = body.message as string | undefined;
  const scope   = body.scope   as string | undefined;
  const slug    = body.slug    as string | undefined;
  const mspSlug = body.mspSlug as string | undefined;

  if (!path || !sha) return json({ error: 'path and sha are required' }, 400);

  const target = await resolveRepo(scope ?? null, slug ?? null, mspSlug ?? null);
  if (!target) return json({ error: 'Provide scope=baseline+mspSlug or slug' }, 400);

  if (target.isBaseline) {
    const guard = await requireMspAccess(session.user, mspSlug ?? '');
    if (guard instanceof NextResponse) return guard;
  } else {
    const guard = await requireTenantAccess(session.user, slug!);
    if (guard instanceof NextResponse) return guard;
  }

  const { org, repo: repoName } = target;

  try {
    await deleteFile(org, repoName, path, sha, message ?? `portal: delete ${path}`);
    return json({ ok: true });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
