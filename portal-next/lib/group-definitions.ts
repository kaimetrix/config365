/** Git paths and JSON shapes for Entra baseline / tenant security groups. */

export type GroupDeployScope = 'baseline' | 'tenant';
export type AssignmentIntent = 'required' | 'available' | 'exclude';

export interface AppAssignment {
  groupName: string;
  groupId?: string;
  intent: AssignmentIntent;
  isNew?: boolean;
  description?: string;
}

/** When true, also assign as Available for enrolled devices → All users (Company Portal). */
export type AppConfigFields = {
  availableForAllUsers?: boolean;
};

/** Intune install/uninstall context — maps to winget --scope machine|user. Default: system. */
export type InstallRunAsAccount = 'system' | 'user';

export interface StaticSecurityGroupJson {
  displayName: string;
  description?: string;
  mailEnabled: boolean;
  securityEnabled: boolean;
  mailNickname: string;
  groupTypes: string[];
}

export interface GroupSidecarJson {
  deployBehavior: 'alwaysDeploy' | 'deployIfNotExists';
}

/** Filesystem-safe filename (without .json) matching display name. */
export function safeGroupFileName(displayName: string): string {
  return displayName.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'Group';
}

/** Parse group display names from a Git tree listing. */
export function parseGroupFileNamesFromTree(entries: { name: string; type: string }[]): string[] {
  return entries
    .filter(e => e.type === 'file' && e.name.endsWith('.json') && !e.name.endsWith('.config.json') && !e.name.startsWith('.') && !e.name.startsWith('ARCHITECTURE'))
    .map(e => e.name.replace(/\.json$/, ''))
    .sort();
}

/** Fetch group names from baseline or tenant Git repos. */
export async function fetchGroupNamesFromGit(treePath: string, queryParams: string): Promise<string[]> {
  const res = await fetch(`/api/git/tree?path=${encodeURIComponent(treePath)}&${queryParams}`);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return parseGroupFileNamesFromTree(data);
}

/** Baseline repo group definitions (baseline/groups/*.json). */
export async function fetchBaselineGroupNames(mspSlug: string): Promise<string[]> {
  return fetchGroupNamesFromGit('baseline/groups', `scope=baseline&mspSlug=${encodeURIComponent(mspSlug)}`);
}

/** Tenant repo group definitions (groups/*.json) — uses displayName from JSON when present. */
export async function fetchTenantGroupNamesFromGit(tenantSlug: string): Promise<string[]> {
  const res = await fetch(`/api/git/tree?path=${encodeURIComponent('groups')}&slug=${encodeURIComponent(tenantSlug)}`);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  const jsonFiles = data.filter(
    (e: { type: string; name: string }) =>
      e.type === 'file' && e.name.endsWith('.json') && !e.name.endsWith('.config.json'),
  );
  if (jsonFiles.length === 0) return [];

  const names = await Promise.all(
    jsonFiles.map(async (entry: { name: string }) => {
      const fallback = entry.name.replace(/\.json$/, '');
      const fileRes = await fetch(
        `/api/git/file?path=${encodeURIComponent(`groups/${entry.name}`)}&slug=${encodeURIComponent(tenantSlug)}`,
      );
      if (!fileRes.ok) return fallback;
      const file = await fileRes.json() as { exists?: boolean; content?: string };
      if (!file.exists || !file.content) return fallback;
      try {
        const parsed = JSON.parse(file.content) as { displayName?: string };
        const displayName = parsed.displayName?.trim();
        if (displayName) return displayName;
      } catch { /* use filename fallback */ }
      return fallback;
    }),
  );
  return [...new Set(names.filter(Boolean))];
}

/** Entra security groups from tenant backup (backups/groups/*.json). */
export async function fetchTenantSecurityGroupNames(tenantSlug: string): Promise<string[]> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantSlug)}/security-groups`);
  if (!res.ok) return [];
  const data = await res.json() as { groups?: Array<{ displayName?: string }> };
  if (!Array.isArray(data.groups)) return [];
  return data.groups
    .map(g => g.displayName?.trim())
    .filter((name): name is string => !!name);
}

/** All assignable group names for one tenant (Git definitions + backed-up Entra groups). */
export async function fetchTenantGroupNames(tenantSlug: string): Promise<string[]> {
  const [gitNames, backupNames] = await Promise.all([
    fetchTenantGroupNamesFromGit(tenantSlug),
    fetchTenantSecurityGroupNames(tenantSlug),
  ]);
  return [...new Set([...gitNames, ...backupNames])].sort();
}

/**
 * Groups available for Intune assignment pickers.
 * Baseline deploy: baseline groups only.
 * Tenant deploy: tenant-local Git groups + backed-up Entra groups for selected tenant(s) only.
 */
export async function fetchAssignmentGroupNames(opts: {
  scope: 'baseline' | 'tenant';
  mspSlug: string;
  tenantSlugs?: string[];
}): Promise<string[]> {
  if (opts.scope === 'baseline') return fetchBaselineGroupNames(opts.mspSlug);
  const tenantSlugs = opts.tenantSlugs ?? [];
  if (tenantSlugs.length === 0) return [];
  const tenantBatches = await Promise.all(tenantSlugs.map(s => fetchTenantGroupNames(s)));
  return [...new Set(tenantBatches.flat())].sort();
}

function sanitizeMailNickname(displayName: string): string {
  const base = displayName
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 40) || 'Group';
  return base;
}

export function buildStaticSecurityGroup(displayName: string, description?: string): StaticSecurityGroupJson {
  return {
    displayName: displayName.trim(),
    description: description?.trim() || `Managed by Config365`,
    mailEnabled: false,
    securityEnabled: true,
    mailNickname: sanitizeMailNickname(displayName),
    groupTypes: [],
  };
}

export function buildGroupSidecar(scope: GroupDeployScope): GroupSidecarJson {
  return {
    deployBehavior: scope === 'baseline' ? 'alwaysDeploy' : 'deployIfNotExists',
  };
}

/** Baseline repo: baseline/groups/{Name}.json (under repo baseline/ content root) */
export function baselineGroupPaths(displayName: string): { main: string; sidecar: string } {
  const file = safeGroupFileName(displayName);
  return {
    main: `baseline/groups/${file}.json`,
    sidecar: `baseline/groups/${file}.config.json`,
  };
}

/** Tenant repo: groups/{Name}.json */
export function tenantGroupPaths(displayName: string): { main: string; sidecar: string } {
  const file = safeGroupFileName(displayName);
  return {
    main: `groups/${file}.json`,
    sidecar: `groups/${file}.config.json`,
  };
}

/** App folder path inside baseline or tenant repo. */
export function appFolderPath(pkgManager: string, packageId: string, scope: GroupDeployScope): string {
  const prefix = scope === 'baseline' ? 'baseline/apps' : 'apps';
  return `${prefix}/${pkgManager}/${packageId}`;
}

export type CustomScriptMode = 'none' | 'before' | 'after' | 'only';

export type DriverDeployMode = 'package' | 'connect';

export type PrinterRole = 'driver' | 'connect';

export interface PrinterPathEntry {
  path: string;
  displayName?: string;
}

export interface PrinterConfigFields {
  pkgManager: 'printer';
  packageId: string;
  displayName: string;
  /** When true, deploy driver (system) + connect (user) as separate IntuneWin apps. */
  splitDeploy?: boolean;
  printerRole?: PrinterRole;
  dependsOnIntuneDisplayName?: string;
  printers: PrinterPathEntry[];
  customScript?: string;
  customScriptMode?: CustomScriptMode;
  customDetectionScript?: string;
  /** Split deploy: driver package (attachments/INF) vs system-level connect printers. Default: package. */
  driverDeployMode?: DriverDeployMode;
  /** Split deploy: driver-side script/detection stored on master config. */
  driverCustomScript?: string;
  driverCustomScriptMode?: CustomScriptMode;
  driverCustomDetectionScript?: string;
  /** Split deploy: connect-side optional script on master config. */
  connectCustomScript?: string;
  connectCustomScriptMode?: CustomScriptMode;
  connectCustomDetectionScript?: string;
  assignments?: AppAssignment[];
  availableForAllUsers?: boolean;
  runAsAccount?: InstallRunAsAccount;
  intuneDisplayName?: string;
}
