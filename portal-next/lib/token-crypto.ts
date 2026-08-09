/**
 * token-crypto.ts — AES-256-GCM encryption for tenant tokens.
 *
 * Works in both the portal (Next.js server) and token-api (standalone Node.js)
 * contexts — intentionally no `server-only` import.
 *
 * Key resolution priority:
 *   1. TOKEN_ENCRYPTION_KEY env var (base64, 32 bytes) — legacy / migration
 *   2. `token_encryption_key` in platform_settings SQLite (encrypted with SESSION_SECRET)
 *   3. HKDF derivation from SESSION_SECRET (fallback — deterministic but not persisted)
 *
 * In the portal, `settings-store.ts::getOrCreateTokenEncryptionKey()` generates and
 * persists the key in platform_settings so that priority 2 succeeds on every request.
 */

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

let _keyCache: Buffer | null = null;

export function getTokenKey(): Buffer {
  if (_keyCache) return _keyCache;

  // Priority 1: legacy env var (migration path — keep working if set)
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length === 32) {
      _keyCache = key;
      return key;
    }
  }

  // Priority 2: read encrypted key from platform_settings SQLite
  const dbPath        = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? process.env.SQLITE_PATH;
  const sessionSecret = process.env.SESSION_SECRET;

  if (dbPath && sessionSecret) {
    try {
      // Use require() so this module stays importable in both CJS and ESM contexts
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get('token_encryption_key') as
        | { value: string }
        | undefined;
      db.close();

      if (row?.value) {
        const SALT   = Buffer.from('config365-settings-v1', 'utf-8');
        const INFO   = Buffer.from('setting-encryption', 'utf-8');
        const aesKey = Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf-8'), SALT, INFO, 32));
        try {
          const parts = row.value.split(':');
          if (parts.length === 3) {
            const [ivB64, tagB64, ctB64] = parts;
            const iv         = Buffer.from(ivB64,  'base64');
            const authTag    = Buffer.from(tagB64, 'base64');
            const ciphertext = Buffer.from(ctB64,  'base64');
            const decipher   = createDecipheriv('aes-256-gcm', aesKey, iv);
            decipher.setAuthTag(authTag);
            const decrypted = decipher.update(ciphertext) + decipher.final('utf8');
            const key = Buffer.from(decrypted, 'base64');
            if (key.length === 32) {
              _keyCache = key;
              return key;
            }
          }
        } catch { /* decryption failed — fall through */ }
      }
    } catch { /* DB not available yet — first boot or different env */ }
  }

  // Priority 3: derive from SESSION_SECRET (deterministic fallback)
  // This ensures token-api always has a working key even before the first
  // portal setup completes. The portal will persist a key on first run.
  if (sessionSecret) {
    const SALT = Buffer.from('config365-token-key-v1', 'utf-8');
    const INFO = Buffer.from('token-encryption', 'utf-8');
    const key  = Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'utf-8'), SALT, INFO, 32));
    _keyCache  = key;
    return key;
  }

  throw new Error(
    '[token-crypto] No token encryption key available. ' +
    'Set TOKEN_ENCRYPTION_KEY or SESSION_SECRET, or complete the setup wizard.'
  );
}

export function encryptToken(plain: string): string {
  const key       = getTokenKey();
  const iv        = randomBytes(12);
  const cipher    = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptToken(stored: string): string {
  if (!stored) return '';
  const key        = getTokenKey();
  const parts      = stored.split(':');
  if (parts.length !== 3) throw new Error('[token-crypto] Invalid encrypted token format');
  const [ivB64, tagB64, ctB64] = parts;
  const iv         = Buffer.from(ivB64,  'base64');
  const authTag    = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64,  'base64');
  const decipher   = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Resets the cached key — call after SESSION_SECRET or TOKEN_ENCRYPTION_KEY changes. */
export function resetTokenKeyCache(): void {
  _keyCache = null;
}
