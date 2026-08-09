import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { generateAndStoreMspInternalKey, getMspInternalKey } from '@/lib/server/tenant-store';
import { setOrgSecret } from '@/lib/server/gitea';
import { requireMspAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

/**
 * POST /api/msps/[slug]/internal-key
 *
 * Generates (or rotates) the PORTAL_INTERNAL_KEY for the given MSP:
 *   1. Creates a new cryptographically random key
 *   2. Stores it in platform_settings as `msp:<slug>:internal_key`
 *   3. Pushes it to the MSP's Gitea org as the PORTAL_INTERNAL_KEY secret
 *
 * Returns { keyPreview: "<first 8 chars>...", giteaOrg: "<org>" }.
 * The full key is never returned to the browser after initial generation.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;
  const mspOrResponse = await requireMspAccess(session.user, slug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  try {
    const newKey = generateAndStoreMspInternalKey(msp.slug);
    let giteaPushed = true;
    let giteaError: string | undefined;
    try {
      await setOrgSecret(msp.giteaOrg, 'PORTAL_INTERNAL_KEY', newKey);
    } catch (err: unknown) {
      // Key is already in platform_settings — do not fail the whole request or the
      // Connect UI will loop on "Generate MSP Key" while Gitea secret push is broken.
      giteaPushed = false;
      giteaError = err instanceof Error ? err.message : String(err);
      console.error(`[internal-key] Stored key for MSP ${msp.slug} but Gitea org secret push failed:`, giteaError);
    }

    return json({
      ok: true,
      keyPreview: `${newKey.slice(0, 8)}…`,
      giteaOrg: msp.giteaOrg,
      giteaPushed,
      ...(giteaError ? { giteaError } : {}),
    });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * GET /api/msps/[slug]/internal-key
 *
 * Returns whether the MSP has a key configured (no key value exposed).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;
  const mspOrResponse = await requireMspAccess(session.user, slug);
  if (mspOrResponse instanceof NextResponse) return mspOrResponse;
  const msp = mspOrResponse;

  const existing = getMspInternalKey(msp.slug);
  return json({ configured: existing !== null, giteaOrg: msp.giteaOrg });
}
