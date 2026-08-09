import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireTenantAccess } from '@/lib/server/authz';
import { resolveTenantVariables } from '@/lib/server/resolve-tenant-variables';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

/**
 * GET /api/git/resolve-variables?slug=tenantSlug
 *
 * Returns the fully-resolved {{VAR:Name}} -> value map for a tenant, using the
 * same precedence as the runner (default -> baseline group override -> tenant override).
 * Used by the portal to expand baseline placeholders before diffing/rendering,
 * since the runner's own resolved-variables cache only exists during a pipeline run.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthorized' }, 401);

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) return json({ error: 'slug is required' }, 400);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;

  try {
    const variables = await resolveTenantVariables(tenantOrResponse.giteaOrg, slug);
    return json({ variables });
  } catch (err: unknown) {
    return json({ error: (err as Error).message ?? 'Failed to resolve variables' }, 500);
  }
}
