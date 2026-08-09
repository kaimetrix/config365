/**
 * db-mssql.ts — MSSQL implementation of DbAdapter (operational tables).
 *
 * Uses the `mssql` package. Connection pool is created lazily and cached.
 * Calls provisionSchema() on first connect to ensure tables exist.
 */
import 'server-only';

import sql, { type ConnectionPool } from 'mssql';
import { provisionSchema } from './db-mssql-schema';
import {
  makeSlug,
  type DbAdapter,
  type Msp, type MspInput,
  type Tenant, type TenantConfig, type TenantInput,
  type IamRole, type IamAssignment,
} from './db-adapter';

// ─── Pool management ──────────────────────────────────────────────────────────

let _pool: ConnectionPool | null = null;
let _connectionString = '';

export async function getMssqlPool(connectionString: string): Promise<ConnectionPool> {
  const { normalizeMssqlConnectionString } = await import('./mssql-connstr');
  const normalized = normalizeMssqlConnectionString(connectionString);
  if (!normalized.ok) {
    throw new Error(normalized.detail);
  }
  const resolved = normalized.connectionString;

  if (_pool?.connected && _connectionString === resolved) return _pool;

  if (_pool) {
    try { await _pool.close(); } catch { /* ignore */ }
    _pool = null;
  }

  _connectionString = resolved;
  const pool = await sql.connect(resolved);
  await provisionSchema(pool);
  _pool = pool;
  return pool;
}

/** Close pool — called during test teardown or connection string change. */
export async function closeMssqlPool(): Promise<void> {
  if (_pool) {
    try { await _pool.close(); } catch { /* ignore */ }
    _pool = null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createMssqlAdapter(connectionString: string): DbAdapter {
  const pool = (): Promise<ConnectionPool> => getMssqlPool(connectionString);

  function resolveConfig(row: Record<string, unknown>): TenantConfig {
    return {
      slug:        String(row.slug),
      displayName: String(row.displayName),
      domain:      (row.domain as string | null) ?? null,
      mspId:       String(row.mspId),
      giteaOrg:    String(row.giteaOrg),
      clientId:    (row.clientId as string | null) ?? process.env.AZURE_AD_CLIENT_ID ?? '',
      tenantId:    (row.tenantId as string | null) ?? process.env.AZURE_AD_TENANT_ID ?? '',
    };
  }

  return {
    // ── MSP ────────────────────────────────────────────────────────────────

    async listMsps(): Promise<Msp[]> {
      const p = await pool();
      const r = await p.request().query<Msp>(
        'SELECT id,slug,displayName,giteaOrg,CAST(isActive AS INT) isActive,createdAt,updatedAt FROM dbo.c365p_msps ORDER BY displayName'
      );
      return r.recordset;
    },

    async getMspBySlug(slug: string): Promise<Msp | null> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, makeSlug(slug))
        .query<Msp>(
          'SELECT id,slug,displayName,giteaOrg,CAST(isActive AS INT) isActive,createdAt,updatedAt FROM dbo.c365p_msps WHERE slug=@slug'
        );
      return r.recordset[0] ?? null;
    },

    async createMsp(input: MspInput): Promise<Msp> {
      const p    = await pool();
      const slug = makeSlug(input.slug);
      const now  = new Date().toISOString();
      const row: Msp = {
        id:          slug,
        slug,
        displayName: input.displayName.trim(),
        giteaOrg:    input.giteaOrg?.trim() || slug,
        isActive:    input.isActive === false ? 0 : 1,
        createdAt:   now,
        updatedAt:   now,
      };
      await p.request()
        .input('id',          sql.NVarChar, row.id)
        .input('slug',        sql.NVarChar, row.slug)
        .input('displayName', sql.NVarChar, row.displayName)
        .input('giteaOrg',    sql.NVarChar, row.giteaOrg)
        .input('isActive',    sql.Bit,      row.isActive)
        .input('createdAt',   sql.NVarChar, row.createdAt)
        .input('updatedAt',   sql.NVarChar, row.updatedAt)
        .query(`
          INSERT INTO dbo.c365p_msps (id,slug,displayName,giteaOrg,isActive,createdAt,updatedAt)
          VALUES (@id,@slug,@displayName,@giteaOrg,@isActive,@createdAt,@updatedAt)
        `);
      return row;
    },

    async updateMsp(slug: string, input: Partial<MspInput>): Promise<Msp | null> {
      const p   = await pool();
      const id  = makeSlug(slug);
      const res = await p.request()
        .input('slug', sql.NVarChar, id)
        .query<Msp>(
          'SELECT id,slug,displayName,giteaOrg,CAST(isActive AS INT) isActive,createdAt,updatedAt FROM dbo.c365p_msps WHERE slug=@slug'
        );
      const existing = res.recordset[0];
      if (!existing) return null;

      const updated: Msp = {
        ...existing,
        displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
        giteaOrg:    input.giteaOrg    !== undefined ? (input.giteaOrg.trim() || existing.giteaOrg) : existing.giteaOrg,
        isActive:    input.isActive    !== undefined ? (input.isActive ? 1 : 0) : existing.isActive,
        updatedAt:   new Date().toISOString(),
      };
      await p.request()
        .input('slug',        sql.NVarChar, id)
        .input('displayName', sql.NVarChar, updated.displayName)
        .input('giteaOrg',    sql.NVarChar, updated.giteaOrg)
        .input('isActive',    sql.Bit,      updated.isActive)
        .input('updatedAt',   sql.NVarChar, updated.updatedAt)
        .query(`
          UPDATE dbo.c365p_msps SET displayName=@displayName,giteaOrg=@giteaOrg,isActive=@isActive,updatedAt=@updatedAt
          WHERE slug=@slug
        `);
      return updated;
    },

    async deleteMsp(slug: string): Promise<boolean> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, makeSlug(slug))
        .query('DELETE FROM dbo.c365p_msps WHERE slug=@slug');
      return (r.rowsAffected[0] ?? 0) > 0;
    },

    async getMspTenantCount(mspId: string): Promise<number> {
      const p = await pool();
      const r = await p.request()
        .input('mspId', sql.NVarChar, mspId)
        .query<{ n: number }>('SELECT COUNT(*) AS n FROM dbo.c365p_tenants WHERE mspId=@mspId');
      return r.recordset[0]?.n ?? 0;
    },

    // ── Tenant ──────────────────────────────────────────────────────────────

    async getTenantBySlug(slug: string): Promise<TenantConfig | null> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, makeSlug(slug))
        .query<Record<string, unknown>>(`
          SELECT t.*,m.giteaOrg FROM dbo.c365p_tenants t
          JOIN dbo.c365p_msps m ON m.id=t.mspId
          WHERE t.slug=@slug AND t.isActive=1
        `);
      return r.recordset[0] ? resolveConfig(r.recordset[0]) : null;
    },

    async getTenantByDomain(domain: string): Promise<TenantConfig | null> {
      const p = await pool();
      const r = await p.request()
        .input('domain', sql.NVarChar, domain.toLowerCase())
        .query<Record<string, unknown>>(`
          SELECT t.*,m.giteaOrg FROM dbo.c365p_tenants t
          JOIN dbo.c365p_msps m ON m.id=t.mspId
          WHERE t.domain=@domain AND t.isActive=1
        `);
      return r.recordset[0] ? resolveConfig(r.recordset[0]) : null;
    },

    async listTenants(mspId?: string): Promise<Tenant[]> {
      const p = await pool();
      if (mspId) {
        const r = await p.request()
          .input('mspId', sql.NVarChar, mspId)
          .query<Tenant & { giteaOrg: string }>(`
            SELECT t.*,CAST(t.isActive AS INT) isActive,m.giteaOrg FROM dbo.c365p_tenants t
            JOIN dbo.c365p_msps m ON m.id=t.mspId
            WHERE t.mspId=@mspId ORDER BY t.displayName
          `);
        return r.recordset;
      }
      const r = await p.request()
        .query<Tenant & { giteaOrg: string }>(`
          SELECT t.*,CAST(t.isActive AS INT) isActive,m.giteaOrg FROM dbo.c365p_tenants t
          JOIN dbo.c365p_msps m ON m.id=t.mspId ORDER BY t.displayName
        `);
      return r.recordset;
    },

    async createTenant(input: TenantInput): Promise<Tenant> {
      const p    = await pool();
      const slug = makeSlug(input.slug);
      const now  = new Date().toISOString();

      const mspRes = await p.request()
        .input('mspId', sql.NVarChar, input.mspId)
        .query<{ giteaOrg: string }>('SELECT giteaOrg FROM dbo.c365p_msps WHERE id=@mspId');
      if (!mspRes.recordset[0]) throw new Error(`MSP "${input.mspId}" not found.`);
      const giteaOrg = mspRes.recordset[0].giteaOrg;

      const row = {
        id:          slug,
        slug,
        displayName: input.displayName.trim(),
        domain:      input.domain?.trim().toLowerCase() || null,
        mspId:       input.mspId,
        clientId:    input.clientId?.trim() || null,
        tenantId:    input.tenantId?.trim() || null,
        isActive:    input.isActive === false ? 0 : 1,
        createdAt:   now,
        updatedAt:   now,
      };
      await p.request()
        .input('id',          sql.NVarChar, row.id)
        .input('slug',        sql.NVarChar, row.slug)
        .input('displayName', sql.NVarChar, row.displayName)
        .input('domain',      sql.NVarChar, row.domain)
        .input('mspId',       sql.NVarChar, row.mspId)
        .input('clientId',    sql.NVarChar, row.clientId)
        .input('tenantId',    sql.NVarChar, row.tenantId)
        .input('isActive',    sql.Bit,      row.isActive)
        .input('createdAt',   sql.NVarChar, row.createdAt)
        .input('updatedAt',   sql.NVarChar, row.updatedAt)
        .query(`
          INSERT INTO dbo.c365p_tenants
            (id,slug,displayName,domain,mspId,clientId,tenantId,isActive,createdAt,updatedAt)
          VALUES
            (@id,@slug,@displayName,@domain,@mspId,@clientId,@tenantId,@isActive,@createdAt,@updatedAt)
        `);
      return { ...row, giteaOrg };
    },

    async updateTenant(slug: string, input: Partial<Omit<TenantInput, 'slug'>>): Promise<Tenant | null> {
      const p  = await pool();
      const id = makeSlug(slug);
      const existRes = await p.request()
        .input('slug', sql.NVarChar, id)
        .query<Tenant & { giteaOrg: string }>(`
          SELECT t.*,CAST(t.isActive AS INT) isActive,m.giteaOrg FROM dbo.c365p_tenants t
          JOIN dbo.c365p_msps m ON m.id=t.mspId WHERE t.slug=@slug
        `);
      const existing = existRes.recordset[0];
      if (!existing) return null;

      const mspId = input.mspId ?? existing.mspId;
      const mspRes = await p.request()
        .input('mspId', sql.NVarChar, mspId)
        .query<{ giteaOrg: string }>('SELECT giteaOrg FROM dbo.c365p_msps WHERE id=@mspId');
      if (!mspRes.recordset[0]) throw new Error(`MSP "${mspId}" not found.`);

      const updated = {
        slug:        existing.slug,
        displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
        domain:      input.domain      !== undefined ? (input.domain?.trim().toLowerCase() || null) : existing.domain,
        mspId,
        clientId:    input.clientId    !== undefined ? (input.clientId?.trim() || null) : existing.clientId,
        tenantId:    input.tenantId    !== undefined ? (input.tenantId?.trim() || null) : existing.tenantId,
        isActive:    input.isActive    !== undefined ? (input.isActive ? 1 : 0) : existing.isActive,
        updatedAt:   new Date().toISOString(),
        giteaOrg:    mspRes.recordset[0].giteaOrg,
      };
      await p.request()
        .input('slug',        sql.NVarChar, id)
        .input('displayName', sql.NVarChar, updated.displayName)
        .input('domain',      sql.NVarChar, updated.domain)
        .input('mspId',       sql.NVarChar, updated.mspId)
        .input('clientId',    sql.NVarChar, updated.clientId)
        .input('tenantId',    sql.NVarChar, updated.tenantId)
        .input('isActive',    sql.Bit,      updated.isActive)
        .input('updatedAt',   sql.NVarChar, updated.updatedAt)
        .query(`
          UPDATE dbo.c365p_tenants SET
            displayName=@displayName,domain=@domain,mspId=@mspId,
            clientId=@clientId,tenantId=@tenantId,isActive=@isActive,updatedAt=@updatedAt
          WHERE slug=@slug
        `);
      return { ...existing, ...updated };
    },

    async deleteTenant(slug: string): Promise<boolean> {
      const p = await pool();
      const r = await p.request()
        .input('slug', sql.NVarChar, makeSlug(slug))
        .query('DELETE FROM dbo.c365p_tenants WHERE slug=@slug');
      return (r.rowsAffected[0] ?? 0) > 0;
    },

    // ── IAM ─────────────────────────────────────────────────────────────────

    async listIamAssignments(role?: IamRole): Promise<IamAssignment[]> {
      const p = await pool();
      if (role) {
        const r = await p.request()
          .input('role', sql.NVarChar, role)
          .query<IamAssignment>(
            'SELECT id,userId,email,displayName,role,mspSlug,createdAt,updatedAt FROM dbo.c365p_iam_assignments WHERE role=@role ORDER BY email'
          );
        return r.recordset;
      }
      const r = await p.request()
        .query<IamAssignment>(
          'SELECT id,userId,email,displayName,role,mspSlug,createdAt,updatedAt FROM dbo.c365p_iam_assignments ORDER BY role,email'
        );
      return r.recordset;
    },

    async listIamAssignmentsForMsp(mspSlug: string): Promise<IamAssignment[]> {
      const p = await pool();
      const r = await p.request()
        .input('mspSlug', sql.NVarChar, mspSlug)
        .query<IamAssignment>(
          "SELECT id,userId,email,displayName,role,mspSlug,createdAt,updatedAt FROM dbo.c365p_iam_assignments WHERE role='msp-admin' AND mspSlug=@mspSlug ORDER BY email"
        );
      return r.recordset;
    },

    async getIamAssignmentForUser(userId: string): Promise<IamAssignment | null> {
      const p = await pool();
      const r = await p.request()
        .input('userId', sql.NVarChar, userId)
        .query<IamAssignment>(
          'SELECT TOP 1 id,userId,email,displayName,role,mspSlug,createdAt,updatedAt FROM dbo.c365p_iam_assignments WHERE userId=@userId'
        );
      return r.recordset[0] ?? null;
    },

    async upsertIamAssignment(input: {
      userId: string; email: string; displayName: string;
      role: IamRole; mspSlug?: string | null;
    }): Promise<IamAssignment> {
      const p   = await pool();
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
      await p.request()
        .input('id',          sql.NVarChar, row.id)
        .input('userId',      sql.NVarChar, row.userId)
        .input('email',       sql.NVarChar, row.email)
        .input('displayName', sql.NVarChar, row.displayName)
        .input('role',        sql.NVarChar, row.role)
        .input('mspSlug',     sql.NVarChar, row.mspSlug)
        .input('createdAt',   sql.NVarChar, row.createdAt)
        .input('updatedAt',   sql.NVarChar, row.updatedAt)
        .query(`
          MERGE dbo.c365p_iam_assignments AS target
          USING (SELECT @userId AS userId, @role AS role, ISNULL(@mspSlug,'') AS mspSlugNorm) AS src
            ON target.userId=src.userId AND target.role=src.role AND target.mspSlugNorm=src.mspSlugNorm
          WHEN MATCHED THEN
            UPDATE SET email=@email, displayName=@displayName, updatedAt=@updatedAt
          WHEN NOT MATCHED THEN
            INSERT (id,userId,email,displayName,role,mspSlug,createdAt,updatedAt)
            VALUES (@id,@userId,@email,@displayName,@role,@mspSlug,@createdAt,@updatedAt);
        `);
      return row;
    },

    async deleteIamAssignment(id: string): Promise<boolean> {
      const p = await pool();
      const r = await p.request()
        .input('id', sql.NVarChar, id)
        .query('DELETE FROM dbo.c365p_iam_assignments WHERE id=@id');
      return (r.rowsAffected[0] ?? 0) > 0;
    },
  };
}
