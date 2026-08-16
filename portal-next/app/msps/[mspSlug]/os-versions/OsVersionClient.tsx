'use client';
import { Fragment, useState, useEffect, useCallback } from 'react';
import RiskBadge from '@/components/RiskBadge';
import { deviceBelowThreshold, resolveDeviceOsVersion } from '@/lib/os-version-threshold';

type Platform = 'android' | 'ios' | 'windows' | 'macos';

interface WindowsRelease { label: string; buildNumber: string; eolDate: string | null; isEol: boolean }
interface PlatformInfo {
  version: string; releaseDate: string | null; supported: boolean; source: string;
  supportedVersions: string[]; extendedVersions?: string[]; patchDate?: string | null;
  windowsReleases?: WindowsRelease[];
}
interface OsVersions { ios: PlatformInfo; android: PlatformInfo; windows: PlatformInfo; macos: PlatformInfo }
interface Policy { path: string; name: string; policyGroup: 'app-protection' | 'compliance'; data: Record<string, unknown> | null }

interface DefenderDevice {
  id: string;
  computerDnsName: string;
  osPlatform: string;
  osVersion: string;
  osBuild: string | number | null;
  patchVersion: string | null;
  lastSeen: string;
  riskScore: string;
  healthStatus: string;
  onboardingStatus: string;
  logonUsers: Array<{ userPrincipalName?: string }>;
  registeredOwner: { displayName?: string; userPrincipalName?: string } | null;
  inIntune?: boolean;
  inMam?: boolean;
  inMde?: boolean;
}
type TenantStatus = 'loading' | 'ready' | 'error' | 'nodata';
interface TenantDeviceEntry { status: TenantStatus; devices: DefenderDevice[]; error?: string }

const GROUP_FIELDS: Record<string, Record<string, [string, string][]>> = {
  'app-protection': {
    android: [
      ['minimumRequiredOsVersion', 'Min required OS'],
      ['minimumWarningOsVersion',  'Min warning OS'],
      ['minimumWipeOsVersion',     'Min wipe OS'],
      ['minimumRequiredPatchVersion', 'Min required patch'],
      ['minimumWarningPatchVersion',  'Min warning patch'],
    ],
    ios: [
      ['minimumRequiredOsVersion', 'Min required OS'],
      ['minimumWarningOsVersion',  'Min warning OS'],
      ['minimumWipeOsVersion',     'Min wipe OS'],
    ],
  },
  'compliance': {
    android: [['osMinimumVersion', 'Min OS version'], ['minAndroidSecurityPatchLevel', 'Min security patch level']],
    ios:     [['osMinimumVersion', 'Min OS version']],
    windows: [['osMinimumVersion', 'Min OS version (build)']],
    macos:   [['osMinimumVersion', 'Min OS version']],
  },
};

function getImpactedDevices(devices: DefenderDevice[], threshold: string): DefenderDevice[] {
  if (!threshold) return [];
  return devices.filter(d => deviceBelowThreshold(d, threshold));
}

function includeInOsImpact(row: { platform?: string; inIntune?: boolean; inMam?: boolean }, plat: Platform): boolean {
  if (row.platform !== plat) return false;
  // Desktop compliance policies only apply to Intune-managed devices.
  // MDE-only Windows/macOS machines are already offboarded.
  if (plat === 'windows' || plat === 'macos') return row.inIntune === true;
  // Mobile: App Protection needs MAM, compliance needs MDM. MDE-only is neither.
  return row.inIntune === true || row.inMam === true;
}

function complianceRowToDevice(row: {
  id: string;
  deviceName: string;
  platform: string;
  osVersion: string | null;
  patchVersion: string | null;
  mdeLastSeen: string | null;
  lastSync: string | null;
  mdeRiskScore: string | null;
  mdeHealthStatus: string | null;
  mdeOnboardingStatus: string | null;
  primaryUser: string | null;
  inIntune?: boolean;
  inMam?: boolean;
  inMde?: boolean;
}): DefenderDevice {
  const osVersion = resolveDeviceOsVersion({ osVersion: row.osVersion }) || row.osVersion || '';
  return {
    id: row.id,
    computerDnsName: row.deviceName,
    osPlatform: row.platform,
    osVersion,
    osBuild: null,
    patchVersion: row.patchVersion,
    lastSeen: row.mdeLastSeen ?? row.lastSync ?? '',
    riskScore: row.mdeRiskScore ?? '',
    healthStatus: row.mdeHealthStatus ?? '',
    onboardingStatus: row.mdeOnboardingStatus ?? '',
    logonUsers: row.primaryUser ? [{ userPrincipalName: row.primaryUser }] : [],
    registeredOwner: row.primaryUser ? { userPrincipalName: row.primaryUser } : null,
    inIntune: !!row.inIntune,
    inMam: !!row.inMam,
    inMde: !!row.inMde,
  };
}

function managementTypeLabel(d: DefenderDevice): string {
  const parts: string[] = [];
  if (d.inIntune) parts.push('MDM');
  if (d.inMam) parts.push('MAM');
  if (d.inMde) parts.push('MDE');
  return parts.join('+') || '—';
}

function getImpactedByPatch(devices: DefenderDevice[], patchThreshold: string): DefenderDevice[] {
  if (!patchThreshold) return [];
  return devices.filter(d => d.patchVersion && d.patchVersion < patchThreshold);
}

function normVal(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return /^0+(-0+)*$/.test(s) || s === '' ? null : s;
}

function defaultSelectedPaths(pols: Policy[], plat: Platform): Set<string> {
  const withValues = pols.filter(p => {
    const fields = GROUP_FIELDS[p.policyGroup]?.[plat] ?? [];
    return fields.some(([k]) => normVal(p.data?.[k]) != null);
  });
  const pick = withValues.length ? withValues : pols;
  return new Set(pick.map(p => p.path));
}

function Checkbox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
      border: `2px solid ${checked || indeterminate ? '#22c55e' : '#52525b'}`,
      background: checked ? '#22c55e' : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {checked && !indeterminate && (
        <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
      {indeterminate && !checked && (
        <div style={{ width: 8, height: 2, borderRadius: 1, background: '#22c55e' }} />
      )}
    </div>
  );
}

function Spinner() {
  return <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite', verticalAlign: 'middle' }} />;
}

function SupportedBadge({ on }: { on: boolean }) {
  return <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: on ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)', color: on ? '#22c55e' : '#f87171', border: `1px solid ${on ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.2)'}` }}>{on ? 'Supported' : 'End of support'}</span>;
}

function PlatformCard({ label, info, platform }: { label: string; info: PlatformInfo; platform: string }) {
  if (!info || info.version === 'unavailable') {
    return (
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{label}</span>
        </div>
        <div style={{ fontSize: '0.75rem', color: '#f87171' }}>{info?.source ?? 'Unavailable'}</div>
      </div>
    );
  }

  if (platform === 'windows') {
    const releases = info.windowsReleases ?? [];
    const active = releases.filter(r => !r.isEol).slice(0, 4);
    return (
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{label}</span>
          <SupportedBadge on={true} />
        </div>
        <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e4e4e7', marginBottom: 4 }}>{active[0]?.label ?? info.version}</div>
        <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#71717a', marginBottom: 8 }}>{active[0]?.buildNumber}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {active.map(r => (
            <div key={r.buildNumber} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#71717a' }}>
              <span style={{ color: '#a1a1aa' }}>{r.label}</span>
              <span style={{ fontFamily: 'monospace', color: '#52525b' }}>{r.buildNumber}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const isAndroid = platform === 'android';
  const patchLine = isAndroid && info.patchDate
    ? <div style={{ fontSize: '0.72rem', color: '#71717a', marginTop: 4 }}>Latest patch: <span style={{ fontFamily: 'monospace', color: '#d4d4d8' }}>{info.patchDate}</span></div>
    : info.releaseDate ? <div style={{ fontSize: '0.72rem', color: '#71717a', marginTop: 4 }}>Released: {info.releaseDate}</div> : null;

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{label}</span>
        <SupportedBadge on={info.supported} />
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#e4e4e7' }}>{info.version}</div>
      {patchLine}
      {info.supportedVersions?.length > 0 && (
        <div style={{ fontSize: '0.7rem', color: '#71717a', marginTop: 6 }}>
          Receiving updates: <span style={{ color: '#a1a1aa' }}>{info.supportedVersions.slice(0, 4).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

function buildOsOptions(vd: PlatformInfo, isAndroid: boolean, useExtended = false): [string, string][] {
  const versions = useExtended ? (vd.extendedVersions ?? vd.supportedVersions ?? []) : (vd.supportedVersions ?? []);
  if (!versions.length) return [];
  const supportedSet = new Set(vd.supportedVersions ?? []);
  return versions.map((v, i) => {
    let value: string, label: string;
    if (isAndroid) {
      if (useExtended) { value = v; label = `Android ${v.split('.')[0]}`; }
      else { const major = v.split(' ')[0]; value = `${major}.0`; label = `Android ${v}`; }
    } else {
      value = v;
      const major = v.split('.')[0];
      if (useExtended) { const tag = i === 0 ? 'latest' : supportedSet.has(v) ? 'supported' : 'end of life'; label = `iOS ${major} — ${v} (${tag})`; }
      else { label = `iOS ${major} — ${v} (${i === 0 ? 'latest' : 'previous major'})`; }
    }
    return [value, label + ((!useExtended && i === versions.length - 1) ? ' — recommended' : '')];
  });
}

function buildPatchOptions(patchDate: string | null | undefined): [string, string][] {
  if (!patchDate) return [];
  const opts: [string, string][] = [];
  const [year, month] = patchDate.split('-').map(Number);
  for (let i = 0; i < 13; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const value = `${yyyy}-${mm}-01`;
    opts.push([value, value + (i === 0 ? ' — latest · recommended' : '')]);
  }
  return opts;
}

function buildWindowsBuildOptions(releases: WindowsRelease[]): [string, string][] {
  return releases.map((r, i) => [r.buildNumber, `${r.label}${r.isEol ? ' (EOL)' : ''} — ${r.buildNumber}${i === 0 ? ' — latest · recommended' : ''}`]);
}

function buildMacosOptions(vd: PlatformInfo): [string, string][] {
  return (vd.supportedVersions ?? []).map((v, i) => [v, `macOS ${v.split('.')[0]} — ${v}${i === 0 ? ' — latest · recommended' : ''}`]);
}

function SelectField({ id, label, options, value, onChange }: { id: string; label: string; options: [string, string][]; value: string; onChange: (v: string) => void }) {
  const opts: [string, string][] = [['', '— no minimum —'], ...options];
  const exists = opts.some(([v]) => v === value);
  const allOpts: [string, string][] = exists ? opts : (value ? [['', '— no minimum —'], [value, `${value}  (current · below supported range)`], ...options] : opts);

  return (
    <div className="form-group">
      <label>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {allOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}


type ImpactKind = 'allowed' | 'blocked' | 'warning' | 'unknown';
type ImpactFilter = 'all' | ImpactKind;
type BlockReason = 'App Protection' | 'Compliance' | 'App Protection + Compliance';
type ImpactResult = {
  allowed: DefenderDevice[];
  blocked: DefenderDevice[];
  warnedOnly: DefenderDevice[];
  unknown: DefenderDevice[];
  reasons: Map<string, BlockReason>;
};
type ActivityDays = 7 | 14 | 30 | 60 | 90 | null;
type TenantRow = { slug: string; displayName: string };

const ACTIVITY_OPTIONS: Array<{ days: ActivityDays; label: string }> = [
  { days: null, label: 'All' },
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' },
];

function seenWithinDays(lastSeen: string | null | undefined, days: ActivityDays): boolean {
  if (days == null) return true;
  if (!lastSeen) return false;
  const t = new Date(lastSeen).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 86_400_000;
}

const IMPACT_STYLE: Record<ImpactKind, { bg: string; color: string; border: string; label: string }> = {
  allowed: { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', border: 'rgba(34,197,94,0.25)', label: 'Allowed' },
  blocked: { bg: 'rgba(239,68,68,0.12)', color: '#f87171', border: 'rgba(239,68,68,0.25)', label: 'Blocked' },
  warning: { bg: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: 'rgba(251,191,36,0.25)', label: 'Warning' },
  unknown: { bg: 'rgba(113,113,122,0.12)', color: '#a1a1aa', border: 'rgba(113,113,122,0.25)', label: 'Unknown' },
};

function ImpactBadge({ kind }: { kind: ImpactKind }) {
  const s = IMPACT_STYLE[kind];
  return (
    <span style={{ fontSize: '0.65rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
      {s.label}
    </span>
  );
}

function countCell(n: number, color: string) {
  return n > 0
    ? <span style={{ color, fontWeight: 600 }}>{n}</span>
    : <span style={{ color: '#3f3f46' }}>0</span>;
}

function ImpactTable({
  tenants, tenantData, expandedTenants, impactFilter, setImpactFilter,
  activityDays, setActivityDays, toggleTenant, computeImpacted,
}: {
  tenants: TenantRow[];
  tenantData: Map<string, TenantDeviceEntry>;
  expandedTenants: Set<string>;
  impactFilter: ImpactFilter;
  setImpactFilter: (f: ImpactFilter) => void;
  activityDays: ActivityDays;
  setActivityDays: (d: ActivityDays) => void;
  toggleTenant: (slug: string) => void;
  computeImpacted: (devices: DefenderDevice[]) => ImpactResult;
}) {
  function activeDevices(devices: DefenderDevice[]) {
    return devices.filter(d => seenWithinDays(d.lastSeen, activityDays));
  }

  const totals = { allowed: 0, blocked: 0, warning: 0, unknown: 0, devices: 0, ready: 0 };
  for (const t of tenants) {
    const entry = tenantData.get(t.slug);
    if (!entry || entry.status !== 'ready') continue;
    const devices = activeDevices(entry.devices);
    const impact = computeImpacted(devices);
    totals.allowed += impact.allowed.length;
    totals.blocked += impact.blocked.length;
    totals.warning += impact.warnedOnly.length;
    totals.unknown += impact.unknown.length;
    totals.devices += impact.allowed.length + impact.blocked.length + impact.warnedOnly.length + impact.unknown.length;
    totals.ready += 1;
  }

  const filters: Array<{ id: ImpactFilter; label: string; count: number; color: string }> = [
    { id: 'all',     label: 'All',     count: totals.devices, color: '#e4e4e7' },
    { id: 'allowed', label: 'Allowed', count: totals.allowed, color: '#22c55e' },
    { id: 'blocked', label: 'Blocked', count: totals.blocked, color: '#f87171' },
    { id: 'warning', label: 'Warning', count: totals.warning, color: '#fbbf24' },
    { id: 'unknown', label: 'Unknown', count: totals.unknown, color: '#a1a1aa' },
  ];

  return (
    <div>
      {totals.ready > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {filters.map(f => {
              const active = impactFilter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setImpactFilter(f.id)}
                  style={{
                    fontSize: '0.72rem', fontFamily: 'inherit', cursor: 'pointer',
                    padding: '3px 9px', borderRadius: 999,
                    border: `1px solid ${active ? f.color : '#27272a'}`,
                    background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                    color: f.color,
                  }}
                >
                  {f.label} {f.count}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: '0.68rem', color: '#52525b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 4 }}>Last activity</span>
            {ACTIVITY_OPTIONS.map(opt => {
              const active = activityDays === opt.days;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setActivityDays(opt.days)}
                  style={{
                    fontSize: '0.72rem', fontFamily: 'inherit', cursor: 'pointer',
                    padding: '3px 9px', borderRadius: 999,
                    border: `1px solid ${active ? '#a1a1aa' : '#27272a'}`,
                    background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                    color: active ? '#e4e4e7' : '#71717a',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #27272a' }}>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'left', fontSize: '0.68rem', color: '#52525b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tenant</th>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#22c55e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Allowed</th>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#f87171', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Blocked</th>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#fbbf24', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Warning</th>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#a1a1aa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Unknown</th>
              <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#52525b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total</th>
              <th style={{ padding: '5px 0', width: 24 }} />
            </tr>
          </thead>
          <tbody>
            {tenants.map(t => {
              const entry = tenantData.get(t.slug);
              if (!entry || entry.status === 'loading') {
                return (
                  <tr key={t.slug} style={{ borderBottom: '1px solid #18181b' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: '#d4d4d8' }}>{t.displayName}</td>
                    <td colSpan={6} style={{ padding: '8px 0', color: '#52525b', fontSize: '0.72rem', fontStyle: 'italic' }}><Spinner /> Loading…</td>
                  </tr>
                );
              }
              if (entry.status === 'error') {
                return (
                  <tr key={t.slug} style={{ borderBottom: '1px solid #18181b' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: '#d4d4d8' }}>{t.displayName}</td>
                    <td colSpan={6} style={{ padding: '8px 0', color: '#f87171', fontSize: '0.72rem' }}>Error: {entry.error}</td>
                  </tr>
                );
              }
              if (entry.status === 'nodata') {
                return (
                  <tr key={t.slug} style={{ borderBottom: '1px solid #18181b' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: '#71717a' }}>{t.displayName}</td>
                    <td colSpan={6} style={{ padding: '8px 0', color: '#3f3f46', fontSize: '0.72rem', fontStyle: 'italic' }}>No backup data — trigger a backup run first</td>
                  </tr>
                );
              }

              const devices = activeDevices(entry.devices);
              const { allowed, blocked, warnedOnly, unknown, reasons } = computeImpacted(devices);
              const total = allowed.length + blocked.length + warnedOnly.length + unknown.length;
              const isExpanded = expandedTenants.has(t.slug);
              const rows: Array<{ device: DefenderDevice; kind: ImpactKind }> = [
                ...blocked.map(d => ({ device: d, kind: 'blocked' as const })),
                ...warnedOnly.map(d => ({ device: d, kind: 'warning' as const })),
                ...unknown.map(d => ({ device: d, kind: 'unknown' as const })),
                ...allowed.map(d => ({ device: d, kind: 'allowed' as const })),
              ].filter(r => impactFilter === 'all' || r.kind === impactFilter);

              return (
                <Fragment key={t.slug}>
                  <tr style={{ borderBottom: isExpanded ? 'none' : '1px solid #18181b', cursor: total > 0 ? 'pointer' : 'default' }}
                    onClick={() => total > 0 && toggleTenant(t.slug)}>
                    <td style={{ padding: '8px 12px 8px 0', color: '#d4d4d8', fontWeight: 500 }}>{t.displayName}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>{countCell(allowed.length, '#22c55e')}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>{countCell(blocked.length, '#f87171')}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>{countCell(warnedOnly.length, '#fbbf24')}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>{countCell(unknown.length, '#a1a1aa')}</td>
                    <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>
                      <span style={{ color: '#e4e4e7', fontWeight: 600 }}>{total}</span>
                    </td>
                    <td style={{ padding: '8px 0', textAlign: 'right', color: '#52525b', fontSize: '0.65rem' }}>
                      {total > 0 && (isExpanded ? '▲' : '▼')}
                    </td>
                  </tr>
                  {isExpanded && total > 0 && (
                    <tr style={{ borderBottom: '1px solid #18181b' }}>
                      <td colSpan={7} style={{ padding: '0 0 8px 0', background: '#0a0a0c' }}>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
                            <thead>
                              <tr style={{ background: '#0f0f11' }}>
                                {['Device', 'Type', 'OS', 'Version', 'Patch', 'Impact', 'Blocked by', 'Last Seen', 'User', 'Risk'].map(h => (
                                  <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: '#52525b', fontWeight: 600, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #27272a', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.slice(0, 200).map(({ device: d, kind }) => {
                                const upn = d.logonUsers?.[0]?.userPrincipalName ?? d.registeredOwner?.userPrincipalName ?? '—';
                                return (
                                  <tr key={d.id} style={{ borderBottom: '1px solid #18181b' }}>
                                    <td style={{ padding: '5px 10px', color: '#d4d4d8', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.computerDnsName}>{d.computerDnsName || d.id}</td>
                                    <td style={{ padding: '5px 10px', color: '#a1a1aa', whiteSpace: 'nowrap' }}>{managementTypeLabel(d)}</td>
                                    <td style={{ padding: '5px 10px', color: '#71717a', whiteSpace: 'nowrap' }}>{d.osPlatform}</td>
                                    <td style={{ padding: '5px 10px', color: IMPACT_STYLE[kind].color, fontFamily: 'monospace', whiteSpace: 'nowrap' }} title={resolveDeviceOsVersion(d) || undefined}>{d.osVersion || resolveDeviceOsVersion(d) || '—'}</td>
                                    <td style={{ padding: '5px 10px', color: '#fbbf24', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{d.patchVersion || '—'}</td>
                                    <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}><ImpactBadge kind={kind} /></td>
                                    <td style={{ padding: '5px 10px', color: kind === 'blocked' || kind === 'warning' ? '#e4e4e7' : '#3f3f46', whiteSpace: 'nowrap' }}>{reasons.get(d.id) ?? '—'}</td>
                                    <td style={{ padding: '5px 10px', color: '#52525b', whiteSpace: 'nowrap' }}>{d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : '—'}</td>
                                    <td style={{ padding: '5px 10px', color: '#a1a1aa', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={upn}>{upn}</td>
                                    <td style={{ padding: '5px 10px' }}><RiskBadge risk={d.riskScore} /></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {rows.length === 0 && (
                            <div style={{ padding: '8px 10px', color: '#52525b', fontSize: '0.7rem' }}>No devices in this filter.</div>
                          )}
                          {rows.length > 200 && (
                            <div style={{ padding: '6px 10px', color: '#52525b', fontSize: '0.7rem' }}>Showing 200 of {rows.length} devices.</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Props { mspSlug: string; tenants: Array<{ slug: string; displayName: string }> }

export default function OsVersionClient({ mspSlug, tenants }: Props) {
  const [platform, setPlatform] = useState<Platform>('android');
  const [osVersions, setOsVersions] = useState<OsVersions | null>(null);
  const [osLoading, setOsLoading] = useState(true);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selectedPolicies, setSelectedPolicies] = useState<Set<string>>(new Set());
  const [polLoading, setPolLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: 'success' | 'error' | '' }>({ msg: '', type: '' });
  const [form, setForm] = useState<Record<string, string>>({});

  // Defender device data keyed by tenant slug
  const [tenantData, setTenantData] = useState<Map<string, TenantDeviceEntry>>(new Map());
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(new Set());
  const [impactFilter, setImpactFilter] = useState<'all' | 'allowed' | 'blocked' | 'warning' | 'unknown'>('all');
  const [activityDays, setActivityDays] = useState<ActivityDays>(null);

  const isMobile = platform === 'android' || platform === 'ios';

  // Fetch live OS version data once
  useEffect(() => {
    setOsLoading(true);
    fetch('/api/os-versions')
      .then(r => r.json())
      .then(d => setOsVersions(d))
      .catch(() => {})
      .finally(() => setOsLoading(false));
  }, []);

  // Fetch baseline policies when platform or msp changes
  const loadPolicies = useCallback(() => {
    setPolLoading(true); setPolicies([]); setSelectedPolicies(new Set()); setStatus({ msg: '', type: '' });
    fetch(`/api/git/baseline-policies?mspSlug=${mspSlug}&platform=${platform}`)
      .then(r => r.json())
      .then(d => {
        if (d.policies) {
          setPolicies(d.policies);
          setSelectedPolicies(defaultSelectedPaths(d.policies, platform));
          prefillForm(d.policies);
        }
      })
      .catch(() => {})
      .finally(() => setPolLoading(false));
  }, [mspSlug, platform]);

  useEffect(() => { loadPolicies(); }, [loadPolicies]);

  // Populate form dropdowns when OS versions load
  useEffect(() => {
    if (osVersions && policies.length) prefillForm(policies);
  }, [osVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load merged Intune + MDE inventory (falls back to the MDE platform file)
  useEffect(() => {
    if (!tenants.length) return;
    setExpandedTenants(new Set());
    const initial = new Map<string, TenantDeviceEntry>(
      tenants.map(t => [t.slug, { status: 'loading', devices: [] }])
    );
    setTenantData(new Map(initial));

    for (const t of tenants) {
      void (async () => {
        try {
          const mergedRes = await fetch(`/api/tenants/${encodeURIComponent(t.slug)}/device-compliance`);
          if (mergedRes.ok) {
            const merged = await mergedRes.json() as {
              hasBackup?: boolean;
              devices?: Array<Parameters<typeof complianceRowToDevice>[0] & { platform?: string; inIntune?: boolean; inMam?: boolean; inMde?: boolean }>;
            };
            if (merged.hasBackup) {
              const devices = (merged.devices ?? [])
                .filter(row => includeInOsImpact(row, platform))
                .map(complianceRowToDevice);
              setTenantData(prev => new Map(prev).set(t.slug, { status: 'ready', devices }));
              return;
            }
          }

          // Desktop impact is Intune-only. Do not fall back to the MDE inventory
          // for Windows/macOS — those leftovers are offboarded.
          if (platform === 'windows' || platform === 'macos') {
            setTenantData(prev => new Map(prev).set(t.slug, { status: 'nodata', devices: [] }));
            return;
          }

          const path = `backups/defender-devices/${platform}-devices.json`;
          const fileRes = await fetch(`/api/git/file?slug=${encodeURIComponent(t.slug)}&path=${encodeURIComponent(path)}`);
          const data = await fileRes.json() as { exists?: boolean; content?: string };
          if (!data.exists) {
            setTenantData(prev => new Map(prev).set(t.slug, { status: 'nodata', devices: [] }));
            return;
          }
          const raw = (data.content ?? '').trim();
          const parsed: DefenderDevice[] = raw ? JSON.parse(raw) : [];
          const devices = parsed.map(d => ({ ...d, inMde: d.inMde ?? true, inIntune: !!d.inIntune, inMam: !!d.inMam }));
          setTenantData(prev => new Map(prev).set(t.slug, { status: 'ready', devices }));
        } catch (e) {
          setTenantData(prev => new Map(prev).set(t.slug, { status: 'error', devices: [], error: (e as Error).message }));
        }
      })();
    }
  }, [platform, mspSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  function prefillForm(pols: Policy[]) {
    const merged: Record<string, string> = {};
    const apFields = GROUP_FIELDS['app-protection']?.[platform] ?? [];
    const cpFields = GROUP_FIELDS['compliance']?.[platform] ?? [];

    const apFirst = pols.find(p => p.policyGroup === 'app-protection' && p.data)?.data ?? {};
    const cpFirst = pols.find(p => p.policyGroup === 'compliance' && p.data)?.data ?? {};

    for (const [k] of apFields) merged[k] = normVal(apFirst[k]) ?? '';
    for (const [k] of cpFields) merged[k] = normVal(cpFirst[k]) ?? '';
    setForm(merged);
  }

  function setField(key: string, val: string) { setForm(prev => ({ ...prev, [key]: val })); }

  async function applyPolicy() {
    const apFields = GROUP_FIELDS['app-protection']?.[platform] ?? [];
    const cpFields = GROUP_FIELDS['compliance']?.[platform] ?? [];

    const apFieldsObj = Object.fromEntries(apFields.map(([k]) => [k, form[k] || null]));
    const cpFieldsObj = Object.fromEntries(cpFields.map(([k]) => [k, form[k] || null]));

    const targets = policies.filter(p => selectedPolicies.has(p.path));
    if (!targets.length) {
      setStatus({ msg: 'Select at least one policy file to update.', type: 'error' });
      return;
    }

    setApplying(true); setStatus({ msg: '', type: '' });
    try {
      let updated = 0;
      for (const p of targets) {
        const fields = p.policyGroup === 'app-protection' ? apFieldsObj : cpFieldsObj;
        const res = await fetch('/api/git/baseline-policies', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mspSlug, path: p.path, fields, sha: (p as Policy & { sha?: string }).sha }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        updated++;
      }
      setStatus({ msg: `${updated} file(s) updated. Trigger a deploy from the Baseline page when ready.`, type: 'success' });
      loadPolicies();
    } catch (e: unknown) {
      setStatus({ msg: e instanceof Error ? e.message : 'Failed', type: 'error' });
    } finally { setApplying(false); }
  }

  function computeImpacted(devices: DefenderDevice[]): ImpactResult {
    if (!isMobile) {
      const required = form.osMinimumVersion ?? '';
      const blocked = getImpactedDevices(devices, required);
      const blockedIds = new Set(blocked.map(d => d.id));
      const unknown = devices.filter(d => !blockedIds.has(d.id) && !!required && !resolveDeviceOsVersion(d));
      const unknownIds = new Set(unknown.map(d => d.id));
      const allowed = devices.filter(d => !blockedIds.has(d.id) && !unknownIds.has(d.id));
      const reasons = new Map<string, BlockReason>(blocked.map(d => [d.id, 'Compliance']));
      return { allowed, blocked, warnedOnly: [], unknown, reasons };
    }

    const mamDevices = devices.filter(d => d.inMam);
    const complianceDevices = devices.filter(d => d.inIntune);
    const inScope = devices.filter(d => d.inMam || d.inIntune);

    const mamRequired = form.minimumRequiredOsVersion ?? '';
    const mamWarning  = form.minimumWarningOsVersion ?? '';
    const mamPatchReq = platform === 'android' ? (form.minimumRequiredPatchVersion ?? '') : '';
    const mamPatchWarn = platform === 'android' ? (form.minimumWarningPatchVersion ?? '') : '';
    const cpRequired  = form.osMinimumVersion ?? '';
    const cpPatch     = platform === 'android' ? (form.minAndroidSecurityPatchLevel ?? '') : '';

    const mamBlockedIds = new Set([
      ...getImpactedDevices(mamDevices, mamRequired),
      ...getImpactedByPatch(mamDevices, mamPatchReq),
    ].map(d => d.id));
    const cpBlockedIds = new Set([
      ...getImpactedDevices(complianceDevices, cpRequired),
      ...getImpactedByPatch(complianceDevices, cpPatch),
    ].map(d => d.id));
    const blockedIds = new Set([...mamBlockedIds, ...cpBlockedIds]);
    const blocked = inScope.filter(d => blockedIds.has(d.id));

    const warnCandIds = new Set([
      ...getImpactedDevices(mamDevices, mamWarning),
      ...getImpactedByPatch(mamDevices, mamPatchWarn),
    ].map(d => d.id));
    const warnedOnly = inScope.filter(d => warnCandIds.has(d.id) && !blockedIds.has(d.id));

    const unknown = inScope.filter(d => {
      if (blockedIds.has(d.id) || warnCandIds.has(d.id)) return false;
      const mamNeedsOs    = d.inMam && !!(mamRequired || mamWarning);
      const mamNeedsPatch = d.inMam && !!mamPatchReq;
      const cpNeedsOs     = !!d.inIntune && !!cpRequired;
      const cpNeedsPatch  = !!d.inIntune && !!cpPatch;
      const missingOs    = (mamNeedsOs || cpNeedsOs) && !resolveDeviceOsVersion(d);
      const missingPatch = (mamNeedsPatch || cpNeedsPatch) && !d.patchVersion;
      return missingOs || missingPatch;
    });
    const unknownIds = new Set(unknown.map(d => d.id));
    const allowed = inScope.filter(d => !blockedIds.has(d.id) && !warnCandIds.has(d.id) && !unknownIds.has(d.id));

    const reasons = new Map<string, BlockReason>();
    for (const d of blocked) {
      const mam = mamBlockedIds.has(d.id);
      const cp = cpBlockedIds.has(d.id);
      reasons.set(d.id, mam && cp ? 'App Protection + Compliance' : mam ? 'App Protection' : 'Compliance');
    }
    for (const d of warnedOnly) reasons.set(d.id, 'App Protection');

    return { allowed, blocked, warnedOnly, unknown, reasons };
  }

  function toggleTenant(slug: string) {
    setExpandedTenants(prev => {
      const next = new Set(prev);
      next.has(slug) ? next.delete(slug) : next.add(slug);
      return next;
    });
  }

  function togglePolicy(path: string) {
    setSelectedPolicies(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function togglePolicyGroup(pols: Policy[]) {
    const allSelected = pols.every(p => selectedPolicies.has(p.path));
    setSelectedPolicies(prev => {
      const next = new Set(prev);
      for (const p of pols) {
        if (allSelected) next.delete(p.path);
        else next.add(p.path);
      }
      return next;
    });
  }

  function renderPolicySection(pols: Policy[], groupLabel: string | null, fields: [string, string][]) {
    if (!pols.length) return null;
    const firstData = pols.find(p => p.data)?.data ?? {};
    const refValues = Object.fromEntries(fields.map(([k]) => [k, normVal(firstData[k])]));
    const allSame = pols.every(p => !p.data || fields.every(([k]) => normVal(p.data![k]) === refValues[k]));
    const selectedCount = pols.filter(p => selectedPolicies.has(p.path)).length;
    const allSelected = selectedCount === pols.length;
    const someSelected = selectedCount > 0 && !allSelected;

    return (
      <div style={{ marginBottom: 12 }}>
        {groupLabel && <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, marginTop: 4 }}>{groupLabel}</div>}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => togglePolicyGroup(pols)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#a1a1aa', fontSize: '0.75rem', fontFamily: 'inherit' }}
          >
            <Checkbox checked={allSelected} indeterminate={someSelected} />
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <span style={{ fontSize: '0.72rem', color: '#71717a' }}>{selectedCount} of {pols.length} selected</span>
        </div>
        {!allSame && (
          <div style={{ color: '#fbbf24', fontSize: '0.75rem', marginBottom: 8 }}>⚠ Values differ across {pols.length} files</div>
        )}
        {allSame && pols.length > 1 && (
          <div style={{ fontSize: '0.72rem', color: '#71717a', marginBottom: 6 }}>{pols.length} files — all matching</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pols.map(p => {
            const checked = selectedPolicies.has(p.path);
            return (
              <button
                key={p.path}
                type="button"
                onClick={() => togglePolicy(p.path)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left',
                  background: checked ? 'rgba(34,197,94,0.06)' : '#18181b',
                  border: `1px solid ${checked ? 'rgba(34,197,94,0.28)' : '#27272a'}`,
                  borderRadius: 6, padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <div style={{ marginTop: 2 }}><Checkbox checked={checked} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>{p.name}</div>
                  {fields.map(([k]) => {
                    const val = normVal(p.data?.[k]);
                    return (
                      <div key={k} style={{ display: 'flex', gap: 8, fontSize: '0.72rem', color: '#71717a' }}>
                        <span style={{ fontFamily: 'monospace', minWidth: 220 }}>{k}</span>
                        {val !== null ? <span style={{ color: '#d4d4d8' }}>{val}</span> : <span style={{ color: '#3f3f46', fontStyle: 'italic' }}>— not set —</span>}
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const apPolicies  = policies.filter(p => p.policyGroup === 'app-protection');
  const cpPolicies  = policies.filter(p => p.policyGroup === 'compliance');
  const apFields    = (GROUP_FIELDS['app-protection']?.[platform] ?? []) as [string, string][];
  const cpFields    = (GROUP_FIELDS['compliance']?.[platform] ?? []) as [string, string][];

  const vd = osVersions?.[platform];
  const apOsOpts   = vd ? buildOsOptions(vd, platform === 'android') : [];
  const apWipeOpts = vd ? buildOsOptions(vd, platform === 'android', true) : [];
  const patchOpts  = vd && 'patchDate' in vd ? buildPatchOptions(vd.patchDate) : [];
  const cpOsOpts   = platform === 'windows' ? buildWindowsBuildOptions(vd?.windowsReleases ?? [])
                   : platform === 'macos'   ? buildMacosOptions(vd as PlatformInfo ?? { version: '', releaseDate: null, supported: true, source: '', supportedVersions: [] })
                   : apOsOpts;

  const PLATFORM_LABELS: Record<Platform, string> = { android: '🤖 Android', ios: '🍎 iOS', windows: '🪟 Windows', macos: '🖥 macOS' };

  // ── Impacted Devices helpers ─────────────────────────────────────────────────
  const required  = isMobile ? (form.minimumRequiredOsVersion ?? '') : (form.osMinimumVersion ?? '');
  const warning   = isMobile ? (form.minimumWarningOsVersion  ?? '') : '';
  const hasThreshold = !!(required || warning || form.osMinimumVersion || form.minimumRequiredPatchVersion || form.minAndroidSecurityPatchLevel);
  const selectedCount = policies.filter(p => selectedPolicies.has(p.path)).length;

  return (
    <div style={{ maxWidth: 1040 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Section 1: Live OS versions ─────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 14 }}>Latest OS Versions</h3>
        {osLoading ? (
          <div style={{ color: '#52525b', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8 }}><Spinner /> Loading live version data…</div>
        ) : !osVersions ? (
          <div style={{ color: '#f87171', fontSize: '0.82rem' }}>Failed to load OS version data.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <PlatformCard label="iOS"     info={osVersions.ios}     platform="ios" />
            <PlatformCard label="Android" info={osVersions.android} platform="android" />
            <PlatformCard label="Windows" info={osVersions.windows} platform="windows" />
            <PlatformCard label="macOS"   info={osVersions.macos}   platform="macos" />
          </div>
        )}
      </div>

      {/* ── Platform tabs ────────────────────────────────────────────── */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        {(['android', 'ios', 'windows', 'macos'] as Platform[]).map(p => (
          <button key={p} className={`tab${platform === p ? ' active' : ''}`} onClick={() => setPlatform(p)}>
            {PLATFORM_LABELS[p]}
          </button>
        ))}
      </div>

      {/* ── Section 2: Current Policy ────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>Current Policy</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12 }}>
          Select the files to update. Files that already set a threshold are pre-selected.
        </p>
        {polLoading ? (
          <div style={{ color: '#52525b', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8 }}><Spinner /> Loading baseline policies…</div>
        ) : policies.length === 0 ? (
          <div style={{ color: '#52525b', fontSize: '0.82rem' }}>No {platform} policy files found in the baseline repo.</div>
        ) : (
          <>
            {isMobile && renderPolicySection(apPolicies, apPolicies.length ? 'App Protection (MAM)' : null, apFields)}
            {renderPolicySection(cpPolicies, (isMobile && cpPolicies.length) ? 'Compliance Policies' : null, cpFields)}
          </>
        )}
      </div>

      {/* ── Section 3: Update Thresholds ─────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>Update OS Version Thresholds</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 16 }}>
          Changes are committed to the baseline repo. Trigger a deploy from the Baseline page when ready.
        </p>

        {isMobile && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>App Protection (MAM)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <SelectField id="f-req" label="minimumRequiredOsVersion" options={apOsOpts} value={form.minimumRequiredOsVersion ?? ''} onChange={v => setField('minimumRequiredOsVersion', v)} />
              <SelectField id="f-warn" label="minimumWarningOsVersion" options={apOsOpts} value={form.minimumWarningOsVersion ?? ''} onChange={v => setField('minimumWarningOsVersion', v)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <SelectField id="f-wipe" label="minimumWipeOsVersion" options={apWipeOpts} value={form.minimumWipeOsVersion ?? ''} onChange={v => setField('minimumWipeOsVersion', v)} />
              {platform === 'android' && (
                <SelectField id="f-pr" label="minimumRequiredPatchVersion" options={patchOpts} value={form.minimumRequiredPatchVersion ?? ''} onChange={v => setField('minimumRequiredPatchVersion', v)} />
              )}
            </div>
            {platform === 'android' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <SelectField id="f-pw" label="minimumWarningPatchVersion" options={patchOpts} value={form.minimumWarningPatchVersion ?? ''} onChange={v => setField('minimumWarningPatchVersion', v)} />
              </div>
            )}
          </div>
        )}

        <div>
          {isMobile && <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Compliance Policy</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <SelectField id="f-cp-min" label="osMinimumVersion" options={cpOsOpts} value={form.osMinimumVersion ?? ''} onChange={v => setField('osMinimumVersion', v)} />
            {platform === 'android' && (
              <SelectField id="f-cp-patch" label="minAndroidSecurityPatchLevel" options={patchOpts} value={form.minAndroidSecurityPatchLevel ?? ''} onChange={v => setField('minAndroidSecurityPatchLevel', v)} />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn" onClick={applyPolicy} disabled={applying || selectedCount === 0}>
            {applying ? <><Spinner /> Applying…</> : selectedCount === 0 ? 'Select policies to apply' : `Apply to ${selectedCount} file${selectedCount === 1 ? '' : 's'}`}
          </button>
          {selectedCount > 0 && (
            <span style={{ fontSize: '0.75rem', color: '#71717a' }}>
              {selectedCount} of {policies.length} selected in Current Policy
            </span>
          )}
          {status.msg && (
            <span style={{ fontSize: '0.82rem', color: status.type === 'success' ? '#22c55e' : '#f87171' }}>
              {status.msg}
            </span>
          )}
        </div>
      </div>

      {/* ── Section 4: Impacted Devices ─────────────────────────────── */}
      <div className="card">
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>Impacted Devices</h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12 }}>
          {isMobile
            ? 'App Protection scores MAM-registered devices. Compliance scores MDM devices only. A device in both is blocked if it fails either.'
            : 'Windows and macOS use Intune-managed devices only — MDE-only machines are treated as offboarded.'}
        </p>

        {!tenants.length ? (
          <div style={{ color: '#52525b', fontSize: '0.82rem' }}>No managed tenants found.</div>
        ) : !hasThreshold ? (
          <div style={{ color: '#52525b', fontSize: '0.82rem' }}>
            Set a required or warning OS version threshold above to see allowed and impacted devices per tenant.
          </div>
        ) : (
          <ImpactTable
            tenants={tenants}
            tenantData={tenantData}
            expandedTenants={expandedTenants}
            impactFilter={impactFilter}
            setImpactFilter={setImpactFilter}
            activityDays={activityDays}
            setActivityDays={setActivityDays}
            toggleTenant={toggleTenant}
            computeImpacted={computeImpacted}
          />
        )}
      </div>
    </div>
  );
}
