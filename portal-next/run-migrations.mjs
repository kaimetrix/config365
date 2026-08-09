// run-migrations.ts
import Database from "better-sqlite3";
import sql2 from "mssql";
import { hkdfSync, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// lib/server/db-mssql-schema.ts
import sql from "mssql";
var MIGRATIONS = [
  {
    version: 1,
    description: "Initial schema",
    ddl: `
      -- Version tracking
      IF OBJECT_ID('dbo.c365p_schema_version', 'U') IS NULL
      CREATE TABLE dbo.c365p_schema_version (
        version     INT           NOT NULL PRIMARY KEY,
        description NVARCHAR(255) NOT NULL,
        appliedAt   NVARCHAR(50)  NOT NULL
      );

      -- MSPs
      IF OBJECT_ID('dbo.c365p_msps', 'U') IS NULL
      CREATE TABLE dbo.c365p_msps (
        id          NVARCHAR(255) NOT NULL PRIMARY KEY,
        slug        NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL,
        giteaOrg    NVARCHAR(255) NOT NULL,
        isActive    BIT           NOT NULL DEFAULT 1,
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL,
        CONSTRAINT UQ_c365p_msps_slug UNIQUE (slug)
      );

      -- Tenants
      IF OBJECT_ID('dbo.c365p_tenants', 'U') IS NULL
      CREATE TABLE dbo.c365p_tenants (
        id          NVARCHAR(255) NOT NULL PRIMARY KEY,
        slug        NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL,
        domain      NVARCHAR(255) NULL,
        mspId       NVARCHAR(255) NOT NULL REFERENCES dbo.c365p_msps(id),
        clientId    NVARCHAR(255) NULL,
        tenantId    NVARCHAR(255) NULL,
        isActive    BIT           NOT NULL DEFAULT 1,
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL,
        CONSTRAINT UQ_c365p_tenants_slug UNIQUE (slug)
      );

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_c365p_tenants_domain' AND object_id = OBJECT_ID('dbo.c365p_tenants'))
        CREATE INDEX idx_c365p_tenants_domain ON dbo.c365p_tenants(domain);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_c365p_tenants_msp' AND object_id = OBJECT_ID('dbo.c365p_tenants'))
        CREATE INDEX idx_c365p_tenants_msp ON dbo.c365p_tenants(mspId);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_c365p_tenants_active' AND object_id = OBJECT_ID('dbo.c365p_tenants'))
        CREATE INDEX idx_c365p_tenants_active ON dbo.c365p_tenants(isActive);

      -- IAM assignments
      IF OBJECT_ID('dbo.c365p_iam_assignments', 'U') IS NULL
      CREATE TABLE dbo.c365p_iam_assignments (
        id          NVARCHAR(500) NOT NULL PRIMARY KEY,
        userId      NVARCHAR(255) NOT NULL,
        email       NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL DEFAULT '',
        role        NVARCHAR(50)  NOT NULL,
        mspSlug     NVARCHAR(255) NULL,
        mspSlugNorm AS ISNULL(mspSlug, ''),
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL
      );

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_c365p_iam_user_role_msp' AND object_id = OBJECT_ID('dbo.c365p_iam_assignments'))
        CREATE UNIQUE INDEX UQ_c365p_iam_user_role_msp ON dbo.c365p_iam_assignments(userId, role, mspSlugNorm);
    `
  },
  {
    version: 2,
    description: "Rename unprefixed tables to c365p_ prefix",
    ddl: `
      -- Rename old msps \u2192 c365p_msps (if old table exists and new one doesn't yet)
      IF OBJECT_ID('dbo.msps', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_msps', 'U') IS NULL
        EXEC sp_rename 'dbo.msps', 'c365p_msps';

      -- Rename old tenants \u2192 c365p_tenants
      IF OBJECT_ID('dbo.tenants', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_tenants', 'U') IS NULL
        EXEC sp_rename 'dbo.tenants', 'c365p_tenants';

      -- Rename old iam_assignments \u2192 c365p_iam_assignments
      IF OBJECT_ID('dbo.iam_assignments', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_iam_assignments', 'U') IS NULL
        EXEC sp_rename 'dbo.iam_assignments', 'c365p_iam_assignments';

      -- Create prefixed tables from scratch if neither old nor new exists
      IF OBJECT_ID('dbo.c365p_msps', 'U') IS NULL
      CREATE TABLE dbo.c365p_msps (
        id          NVARCHAR(255) NOT NULL PRIMARY KEY,
        slug        NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL,
        giteaOrg    NVARCHAR(255) NOT NULL,
        isActive    BIT           NOT NULL DEFAULT 1,
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL,
        CONSTRAINT UQ_c365p_msps_slug UNIQUE (slug)
      );

      IF OBJECT_ID('dbo.c365p_tenants', 'U') IS NULL
      CREATE TABLE dbo.c365p_tenants (
        id          NVARCHAR(255) NOT NULL PRIMARY KEY,
        slug        NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL,
        domain      NVARCHAR(255) NULL,
        mspId       NVARCHAR(255) NOT NULL REFERENCES dbo.c365p_msps(id),
        clientId    NVARCHAR(255) NULL,
        tenantId    NVARCHAR(255) NULL,
        isActive    BIT           NOT NULL DEFAULT 1,
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL,
        CONSTRAINT UQ_c365p_tenants_slug UNIQUE (slug)
      );

      IF OBJECT_ID('dbo.c365p_iam_assignments', 'U') IS NULL
      CREATE TABLE dbo.c365p_iam_assignments (
        id          NVARCHAR(500) NOT NULL PRIMARY KEY,
        userId      NVARCHAR(255) NOT NULL,
        email       NVARCHAR(255) NOT NULL,
        displayName NVARCHAR(500) NOT NULL DEFAULT '',
        role        NVARCHAR(50)  NOT NULL,
        mspSlug     NVARCHAR(255) NULL,
        mspSlugNorm AS ISNULL(mspSlug, ''),
        createdAt   NVARCHAR(50)  NOT NULL,
        updatedAt   NVARCHAR(50)  NOT NULL
      );
    `
  }
];
var MSSQL_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
async function provisionSchema(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.schema_version', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_schema_version', 'U') IS NULL
      EXEC sp_rename 'dbo.schema_version', 'c365p_schema_version';

    IF OBJECT_ID('dbo.c365p_schema_version', 'U') IS NULL
    CREATE TABLE dbo.c365p_schema_version (
      version     INT           NOT NULL PRIMARY KEY,
      description NVARCHAR(255) NOT NULL,
      appliedAt   NVARCHAR(50)  NOT NULL
    );
  `);
  const currentVersionRow = await pool.request().query(
    "SELECT ISNULL(MAX(version), 0) AS version FROM dbo.c365p_schema_version"
  );
  let currentVersion = currentVersionRow.recordset[0]?.version ?? 0;
  let applied = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    const stmts = migration.ddl.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await pool.request().query(stmt);
    }
    await pool.request().input("version", sql.Int, migration.version).input("description", sql.NVarChar, migration.description).input("appliedAt", sql.NVarChar, (/* @__PURE__ */ new Date()).toISOString()).query("INSERT INTO dbo.c365p_schema_version (version, description, appliedAt) VALUES (@version, @description, @appliedAt)");
    currentVersion = migration.version;
    applied++;
    console.log(`[db-mssql-schema] Applied migration v${migration.version}: ${migration.description}`);
  }
  return { migrationsApplied: applied, schemaVersion: currentVersion };
}
async function getSchemaVersion(pool) {
  try {
    const result = await pool.request().query(
      "SELECT ISNULL(MAX(version), 0) AS version FROM dbo.c365p_schema_version"
    );
    return result.recordset[0]?.version ?? 0;
  } catch {
    return 0;
  }
}

// lib/server/db-sqlite-schema.ts
var MIGRATIONS2 = [
  {
    version: 1,
    description: "Initial schema + schema_version table",
    ddl: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER NOT NULL PRIMARY KEY,
        description TEXT NOT NULL,
        appliedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS msps (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        displayName TEXT NOT NULL,
        giteaOrg    TEXT NOT NULL,
        isActive    INTEGER NOT NULL DEFAULT 1,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY,
        slug        TEXT NOT NULL UNIQUE,
        displayName TEXT NOT NULL,
        domain      TEXT,
        mspId       TEXT NOT NULL REFERENCES msps(id),
        clientId    TEXT,
        tenantId    TEXT,
        isActive    INTEGER NOT NULL DEFAULT 1,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_domain ON tenants(domain);
      CREATE INDEX IF NOT EXISTS idx_tenants_msp    ON tenants(mspId);
      CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(isActive);

      CREATE TABLE IF NOT EXISTS iam_assignments (
        id          TEXT PRIMARY KEY,
        userId      TEXT NOT NULL,
        email       TEXT NOT NULL,
        displayName TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL,
        mspSlug     TEXT,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_iam_user_role_msp
        ON iam_assignments(userId, role, COALESCE(mspSlug, ''));
    `
  }
];
function getSqliteSchemaVersion(db) {
  try {
    const row = db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_version"
    ).get();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
function provisionSqliteSchema(db) {
  let currentVersion = getSqliteSchemaVersion(db);
  let applied = 0;
  for (const migration of MIGRATIONS2) {
    if (migration.version <= currentVersion) continue;
    db.exec(migration.ddl);
    db.prepare(
      "INSERT INTO schema_version (version, description, appliedAt) VALUES (?, ?, ?)"
    ).run(migration.version, migration.description, (/* @__PURE__ */ new Date()).toISOString());
    currentVersion = migration.version;
    applied++;
    console.log(`[db-sqlite-schema] Applied migration v${migration.version}: ${migration.description}`);
  }
  return { migrationsApplied: applied, schemaVersion: currentVersion };
}

// run-migrations.ts
var DB_PATH = process.env.DB_PATH ?? process.env.MAIN_DB_PATH ?? "/data/db/config365.db";
function decryptSettingValue(stored) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET required to decrypt connection strings");
  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf-8"),
    Buffer.from("config365-settings-v1", "utf-8"),
    Buffer.from("setting-encryption", "utf-8"),
    32
  ));
  const parts = stored.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted setting format");
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return decipher.update(Buffer.from(ctB64, "base64")) + decipher.final("utf8");
}
async function decryptSetting(key) {
  if (!existsSync(DB_PATH)) return null;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db.prepare(
      "SELECT value FROM platform_settings WHERE key = ?"
    ).get(key);
    if (!row?.value) return null;
    if (!row.value.includes(":")) return row.value;
    return decryptSettingValue(row.value);
  } finally {
    db.close();
  }
}
async function runSqlite() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const before = getSqliteSchemaVersion(db);
    const result = provisionSqliteSchema(db);
    console.log(`[run-migrations] SQLite: v${before} \u2192 v${result.schemaVersion} (${result.migrationsApplied} applied)`);
    return result;
  } finally {
    db.close();
  }
}
async function runMssqlPortal(connStr) {
  const pool = await new sql2.ConnectionPool(connStr).connect();
  try {
    const before = await getSchemaVersion(pool);
    const result = await provisionSchema(pool);
    console.log(`[run-migrations] MSSQL portal: v${before} \u2192 v${result.schemaVersion} (${result.migrationsApplied} applied)`);
    return result;
  } finally {
    await pool.close();
  }
}
async function runMssqlToken(connStr) {
  const pool = await new sql2.ConnectionPool(connStr).connect();
  try {
    await pool.request().query(`
      IF OBJECT_ID('dbo.tenant_tokens', 'U') IS NOT NULL
         AND OBJECT_ID('dbo.c365t_tenant_tokens', 'U') IS NULL
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
    console.log("[run-migrations] MSSQL token store provisioned");
  } finally {
    await pool.close();
  }
}
async function main() {
  const portalConn = process.env.MSSQL_PORTAL_CONNECTION_STRING ?? await decryptSetting("mssql_portal_connection_string");
  const tokenConn = process.env.MSSQL_TOKEN_CONNECTION_STRING ?? await decryptSetting("mssql_token_connection_string");
  let schemaVersion = 0;
  let migrationsApplied = 0;
  if (portalConn) {
    const r = await runMssqlPortal(portalConn);
    schemaVersion = Math.max(schemaVersion, r.schemaVersion);
    migrationsApplied += r.migrationsApplied;
  } else {
    const r = await runSqlite();
    schemaVersion = Math.max(schemaVersion, r.schemaVersion);
    migrationsApplied += r.migrationsApplied;
  }
  if (tokenConn) await runMssqlToken(tokenConn);
  const out = { ok: true, schemaVersion, migrationsApplied };
  console.log(JSON.stringify(out));
}
main().catch((err) => {
  console.error("[run-migrations] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
