/**
 * config-crypto.ts — AES-256-GCM encryption for platform_settings values.
 *
 * Derives the encryption key from SESSION_SECRET via HKDF-SHA256 so no
 * additional secret needs to be provisioned. The key is cached in-process.
 *
 * Format: iv:authTag:ciphertext  (all base64, colon-separated)
 * — identical to the existing token encryption format in token-store.ts.
 */
import 'server-only';

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const SALT = Buffer.from('config365-settings-v1', 'utf-8');
const INFO = Buffer.from('setting-encryption', 'utf-8');

let _key: Buffer | null = null;

function deriveKey(): Buffer {
  if (_key) return _key;
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('[config-crypto] SESSION_SECRET is not set');
  _key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf-8'), SALT, INFO, 32));
  return _key;
}

/** Resets the cached key — call after SESSION_SECRET changes (tests only). */
export function _resetKeyCache(): void { _key = null; }

export function encryptSetting(plain: string): string {
  const key = deriveKey();
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSetting(stored: string): string {
  const key   = deriveKey();
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('[config-crypto] Invalid encrypted setting format');
  const [ivB64, tagB64, ctB64] = parts;
  const iv         = Buffer.from(ivB64,  'base64');
  const authTag    = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64,  'base64');
  const decipher   = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Returns null instead of throwing when decryption fails (e.g. key rotation). */
export function tryDecryptSetting(stored: string): string | null {
  try { return decryptSetting(stored); }
  catch { return null; }
}
