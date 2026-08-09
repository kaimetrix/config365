/**
 * authz.ts — Shared authorization helpers for API route handlers.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import { isPlatformAdmin } from './session';
import { getIamAssignmentForUser, getTenantBySlug, getMspBySlug } from './tenant-store';
import type { SessionUser } from './session';
import type { Msp, TenantConfig } from './db-adapter';

/**
 * Resolves the tenant by slug and verifies the user may access it.
 *
 * Allowed if:
 *   - The user is a platform-admin, OR
 *   - The user is an msp-admin whose assigned MSP owns the tenant.
 *
 * Returns the Tenant on success.
 * Returns a 403/404 NextResponse on failure — callers should return it immediately:
 *
 *   const result = await requireTenantAccess(session.user, slug);
 *   if (result instanceof NextResponse) return result;
 */
export async function requireTenantAccess(
  user: SessionUser,
  tenantSlug: string,
): Promise<TenantConfig | NextResponse> {
  const tenant = await getTenantBySlug(tenantSlug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

  if (isPlatformAdmin(user)) return tenant;

  try {
    const assignment = await getIamAssignmentForUser(user.userId);
    if (assignment?.role === 'msp-admin' && assignment.mspSlug) {
      const msp = await getMspBySlug(assignment.mspSlug);
      if (msp && msp.id === tenant.mspId) return tenant;
    }
  } catch {
    // DB not ready — deny by default
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Resolves the MSP by slug and verifies the user may access it.
 *
 * Allowed if:
 *   - The user is a platform-admin, OR
 *   - The user is an msp-admin whose assigned MSP matches this MSP.
 *
 * Returns the Msp on success.
 * Returns a 403/404 NextResponse on failure — callers should return it immediately:
 *
 *   const result = await requireMspAccess(session.user, mspSlug);
 *   if (result instanceof NextResponse) return result;
 */
export async function requireMspAccess(
  user: SessionUser,
  mspSlug: string,
): Promise<Msp | NextResponse> {
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return NextResponse.json({ error: 'MSP not found' }, { status: 404 });

  if (isPlatformAdmin(user)) return msp;

  try {
    const assignment = await getIamAssignmentForUser(user.userId);
    if (assignment?.role === 'msp-admin' && assignment.mspSlug === msp.slug) return msp;
  } catch {
    // DB not ready — deny by default
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
