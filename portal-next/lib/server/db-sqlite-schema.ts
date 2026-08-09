/**
 * SQLite schema migration runner for Config365 portal DB.
 * Mirrors the MSSQL versioned migration pattern in db-mssql-schema.ts.
 */
import 'server-only';

import type Database from 'better-sqlite3';

export const SQLITE_SCHEMA_VERSION = 1;

const MIGRATIONS: Array<{ version: number; description: string; ddl: string }> = [
  {
    version: 1,
    description: 'Initial schema + schema_version table',
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
    `,
  },
];

export function getSqliteSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare<[], { version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_version',
    ).get();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

export function provisionSqliteSchema(db: Database.Database): { migrationsApplied: number; schemaVersion: number } {
  let currentVersion = getSqliteSchemaVersion(db);
  let applied = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec(migration.ddl);
    db.prepare(
      'INSERT INTO schema_version (version, description, appliedAt) VALUES (?, ?, ?)',
    ).run(migration.version, migration.description, new Date().toISOString());
    currentVersion = migration.version;
    applied++;
    console.log(`[db-sqlite-schema] Applied migration v${migration.version}: ${migration.description}`);
  }

  return { migrationsApplied: applied, schemaVersion: currentVersion };
}

export function listPendingSqliteMigrations(db: Database.Database): Array<{ version: number; description: string }> {
  const current = getSqliteSchemaVersion(db);
  return MIGRATIONS.filter(m => m.version > current).map(m => ({ version: m.version, description: m.description }));
}
