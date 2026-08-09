/**
 * db-adapter.ts — Shared types and DbAdapter interface for operational data.
 *
 * Operational tables: msps, tenants, iam_assignments.
 * platform_settings lives in settings-store.ts (always SQLite) — not here.
 */
import 'server-only';

// ─── Types (re-exported for callers) ─────────────────────────────────────────

export type IamRole = 'platform-admin' | 'msp-admin';

export interface IamAssignment {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: IamRole;
  mspSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Msp {
  id: string;
  slug: string;
  displayName: string;
  giteaOrg: string;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface MspInput {
  slug: string;
  displayName: string;
  giteaOrg?: string;
  isActive?: boolean;
}

export interface Tenant {
  id: string;
  slug: string;
  displayName: string;
  domain: string | null;
  mspId: string;
  giteaOrg: string;
  clientId: string | null;
  tenantId: string | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantConfig {
  slug: string;
  displayName: string;
  domain: string | null;
  mspId: string;
  giteaOrg: string;
  clientId: string;
  tenantId: string;
}

export interface TenantInput {
  slug: string;
  displayName: string;
  domain?: string | null;
  mspId: string;
  clientId?: string | null;
  tenantId?: string | null;
  isActive?: boolean;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function makeSlug(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── DbAdapter interface ──────────────────────────────────────────────────────

export interface DbAdapter {
  // MSP
  listMsps(): Promise<Msp[]>;
  getMspBySlug(slug: string): Promise<Msp | null>;
  createMsp(input: MspInput): Promise<Msp>;
  updateMsp(slug: string, input: Partial<MspInput>): Promise<Msp | null>;
  deleteMsp(slug: string): Promise<boolean>;
  getMspTenantCount(mspId: string): Promise<number>;

  // Tenant
  getTenantBySlug(slug: string): Promise<TenantConfig | null>;
  getTenantByDomain(domain: string): Promise<TenantConfig | null>;
  listTenants(mspId?: string): Promise<Tenant[]>;
  createTenant(input: TenantInput): Promise<Tenant>;
  updateTenant(slug: string, input: Partial<Omit<TenantInput, 'slug'>>): Promise<Tenant | null>;
  deleteTenant(slug: string): Promise<boolean>;

  // IAM
  listIamAssignments(role?: IamRole): Promise<IamAssignment[]>;
  listIamAssignmentsForMsp(mspSlug: string): Promise<IamAssignment[]>;
  getIamAssignmentForUser(userId: string): Promise<IamAssignment | null>;
  upsertIamAssignment(input: {
    userId: string;
    email: string;
    displayName: string;
    role: IamRole;
    mspSlug?: string | null;
  }): Promise<IamAssignment>;
  deleteIamAssignment(id: string): Promise<boolean>;
}
