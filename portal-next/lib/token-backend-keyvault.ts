/**
 * token-backend-keyvault.ts — Azure Key Vault implementation of TokenBackend.
 *
 * Each tenant's token data is stored as a single JSON secret in Key Vault.
 *
 * Secret naming: `c365-token-{mspSlug}-{tenantSlug}`
 *   — the compound key is supplied by token-store.ts::tokenStorageKey(), so this
 *     backend receives the pre-composed "{mspSlug}-{tenantSlug}" string as `slug`.
 *   — Azure Key Vault names allow only alphanumeric characters and hyphens;
 *     secretName() replaces any other characters with hyphens.
 *
 * The token values are AES-256-GCM encrypted (via token-crypto.ts) before being
 * stored in the JSON, so the raw tokens are never in plain text in Key Vault.
 *
 * Authentication uses DefaultAzureCredential (managed identity in production on
 * Azure Container Apps; AZURE_* env vars for local dev / service principal).
 */

import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import type { TokenBackend, TenantTokens, ConnectionStatus } from './token-backend';

const SECRET_PREFIX = 'c365-token-';

function secretName(slug: string): string {
  // KV names: alphanumeric and hyphens only; replace underscores/other chars
  return `${SECRET_PREFIX}${slug.replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

interface KvTokenPayload {
  accessTokenEnc?:     string;
  refreshTokenEnc?:    string;
  expiresAt?:          string;
  scope?:              string;
  deviceCode?:         string;
  mdeRefreshTokenEnc?: string;
  updatedAt?:          string;
}

export function createKeyVaultBackend(vaultUrl: string): TokenBackend {
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());

  async function readPayload(slug: string): Promise<KvTokenPayload | null> {
    try {
      const secret = await client.getSecret(secretName(slug));
      if (!secret.value) return null;
      return JSON.parse(secret.value) as KvTokenPayload;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SecretNotFound' || code === '404') return null;
      throw err;
    }
  }

  async function writePayload(slug: string, payload: KvTokenPayload): Promise<void> {
    await client.setSecret(secretName(slug), JSON.stringify(payload));
  }

  return {
    async saveTenantTokens(slug: string, tokens: TenantTokens): Promise<void> {
      const { encryptToken } = await import('./token-crypto');
      const existing = (await readPayload(slug)) ?? {};
      await writePayload(slug, {
        ...existing,
        accessTokenEnc:  encryptToken(tokens.accessToken),
        refreshTokenEnc: encryptToken(tokens.refreshToken),
        expiresAt:       tokens.expiresAt,
        scope:           tokens.scope,
        updatedAt:       new Date().toISOString(),
      });
    },

    async getTenantTokens(slug: string): Promise<TenantTokens | null> {
      const { decryptToken } = await import('./token-crypto');
      const payload = await readPayload(slug);
      if (!payload?.accessTokenEnc) return null;
      return {
        accessToken:  decryptToken(payload.accessTokenEnc),
        refreshToken: decryptToken(payload.refreshTokenEnc ?? ''),
        expiresAt:    payload.expiresAt ?? '',
        scope:        payload.scope ?? '',
      };
    },

    async deleteTenantTokens(slug: string): Promise<boolean> {
      try {
        await client.beginDeleteSecret(secretName(slug));
        return true;
      } catch {
        return false;
      }
    },

    async savePendingDeviceCode(slug: string, deviceCode: string): Promise<void> {
      const existing = (await readPayload(slug)) ?? {};
      await writePayload(slug, {
        ...existing,
        deviceCode,
        updatedAt: new Date().toISOString(),
      });
    },

    async getPendingDeviceCode(slug: string): Promise<string | null> {
      const payload = await readPayload(slug);
      return payload?.deviceCode ?? null;
    },

    async getTenantConnectionStatus(slug: string): Promise<ConnectionStatus> {
      const payload = await readPayload(slug);
      if (!payload?.accessTokenEnc) {
        return { connected: false, expiresAt: null, updatedAt: null };
      }
      const expiry    = new Date(payload.expiresAt ?? '');
      const connected = !isNaN(expiry.getTime()) && expiry > new Date();
      return { connected, expiresAt: payload.expiresAt ?? null, updatedAt: payload.updatedAt ?? null };
    },

    async saveMdeRefreshToken(slug: string, refreshTokenEnc: string): Promise<void> {
      const existing = (await readPayload(slug)) ?? {};
      await writePayload(slug, {
        ...existing,
        mdeRefreshTokenEnc: refreshTokenEnc,
        updatedAt:          new Date().toISOString(),
      });
    },

    async getMdeRefreshToken(slug: string): Promise<string | null> {
      const payload = await readPayload(slug);
      return payload?.mdeRefreshTokenEnc ?? null;
    },
  };
}
