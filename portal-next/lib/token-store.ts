/**
 * token-store.ts — Token API only. Never imported by the Next.js portal app.
 *
 * Tenant/MSP lookups go through the portal internal HTTP API (single source of
 * truth for MSSQL or SQLite). Local SQLite is only used for platform_settings
 * (Graph credentials, encryption key, PORTAL_INTERNAL_KEY).
 * Token storage is delegated to TokenBackend (SQLite / MSSQL / Key Vault).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Local settings DB (platform_settings only) ───────────────────────────────

const MAIN_DB_PATH = process.env.MAIN_DB_PATH ?? process.env.DB_PATH ?? './data/config365.db';

let _mainDb: Database.Database | null = null;

function getMainDb(): Database.Database {
  if (_mainDb) return _mainDb;
  mkdirSync(dirname(MAIN_DB_PATH), { recursive: true });
  _mainDb = new Database(MAIN_DB_PATH);
  _mainDb.pragma('journal_mode = WAL');
  _mainDb.pragma('foreign_keys = ON');
  _mainDb.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return _mainDb;
}

function makeSlug(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── Portal internal API (tenant / MSP lookup) ────────────────────────────────

const PORTAL_INTERNAL_URL = (process.env.PORTAL_INTERNAL_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');

interface PortalTenantLookup {
  slug: string;
  mspSlug: string;
  mspId: string;
  giteaOrg: string;
  tenantId: string | null;
  clientId: string | null;
  domain: string | null;
  displayName: string;
}

/** Shape kept for token-api-server auth diagnostics. */
export interface TenantMspRow {
  tenantSlug: string;
  mspSlug: string;
  tenantId: string | null;
  clientId: string | null;
}

async function resolveTenantViaPortal(tenantSlug: string): Promise<PortalTenantLookup | null> {
  const slug = makeSlug(tenantSlug);
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error('[token-store] SESSION_SECRET is not set — cannot call portal internal API');
    return null;
  }

  try {
    const res = await fetch(`${PORTAL_INTERNAL_URL}/api/internal/tenants/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[token-store] portal tenant lookup failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as PortalTenantLookup;
  } catch (err) {
    console.error('[token-store] portal tenant lookup error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Resolves tenant → MSP info via the portal (same DB the UI uses). */
export async function resolveTenantMspRowForAuth(tenantSlug: string): Promise<TenantMspRow | null> {
  const row = await resolveTenantViaPortal(tenantSlug);
  if (!row) return null;
  return {
    tenantSlug: row.slug,
    mspSlug: row.mspSlug,
    tenantId: row.tenantId,
    clientId: row.clientId,
  };
}

// ─── Decryption helper ────────────────────────────────────────────────────────
// platform_settings values may be AES-256-GCM encrypted (format: iv:tag:ct).

async function decryptValue(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const { tryDecryptSetting } = await import('./server/config-crypto.js');
  return tryDecryptSetting(raw) ?? raw;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type { TenantTokens, ConnectionStatus } from './token-backend';

export interface TenantCreds {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

interface SettingRow { value: string; }

/**
 * Resolves the globally-unique token storage key for a tenant.
 * Format: `{mspSlug}-{tenantSlug}`
 */
async function tokenStorageKey(tenantSlug: string, mspSlugHint?: string): Promise<string> {
  if (mspSlugHint) return `${makeSlug(mspSlugHint)}-${makeSlug(tenantSlug)}`;
  const row = await resolveTenantViaPortal(tenantSlug);
  return `${row?.mspSlug ?? 'unknown'}-${makeSlug(tenantSlug)}`;
}

export interface TenantCredsHint {
  mspSlug?: string | null;
  tenantId?: string | null;
  clientId?: string | null;
}

/**
 * Resolves Graph credentials for a tenant.
 * Tenant identity from portal API; Graph secrets from platform_settings.
 * Optional hint avoids a second portal round-trip when the caller already resolved the tenant.
 */
export async function getTenantCreds(tenantSlug: string, hint?: TenantCredsHint): Promise<TenantCreds> {
  const row = hint?.mspSlug && hint?.tenantId
    ? null
    : await resolveTenantViaPortal(tenantSlug);
  const mspSlug = (hint?.mspSlug?.trim() || row?.mspSlug || '').trim();
  if (!mspSlug) {
    throw new Error(
      `[token-store] Tenant "${tenantSlug}" not found via portal API ` +
      `(${PORTAL_INTERNAL_URL}/api/internal/tenants/...). Check portal is up and SESSION_SECRET matches.`,
    );
  }

  const db = getMainDb();
  const resolvedTenantId =
    (hint?.tenantId?.trim() || row?.tenantId?.trim() || process.env.AZURE_AD_TENANT_ID || '');

  const tenantClientId =
    (hint?.clientId?.trim() || row?.clientId?.trim() || '') || null;
  const tenantSecretRaw = db.prepare<[string], SettingRow>('SELECT value FROM platform_settings WHERE key = ?')
    .get(`tenant:${makeSlug(tenantSlug)}:clientSecret`)?.value ?? null;
  const tenantClientSecret = await decryptValue(tenantSecretRaw);

  if (tenantClientId && tenantClientSecret) {
    if (!resolvedTenantId) throw new Error(`[token-store] No tenantId for "${tenantSlug}"`);
    return { clientId: tenantClientId, clientSecret: tenantClientSecret, tenantId: resolvedTenantId };
  }

  const mspGraphClientId = db.prepare<[string], SettingRow>('SELECT value FROM platform_settings WHERE key = ?')
    .get(`msp:${mspSlug}:graph_client_id`)?.value?.trim() || null;
  const mspGraphClientSecretRaw = db.prepare<[string], SettingRow>('SELECT value FROM platform_settings WHERE key = ?')
    .get(`msp:${mspSlug}:graph_client_secret`)?.value ?? null;
  const mspGraphClientSecret = await decryptValue(mspGraphClientSecretRaw);

  if (mspGraphClientId && mspGraphClientSecret) {
    if (!resolvedTenantId) throw new Error(`[token-store] No tenantId for "${tenantSlug}"`);
    return { clientId: mspGraphClientId, clientSecret: mspGraphClientSecret, tenantId: resolvedTenantId };
  }

  const clientId     = process.env.AZURE_AD_CLIENT_ID     ?? '';
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret || !resolvedTenantId) {
    throw new Error(
      `[token-store] Incomplete Graph credentials for tenant "${tenantSlug}". ` +
      `Set msp:${mspSlug}:graph_client_id and msp:${mspSlug}:graph_client_secret in the MSP settings.`,
    );
  }
  return { clientId, clientSecret, tenantId: resolvedTenantId };
}

export function getSetting(key: string): string | null {
  const row = getMainDb().prepare<[string], SettingRow>('SELECT value FROM platform_settings WHERE key = ?').get(key);
  return row?.value ?? null;
}

/** Direct MSP key lookup — does not require resolving the tenant. */
export async function getMspInternalKeyBySlug(mspSlug: string): Promise<string | null> {
  const raw = getMainDb()
    .prepare<[string], { value: string }>('SELECT value FROM platform_settings WHERE key = ?')
    .get(`msp:${makeSlug(mspSlug)}:internal_key`)?.value ?? null;
  return decryptValue(raw);
}

export async function getMspInternalKeyForTenant(tenantSlug: string, mspSlugHint?: string): Promise<string | null> {
  if (mspSlugHint) return getMspInternalKeyBySlug(mspSlugHint);
  const row = await resolveTenantViaPortal(tenantSlug);
  if (!row) return null;
  return getMspInternalKeyBySlug(row.mspSlug);
}

// ─── Token CRUD — delegates to TokenBackend ───────────────────────────────────

import { getTokenBackend } from './token-backend';
import type { TenantTokens } from './token-backend';

export async function saveTenantTokens(slug: string, tokens: TenantTokens, mspSlugHint?: string): Promise<void> {
  return (await getTokenBackend()).saveTenantTokens(await tokenStorageKey(slug, mspSlugHint), tokens);
}

export async function getTenantTokens(slug: string, mspSlugHint?: string): Promise<TenantTokens | null> {
  return (await getTokenBackend()).getTenantTokens(await tokenStorageKey(slug, mspSlugHint));
}

export async function deleteTenantTokens(slug: string, mspSlugHint?: string): Promise<boolean> {
  return (await getTokenBackend()).deleteTenantTokens(await tokenStorageKey(slug, mspSlugHint));
}

export async function savePendingDeviceCode(slug: string, deviceCode: string, mspSlugHint?: string): Promise<void> {
  return (await getTokenBackend()).savePendingDeviceCode(await tokenStorageKey(slug, mspSlugHint), deviceCode);
}

export async function getPendingDeviceCode(slug: string, mspSlugHint?: string): Promise<string | null> {
  return (await getTokenBackend()).getPendingDeviceCode(await tokenStorageKey(slug, mspSlugHint));
}

export async function getTenantConnectionStatus(slug: string, mspSlugHint?: string) {
  return (await getTokenBackend()).getTenantConnectionStatus(await tokenStorageKey(slug, mspSlugHint));
}

/** Returns the tenant's stored domain (e.g. contoso.onmicrosoft.com), or null if not set. */
export async function getTenantDomain(tenantSlug: string): Promise<string | null> {
  const row = await resolveTenantViaPortal(tenantSlug);
  return row?.domain ?? null;
}

export async function saveMdeRefreshToken(slug: string, refreshTokenEnc: string): Promise<void> {
  return (await getTokenBackend()).saveMdeRefreshToken(await tokenStorageKey(slug), refreshTokenEnc);
}

export async function getMdeRefreshToken(slug: string): Promise<string | null> {
  return (await getTokenBackend()).getMdeRefreshToken(await tokenStorageKey(slug));
}
