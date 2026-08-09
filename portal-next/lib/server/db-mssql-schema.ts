/**
 * db-mssql-schema.ts — T-SQL DDL and migration runner for Config365 MSSQL schema.
 *
 * Tables: c365p_schema_version, c365p_msps, c365p_tenants, c365p_iam_assignments
 * Each migration is idempotent — safe to re-run.
 *
 * Table naming convention: c365p_ prefix for portal tables (c365t_ for token tables).
 */
import 'server-only';

import type { ConnectionPool } from 'mssql';
import sql from 'mssql';

// ─── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS: Array<{ version: number; description: string; ddl: string }> = [
  {
    version: 1,
    description: 'Initial schema',
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
    `,
  },
  {
    version: 2,
    description: 'Rename unprefixed tables to c365p_ prefix',
    ddl: `
      -- Rename old msps → c365p_msps (if old table exists and new one doesn't yet)
      IF OBJECT_ID('dbo.msps', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_msps', 'U') IS NULL
        EXEC sp_rename 'dbo.msps', 'c365p_msps';

      -- Rename old tenants → c365p_tenants
      IF OBJECT_ID('dbo.tenants', 'U') IS NOT NULL AND OBJECT_ID('dbo.c365p_tenants', 'U') IS NULL
        EXEC sp_rename 'dbo.tenants', 'c365p_tenants';

      -- Rename old iam_assignments → c365p_iam_assignments
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
    `,
  },
];

export const MSSQL_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export function listPendingMssqlMigrations(currentVersion: number): Array<{ version: number; description: string }> {
  return MIGRATIONS.filter(m => m.version > currentVersion).map(m => ({ version: m.version, description: m.description }));
}

// ─── Migration runner ─────────────────────────────────────────────────────────

export async function provisionSchema(pool: ConnectionPool): Promise<{ migrationsApplied: number; schemaVersion: number }> {
  // Handle rename of schema_version itself for installs that used the old unprefixed name.
  // Must be done before we try to read from c365p_schema_version.
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

  const currentVersionRow = await pool.request().query<{ version: number }>(
    'SELECT ISNULL(MAX(version), 0) AS version FROM dbo.c365p_schema_version'
  );
  let currentVersion = currentVersionRow.recordset[0]?.version ?? 0;
  let applied = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    // Execute in individual statements (mssql doesn't support GO batches)
    const stmts = migration.ddl
      .split(/;\s*\n/)
      .map(s => s.trim())
      .filter(Boolean);

    for (const stmt of stmts) {
      await pool.request().query(stmt);
    }

    await pool.request()
      .input('version', sql.Int, migration.version)
      .input('description', sql.NVarChar, migration.description)
      .input('appliedAt', sql.NVarChar, new Date().toISOString())
      .query('INSERT INTO dbo.c365p_schema_version (version, description, appliedAt) VALUES (@version, @description, @appliedAt)');

    currentVersion = migration.version;
    applied++;
    console.log(`[db-mssql-schema] Applied migration v${migration.version}: ${migration.description}`);
  }

  return { migrationsApplied: applied, schemaVersion: currentVersion };
}

export async function getSchemaVersion(pool: ConnectionPool): Promise<number> {
  try {
    const result = await pool.request().query<{ version: number }>(
      'SELECT ISNULL(MAX(version), 0) AS version FROM dbo.c365p_schema_version'
    );
    return result.recordset[0]?.version ?? 0;
  } catch {
    return 0;
  }
}
