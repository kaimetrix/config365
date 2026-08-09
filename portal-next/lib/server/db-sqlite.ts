/**
 * db-sqlite.ts — SQLite implementation of DbAdapter (operational tables).
 *
 * Uses the same SQLite connection as settings-store.ts to avoid multiple
 * connections to the same file. Creates the operational tables (msps, tenants,
 * iam_assignments) on first use.
 */
import 'server-only';

import { getSettingsDb } from './settings-store';
import { provisionSqliteSchema } from './db-sqlite-schema';
import {
  makeSlug,
  type DbAdapter,
  type Msp, type MspInput,
  type Tenant, type TenantConfig, type TenantInput,
  type IamRole, type IamAssignment,
} from './db-adapter';

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

let _initialized = false;

function ensureSchema(): void {
  if (_initialized) return;
  const db = getSettingsDb();
  provisionSqliteSchema(db);
  _initialized = true;
}

// ─── Internal row types ───────────────────────────────────────────────────────

interface TenantRow {
  id: string; slug: string; displayName: string; domain: string | null;
  mspId: string; clientId: string | null; tenantId: string | null;
  isActive: number; createdAt: string; updatedAt: string;
  giteaOrg: string;
}

const TENANT_JOIN = `
  SELECT t.*, m.giteaOrg
  FROM tenants t
  JOIN msps m ON m.id = t.mspId
`;

function resolveConfig(row: TenantRow): TenantConfig {
  return {
    slug:        row.slug,
    displayName: row.displayName,
    domain:      row.domain      ?? null,
    mspId:       row.mspId,
    giteaOrg:    row.giteaOrg,
    clientId:    row.clientId  ?? process.env.AZURE_AD_CLIENT_ID ?? '',
    tenantId:    row.tenantId  ?? process.env.AZURE_AD_TENANT_ID ?? '',
  };
}

// ─── SQLite DbAdapter ─────────────────────────────────────────────────────────

export const sqliteAdapter: DbAdapter = {
  // ── MSP ──────────────────────────────────────────────────────────────────

  async listMsps(): Promise<Msp[]> {
    ensureSchema();
    return getSettingsDb()
      .prepare<[], Msp>('SELECT * FROM msps ORDER BY displayName ASC')
      .all();
  },

  async getMspBySlug(slug: string): Promise<Msp | null> {
    ensureSchema();
    return getSettingsDb()
      .prepare<[string], Msp>('SELECT * FROM msps WHERE slug = ?')
      .get(makeSlug(slug)) ?? null;
  },

  async createMsp(input: MspInput): Promise<Msp> {
    ensureSchema();
    const db   = getSettingsDb();
    const slug = makeSlug(input.slug);
    const now  = new Date().toISOString();
    const row: Msp = {
      id:          slug,
      slug,
      displayName: input.displayName.trim(),
      giteaOrg:    (input.giteaOrg?.trim()) || slug,
      isActive:    input.isActive === false ? 0 : 1,
      createdAt:   now,
      updatedAt:   now,
    };
    db.prepare(`
      INSERT INTO msps (id, slug, displayName, giteaOrg, isActive, createdAt, updatedAt)
      VALUES (@id, @slug, @displayName, @giteaOrg, @isActive, @createdAt, @updatedAt)
    `).run(row);
    return row;
  },

  async updateMsp(slug: string, input: Partial<MspInput>): Promise<Msp | null> {
    ensureSchema();
    const db = getSettingsDb();
    const id = makeSlug(slug);
    const existing = db.prepare<[string], Msp>('SELECT * FROM msps WHERE slug = ?').get(id);
    if (!existing) return null;
    const updated: Msp = {
      ...existing,
      displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
      giteaOrg:    input.giteaOrg    !== undefined ? (input.giteaOrg.trim() || existing.giteaOrg) : existing.giteaOrg,
      isActive:    input.isActive    !== undefined ? (input.isActive ? 1 : 0) : existing.isActive,
      updatedAt:   new Date().toISOString(),
    };
    db.prepare(`
      UPDATE msps SET displayName=@displayName, giteaOrg=@giteaOrg, isActive=@isActive, updatedAt=@updatedAt
      WHERE slug=@slug
    `).run(updated);
    return updated;
  },

  async deleteMsp(slug: string): Promise<boolean> {
    ensureSchema();
    const result = getSettingsDb()
      .prepare<[string]>('DELETE FROM msps WHERE slug = ?')
      .run(makeSlug(slug));
    return result.changes > 0;
  },

  async getMspTenantCount(mspId: string): Promise<number> {
    ensureSchema();
    const row = getSettingsDb()
      .prepare<[string], { n: number }>('SELECT COUNT(*) as n FROM tenants WHERE mspId = ?')
      .get(mspId);
    return row?.n ?? 0;
  },

  // ── Tenant ────────────────────────────────────────────────────────────────

  async getTenantBySlug(slug: string): Promise<TenantConfig | null> {
    ensureSchema();
    const row = getSettingsDb()
      .prepare<[string], TenantRow>(`${TENANT_JOIN} WHERE t.slug = ? AND t.isActive = 1`)
      .get(makeSlug(slug));
    return row ? resolveConfig(row) : null;
  },

  async getTenantByDomain(domain: string): Promise<TenantConfig | null> {
    ensureSchema();
    const row = getSettingsDb()
      .prepare<[string], TenantRow>(`${TENANT_JOIN} WHERE t.domain = ? AND t.isActive = 1`)
      .get(domain.toLowerCase());
    return row ? resolveConfig(row) : null;
  },

  async listTenants(mspId?: string): Promise<Tenant[]> {
    ensureSchema();
    const db = getSettingsDb();
    if (mspId) {
      return db.prepare<[string], TenantRow>(`${TENANT_JOIN} WHERE t.mspId = ? ORDER BY t.displayName ASC`)
        .all(mspId) as unknown as Tenant[];
    }
    return db.prepare<[], TenantRow>(`${TENANT_JOIN} ORDER BY t.displayName ASC`)
      .all() as unknown as Tenant[];
  },

  async createTenant(input: TenantInput): Promise<Tenant> {
    ensureSchema();
    const db   = getSettingsDb();
    const slug  = makeSlug(input.slug);
    const now   = new Date().toISOString();

    const msp = db.prepare<[string], Msp>('SELECT * FROM msps WHERE id = ?').get(input.mspId);
    if (!msp) throw new Error(`MSP "${input.mspId}" not found.`);

    const row = {
      id:          slug,
      slug,
      displayName: input.displayName.trim(),
      domain:      input.domain?.trim().toLowerCase() || null,
      mspId:       input.mspId,
      clientId:    input.clientId?.trim()  || null,
      tenantId:    input.tenantId?.trim()  || null,
      isActive:    input.isActive === false ? 0 : 1,
      createdAt:   now,
      updatedAt:   now,
    };
    db.prepare(`
      INSERT INTO tenants (id, slug, displayName, domain, mspId, clientId, tenantId, isActive, createdAt, updatedAt)
      VALUES (@id, @slug, @displayName, @domain, @mspId, @clientId, @tenantId, @isActive, @createdAt, @updatedAt)
    `).run(row);
    return { ...row, giteaOrg: msp.giteaOrg };
  },

  async updateTenant(slug: string, input: Partial<Omit<TenantInput, 'slug'>>): Promise<Tenant | null> {
    ensureSchema();
    const db = getSettingsDb();
    const id = makeSlug(slug);
    const existing = db.prepare<[string], TenantRow>(`${TENANT_JOIN} WHERE t.slug = ?`).get(id);
    if (!existing) return null;

    const mspId = input.mspId ?? existing.mspId;
    const msp   = db.prepare<[string], Msp>('SELECT * FROM msps WHERE id = ?').get(mspId);
    if (!msp) throw new Error(`MSP "${mspId}" not found.`);

    const updated = {
      slug:        existing.slug,
      displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
      domain:      input.domain      !== undefined ? (input.domain?.trim().toLowerCase() || null) : existing.domain,
      mspId,
      clientId:    input.clientId    !== undefined ? (input.clientId?.trim() || null) : existing.clientId,
      tenantId:    input.tenantId    !== undefined ? (input.tenantId?.trim() || null) : existing.tenantId,
      isActive:    input.isActive    !== undefined ? (input.isActive ? 1 : 0) : existing.isActive,
      updatedAt:   new Date().toISOString(),
    };
    db.prepare(`
      UPDATE tenants SET
        displayName=@displayName, domain=@domain, mspId=@mspId,
        clientId=@clientId, tenantId=@tenantId, isActive=@isActive, updatedAt=@updatedAt
      WHERE slug=@slug
    `).run(updated);
    return { ...existing, ...updated, giteaOrg: msp.giteaOrg };
  },

  async deleteTenant(slug: string): Promise<boolean> {
    ensureSchema();
    const result = getSettingsDb()
      .prepare<[string]>('DELETE FROM tenants WHERE slug = ?')
      .run(makeSlug(slug));
    return result.changes > 0;
  },

  // ── IAM ───────────────────────────────────────────────────────────────────

  async listIamAssignments(role?: IamRole): Promise<IamAssignment[]> {
    ensureSchema();
    const db = getSettingsDb();
    if (role) {
      return db.prepare<[string], IamAssignment>(
        'SELECT * FROM iam_assignments WHERE role = ? ORDER BY email ASC'
      ).all(role);
    }
    return db.prepare<[], IamAssignment>(
      'SELECT * FROM iam_assignments ORDER BY role ASC, email ASC'
    ).all();
  },

  async listIamAssignmentsForMsp(mspSlug: string): Promise<IamAssignment[]> {
    ensureSchema();
    return getSettingsDb()
      .prepare<[string, string], IamAssignment>(
        'SELECT * FROM iam_assignments WHERE role = ? AND mspSlug = ? ORDER BY email ASC'
      ).all('msp-admin', mspSlug);
  },

  async getIamAssignmentForUser(userId: string): Promise<IamAssignment | null> {
    ensureSchema();
    return getSettingsDb()
      .prepare<[string], IamAssignment>(
        'SELECT * FROM iam_assignments WHERE userId = ? LIMIT 1'
      ).get(userId) ?? null;
  },

  async upsertIamAssignment(input: {
    userId: string; email: string; displayName: string;
    role: IamRole; mspSlug?: string | null;
  }): Promise<IamAssignment> {
    ensureSchema();
    const db  = getSettingsDb();
    const now = new Date().toISOString();
    const id  = `${input.userId}-${input.role}-${input.mspSlug ?? ''}`;
    const row: IamAssignment = {
      id,
      userId:      input.userId,
      email:       input.email.toLowerCase().trim(),
      displayName: input.displayName.trim(),
      role:        input.role,
      mspSlug:     input.mspSlug ?? null,
      createdAt:   now,
      updatedAt:   now,
    };
    db.prepare(`
      INSERT INTO iam_assignments (id, userId, email, displayName, role, mspSlug, createdAt, updatedAt)
      VALUES (@id, @userId, @email, @displayName, @role, @mspSlug, @createdAt, @updatedAt)
      ON CONFLICT(userId, role, COALESCE(mspSlug, ''))
      DO UPDATE SET email=excluded.email, displayName=excluded.displayName, updatedAt=excluded.updatedAt
    `).run(row);
    return row;
  },

  async deleteIamAssignment(id: string): Promise<boolean> {
    ensureSchema();
    const result = getSettingsDb()
      .prepare<[string]>('DELETE FROM iam_assignments WHERE id = ?')
      .run(id);
    return result.changes > 0;
  },
};
