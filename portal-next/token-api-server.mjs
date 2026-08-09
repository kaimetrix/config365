var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/server/config-crypto.ts
var config_crypto_exports = {};
__export(config_crypto_exports, {
  _resetKeyCache: () => _resetKeyCache,
  decryptSetting: () => decryptSetting,
  encryptSetting: () => encryptSetting,
  tryDecryptSetting: () => tryDecryptSetting
});
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
function deriveKey() {
  if (_key) return _key;
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("[config-crypto] SESSION_SECRET is not set");
  _key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf-8"), SALT, INFO, 32));
  return _key;
}
function _resetKeyCache() {
  _key = null;
}
function encryptSetting(plain) {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}
function decryptSetting(stored) {
  const key = deriveKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("[config-crypto] Invalid encrypted setting format");
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
function tryDecryptSetting(stored) {
  try {
    return decryptSetting(stored);
  } catch {
    return null;
  }
}
var SALT, INFO, _key;
var init_config_crypto = __esm({
  "lib/server/config-crypto.ts"() {
    "use strict";
    SALT = Buffer.from("config365-settings-v1", "utf-8");
    INFO = Buffer.from("setting-encryption", "utf-8");
    _key = null;
  }
});

// lib/server/settings-store.ts
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
function getSettingsDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  maybeRestoreSettings(_db);
  return _db;
}
function settingsBackupPath() {
  const persist = process.env.CONFIG365_PERSIST_DIR;
  if (persist) return join(persist, "settings-backup.json");
  return join(dirname(DB_PATH), "settings-backup.json");
}
function maybeRestoreSettings(db) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM platform_settings").get()?.n ?? 0;
  if (count > 0) return;
  const candidates = [
    settingsBackupPath(),
    join(dirname(DB_PATH), "settings-backup.json"),
    "/home/config365-data/settings-backup.json"
  ];
  const backup = candidates.find((p) => existsSync(p));
  if (!backup) return;
  try {
    const obj = JSON.parse(readFileSync(backup, "utf-8"));
    const ins = db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)");
    const restore = db.transaction((entries) => {
      for (const [k, v] of entries) ins.run(k, v);
    });
    restore(Object.entries(obj));
    console.log(`[settings-store] Restored ${Object.keys(obj).length} settings from ${backup}.`);
  } catch (e) {
    console.error("[settings-store] Settings restore failed:", e);
  }
}
function getSetting(key) {
  const row = getSettingsDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
  return row?.value ?? null;
}
function getDecryptedSetting(key) {
  const stored = getSetting(key);
  if (!stored) return null;
  const plain = tryDecryptSetting(stored);
  if (plain !== null) return plain;
  if (stored.includes(":") && stored.split(":").length === 3) {
    console.warn(`[settings-store] Decryption failed for key "${key}" \u2014 SESSION_SECRET may have changed.`);
    return null;
  }
  return stored;
}
var DB_PATH, _db;
var init_settings_store = __esm({
  "lib/server/settings-store.ts"() {
    "use strict";
    init_config_crypto();
    DB_PATH = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? process.env.SQLITE_PATH ?? "./data/config365.db";
    _db = null;
  }
});

// lib/token-crypto.ts
var token_crypto_exports = {};
__export(token_crypto_exports, {
  decryptToken: () => decryptToken,
  encryptToken: () => encryptToken,
  getTokenKey: () => getTokenKey,
  resetTokenKeyCache: () => resetTokenKeyCache
});
import { createCipheriv as createCipheriv2, createDecipheriv as createDecipheriv2, randomBytes as randomBytes2, hkdfSync as hkdfSync2 } from "node:crypto";
function getTokenKey() {
  if (_keyCache) return _keyCache;
  const fromEnv = process.env.TOKEN_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length === 32) {
      _keyCache = key;
      return key;
    }
  }
  const dbPath = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? process.env.SQLITE_PATH;
  const sessionSecret = process.env.SESSION_SECRET;
  if (dbPath && sessionSecret) {
    try {
      const Database4 = __require("better-sqlite3");
      const db = new Database4(dbPath, { readonly: true });
      const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get("token_encryption_key");
      db.close();
      if (row?.value) {
        const SALT2 = Buffer.from("config365-settings-v1", "utf-8");
        const INFO2 = Buffer.from("setting-encryption", "utf-8");
        const aesKey = Buffer.from(hkdfSync2("sha256", Buffer.from(sessionSecret, "utf-8"), SALT2, INFO2, 32));
        try {
          const parts = row.value.split(":");
          if (parts.length === 3) {
            const [ivB64, tagB64, ctB64] = parts;
            const iv = Buffer.from(ivB64, "base64");
            const authTag = Buffer.from(tagB64, "base64");
            const ciphertext = Buffer.from(ctB64, "base64");
            const decipher = createDecipheriv2("aes-256-gcm", aesKey, iv);
            decipher.setAuthTag(authTag);
            const decrypted = decipher.update(ciphertext) + decipher.final("utf8");
            const key = Buffer.from(decrypted, "base64");
            if (key.length === 32) {
              _keyCache = key;
              return key;
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  if (sessionSecret) {
    const SALT2 = Buffer.from("config365-token-key-v1", "utf-8");
    const INFO2 = Buffer.from("token-encryption", "utf-8");
    const key = Buffer.from(hkdfSync2("sha256", Buffer.from(sessionSecret, "utf-8"), SALT2, INFO2, 32));
    _keyCache = key;
    return key;
  }
  throw new Error(
    "[token-crypto] No token encryption key available. Set TOKEN_ENCRYPTION_KEY or SESSION_SECRET, or complete the setup wizard."
  );
}
function encryptToken(plain) {
  const key = getTokenKey();
  const iv = randomBytes2(12);
  const cipher = createCipheriv2("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}
function decryptToken(stored) {
  if (!stored) return "";
  const key = getTokenKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("[token-crypto] Invalid encrypted token format");
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv2("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
function resetTokenKeyCache() {
  _keyCache = null;
}
var _keyCache;
var init_token_crypto = __esm({
  "lib/token-crypto.ts"() {
    "use strict";
    _keyCache = null;
  }
});

// lib/token-backend-keyvault.ts
var token_backend_keyvault_exports = {};
__export(token_backend_keyvault_exports, {
  createKeyVaultBackend: () => createKeyVaultBackend
});
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
function secretName(slug) {
  return `${SECRET_PREFIX}${slug.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}
function createKeyVaultBackend(vaultUrl) {
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  async function readPayload(slug) {
    try {
      const secret = await client.getSecret(secretName(slug));
      if (!secret.value) return null;
      return JSON.parse(secret.value);
    } catch (err) {
      const code = err.code;
      if (code === "SecretNotFound" || code === "404") return null;
      throw err;
    }
  }
  async function writePayload(slug, payload) {
    await client.setSecret(secretName(slug), JSON.stringify(payload));
  }
  return {
    async saveTenantTokens(slug, tokens) {
      const { encryptToken: encryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
      const existing = await readPayload(slug) ?? {};
      await writePayload(slug, {
        ...existing,
        accessTokenEnc: encryptToken2(tokens.accessToken),
        refreshTokenEnc: encryptToken2(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    },
    async getTenantTokens(slug) {
      const { decryptToken: decryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
      const payload = await readPayload(slug);
      if (!payload?.accessTokenEnc) return null;
      return {
        accessToken: decryptToken2(payload.accessTokenEnc),
        refreshToken: decryptToken2(payload.refreshTokenEnc ?? ""),
        expiresAt: payload.expiresAt ?? "",
        scope: payload.scope ?? ""
      };
    },
    async deleteTenantTokens(slug) {
      try {
        await client.beginDeleteSecret(secretName(slug));
        return true;
      } catch {
        return false;
      }
    },
    async savePendingDeviceCode(slug, deviceCode) {
      const existing = await readPayload(slug) ?? {};
      await writePayload(slug, {
        ...existing,
        deviceCode,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    },
    async getPendingDeviceCode(slug) {
      const payload = await readPayload(slug);
      return payload?.deviceCode ?? null;
    },
    async getTenantConnectionStatus(slug) {
      const payload = await readPayload(slug);
      if (!payload?.accessTokenEnc) {
        return { connected: false, expiresAt: null, updatedAt: null };
      }
      const expiry = new Date(payload.expiresAt ?? "");
      const connected = !isNaN(expiry.getTime()) && expiry > /* @__PURE__ */ new Date();
      return { connected, expiresAt: payload.expiresAt ?? null, updatedAt: payload.updatedAt ?? null };
    },
    async saveMdeRefreshToken(slug, refreshTokenEnc) {
      const existing = await readPayload(slug) ?? {};
      await writePayload(slug, {
        ...existing,
        mdeRefreshTokenEnc: refreshTokenEnc,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    },
    async getMdeRefreshToken(slug) {
      const payload = await readPayload(slug);
      return payload?.mdeRefreshTokenEnc ?? null;
    }
  };
}
var SECRET_PREFIX;
var init_token_backend_keyvault = __esm({
  "lib/token-backend-keyvault.ts"() {
    "use strict";
    SECRET_PREFIX = "c365-token-";
  }
});

// lib/token-backend-mssql.ts
var token_backend_mssql_exports = {};
__export(token_backend_mssql_exports, {
  createMssqlTokenBackend: () => createMssqlTokenBackend
});
import sql from "mssql";
async function provisionTokenSchema(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.tenant_tokens', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
      EXEC sp_rename 'dbo.tenant_tokens', 'c365t_tenant_tokens';
  `);
  await pool.request().query(`
    IF OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
    CREATE TABLE dbo.c365t_tenant_tokens (
      tenantSlug         NVARCHAR(255) NOT NULL PRIMARY KEY,
      accessTokenEnc     NVARCHAR(MAX) NOT NULL DEFAULT '',
      refreshTokenEnc    NVARCHAR(MAX) NOT NULL DEFAULT '',
      expiresAt          NVARCHAR(50)  NOT NULL DEFAULT '',
      scope              NVARCHAR(MAX) NOT NULL DEFAULT '',
      deviceCode         NVARCHAR(MAX) NULL,
      mdeRefreshTokenEnc NVARCHAR(MAX) NOT NULL DEFAULT '',
      mdeDeviceCode      NVARCHAR(MAX) NOT NULL DEFAULT '',
      updatedAt          NVARCHAR(50)  NOT NULL
    );
  `);
}
async function getPool(connectionString) {
  if (_pool?.connected && _connStr === connectionString) return _pool;
  if (_pool) {
    try {
      await _pool.close();
    } catch {
    }
  }
  const pool = await sql.connect(connectionString);
  await provisionTokenSchema(pool);
  _pool = pool;
  _connStr = connectionString;
  return pool;
}
async function createMssqlTokenBackend(connectionString) {
  const pool = () => getPool(connectionString);
  return {
    async saveTenantTokens(slug, tokens) {
      const { encryptToken: encryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
      const p = await pool();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await p.request().input("slug", sql.NVarChar, slug).input("at", sql.NVarChar, encryptToken2(tokens.accessToken)).input("rt", sql.NVarChar, encryptToken2(tokens.refreshToken)).input("exp", sql.NVarChar, tokens.expiresAt).input("scope", sql.NVarChar, tokens.scope).input("now", sql.NVarChar, now).query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET
            accessTokenEnc=@at, refreshTokenEnc=@rt, expiresAt=@exp, scope=@scope, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,updatedAt)
            VALUES (@slug,@at,@rt,@exp,@scope,@now);
        `);
    },
    async getTenantTokens(slug) {
      const { decryptToken: decryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
      const p = await pool();
      const r = await p.request().input("slug", sql.NVarChar, slug).query(
        "SELECT accessTokenEnc,refreshTokenEnc,expiresAt,scope FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug"
      );
      const row = r.recordset[0];
      if (!row) return null;
      return {
        accessToken: decryptToken2(row.accessTokenEnc),
        refreshToken: decryptToken2(row.refreshTokenEnc),
        expiresAt: row.expiresAt,
        scope: row.scope
      };
    },
    async deleteTenantTokens(slug) {
      const p = await pool();
      const r = await p.request().input("slug", sql.NVarChar, slug).query("DELETE FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug");
      return (r.rowsAffected[0] ?? 0) > 0;
    },
    async savePendingDeviceCode(slug, deviceCode) {
      const p = await pool();
      await p.request().input("slug", sql.NVarChar, slug).input("dc", sql.NVarChar, deviceCode).input("now", sql.NVarChar, (/* @__PURE__ */ new Date()).toISOString()).query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET deviceCode=@dc, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,deviceCode,updatedAt)
            VALUES (@slug,'','','','',@dc,@now);
        `);
    },
    async getPendingDeviceCode(slug) {
      const p = await pool();
      const r = await p.request().input("slug", sql.NVarChar, slug).query("SELECT deviceCode FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug");
      return r.recordset[0]?.deviceCode ?? null;
    },
    async getTenantConnectionStatus(slug) {
      const p = await pool();
      const r = await p.request().input("slug", sql.NVarChar, slug).query(
        "SELECT expiresAt,updatedAt,accessTokenEnc FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug"
      );
      const row = r.recordset[0];
      if (!row || !row.accessTokenEnc) return { connected: false, expiresAt: null, updatedAt: null };
      const expiry = new Date(row.expiresAt);
      const connected = !isNaN(expiry.getTime()) && expiry > /* @__PURE__ */ new Date();
      return { connected, expiresAt: row.expiresAt, updatedAt: row.updatedAt };
    },
    async saveMdeRefreshToken(slug, refreshTokenEnc) {
      const p = await pool();
      await p.request().input("slug", sql.NVarChar, slug).input("mrt", sql.NVarChar, refreshTokenEnc).input("now", sql.NVarChar, (/* @__PURE__ */ new Date()).toISOString()).query(`
          MERGE dbo.c365t_tenant_tokens AS t
          USING (SELECT @slug AS tenantSlug) AS s ON t.tenantSlug=s.tenantSlug
          WHEN MATCHED THEN UPDATE SET mdeRefreshTokenEnc=@mrt, updatedAt=@now
          WHEN NOT MATCHED THEN INSERT
            (tenantSlug,accessTokenEnc,refreshTokenEnc,expiresAt,scope,mdeRefreshTokenEnc,updatedAt)
            VALUES (@slug,'','','','',@mrt,@now);
        `);
    },
    async getMdeRefreshToken(slug) {
      const p = await pool();
      const r = await p.request().input("slug", sql.NVarChar, slug).query(
        "SELECT mdeRefreshTokenEnc FROM dbo.c365t_tenant_tokens WHERE tenantSlug=@slug"
      );
      return r.recordset[0]?.mdeRefreshTokenEnc || null;
    }
  };
}
var _pool, _connStr;
var init_token_backend_mssql = __esm({
  "lib/token-backend-mssql.ts"() {
    "use strict";
    _pool = null;
    _connStr = "";
  }
});

// lib/token-backend-sqlite.ts
var token_backend_sqlite_exports = {};
__export(token_backend_sqlite_exports, {
  sqliteTokenBackend: () => sqliteTokenBackend
});
import Database2 from "better-sqlite3";
import { mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
function getDb() {
  if (_db2) return _db2;
  mkdirSync2(dirname2(TOKEN_DB_PATH), { recursive: true });
  _db2 = new Database2(TOKEN_DB_PATH);
  _db2.pragma("journal_mode = WAL");
  _db2.pragma("foreign_keys = ON");
  _db2.exec(`
    CREATE TABLE IF NOT EXISTS tenant_tokens (
      tenantSlug         TEXT PRIMARY KEY,
      accessTokenEnc     TEXT NOT NULL DEFAULT '',
      refreshTokenEnc    TEXT NOT NULL DEFAULT '',
      expiresAt          TEXT NOT NULL DEFAULT '',
      scope              TEXT NOT NULL DEFAULT '',
      deviceCode         TEXT,
      mdeRefreshTokenEnc TEXT NOT NULL DEFAULT '',
      mdeDeviceCode      TEXT NOT NULL DEFAULT '',
      updatedAt          TEXT NOT NULL
    );
  `);
  return _db2;
}
var TOKEN_DB_PATH, _db2, sqliteTokenBackend;
var init_token_backend_sqlite = __esm({
  "lib/token-backend-sqlite.ts"() {
    "use strict";
    TOKEN_DB_PATH = process.env.TOKEN_DB_PATH ?? "./data/tokens.db";
    _db2 = null;
    sqliteTokenBackend = {
      async saveTenantTokens(slug, tokens) {
        const { encryptToken: encryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
        const now = (/* @__PURE__ */ new Date()).toISOString();
        getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET
        accessTokenEnc  = excluded.accessTokenEnc,
        refreshTokenEnc = excluded.refreshTokenEnc,
        expiresAt       = excluded.expiresAt,
        scope           = excluded.scope,
        updatedAt       = excluded.updatedAt
    `).run(
          slug,
          encryptToken2(tokens.accessToken),
          encryptToken2(tokens.refreshToken),
          tokens.expiresAt,
          tokens.scope,
          now
        );
      },
      async getTenantTokens(slug) {
        const { decryptToken: decryptToken2 } = await Promise.resolve().then(() => (init_token_crypto(), token_crypto_exports));
        const row = getDb().prepare("SELECT accessTokenEnc, refreshTokenEnc, expiresAt, scope FROM tenant_tokens WHERE tenantSlug = ?").get(slug);
        if (!row) return null;
        return {
          accessToken: decryptToken2(row.accessTokenEnc),
          refreshToken: decryptToken2(row.refreshTokenEnc),
          expiresAt: row.expiresAt,
          scope: row.scope
        };
      },
      async deleteTenantTokens(slug) {
        const result = getDb().prepare(
          "DELETE FROM tenant_tokens WHERE tenantSlug = ?"
        ).run(slug);
        return result.changes > 0;
      },
      async savePendingDeviceCode(slug, deviceCode) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, deviceCode, updatedAt)
      VALUES (?, '', '', '', '', ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET deviceCode=excluded.deviceCode, updatedAt=excluded.updatedAt
    `).run(slug, deviceCode, now);
      },
      async getPendingDeviceCode(slug) {
        const row = getDb().prepare(
          "SELECT deviceCode FROM tenant_tokens WHERE tenantSlug = ?"
        ).get(slug);
        return row?.deviceCode ?? null;
      },
      async getTenantConnectionStatus(slug) {
        const row = getDb().prepare("SELECT expiresAt, updatedAt, accessTokenEnc FROM tenant_tokens WHERE tenantSlug = ?").get(slug);
        if (!row || !row.accessTokenEnc) {
          return { connected: false, expiresAt: null, updatedAt: null };
        }
        const expiry = new Date(row.expiresAt);
        const connected = !isNaN(expiry.getTime()) && expiry > /* @__PURE__ */ new Date();
        return { connected, expiresAt: row.expiresAt, updatedAt: row.updatedAt };
      },
      async saveMdeRefreshToken(slug, refreshTokenEnc) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        getDb().prepare(`
      INSERT INTO tenant_tokens (tenantSlug, accessTokenEnc, refreshTokenEnc, expiresAt, scope, mdeRefreshTokenEnc, updatedAt)
      VALUES (?, '', '', '', '', ?, ?)
      ON CONFLICT(tenantSlug) DO UPDATE SET mdeRefreshTokenEnc=excluded.mdeRefreshTokenEnc, updatedAt=excluded.updatedAt
    `).run(slug, refreshTokenEnc, now);
      },
      async getMdeRefreshToken(slug) {
        const row = getDb().prepare(
          "SELECT mdeRefreshTokenEnc FROM tenant_tokens WHERE tenantSlug = ?"
        ).get(slug);
        return row?.mdeRefreshTokenEnc || null;
      }
    };
  }
});

// lib/token-backend.ts
async function getTokenBackend() {
  const kvUrl = getSetting("keyvault_url");
  const tokenConn = getDecryptedSetting("mssql_token_connection_string");
  const cacheKey = `${kvUrl ?? ""}|${tokenConn ?? ""}`;
  if (_backend && _backendKey === cacheKey) return _backend;
  let backend;
  if (kvUrl) {
    const { createKeyVaultBackend: createKeyVaultBackend2 } = await Promise.resolve().then(() => (init_token_backend_keyvault(), token_backend_keyvault_exports));
    backend = createKeyVaultBackend2(kvUrl);
  } else if (tokenConn) {
    const { createMssqlTokenBackend: createMssqlTokenBackend2 } = await Promise.resolve().then(() => (init_token_backend_mssql(), token_backend_mssql_exports));
    backend = await createMssqlTokenBackend2(tokenConn);
  } else {
    const { sqliteTokenBackend: sqliteTokenBackend2 } = await Promise.resolve().then(() => (init_token_backend_sqlite(), token_backend_sqlite_exports));
    backend = sqliteTokenBackend2;
  }
  _backend = backend;
  _backendKey = cacheKey;
  return backend;
}
var _backend, _backendKey;
var init_token_backend = __esm({
  "lib/token-backend.ts"() {
    "use strict";
    init_settings_store();
    _backend = null;
    _backendKey = "";
  }
});

// lib/token-store.ts
var token_store_exports = {};
__export(token_store_exports, {
  deleteTenantTokens: () => deleteTenantTokens,
  getMdeRefreshToken: () => getMdeRefreshToken,
  getMspInternalKeyBySlug: () => getMspInternalKeyBySlug,
  getMspInternalKeyForTenant: () => getMspInternalKeyForTenant,
  getPendingDeviceCode: () => getPendingDeviceCode,
  getSetting: () => getSetting2,
  getTenantConnectionStatus: () => getTenantConnectionStatus,
  getTenantCreds: () => getTenantCreds,
  getTenantDomain: () => getTenantDomain,
  getTenantTokens: () => getTenantTokens,
  resolveTenantMspRowForAuth: () => resolveTenantMspRowForAuth,
  saveMdeRefreshToken: () => saveMdeRefreshToken,
  savePendingDeviceCode: () => savePendingDeviceCode,
  saveTenantTokens: () => saveTenantTokens
});
import Database3 from "better-sqlite3";
import { mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function getMainDb() {
  if (_mainDb) return _mainDb;
  mkdirSync3(dirname3(MAIN_DB_PATH), { recursive: true });
  _mainDb = new Database3(MAIN_DB_PATH);
  _mainDb.pragma("journal_mode = WAL");
  _mainDb.pragma("foreign_keys = ON");
  _mainDb.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return _mainDb;
}
function makeSlug(raw) {
  return raw.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
async function resolveTenantViaPortal(tenantSlug) {
  const slug = makeSlug(tenantSlug);
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error("[token-store] SESSION_SECRET is not set \u2014 cannot call portal internal API");
    return null;
  }
  try {
    const res = await fetch(`${PORTAL_INTERNAL_URL}/api/internal/tenants/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store"
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[token-store] portal tenant lookup failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[token-store] portal tenant lookup error:", err instanceof Error ? err.message : err);
    return null;
  }
}
async function resolveTenantMspRowForAuth(tenantSlug) {
  const row = await resolveTenantViaPortal(tenantSlug);
  if (!row) return null;
  return {
    tenantSlug: row.slug,
    mspSlug: row.mspSlug,
    tenantId: row.tenantId,
    clientId: row.clientId
  };
}
async function decryptValue(raw) {
  if (!raw) return null;
  const { tryDecryptSetting: tryDecryptSetting2 } = await Promise.resolve().then(() => (init_config_crypto(), config_crypto_exports));
  return tryDecryptSetting2(raw) ?? raw;
}
async function tokenStorageKey(tenantSlug, mspSlugHint) {
  if (mspSlugHint) return `${makeSlug(mspSlugHint)}-${makeSlug(tenantSlug)}`;
  const row = await resolveTenantViaPortal(tenantSlug);
  return `${row?.mspSlug ?? "unknown"}-${makeSlug(tenantSlug)}`;
}
async function getTenantCreds(tenantSlug, hint) {
  const row = hint?.mspSlug && hint?.tenantId ? null : await resolveTenantViaPortal(tenantSlug);
  const mspSlug = (hint?.mspSlug?.trim() || row?.mspSlug || "").trim();
  if (!mspSlug) {
    throw new Error(
      `[token-store] Tenant "${tenantSlug}" not found via portal API (${PORTAL_INTERNAL_URL}/api/internal/tenants/...). Check portal is up and SESSION_SECRET matches.`
    );
  }
  const db = getMainDb();
  const resolvedTenantId = hint?.tenantId?.trim() || row?.tenantId?.trim() || process.env.AZURE_AD_TENANT_ID || "";
  const tenantClientId = hint?.clientId?.trim() || row?.clientId?.trim() || "" || null;
  const tenantSecretRaw = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(`tenant:${makeSlug(tenantSlug)}:clientSecret`)?.value ?? null;
  const tenantClientSecret = await decryptValue(tenantSecretRaw);
  if (tenantClientId && tenantClientSecret) {
    if (!resolvedTenantId) throw new Error(`[token-store] No tenantId for "${tenantSlug}"`);
    return { clientId: tenantClientId, clientSecret: tenantClientSecret, tenantId: resolvedTenantId };
  }
  const mspGraphClientId = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(`msp:${mspSlug}:graph_client_id`)?.value?.trim() || null;
  const mspGraphClientSecretRaw = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(`msp:${mspSlug}:graph_client_secret`)?.value ?? null;
  const mspGraphClientSecret = await decryptValue(mspGraphClientSecretRaw);
  if (mspGraphClientId && mspGraphClientSecret) {
    if (!resolvedTenantId) throw new Error(`[token-store] No tenantId for "${tenantSlug}"`);
    return { clientId: mspGraphClientId, clientSecret: mspGraphClientSecret, tenantId: resolvedTenantId };
  }
  const clientId = process.env.AZURE_AD_CLIENT_ID ?? "";
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret || !resolvedTenantId) {
    throw new Error(
      `[token-store] Incomplete Graph credentials for tenant "${tenantSlug}". Set msp:${mspSlug}:graph_client_id and msp:${mspSlug}:graph_client_secret in the MSP settings.`
    );
  }
  return { clientId, clientSecret, tenantId: resolvedTenantId };
}
function getSetting2(key) {
  const row = getMainDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
  return row?.value ?? null;
}
async function getMspInternalKeyBySlug(mspSlug) {
  const raw = getMainDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(`msp:${makeSlug(mspSlug)}:internal_key`)?.value ?? null;
  return decryptValue(raw);
}
async function getMspInternalKeyForTenant(tenantSlug, mspSlugHint) {
  if (mspSlugHint) return getMspInternalKeyBySlug(mspSlugHint);
  const row = await resolveTenantViaPortal(tenantSlug);
  if (!row) return null;
  return getMspInternalKeyBySlug(row.mspSlug);
}
async function saveTenantTokens(slug, tokens, mspSlugHint) {
  return (await getTokenBackend()).saveTenantTokens(await tokenStorageKey(slug, mspSlugHint), tokens);
}
async function getTenantTokens(slug, mspSlugHint) {
  return (await getTokenBackend()).getTenantTokens(await tokenStorageKey(slug, mspSlugHint));
}
async function deleteTenantTokens(slug, mspSlugHint) {
  return (await getTokenBackend()).deleteTenantTokens(await tokenStorageKey(slug, mspSlugHint));
}
async function savePendingDeviceCode(slug, deviceCode, mspSlugHint) {
  return (await getTokenBackend()).savePendingDeviceCode(await tokenStorageKey(slug, mspSlugHint), deviceCode);
}
async function getPendingDeviceCode(slug, mspSlugHint) {
  return (await getTokenBackend()).getPendingDeviceCode(await tokenStorageKey(slug, mspSlugHint));
}
async function getTenantConnectionStatus(slug, mspSlugHint) {
  return (await getTokenBackend()).getTenantConnectionStatus(await tokenStorageKey(slug, mspSlugHint));
}
async function getTenantDomain(tenantSlug) {
  const row = await resolveTenantViaPortal(tenantSlug);
  return row?.domain ?? null;
}
async function saveMdeRefreshToken(slug, refreshTokenEnc) {
  return (await getTokenBackend()).saveMdeRefreshToken(await tokenStorageKey(slug), refreshTokenEnc);
}
async function getMdeRefreshToken(slug) {
  return (await getTokenBackend()).getMdeRefreshToken(await tokenStorageKey(slug));
}
var MAIN_DB_PATH, _mainDb, PORTAL_INTERNAL_URL;
var init_token_store = __esm({
  "lib/token-store.ts"() {
    "use strict";
    init_token_backend();
    MAIN_DB_PATH = process.env.MAIN_DB_PATH ?? process.env.DB_PATH ?? "./data/config365.db";
    _mainDb = null;
    PORTAL_INTERNAL_URL = (process.env.PORTAL_INTERNAL_URL ?? "http://127.0.0.1:4321").replace(/\/$/, "");
  }
});

// token-api-server.ts
import { createServer } from "node:http";

// lib/tenant-auth.ts
init_token_store();
function tokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}
function deviceCodeEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
}
var FETCH_TIMEOUT_MS = 3e4;
async function fetchWithTimeout(url, opts, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`[tenant-auth] Request to ${new URL(url).hostname} timed out after ${timeoutMs / 1e3}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
var GRAPH_SCOPES = [
  "https://graph.microsoft.com/DeviceManagementApps.ReadWrite.All",
  "https://graph.microsoft.com/DeviceManagementConfiguration.ReadWrite.All",
  "https://graph.microsoft.com/DeviceManagementManagedDevices.ReadWrite.All",
  "https://graph.microsoft.com/DeviceManagementManagedDevices.PrivilegedOperations.All",
  "https://graph.microsoft.com/DeviceManagementScripts.ReadWrite.All",
  "https://graph.microsoft.com/DeviceManagementServiceConfig.ReadWrite.All",
  "https://graph.microsoft.com/CustomSecAttributeDefinition.ReadWrite.All",
  "https://graph.microsoft.com/Directory.ReadWrite.All",
  "https://graph.microsoft.com/Directory.AccessAsUser.All",
  "https://graph.microsoft.com/Group.ReadWrite.All",
  "https://graph.microsoft.com/Policy.Read.All",
  "https://graph.microsoft.com/Policy.ReadWrite.AuthenticationMethod",
  "https://graph.microsoft.com/Policy.ReadWrite.Authorization",
  "https://graph.microsoft.com/Policy.ReadWrite.ConditionalAccess",
  "https://graph.microsoft.com/Policy.ReadWrite.DeviceConfiguration",
  "https://graph.microsoft.com/Policy.ReadWrite.MobilityManagement",
  "https://graph.microsoft.com/Policy.ReadWrite.PermissionGrant",
  "https://graph.microsoft.com/RoleManagement.ReadWrite.Directory",
  "https://graph.microsoft.com/Application.ReadWrite.All",
  "https://graph.microsoft.com/AuditLog.Read.All",
  "https://graph.microsoft.com/SecurityEvents.Read.All",
  "https://graph.microsoft.com/User.Read.All",
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
  "offline_access"
].join(" ");
async function extractError(res) {
  try {
    const body = await res.json();
    const code = body.error ?? "unknown_error";
    const desc = body.error_description?.split("\r\n")[0].trim();
    return desc ? `${code} (${desc})` : code;
  } catch {
    return "unparseable_error";
  }
}
async function startDeviceCodeFlow(tenantSlug, hint) {
  const { clientId, clientSecret, tenantId } = await getTenantCreds(tenantSlug, hint);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: GRAPH_SCOPES
    // Device code flow uses public client mode (no client_secret at the /devicecode endpoint).
    // "Allow public client flows" must be enabled on the Azure AD app registration.
  });
  const res = await fetchWithTimeout(deviceCodeEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Device code initiation failed: HTTP ${res.status} / ${errCode}`);
  }
  const data = await res.json();
  await savePendingDeviceCode(tenantSlug, data.device_code, hint?.mspSlug ?? void 0);
  return {
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval
  };
}
function extractTid(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return typeof payload.tid === "string" ? payload.tid : null;
  } catch {
    return null;
  }
}
async function pollDeviceCodeFlow(tenantSlug, hint) {
  const deviceCode = await getPendingDeviceCode(tenantSlug, hint?.mspSlug ?? void 0);
  if (!deviceCode) throw new Error(`[tenant-auth] No pending device code for "${tenantSlug}"`);
  const { clientId, clientSecret, tenantId } = await getTenantCreds(tenantSlug, hint);
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode
    // No client_secret — device code flow uses public client mode.
  });
  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    let errCode;
    try {
      const body = await res.json();
      errCode = body.error ?? "unknown";
    } catch {
      errCode = "unparseable";
    }
    if (errCode === "authorization_pending" || errCode === "slow_down") return { status: "pending" };
    if (errCode === "authorization_declined" || errCode === "expired_token" || errCode === "invalid_grant") return { status: "expired" };
    console.error(`[tenant-auth] Poll failed: HTTP ${res.status} / ${errCode}`);
    return { status: "error", reason: errCode };
  }
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1e3).toISOString();
  const jwtTid = extractTid(data.access_token);
  if (jwtTid && tenantId && jwtTid.toLowerCase() !== tenantId.toLowerCase()) {
    await savePendingDeviceCode(tenantSlug, "", hint?.mspSlug ?? void 0);
    console.warn(`[tenant-auth] Tenant mismatch for "${tenantSlug}": expected ${tenantId}, got ${jwtTid}`);
    return { status: "tenant_mismatch", expected: tenantId, got: jwtTid };
  }
  await saveTenantTokens(tenantSlug, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope ?? GRAPH_SCOPES
  }, hint?.mspSlug ?? void 0);
  await savePendingDeviceCode(tenantSlug, "", hint?.mspSlug ?? void 0);
  return { status: "success" };
}
var REFRESH_THRESHOLD_MS = 10 * 60 * 1e3;
var EXCHANGE_SCOPE = "https://outlook.office365.com/.default";
function sharePointScopeFromDomain(domain) {
  const normalized = domain.trim().toLowerCase();
  const onMicrosoft = normalized.match(/^([a-z0-9-]+)\.onmicrosoft\.(com|us|de)$/);
  if (onMicrosoft) {
    return `https://${onMicrosoft[1]}.sharepoint.com/.default`;
  }
  const sharePointHost = normalized.match(/^([a-z0-9-]+)\.sharepoint\.com$/);
  if (sharePointHost) {
    return `https://${sharePointHost[1]}.sharepoint.com/.default`;
  }
  const prefix = normalized.split(".")[0];
  if (!prefix) {
    throw new Error(`[tenant-auth] Cannot derive SharePoint tenant prefix from domain "${domain}"`);
  }
  return `https://${prefix}.sharepoint.com/.default`;
}
function sharePointAdminUrlFromDomain(domain) {
  try {
    const scope = sharePointScopeFromDomain(domain);
    const match = scope.match(/^https:\/\/([a-z0-9-]+)\.sharepoint\.com\/\.default$/);
    if (!match) return null;
    return `https://${match[1]}-admin.sharepoint.com`;
  } catch {
    return null;
  }
}
function decodeJwtPayload(token) {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - base64.length % 4) % 4;
    const padded = base64 + "=".repeat(padLen);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
function userPrincipalNameFromAccessToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return void 0;
  for (const key of ["upn", "preferred_username", "unique_name", "email"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return void 0;
}
var MDE_SCOPE = "https://api.securitycenter.microsoft.com/.default";
async function getOrRefreshTenantToken(tenantSlug) {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Run the connect-tenant workflow first.`);
  }
  const expiresAt = new Date(stored.expiresAt);
  const msUntilExpiry = expiresAt.getTime() - Date.now();
  if (msUntilExpiry > REFRESH_THRESHOLD_MS) {
    return stored.accessToken;
  }
  const { clientId, tenantId } = await getTenantCreds(tenantSlug);
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    scope: GRAPH_SCOPES
    // always use base scopes, not the expanded list Azure returns
  });
  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Token refresh failed: HTTP ${res.status} / ${errCode}`);
  }
  const data = await res.json();
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1e3).toISOString();
  await saveTenantTokens(tenantSlug, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: newExpiresAt,
    scope: data.scope ?? stored.scope
  });
  return data.access_token;
}
async function getExchangeTenantToken(tenantSlug) {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Complete the device code flow first.`);
  }
  const { clientId, tenantId } = await getTenantCreds(tenantSlug);
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    scope: EXCHANGE_SCOPE
  });
  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] Exchange token request failed: HTTP ${res.status} / ${errCode}`);
  }
  const data = await res.json();
  return data.access_token;
}
async function getSharePointTenantToken(tenantSlug) {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored) {
    throw new Error(`[tenant-auth] No stored token for tenant "${tenantSlug}". Complete the device code flow first.`);
  }
  const domain = await getTenantDomain(tenantSlug);
  if (!domain) {
    throw new Error(`[tenant-auth] No tenant domain saved for "${tenantSlug}". Set domain in portal tenant settings.`);
  }
  const { clientId, tenantId } = await getTenantCreds(tenantSlug);
  const scope = sharePointScopeFromDomain(domain);
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    scope
  });
  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] SharePoint token request failed: HTTP ${res.status} / ${errCode}`);
  }
  const data = await res.json();
  return data.access_token;
}
async function getMdeTenantToken(tenantSlug) {
  const stored = await getTenantTokens(tenantSlug);
  if (!stored?.refreshToken) {
    throw new Error(`[tenant-auth] No token for tenant "${tenantSlug}". Complete the device code flow in the portal first.`);
  }
  const { clientId, tenantId } = await getTenantCreds(tenantSlug);
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    scope: MDE_SCOPE
  });
  const res = await fetchWithTimeout(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  }, 1e4);
  if (!res.ok) {
    const errCode = await extractError(res);
    throw new Error(`[tenant-auth] MDE token request failed: HTTP ${res.status} / ${errCode}`);
  }
  const data = await res.json();
  if (data.refresh_token) {
    await saveTenantTokens(tenantSlug, {
      ...stored,
      refreshToken: data.refresh_token
    });
  }
  return data.access_token;
}

// token-api-server.ts
init_token_store();
var PORT = parseInt(process.env.INTERNAL_API_PORT ?? "4322", 10);
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Connection": "close"
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function authenticateForTenant(req, res, tenantSlug, mspSlugHint) {
  const expectedKey = await getMspInternalKeyForTenant(tenantSlug, mspSlugHint);
  if (!expectedKey) {
    if (mspSlugHint) {
      json(res, 403, { error: "msp_key_not_configured" });
      return false;
    }
    const { resolveTenantMspRowForAuth: resolveTenantMspRowForAuth2 } = await Promise.resolve().then(() => (init_token_store(), token_store_exports));
    const row = await resolveTenantMspRowForAuth2(tenantSlug);
    if (!row) {
      console.error(`[token-api] tenant_not_found for slug="${tenantSlug}" (portal internal lookup)`);
      json(res, 404, {
        error: "tenant_not_found",
        detail: `Tenant "${tenantSlug}" was not found via the portal API. MSP/tenant rows must exist in the portal (same DB the UI uses).`
      });
      return false;
    }
    json(res, 403, { error: "msp_key_not_configured" });
    return false;
  }
  const auth = req.headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer !== expectedKey) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}
async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method?.toUpperCase() ?? "GET";
  if (method === "GET" && path === "/health") {
    return json(res, 200, { ok: true });
  }
  try {
    if (method === "POST" && path === "/tenant-auth/device-start") {
      const body = JSON.parse(await readBody(req));
      if (!body.tenantSlug) return json(res, 400, { error: "tenantSlug is required" });
      if (!await authenticateForTenant(req, res, body.tenantSlug, body.mspSlug)) return;
      const hint = {
        mspSlug: body.mspSlug,
        tenantId: body.tenantId,
        clientId: body.clientId
      };
      const result = await startDeviceCodeFlow(body.tenantSlug, hint);
      return json(res, 200, result);
    }
    if (method === "GET" && path === "/tenant-auth/device-poll") {
      const tenantSlug = url.searchParams.get("tenantSlug");
      const mspSlug = url.searchParams.get("mspSlug") ?? void 0;
      if (!tenantSlug) return json(res, 400, { error: "tenantSlug query param is required" });
      if (!await authenticateForTenant(req, res, tenantSlug, mspSlug)) return;
      const result = await pollDeviceCodeFlow(tenantSlug, { mspSlug });
      return json(res, 200, result);
    }
    if (method === "POST" && path === "/tenant-auth/token") {
      const body = JSON.parse(await readBody(req));
      if (!body.tenantSlug) return json(res, 400, { error: "tenantSlug is required" });
      if (!await authenticateForTenant(req, res, body.tenantSlug)) return;
      let accessToken;
      if (body.resource === "exchange") {
        accessToken = await getExchangeTenantToken(body.tenantSlug);
        const domain = await getTenantDomain(body.tenantSlug);
        const userPrincipalName = userPrincipalNameFromAccessToken(accessToken);
        return json(res, 200, {
          accessToken,
          organizationName: domain ?? void 0,
          userPrincipalName
        });
      } else if (body.resource === "sharepoint") {
        accessToken = await getSharePointTenantToken(body.tenantSlug);
        const domain = await getTenantDomain(body.tenantSlug);
        return json(res, 200, {
          accessToken,
          organizationName: domain ?? void 0,
          sharePointAdminUrl: domain ? sharePointAdminUrlFromDomain(domain) ?? void 0 : void 0
        });
      } else if (body.resource === "mde") {
        accessToken = await getMdeTenantToken(body.tenantSlug);
      } else {
        accessToken = await getOrRefreshTenantToken(body.tenantSlug);
      }
      return json(res, 200, { accessToken });
    }
    if (method === "DELETE" && path === "/tenant-auth/disconnect") {
      const body = JSON.parse(await readBody(req));
      if (!body.tenantSlug) return json(res, 400, { error: "tenantSlug is required" });
      if (!await authenticateForTenant(req, res, body.tenantSlug)) return;
      const removed = await deleteTenantTokens(body.tenantSlug);
      return json(res, 200, { ok: removed });
    }
    if (method === "GET" && path === "/tenant-auth/status") {
      const tenantSlug = url.searchParams.get("tenantSlug");
      if (!tenantSlug) return json(res, 400, { error: "tenantSlug query param is required" });
      if (!await authenticateForTenant(req, res, tenantSlug)) return;
      const status = await getTenantConnectionStatus(tenantSlug);
      return json(res, 200, status);
    }
    if (method === "GET" && path === "/tenant-auth/graph-app") {
      const tenantSlug = url.searchParams.get("tenantSlug");
      if (!tenantSlug) return json(res, 400, { error: "tenantSlug query param is required" });
      if (!await authenticateForTenant(req, res, tenantSlug)) return;
      const { clientId, tenantId } = await getTenantCreds(tenantSlug);
      return json(res, 200, { clientId, tenantId });
    }
    json(res, 404, { error: "not_found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[token-api] ${method} ${path} error: ${message}`);
    json(res, 500, { error: "internal_error", detail: message });
  }
}
var server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[token-api] Unhandled error:", err);
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[token-api] Listening on 0.0.0.0:${PORT} (internal only \u2014 per-MSP key auth)`);
});
process.on("SIGTERM", () => {
  server.close(() => {
    console.log("[token-api] Shutting down gracefully");
    process.exit(0);
  });
});
