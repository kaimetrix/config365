import 'server-only';
import { getFile } from '@/lib/server/gitea';
import { VARIABLES_CONFIG_PATH, TENANT_VARIABLES_PATH } from './variables-config-paths';
import { GROUPS_CONFIG_PATH } from './groups-config-paths';
import type { VariableDefinition } from './variables-config';

interface GroupDefinition {
  membership?: {
    direct?: string[];
    dynamic?: Array<{ type?: string; skuPartNumbers?: string[] }>;
  };
}

interface SubscribedSku {
  skuPartNumber?: string;
  capabilityStatus?: string;
}

async function readJsonFile<T>(org: string, repo: string, path: string): Promise<T | null> {
  const result = await getFile(org, repo, path);
  if (!result.exists) return null;
  try { return JSON.parse(result.content) as T; } catch { return null; }
}

/**
 * Mirrors Get-TenantGroupMembership (runner/scripts/common/Common-TenantGroups.ps1):
 *   - config/tenant-groups.json cache (direct list)
 *   - groups-config.json membership.direct (slug match)
 *   - groups-config.json membership.dynamic (license SKU rules)
 */
async function resolveTenantGroupMembership(
  org: string,
  tenantRepo: string,
  tenantSlug: string,
  groupsConfig: Record<string, GroupDefinition>,
): Promise<Set<string>> {
  const member = new Set<string>();

  const cached = await readJsonFile<{ groups?: string[] }>(org, tenantRepo, 'config/tenant-groups.json');
  for (const g of cached?.groups ?? []) member.add(g);

  const lowerSlug = tenantSlug.trim().toLowerCase();
  for (const [groupName, def] of Object.entries(groupsConfig)) {
    if (member.has(groupName)) continue;
    const direct = def.membership?.direct ?? [];
    if (direct.some((d) => d?.trim().toLowerCase() === lowerSlug)) member.add(groupName);
  }

  const skus = await readJsonFile<SubscribedSku[]>(org, tenantRepo, 'backups/licenses/subscribed-skus.json');
  if (skus?.length) {
    for (const [groupName, def] of Object.entries(groupsConfig)) {
      if (member.has(groupName)) continue;
      const dynamic = def.membership?.dynamic ?? [];
      const matched = dynamic.some(
        (rule) =>
          rule?.type === 'license' &&
          (rule.skuPartNumbers ?? []).some((sku) =>
            skus.some((s) => s.skuPartNumber === sku && (s.capabilityStatus === 'Enabled' || s.capabilityStatus === 'Warning')),
          ),
      );
      if (matched) member.add(groupName);
    }
  }

  return member;
}

/**
 * Resolves {{VAR:Name}} values for a tenant, mirroring the precedence used by the
 * runner's Get-TenantVariables (runner/scripts/common/Common-Variables.ps1):
 *   1. default (baseline variables.json)
 *   2. groups.{GroupName} for each baseline group the tenant belongs to (declaration order)
 *   3. tenant config/variables.json override
 */
export async function resolveTenantVariables(org: string, tenantSlug: string): Promise<Record<string, string>> {
  const tenantRepo = `tenant-${tenantSlug}`;

  const [varsRoot, groupsRoot, tenantOverridesRaw] = await Promise.all([
    readJsonFile<{ variables?: Record<string, VariableDefinition> }>(org, 'baseline', VARIABLES_CONFIG_PATH),
    readJsonFile<{ groups?: Record<string, GroupDefinition> } | Record<string, GroupDefinition>>(org, 'baseline', GROUPS_CONFIG_PATH),
    readJsonFile<{ variables?: Record<string, string> } | Record<string, string>>(org, tenantRepo, TENANT_VARIABLES_PATH),
  ]);

  const definitions = varsRoot?.variables ?? {};
  const groupsConfig = ((groupsRoot as { groups?: Record<string, GroupDefinition> })?.groups ?? groupsRoot ?? {}) as Record<string, GroupDefinition>;
  const groupOrder = Object.keys(groupsConfig);
  const memberGroups = await resolveTenantGroupMembership(org, tenantRepo, tenantSlug, groupsConfig);

  const resolved: Record<string, string> = {};
  for (const [varName, def] of Object.entries(definitions)) {
    let value = (def.default ?? '').toString();
    for (const groupName of groupOrder) {
      if (!memberGroups.has(groupName)) continue;
      const groupValue = def.groups?.[groupName];
      if (groupValue && groupValue.trim() !== '') value = groupValue;
    }
    if (value.trim() !== '') resolved[varName] = value;
  }

  const overridesSource = ((tenantOverridesRaw as { variables?: Record<string, string> })?.variables ?? tenantOverridesRaw ?? {}) as Record<string, string>;
  for (const [name, value] of Object.entries(overridesSource)) {
    if (value != null && String(value).trim() !== '') resolved[name] = String(value);
  }

  return resolved;
}

/** Replaces {{VAR:Name}} tokens in a JSON/text string with resolved tenant values. Unresolved tokens are left as-is. */
export function applyResolvedVariables(content: string, resolved: Record<string, string>): string {
  return content.replace(/\{\{VAR:([^}]+)\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(resolved, name) ? resolved[name] : match;
  });
}
