import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';
import { getMspBySlug } from '@/lib/server/tenant-store';
import { syncTenantRepoFromTemplate } from '@/lib/server/platform-bootstrap';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * POST /api/tenants/[slug]/sync-template
 *
 * Copies `.gitea/**` and `.baseline-ignore` from the MSP tenant-template
 * into this tenant's Gitea repo (create or update), and refreshes Actions /
 * repo variables. Use to heal tenants created without template content.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const msp = await getMspBySlug(tenant.mspId);
  if (!msp) return json({ error: `MSP not found: ${tenant.mspId}` }, 404);

  try {
    const result = await syncTenantRepoFromTemplate(msp, tenant);
    const failed = result.errors.length > 0;
    return json({
      ok: !failed,
      message: failed
        ? `Synced with errors (${result.updated.length} updated, ${result.errors.length} failed)`
        : result.updated.length === 0
          ? 'Already in sync with tenant-template'
          : `Synced ${result.updated.length} file(s) from tenant-template`,
      ...result,
    }, failed ? 207 : 200);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[POST /api/tenants/${slug}/sync-template]`, message);
    return json({ error: message }, 500);
  }
}
