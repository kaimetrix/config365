import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspGraphClientId } from '@/lib/server/tenant-store';
import { requireTenantAccess } from '@/lib/server/authz';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * GET /api/tenants/[slug]/auth-config
 *
 * Returns the resolved client ID and admin consent URL for the tenant.
 * Priority: tenant-specific clientId → MSP graph_client_id → env var.
 * Used by the UI to display the consent link before starting the device code flow.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  // Same priority as token-store.ts getTenantCreds:
  //   1. Tenant-specific clientId
  //   2. MSP-level graph client ID
  //   3. Env var fallback
  const clientId =
    tenant.clientId?.trim() ||
    getMspGraphClientId(tenant.mspId) ||
    process.env.AZURE_AD_CLIENT_ID ||
    '';

  // Multi-tenant app: use /common/adminconsent so the signing-in admin is routed
  // to their own tenant. redirect_uri must be https://portal.azure.com (registered
  // on the app) when the link is opened in a new browser tab/window.
  const adminConsentRedirectUri = 'https://portal.azure.com';
  const adminConsentUrl = clientId
    ? `https://login.microsoftonline.com/common/adminconsent?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(adminConsentRedirectUri)}`
    : null;

  return json({ clientId, consentUrl: adminConsentUrl, adminConsentUrl });
}
