/**
 * tenant-store.ts — Public API for all Config365 data access.
 *
 * Re-exports:
 *  - Settings (getSetting, setSetting, …) — always SQLite, synchronous
 *  - Types (Msp, Tenant, …) — from db-adapter
 *  - Operational CRUD (listMsps, createTenant, …) — async, routed through
 *    db-factory which picks SQLite or MSSQL based on platform_settings
 */
import 'server-only';

// ─── Settings (always synchronous / SQLite) ───────────────────────────────────

export {
  getSetting,
  setSetting,
  deleteSetting,
  setEncryptedSetting,
  getDecryptedSetting,
  isSetupComplete,
  bootstrapGiteaToken,
  getOrCreateTokenEncryptionKey,
  recordRejectedRun,
  isRejectedRun,
} from './settings-store';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  IamRole,
  IamAssignment,
  Msp,
  MspInput,
  Tenant,
  TenantConfig,
  TenantInput,
} from './db-adapter';

// ─── Internal imports ─────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { getSetting, setSetting, setEncryptedSetting, getDecryptedSetting } from './settings-store';
import { getDb } from './db-factory';
import type { IamRole, MspInput, TenantInput } from './db-adapter';

// ─── MSP Graph App Credentials (settings-backed, synchronous) ─────────────────

export function setMspGraphCreds(mspSlug: string, clientId: string, clientSecret: string): void {
  setSetting(`msp:${mspSlug}:graph_client_id`,              clientId.trim());
  setEncryptedSetting(`msp:${mspSlug}:graph_client_secret`, clientSecret.trim());
}

export function getMspGraphClientId(mspSlug: string): string | null {
  return getSetting(`msp:${mspSlug}:graph_client_id`);
}

export function getMspGraphClientSecret(mspSlug: string): string | null {
  return getDecryptedSetting(`msp:${mspSlug}:graph_client_secret`);
}

// ─── Tenant Client Secret (settings-backed, synchronous) ─────────────────────

export function setTenantClientSecret(tenantSlug: string, secret: string): void {
  setEncryptedSetting(`tenant:${tenantSlug}:clientSecret`, secret.trim());
}

// ─── MSP Internal-Key Management (settings-backed, synchronous) ───────────────

const MSP_KEY_PREFIX = 'msp:';
const MSP_KEY_SUFFIX = ':internal_key';

export function generateAndStoreMspInternalKey(mspSlug: string): string {
  const key = randomBytes(36).toString('base64url');
  setEncryptedSetting(`${MSP_KEY_PREFIX}${mspSlug}${MSP_KEY_SUFFIX}`, key);
  return key;
}

export function getMspInternalKey(mspSlug: string): string | null {
  return getDecryptedSetting(`${MSP_KEY_PREFIX}${mspSlug}${MSP_KEY_SUFFIX}`);
}

/**
 * Resolve the MSP slug for a tenant, then read that MSP's PORTAL_INTERNAL_KEY.
 * Keys are stored as `msp:<slug>:internal_key` — never look them up by msp UUID/id alone
 * unless id === slug (legacy SQLite createMsp uses id = slug).
 */
export async function getMspInternalKeyForTenantRecord(tenant: {
  mspId: string;
}): Promise<{ key: string | null; mspSlug: string | null }> {
  const msps = await listMsps();
  const msp =
    msps.find((m) => m.id === tenant.mspId) ??
    msps.find((m) => m.slug === tenant.mspId) ??
    null;
  const mspSlug = msp?.slug ?? null;
  if (!mspSlug) {
    // Last resort: treat mspId as slug (matches createMsp id===slug).
    return { key: getMspInternalKey(tenant.mspId), mspSlug: tenant.mspId };
  }
  return { key: getMspInternalKey(mspSlug), mspSlug };
}

// ─── MSP CRUD (async) ─────────────────────────────────────────────────────────

export async function listMsps() { return (await getDb()).listMsps(); }

export async function getMspBySlug(slug: string) { return (await getDb()).getMspBySlug(slug); }

export async function getMspByGiteaOrg(giteaOrg: string) {
  const msps = await (await getDb()).listMsps();
  return msps.find((m) => m.giteaOrg === giteaOrg) ?? null;
}

export async function createMsp(input: MspInput) { return (await getDb()).createMsp(input); }

export async function updateMsp(slug: string, input: Partial<MspInput>) {
  return (await getDb()).updateMsp(slug, input);
}

export async function deleteMsp(slug: string) { return (await getDb()).deleteMsp(slug); }

export async function getMspTenantCount(mspId: string) {
  return (await getDb()).getMspTenantCount(mspId);
}

// ─── Tenant CRUD (async) ──────────────────────────────────────────────────────

export async function getTenantBySlug(slug: string) {
  return (await getDb()).getTenantBySlug(slug);
}

export async function getTenantByDomain(domain: string) {
  return (await getDb()).getTenantByDomain(domain);
}

export async function listTenants(mspId?: string) {
  return (await getDb()).listTenants(mspId);
}

export async function createTenant(input: TenantInput) {
  return (await getDb()).createTenant(input);
}

export async function updateTenant(slug: string, input: Partial<Omit<TenantInput, 'slug'>>) {
  return (await getDb()).updateTenant(slug, input);
}

export async function deleteTenant(slug: string) {
  return (await getDb()).deleteTenant(slug);
}

// ─── IAM Assignments (async) ──────────────────────────────────────────────────

export async function listIamAssignments(role?: IamRole) {
  return (await getDb()).listIamAssignments(role);
}

export async function listIamAssignmentsForMsp(mspSlug: string) {
  return (await getDb()).listIamAssignmentsForMsp(mspSlug);
}

export async function getIamAssignmentForUser(userId: string) {
  return (await getDb()).getIamAssignmentForUser(userId);
}

export async function upsertIamAssignment(input: {
  userId: string;
  email: string;
  displayName: string;
  role: IamRole;
  mspSlug?: string | null;
}) {
  return (await getDb()).upsertIamAssignment(input);
}

export async function deleteIamAssignment(id: string) {
  return (await getDb()).deleteIamAssignment(id);
}
