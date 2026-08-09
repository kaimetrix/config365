/**
 * token-backend.ts — TokenBackend interface and factory.
 *
 * Priority for token storage (independent of portal DB choice):
 *   1. Azure Key Vault  (keyvault_url set in platform_settings)
 *   2. MSSQL            (mssql_token_connection_string set, no KV)
 *   3. SQLite           (default — tokens.db at TOKEN_DB_PATH)
 *
 * The factory reads from platform_settings on every call but caches the
 * resolved backend until the settings change.
 */

import { getSetting, getDecryptedSetting } from './server/settings-store';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TenantTokens {
  accessToken:  string;
  refreshToken: string;
  expiresAt:    string;
  scope:        string;
}

export interface ConnectionStatus {
  connected:  boolean;
  expiresAt:  string | null;
  updatedAt:  string | null;
}

export interface TokenBackend {
  saveTenantTokens(slug: string, tokens: TenantTokens): Promise<void>;
  getTenantTokens(slug: string): Promise<TenantTokens | null>;
  deleteTenantTokens(slug: string): Promise<boolean>;
  savePendingDeviceCode(slug: string, deviceCode: string): Promise<void>;
  getPendingDeviceCode(slug: string): Promise<string | null>;
  getTenantConnectionStatus(slug: string): Promise<ConnectionStatus>;
  saveMdeRefreshToken(slug: string, refreshTokenEnc: string): Promise<void>;
  getMdeRefreshToken(slug: string): Promise<string | null>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _backend: TokenBackend | null = null;
let _backendKey = '';

export async function getTokenBackend(): Promise<TokenBackend> {
  const kvUrl      = getSetting('keyvault_url');
  const tokenConn  = getDecryptedSetting('mssql_token_connection_string');
  const cacheKey   = `${kvUrl ?? ''}|${tokenConn ?? ''}`;

  if (_backend && _backendKey === cacheKey) return _backend;

  let backend: TokenBackend;

  if (kvUrl) {
    const { createKeyVaultBackend } = await import('./token-backend-keyvault');
    backend = createKeyVaultBackend(kvUrl);
  } else if (tokenConn) {
    const { createMssqlTokenBackend } = await import('./token-backend-mssql');
    backend = await createMssqlTokenBackend(tokenConn);
  } else {
    const { sqliteTokenBackend } = await import('./token-backend-sqlite');
    backend = sqliteTokenBackend;
  }

  _backend    = backend;
  _backendKey = cacheKey;
  return backend;
}

/** Forces re-resolution on next call (e.g. after settings change). */
export function resetTokenBackend(): void {
  _backend    = null;
  _backendKey = '';
}
