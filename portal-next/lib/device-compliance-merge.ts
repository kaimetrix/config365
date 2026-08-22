/**
 * Merge Intune managed devices, MAM registrations, and MDE inventory
 * into a unified device compliance row list.
 */

import { androidPatchFromBuild, normalizeOsVersion, resolveDeviceOsVersion } from './os-version-threshold';

export interface ManagedDeviceRecord {
  id: string;
  deviceName?: string;
  azureADDeviceId?: string;
  managementAgent?: string;
  operatingSystem?: string;
  osVersion?: string;
  complianceState?: string;
  complianceGracePeriodExpirationDateTime?: string;
  userPrincipalName?: string;
  userDisplayName?: string;
  lastSyncDateTime?: string;
  enrolledDateTime?: string;
  isEncrypted?: boolean;
  jailBroken?: boolean;
  model?: string;
  manufacturer?: string;
  wiFiMacAddress?: string;
}

export interface MamRegistrationRecord {
  azureADDeviceId?: string;
  deviceName?: string;
  platform?: string;
  deviceOperatingSystemVersion?: string;
  patchVersion?: string;
  userId?: string;
  createdDateTime?: string;
  lastSyncDateTime?: string;
}

export interface MdeDeviceRecord {
  id: string;
  aadDeviceId?: string;
  computerDnsName?: string;
  osPlatform?: string;
  osVersion?: string;
  osBuild?: string;
  patchVersion?: string;
  lastSeen?: string;
  riskScore?: string;
  exposureLevel?: string;
  healthStatus?: string;
  onboardingStatus?: string;
  rbacGroupName?: string;
  logonUsers?: Array<{ userPrincipalName?: string }>;
  registeredOwner?: { displayName?: string; userPrincipalName?: string };
}

export interface DeviceComplianceRow {
  id: string;
  deviceName: string;
  platform: string;
  osVersion: string | null;
  patchVersion: string | null;
  managementType: string;
  complianceState: string | null;
  complianceGracePeriodExpirationDateTime: string | null;
  mdeRiskScore: string | null;
  mdeExposureLevel: string | null;
  mdeHealthStatus: string | null;
  mdeOnboardingStatus: string | null;
  mdeLastSeen: string | null;
  mdeRbacGroupName: string | null;
  azureADDeviceId: string | null;
  primaryUser: string | null;
  lastSync: string | null;
  inMde: boolean;
  inIntune: boolean;
  inMam: boolean;
  isEncrypted: boolean | null;
  jailBroken: boolean | null;
  model: string | null;
  manufacturer: string | null;
}

export interface DeviceComplianceSummary {
  total: number;
  compliant: number;
  nonCompliant: number;
  gracePeriod: number;
  notInIntune: number;
  highRisk: number;
  mamOnly: number;
  intuneManaged: number;
}

export function normalizePlatform(os: string | undefined | null): string {
  const lower = String(os ?? '').toLowerCase();
  if (lower.includes('windows')) return 'windows';
  if (lower.includes('macos') || lower.includes('mac os')) return 'macos';
  if (lower === 'ios' || lower.includes('iphone') || lower.includes('ipad')) return 'ios';
  if (lower === 'android') return 'android';
  return 'other';
}

/** Short hostname for cross-source matching (strips FQDN/domain suffix). */
export function normalizeDeviceName(name: string | null | undefined): string {
  if (!name) return '';
  const trimmed = name.trim().toLowerCase();
  const short = trimmed.split('.')[0] ?? trimmed;
  return short.replace(/[^a-z0-9_-]/g, '');
}

function mdeOsVersion(mde: MdeDeviceRecord): string | null {
  return resolveDeviceOsVersion(mde) || null;
}

function mdePatchVersion(mde: MdeDeviceRecord): string | null {
  return mde.patchVersion
    || androidPatchFromBuild(mde.osBuild)
    || androidPatchFromBuild(mde.osVersion)
    || null;
}

function buildManagementType(flags: { mdm: boolean; mam: boolean; mde: boolean }): string {
  const parts: string[] = [];
  if (flags.mdm) parts.push('MDM');
  if (flags.mam) parts.push('MAM');
  if (flags.mde) parts.push('MDE');
  return parts.length ? parts.join('+') : 'Unknown';
}

function mdePrimaryUser(d: MdeDeviceRecord): string | null {
  return d.logonUsers?.[0]?.userPrincipalName
    ?? d.registeredOwner?.userPrincipalName
    ?? d.registeredOwner?.displayName
    ?? null;
}

function applyMdeEnrichment(row: DeviceComplianceRow, mde: MdeDeviceRecord): DeviceComplianceRow {
  return {
    ...row,
    deviceName: row.deviceName || mde.computerDnsName || mde.id,
    platform: row.platform !== 'other' ? row.platform : normalizePlatform(mde.osPlatform),
    // Version stays Intune-only (MDM osVersion or MAM platformVersion).
    // MDE release can disagree with App Protection and is not what the policies evaluate.
    osVersion: normalizeOsVersion(row.osVersion) || null,
    patchVersion: row.patchVersion ?? mdePatchVersion(mde),
    mdeRiskScore: mde.riskScore ?? null,
    mdeExposureLevel: mde.exposureLevel ?? null,
    mdeHealthStatus: mde.healthStatus ?? null,
    mdeOnboardingStatus: mde.onboardingStatus ?? null,
    mdeLastSeen: mde.lastSeen ?? null,
    mdeRbacGroupName: mde.rbacGroupName ?? null,
    azureADDeviceId: row.azureADDeviceId ?? mde.aadDeviceId?.toLowerCase() ?? null,
    primaryUser: row.primaryUser ?? mdePrimaryUser(mde),
    lastSync: row.lastSync ?? mde.lastSeen ?? null,
    inMde: true,
    managementType: buildManagementType({
      mdm: row.inIntune,
      mam: row.inMam,
      mde: true,
    }),
  };
}

function indexMdeDevices(mde: MdeDeviceRecord[]) {
  const byAad = new Map<string, MdeDeviceRecord>();
  const byName = new Map<string, MdeDeviceRecord>();

  for (const device of mde) {
    if (device.aadDeviceId) {
      byAad.set(device.aadDeviceId.toLowerCase(), device);
    }
    const nameKey = normalizeDeviceName(device.computerDnsName);
    if (nameKey && !byName.has(nameKey)) {
      byName.set(nameKey, device);
    }
  }

  return { byAad, byName };
}

function findMdeForIntune(
  md: ManagedDeviceRecord,
  byAad: Map<string, MdeDeviceRecord>,
  byName: Map<string, MdeDeviceRecord>,
): MdeDeviceRecord | undefined {
  const aadKey = md.azureADDeviceId?.toLowerCase();
  if (aadKey && byAad.has(aadKey)) return byAad.get(aadKey);

  const nameKey = normalizeDeviceName(md.deviceName);
  if (nameKey && byName.has(nameKey)) return byName.get(nameKey);

  return undefined;
}

export function mergeDeviceComplianceData(
  managed: ManagedDeviceRecord[],
  mam: MamRegistrationRecord[],
  mde: MdeDeviceRecord[],
): DeviceComplianceRow[] {
  const rowsByKey = new Map<string, DeviceComplianceRow>();
  const claimedMdeIds = new Set<string>();
  const mamByAad = new Map<string, MamRegistrationRecord>();
  const { byAad: mdeByAad, byName: mdeByName } = indexMdeDevices(mde);

  for (const reg of mam) {
    if (reg.azureADDeviceId) mamByAad.set(reg.azureADDeviceId.toLowerCase(), reg);
  }

  for (const md of managed) {
    const aadKey = md.azureADDeviceId?.toLowerCase() ?? '';
    const mamReg = aadKey ? mamByAad.get(aadKey) : undefined;
    const mdeMatch = findMdeForIntune(md, mdeByAad, mdeByName);

    let row: DeviceComplianceRow = {
      id: md.id || aadKey || md.deviceName || `intune-${rowsByKey.size}`,
      deviceName: md.deviceName ?? 'Unknown',
      platform: normalizePlatform(md.operatingSystem),
      osVersion: resolveDeviceOsVersion({ osVersion: md.osVersion })
        || normalizeOsVersion(mamReg?.deviceOperatingSystemVersion)
        || null,
      patchVersion: mamReg?.patchVersion ?? null,
      managementType: buildManagementType({ mdm: true, mam: !!mamReg, mde: !!mdeMatch }),
      complianceState: md.complianceState ?? null,
      complianceGracePeriodExpirationDateTime: md.complianceGracePeriodExpirationDateTime ?? null,
      mdeRiskScore: null,
      mdeExposureLevel: null,
      mdeHealthStatus: null,
      mdeOnboardingStatus: null,
      mdeLastSeen: null,
      mdeRbacGroupName: null,
      azureADDeviceId: aadKey || null,
      primaryUser: md.userPrincipalName ?? md.userDisplayName ?? null,
      lastSync: md.lastSyncDateTime ?? mamReg?.lastSyncDateTime ?? null,
      inMde: !!mdeMatch,
      inIntune: true,
      inMam: !!mamReg,
      isEncrypted: md.isEncrypted ?? null,
      jailBroken: md.jailBroken ?? null,
      model: md.model ?? null,
      manufacturer: md.manufacturer ?? null,
    };

    if (mdeMatch) {
      row = applyMdeEnrichment(row, mdeMatch);
      claimedMdeIds.add(mdeMatch.id);
    }

    const rowKey = aadKey || `intune:${normalizeDeviceName(md.deviceName) || row.id}`;
    rowsByKey.set(rowKey, row);
  }

  for (const [aadKey, reg] of mamByAad) {
    if (rowsByKey.has(aadKey)) continue;
    const mdeDevice = mdeByAad.get(aadKey) ?? mdeByName.get(normalizeDeviceName(reg.deviceName));
    let row: DeviceComplianceRow = {
      id: aadKey || reg.deviceName || `mam-${rowsByKey.size}`,
      deviceName: reg.deviceName ?? 'Unknown',
      platform: normalizePlatform(reg.platform ?? reg.deviceOperatingSystemVersion),
      osVersion: normalizeOsVersion(reg.deviceOperatingSystemVersion) || null,
      patchVersion: reg.patchVersion ?? null,
      managementType: buildManagementType({ mdm: false, mam: true, mde: !!mdeDevice }),
      complianceState: null,
      complianceGracePeriodExpirationDateTime: null,
      mdeRiskScore: null,
      mdeExposureLevel: null,
      mdeHealthStatus: null,
      mdeOnboardingStatus: null,
      mdeLastSeen: null,
      mdeRbacGroupName: null,
      azureADDeviceId: aadKey || null,
      primaryUser: null,
      lastSync: reg.lastSyncDateTime ?? reg.createdDateTime ?? null,
      inMde: !!mdeDevice,
      inIntune: false,
      inMam: true,
      isEncrypted: null,
      jailBroken: null,
      model: null,
      manufacturer: null,
    };
    if (mdeDevice) {
      row = applyMdeEnrichment(row, mdeDevice);
      claimedMdeIds.add(mdeDevice.id);
    }
    rowsByKey.set(aadKey, row);
  }

  // MDE-only devices: skip any already matched to Intune/MAM by AAD ID or hostname
  const claimedNames = new Set(
    [...rowsByKey.values()].map(r => normalizeDeviceName(r.deviceName)).filter(Boolean),
  );

  for (const mdeDevice of mde) {
    if (claimedMdeIds.has(mdeDevice.id)) continue;

    const aadKey = mdeDevice.aadDeviceId?.toLowerCase();
    if (aadKey && rowsByKey.has(aadKey)) continue;

    const nameKey = normalizeDeviceName(mdeDevice.computerDnsName);
    if (nameKey && claimedNames.has(nameKey)) continue;

    const key = aadKey || `mde:${nameKey || mdeDevice.id}`;
    rowsByKey.set(key, {
      id: mdeDevice.id,
      deviceName: mdeDevice.computerDnsName ?? mdeDevice.id,
      platform: normalizePlatform(mdeDevice.osPlatform),
      osVersion: mdeOsVersion(mdeDevice),
      patchVersion: mdePatchVersion(mdeDevice),
      managementType: 'MDE',
      complianceState: 'notInIntune',
      complianceGracePeriodExpirationDateTime: null,
      mdeRiskScore: mdeDevice.riskScore ?? null,
      mdeExposureLevel: mdeDevice.exposureLevel ?? null,
      mdeHealthStatus: mdeDevice.healthStatus ?? null,
      mdeOnboardingStatus: mdeDevice.onboardingStatus ?? null,
      mdeLastSeen: mdeDevice.lastSeen ?? null,
      mdeRbacGroupName: mdeDevice.rbacGroupName ?? null,
      azureADDeviceId: aadKey || null,
      primaryUser: mdePrimaryUser(mdeDevice),
      lastSync: mdeDevice.lastSeen ?? null,
      inMde: true,
      inIntune: false,
      inMam: false,
      isEncrypted: null,
      jailBroken: null,
      model: null,
      manufacturer: null,
    });
  }

  return [...rowsByKey.values()].sort((a, b) =>
    a.deviceName.localeCompare(b.deviceName, undefined, { sensitivity: 'base' }),
  );
}

export function summarizeDevices(rows: DeviceComplianceRow[]): DeviceComplianceSummary {
  return {
    total: rows.length,
    compliant: rows.filter(r => r.complianceState === 'compliant').length,
    nonCompliant: rows.filter(r => r.complianceState === 'noncompliant').length,
    gracePeriod: rows.filter(r => r.complianceState === 'inGracePeriod').length,
    notInIntune: rows.filter(r => !r.inIntune).length,
    highRisk: rows.filter(r => String(r.mdeRiskScore ?? '').toLowerCase() === 'high').length,
    mamOnly: rows.filter(r => r.inMam && !r.inIntune).length,
    intuneManaged: rows.filter(r => r.inIntune).length,
  };
}

export interface AdvancedDeviceFilters {
  platforms: string[];
  compliance: string[];
  management: string[];
  risks: string[];
  exposures: string[];
  /** Show devices last seen within this many days (null = no limit). */
  lastSeenWithinDays: number | null;
  /** Show devices not seen for at least this many days (null = no limit). */
  lastSeenOlderThanDays: number | null;
  search: string;
}

export const EMPTY_DEVICE_FILTERS: AdvancedDeviceFilters = {
  platforms: [],
  compliance: [],
  management: [],
  risks: [],
  exposures: [],
  lastSeenWithinDays: null,
  lastSeenOlderThanDays: null,
  search: '',
};

function effectiveLastSeen(row: DeviceComplianceRow): Date | null {
  const raw = row.mdeLastSeen ?? row.lastSync;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeRisk(risk: string | null | undefined): string {
  const v = String(risk ?? 'none').toLowerCase();
  if (v === 'informational') return 'informational';
  return v || 'none';
}

function normalizeExposure(exposure: string | null | undefined): string {
  return String(exposure ?? 'none').toLowerCase() || 'none';
}

function deviceManagementTokens(managementType: string): string[] {
  return managementType.split('+').map(s => s.trim()).filter(Boolean);
}

function matchesCompliance(row: DeviceComplianceRow, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.some(key => {
    switch (key) {
      case 'compliant':
        return row.complianceState === 'compliant';
      case 'nonCompliant':
        return row.complianceState === 'noncompliant';
      case 'gracePeriod':
        return row.complianceState === 'inGracePeriod';
      case 'notInIntune':
        return !row.inIntune || row.complianceState === 'notInIntune';
      case 'mamOnly':
        return row.inMam && !row.inIntune;
      case 'unknown':
        return row.inIntune && (row.complianceState == null || row.complianceState === '');
      default:
        return false;
    }
  });
}

export function applyDeviceFilters(
  rows: DeviceComplianceRow[],
  filters: AdvancedDeviceFilters,
): DeviceComplianceRow[] {
  let filtered = rows;

  if (filters.platforms.length > 0) {
    filtered = filtered.filter(r => filters.platforms.includes(r.platform));
  }

  if (filters.compliance.length > 0) {
    filtered = filtered.filter(r => matchesCompliance(r, filters.compliance));
  }

  if (filters.management.length > 0) {
    filtered = filtered.filter(r => {
      const tokens = deviceManagementTokens(r.managementType);
      return filters.management.some(m => tokens.includes(m));
    });
  }

  if (filters.risks.length > 0) {
    const riskSet = new Set(filters.risks.map(r => r.toLowerCase()));
    filtered = filtered.filter(r => riskSet.has(normalizeRisk(r.mdeRiskScore)));
  }

  if (filters.exposures.length > 0) {
    const expSet = new Set(filters.exposures.map(e => e.toLowerCase()));
    filtered = filtered.filter(r => expSet.has(normalizeExposure(r.mdeExposureLevel)));
  }

  const now = Date.now();
  if (filters.lastSeenWithinDays != null) {
    const cutoff = now - filters.lastSeenWithinDays * 86_400_000;
    filtered = filtered.filter(r => {
      const seen = effectiveLastSeen(r);
      return seen !== null && seen.getTime() >= cutoff;
    });
  }

  if (filters.lastSeenOlderThanDays != null) {
    const cutoff = now - filters.lastSeenOlderThanDays * 86_400_000;
    filtered = filtered.filter(r => {
      const seen = effectiveLastSeen(r);
      return seen === null || seen.getTime() < cutoff;
    });
  }

  const q = filters.search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(r =>
      r.deviceName.toLowerCase().includes(q)
      || (r.primaryUser?.toLowerCase().includes(q) ?? false),
    );
  }

  return filtered;
}

export function filterDeviceRows(
  rows: DeviceComplianceRow[],
  opts: { platform?: string; compliance?: string; search?: string },
): DeviceComplianceRow[] {
  return applyDeviceFilters(rows, {
    ...EMPTY_DEVICE_FILTERS,
    platforms: opts.platform && opts.platform !== 'all' ? [opts.platform] : [],
    compliance: opts.compliance && opts.compliance !== 'all' ? [opts.compliance] : [],
    search: opts.search ?? '',
  });
}

export function countActiveFilters(filters: AdvancedDeviceFilters): number {
  let n = 0;
  if (filters.platforms.length) n++;
  if (filters.compliance.length) n++;
  if (filters.management.length) n++;
  if (filters.risks.length) n++;
  if (filters.exposures.length) n++;
  if (filters.lastSeenWithinDays != null) n++;
  if (filters.lastSeenOlderThanDays != null) n++;
  if (filters.search.trim()) n++;
  return n;
}
