'use client';
import { useState, useEffect, useCallback, useMemo, Fragment, useRef } from 'react';
import RiskBadge from '@/components/RiskBadge';
import type { DeviceComplianceRow, DeviceComplianceSummary } from '@/lib/device-compliance-merge';
import {
  applyDeviceFilters,
  countActiveFilters,
  EMPTY_DEVICE_FILTERS,
  summarizeDevices,
  type AdvancedDeviceFilters,
} from '@/lib/device-compliance-merge';

type SortKey = 'deviceName' | 'platform' | 'osVersion' | 'complianceState' | 'mdeRiskScore' | 'lastSync';
type SortDir = 'asc' | 'desc';

interface TenantData {
  status: 'loading' | 'ready' | 'error' | 'nodata';
  summary: DeviceComplianceSummary;
  devices: DeviceComplianceRow[];
  intuneInventoryMissing?: boolean;
  error?: string;
}

const EMPTY_SUMMARY: DeviceComplianceSummary = {
  total: 0, compliant: 0, nonCompliant: 0, gracePeriod: 0,
  notInIntune: 0, highRisk: 0, mamOnly: 0, intuneManaged: 0,
};

interface Props {
  mspSlug: string;
  tenants: { slug: string; displayName: string }[];
}

interface TableRow extends DeviceComplianceRow {
  tenantName: string;
  tenantSlug: string;
}

const C = {
  bg: '#09090b',
  surface: '#111113',
  border: '#27272a',
  muted: '#52525b',
  dim: '#71717a',
  body: '#a1a1aa',
  text: '#e4e4e7',
  green: '#22c55e',
  greenBg: 'rgba(34,197,94,0.12)',
  red: '#f87171',
  redBg: 'rgba(248,113,113,0.12)',
  yellow: '#fbbf24',
  yellowBg: 'rgba(251,191,36,0.12)',
  orange: '#fb923c',
  orangeBg: 'rgba(251,146,60,0.12)',
  blue: '#60a5fa',
  blueBg: 'rgba(96,165,250,0.12)',
} as const;

interface SecurityGroup { id: string; displayName: string }
interface GroupFilterRow { id: string; groupKey: string; mode: 'member' | 'not-member' }
interface DeviceMemberCacheEntry {
  deviceIds: Set<string>;
  notBacked: boolean;
  deviceMembersMissing: boolean;
}

function memberCacheKey(tenantSlug: string, groupKey: string) {
  return `${tenantSlug}::${groupKey}`;
}

function deviceRowKey(row: { tenantSlug: string; id: string }) {
  return `${row.tenantSlug}:${row.id}`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function lastSeenIso(row: DeviceComplianceRow): string {
  const raw = row.mdeLastSeen ?? row.lastSync;
  return raw ? new Date(raw).toISOString() : '';
}

function buildSelectedDevicesClipboardText(rows: TableRow[]): string {
  return rows.map(r => r.deviceName).join('\n');
}

function buildSelectedDevicesCsv(rows: TableRow[]): string {
  const headers = [
    'Tenant',
    'DeviceName',
    'Platform',
    'OsVersion',
    'PatchVersion',
    'Compliance',
    'Management',
    'MdeRisk',
    'Exposure',
    'Health',
    'Onboarding',
    'AzureAdDeviceId',
    'PrimaryUser',
    'LastSeen',
    'Model',
    'Manufacturer',
    'Encrypted',
    'Jailbroken',
    'MdeGroup',
  ];
  const lines = rows.map(r => [
    r.tenantName,
    r.deviceName,
    r.platform,
    r.osVersion ?? '',
    r.patchVersion ?? '',
    r.complianceState ?? '',
    r.managementType,
    r.mdeRiskScore ?? '',
    r.mdeExposureLevel ?? '',
    r.mdeHealthStatus ?? '',
    r.mdeOnboardingStatus ?? '',
    r.azureADDeviceId ?? '',
    r.primaryUser ?? '',
    lastSeenIso(r),
    r.model ?? '',
    r.manufacturer ?? '',
    r.isEncrypted == null ? '' : r.isEncrypted ? 'Yes' : 'No',
    r.jailBroken == null ? '' : r.jailBroken ? 'Yes' : 'No',
    r.mdeRbacGroupName ?? '',
  ].map(v => csvEscape(String(v))).join(','));
  return [headers.join(','), ...lines].join('\n');
}

function Checkbox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 4, flexShrink: 0, boxSizing: 'border-box',
      border: `2px solid ${checked || indeterminate ? C.green : C.muted}`,
      background: checked && !indeterminate ? C.green : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {checked && !indeterminate && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      {indeterminate && !checked && <div style={{ width: 8, height: 2, borderRadius: 1, background: C.green }} />}
    </div>
  );
}

function Btn({
  children, onClick, disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
        background: '#18181b', color: C.text, border: `1px solid ${C.border}`,
      }}
    >
      {children}
    </button>
  );
}

const PLATFORM_OPTIONS = [
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
  { id: 'ios', label: 'iOS' },
  { id: 'android', label: 'Android' },
  { id: 'other', label: 'Other' },
];

const COMPLIANCE_OPTIONS = [
  { id: 'compliant', label: 'Compliant' },
  { id: 'nonCompliant', label: 'Non-compliant' },
  { id: 'gracePeriod', label: 'Grace period' },
  { id: 'notInIntune', label: 'Not in Intune' },
  { id: 'mamOnly', label: 'MAM only' },
  { id: 'unknown', label: 'Unknown' },
];

const MANAGEMENT_OPTIONS = [
  { id: 'MDM', label: 'MDM' },
  { id: 'MAM', label: 'MAM' },
  { id: 'MDE', label: 'MDE' },
];

const RISK_OPTIONS = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'informational', label: 'Informational' },
  { id: 'none', label: 'None' },
];

const EXPOSURE_OPTIONS = [
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'none', label: 'None' },
];

const LAST_SEEN_OPTIONS: { id: string; label: string; within: number | null; older: number | null }[] = [
  { id: 'any', label: 'Any time', within: null, older: null },
  { id: '7d', label: 'Seen in last 7 days', within: 7, older: null },
  { id: '30d', label: 'Seen in last 30 days', within: 30, older: null },
  { id: '90d', label: 'Seen in last 90 days', within: 90, older: null },
  { id: '180d', label: 'Seen in last 180 days', within: 180, older: null },
  { id: 'stale90', label: 'Not seen in 90+ days', within: null, older: 90 },
  { id: 'never', label: 'No last seen date', within: null, older: null },
];

function complianceLabel(state: string | null): string {
  if (!state) return 'Unknown';
  if (state === 'notInIntune') return 'Not in Intune';
  if (state === 'inGracePeriod') return 'Grace period';
  if (state === 'noncompliant') return 'Non-compliant';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function ComplianceBadge({ state }: { state: string | null }) {
  const label = complianceLabel(state);
  let color: string = C.muted;
  let bg = 'rgba(82,82,91,0.12)';
  if (state === 'compliant') { color = C.green; bg = C.greenBg; }
  else if (state === 'noncompliant') { color = C.red; bg = C.redBg; }
  else if (state === 'inGracePeriod') { color = C.yellow; bg = C.yellowBg; }
  else if (state === 'notInIntune') { color = C.blue; bg = C.blueBg; }
  return (
    <span style={{
      fontSize: '0.65rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4,
      color, background: bg, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="card" style={{ padding: '14px 16px', minWidth: 120 }}>
      <div style={{ fontSize: '0.65rem', color: C.dim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent ?? C.text }}>{value}</div>
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid #27272a', borderTopColor: '#22c55e',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  );
}

function MultiChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: '0.72rem', fontWeight: 600, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
        border: `1px solid ${active ? 'rgba(34,197,94,0.45)' : C.border}`,
        background: active ? 'rgba(34,197,94,0.12)' : C.surface,
        color: active ? C.green : C.body,
        fontFamily: 'inherit',
      }}
    >
      {active ? '✓ ' : ''}{label}
    </button>
  );
}

function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: '0.65rem', fontWeight: 700, color: C.dim, textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>
    </div>
  );
}

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
}

function sortDevices(devices: TableRow[], key: SortKey, dir: SortDir): TableRow[] {
  const mult = dir === 'asc' ? 1 : -1;
  return [...devices].sort((a, b) => {
    const av = a[key] ?? '';
    const bv = b[key] ?? '';
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv, undefined, { sensitivity: 'base' }) * mult;
    }
    return 0;
  });
}

function deviceHasNoLastSeen(row: DeviceComplianceRow): boolean {
  return !(row.mdeLastSeen ?? row.lastSync);
}

export default function DeviceComplianceClient({ tenants }: Props) {
  const [selectedTenant, setSelectedTenant] = useState<string>('all');
  const [filters, setFilters] = useState<AdvancedDeviceFilters>(EMPTY_DEVICE_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [lastSeenMode, setLastSeenMode] = useState('any');
  const [sortKey, setSortKey] = useState<SortKey>('deviceName');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tenantData, setTenantData] = useState<Record<string, TenantData>>({});

  const [groups, setGroups] = useState<SecurityGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsNeeded, setGroupsNeeded] = useState(false);
  const [groupFilters, setGroupFilters] = useState<GroupFilterRow[]>([]);
  const [groupFilterLogic, setGroupFilterLogic] = useState<'and' | 'or'>('and');
  const [memberCache, setMemberCache] = useState<Record<string, DeviceMemberCacheEntry | null>>({});
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const tenantScopeRef = useRef(selectedTenant);
  tenantScopeRef.current = selectedTenant;

  const loadTenant = useCallback(async (slug: string) => {
    setTenantData(prev => ({
      ...prev,
      [slug]: { status: 'loading', summary: EMPTY_SUMMARY, devices: [] },
    }));

    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(slug)}/device-compliance`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');

      if (!data.hasBackup) {
        setTenantData(prev => ({
          ...prev,
          [slug]: { status: 'nodata', summary: data.summary, devices: [] },
        }));
        return;
      }

      setTenantData(prev => ({
        ...prev,
        [slug]: {
          status: 'ready',
          summary: data.summary,
          devices: data.devices ?? [],
          intuneInventoryMissing: data.intuneInventoryMissing === true,
        },
      }));
    } catch (err) {
      setTenantData(prev => ({
        ...prev,
        [slug]: {
          status: 'error',
          summary: EMPTY_SUMMARY,
          devices: [],
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      }));
    }
  }, []);

  useEffect(() => {
    for (const t of tenants) loadTenant(t.slug);
  }, [tenants, loadTenant]);

  useEffect(() => {
    setGroups([]);
    setGroupsLoading(false);
    setGroupsNeeded(false);
    setGroupFilters([]);
    setGroupFilterLogic('and');
    setMemberCache({});
    setSelectedDevices(new Set());
    setExportMsg(null);
  }, [selectedTenant]);

  const groupTenantSlugs = useMemo(
    () => selectedTenant === 'all' ? tenants.map(t => t.slug) : [selectedTenant],
    [selectedTenant, tenants],
  );

  useEffect(() => {
    if (!groupsNeeded || groups.length > 0) return;
    const slugs = groupTenantSlugs;
    const scope = selectedTenant;
    let cancelled = false;
    setGroupsLoading(true);
    Promise.all(slugs.map(slug =>
      fetch(`/api/tenants/${encodeURIComponent(slug)}/security-groups`)
        .then(r => r.json() as Promise<{ groups?: SecurityGroup[] }>)
        .then(body => body.groups ?? [])
        .catch(() => [] as SecurityGroup[]),
    )).then(lists => {
      if (cancelled || tenantScopeRef.current !== scope) return;
      const byName = new Map<string, SecurityGroup>();
      for (const list of lists) {
        for (const g of list) {
          if (g.displayName && !byName.has(g.displayName)) {
            byName.set(g.displayName, { id: g.id ?? '', displayName: g.displayName });
          }
        }
      }
      setGroups([...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));
    }).finally(() => {
      if (!cancelled && tenantScopeRef.current === scope) setGroupsLoading(false);
    });
    return () => { cancelled = true; };
  }, [groupsNeeded, selectedTenant, groups.length, groupTenantSlugs]);

  useEffect(() => {
    const needed: Array<{ slug: string; groupKey: string }> = [];
    for (const f of groupFilters) {
      if (!f.groupKey) continue;
      for (const slug of groupTenantSlugs) {
        if (memberCache[memberCacheKey(slug, f.groupKey)] === undefined) {
          needed.push({ slug, groupKey: f.groupKey });
        }
      }
    }
    if (needed.length === 0) return;

    const scope = selectedTenant;
    setMemberCache(prev => {
      const next = { ...prev };
      for (const n of needed) next[memberCacheKey(n.slug, n.groupKey)] = null;
      return next;
    });

    for (const { slug, groupKey } of needed) {
      fetch(`/api/tenants/${encodeURIComponent(slug)}/group-membership?groupName=${encodeURIComponent(groupKey)}`)
        .then(r => r.json() as Promise<{
          deviceIds?: string[];
          notBacked?: boolean;
          deviceMembersMissing?: boolean;
        }>)
        .then(body => {
          if (tenantScopeRef.current !== scope) return;
          setMemberCache(prev => ({
            ...prev,
            [memberCacheKey(slug, groupKey)]: {
              deviceIds: new Set((body.deviceIds ?? []).map(id => id.toLowerCase())),
              notBacked: body.notBacked === true,
              deviceMembersMissing: body.deviceMembersMissing === true,
            },
          }));
        })
        .catch(() => {
          if (tenantScopeRef.current !== scope) return;
          setMemberCache(prev => ({
            ...prev,
            [memberCacheKey(slug, groupKey)]: { deviceIds: new Set(), notBacked: true, deviceMembersMissing: false },
          }));
        });
    }
  }, [groupFilters, selectedTenant, groupTenantSlugs, memberCache]);

  const activeTenants = selectedTenant === 'all' ? tenants : tenants.filter(t => t.slug === selectedTenant);

  const allRows = useMemo(() => {
    const rows: TableRow[] = [];
    for (const t of activeTenants) {
      const d = tenantData[t.slug];
      if (d?.status === 'ready') {
        for (const device of d.devices) {
          rows.push({ ...device, tenantName: t.displayName, tenantSlug: t.slug });
        }
      }
    }
    return rows;
  }, [activeTenants, tenantData]);

  const effectiveFilters = useMemo((): AdvancedDeviceFilters => {
    const mode = LAST_SEEN_OPTIONS.find(o => o.id === lastSeenMode) ?? LAST_SEEN_OPTIONS[0];
    return {
      ...filters,
      lastSeenWithinDays: mode.within,
      lastSeenOlderThanDays: mode.older,
    };
  }, [filters, lastSeenMode]);

  const filteredRows = useMemo(() => {
    const active = groupFilters.filter(f => f.groupKey);
    return allRows.filter(row => {
      const [matched] = applyDeviceFilters([row], effectiveFilters);
      if (!matched) return false;
      if (lastSeenMode === 'never' && !deviceHasNoLastSeen(row)) return false;

      if (active.length > 0) {
        const results = active.map(f => {
          const members = memberCache[memberCacheKey(row.tenantSlug, f.groupKey)];
          if (!members) return true;
          const aadId = row.azureADDeviceId?.trim().toLowerCase() ?? '';
          const isMember = aadId !== '' && members.deviceIds.has(aadId);
          return f.mode === 'member' ? isMember : !isMember;
        });
        const pass = groupFilterLogic === 'and' ? results.every(Boolean) : results.some(Boolean);
        if (!pass) return false;
      }

      return true;
    });
  }, [allRows, effectiveFilters, lastSeenMode, groupFilters, memberCache, groupFilterLogic]);

  const tableRows = useMemo(
    () => sortDevices(filteredRows, sortKey, sortDir),
    [filteredRows, sortKey, sortDir],
  );

  const aggregateSummary = useMemo(
    () => summarizeDevices(filteredRows),
    [filteredRows],
  );

  const activeFilterCount = countActiveFilters(effectiveFilters) + (lastSeenMode !== 'any' ? 1 : 0);

  function updateFilters(patch: Partial<AdvancedDeviceFilters>) {
    setFilters(prev => ({ ...prev, ...patch }));
  }

  function clearFilters() {
    setFilters(EMPTY_DEVICE_FILTERS);
    setLastSeenMode('any');
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  const isLoading = activeTenants.some(t => tenantData[t.slug]?.status === 'loading');
  const missingIntuneInventory = activeTenants.some(
    t => tenantData[t.slug]?.status === 'ready' && tenantData[t.slug]?.intuneInventoryMissing,
  );
  const sortIndicator = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  function toggleDevice(rowKey: string) {
    setSelectedDevices(prev => {
      const next = new Set(prev);
      next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey);
      return next;
    });
  }
  function clearSelection() { setSelectedDevices(new Set()); }
  const allVisibleSelected = tableRows.length > 0 && tableRows.every(r => selectedDevices.has(deviceRowKey(r)));
  const someVisibleSelected = !allVisibleSelected && tableRows.some(r => selectedDevices.has(deviceRowKey(r)));
  function toggleSelectAllVisible() {
    setSelectedDevices(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of tableRows) next.delete(deviceRowKey(r));
      } else {
        for (const r of tableRows) next.add(deviceRowKey(r));
      }
      return next;
    });
  }

  const selectedDeviceRecords = useMemo(
    () => allRows.filter(r => selectedDevices.has(deviceRowKey(r))),
    [allRows, selectedDevices],
  );

  async function copySelectedDevices() {
    if (selectedDeviceRecords.length === 0) return;
    try {
      await navigator.clipboard.writeText(buildSelectedDevicesClipboardText(selectedDeviceRecords));
      setExportMsg(`Copied ${selectedDeviceRecords.length} device name${selectedDeviceRecords.length !== 1 ? 's' : ''} to clipboard`);
    } catch {
      setExportMsg('Failed to copy to clipboard');
    }
    setTimeout(() => setExportMsg(null), 3000);
  }

  function exportSelectedDevicesCsv() {
    if (selectedDeviceRecords.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    const scope = selectedTenant === 'all' ? 'all-tenants' : selectedTenant;
    downloadCsv(`device-compliance-${scope}-${date}.csv`, buildSelectedDevicesCsv(selectedDeviceRecords));
    setExportMsg(`Exported ${selectedDeviceRecords.length} device${selectedDeviceRecords.length !== 1 ? 's' : ''} to CSV`);
    setTimeout(() => setExportMsg(null), 3000);
  }

  return (
    <div style={{ padding: '20px 28px 32px' }}>
      {missingIntuneInventory && !isLoading && (
        <div style={{
          marginBottom: 16, padding: '12px 14px', borderRadius: 8,
          background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)',
          color: '#fbbf24', fontSize: '0.8125rem', lineHeight: 1.5,
        }}>
          Intune device inventory (<code style={{ fontSize: '0.75rem' }}>managed-devices.json</code>) is missing from the backup.
          Devices shown below are from Defender for Endpoint only and appear as &quot;Not in Intune&quot;.
          Run a tenant backup to export Intune compliance data (included in the Intune backup step).
        </div>
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <select
          value={selectedTenant}
          onChange={e => setSelectedTenant(e.target.value)}
          style={{
            background: C.surface, border: `1px solid ${C.border}`, color: C.text,
            borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem',
          }}
        >
          <option value="all">All tenants</option>
          {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
        </select>

        <input
          type="search"
          placeholder="Search device or user…"
          value={filters.search}
          onChange={e => updateFilters({ search: e.target.value })}
          style={{
            background: C.surface, border: `1px solid ${C.border}`, color: C.text,
            borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem', minWidth: 220, flex: '1 1 200px',
          }}
        />

        <button
          type="button"
          onClick={() => setFiltersOpen(o => !o)}
          style={{
            background: activeFilterCount > 0 ? C.blueBg : C.surface,
            border: `1px solid ${activeFilterCount > 0 ? 'rgba(96,165,250,0.4)' : C.border}`,
            color: activeFilterCount > 0 ? C.blue : C.body,
            borderRadius: 6, padding: '6px 12px', fontSize: '0.8125rem', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}
        >
          Advanced filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {filtersOpen ? '▲' : '▼'}
        </button>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            style={{
              background: 'transparent', border: 'none', color: C.dim,
              fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {/* Group filter bar */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 16, padding: '7px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: groupFilters.length > 0 ? 8 : 0 }}>
          <span style={{ fontSize: '0.75rem', color: C.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>Group filter</span>

          {groupFilters.length >= 2 && (
            <div style={{ display: 'flex', gap: 2, background: '#18181b', borderRadius: 5, padding: 2 }}>
              {(['and', 'or'] as const).map(l => (
                <button key={l} type="button" onClick={() => setGroupFilterLogic(l)} style={{
                  padding: '2px 10px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  background: groupFilterLogic === l ? C.blue : 'transparent',
                  color:      groupFilterLogic === l ? '#000'  : C.dim,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>{l}</button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setGroupsNeeded(true);
              setGroupFilters(prev => [...prev, { id: crypto.randomUUID(), groupKey: '', mode: 'member' }]);
            }}
            style={{
              padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', fontWeight: 500,
              border: `1px solid ${C.border}`, background: 'transparent',
              color: C.dim, cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ fontSize: '1rem', lineHeight: 1 }}>+</span> Add condition
          </button>

          {groupFilters.length > 0 && (
            <>
              <span style={{ fontSize: '0.75rem', color: C.muted }}>
                {filteredRows.length} / {allRows.length} devices
              </span>
              <button
                type="button"
                onClick={() => setGroupFilters([])}
                style={{ marginLeft: 'auto', padding: '2px 7px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem' }}
              >
                Clear all
              </button>
            </>
          )}
        </div>

        {groupFilters.map((row, idx) => {
          const slugs = groupTenantSlugs;
          const states = slugs.map(s => memberCache[memberCacheKey(s, row.groupKey)]);
          const isLoading = !!row.groupKey && states.some(s => s === null || s === undefined);
          const ready = states.filter((s): s is DeviceMemberCacheEntry => !!s);
          const noBackup = !!row.groupKey && !isLoading && ready.length > 0 && ready.every(s => s.notBacked);
          const needsDeviceBackup = !!row.groupKey && !isLoading && !noBackup && ready.some(s => s.deviceMembersMissing);
          const isConfigured = row.groupKey !== '';

          return (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: idx === 0 ? 0 : 6 }}>
              {idx > 0 && (
                <span style={{
                  fontSize: '0.6875rem', fontWeight: 700, color: C.blue,
                  textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 28, textAlign: 'center',
                }}>
                  {groupFilterLogic}
                </span>
              )}
              {idx === 0 && groupFilters.length > 1 && (
                <span style={{ minWidth: 28 }} />
              )}

              <select
                value={row.groupKey}
                onChange={e => setGroupFilters(prev => prev.map(f => f.id === row.id ? { ...f, groupKey: e.target.value } : f))}
                onFocus={() => setGroupsNeeded(true)}
                style={{
                  background: '#18181b', border: `1px solid ${C.border}`,
                  color: row.groupKey ? C.text : C.muted,
                  borderRadius: 5, padding: '4px 7px', fontSize: '0.8125rem',
                  fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
                  minWidth: 160, maxWidth: 300,
                }}
              >
                <option value="">— select group —</option>
                {groupsLoading && <option disabled>Loading…</option>}
                {groups.map(g => <option key={g.displayName} value={g.displayName}>{g.displayName}</option>)}
              </select>

              {isConfigured && (
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['member', 'not-member'] as const).map(mode => {
                    const active = row.mode === mode;
                    const color  = mode === 'member' ? C.green : C.orange;
                    const bg     = mode === 'member' ? C.greenBg : C.orangeBg;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setGroupFilters(prev => prev.map(f => f.id === row.id ? { ...f, mode } : f))}
                        style={{
                          padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', fontWeight: 500,
                          border: `1px solid ${active ? color : C.border}`,
                          background: active ? bg : 'transparent',
                          color: active ? color : C.dim,
                          cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {mode === 'member' ? 'Is member' : 'Not member'}
                      </button>
                    );
                  })}
                </div>
              )}

              {isLoading && <span style={{ fontSize: '0.75rem', color: C.dim }}>Loading…</span>}
              {!isLoading && noBackup && <span style={{ fontSize: '0.75rem', color: C.yellow }}>⚠ No backup</span>}
              {!isLoading && needsDeviceBackup && (
                <span style={{ fontSize: '0.75rem', color: C.yellow }}>⚠ Run backup to include device members</span>
              )}

              <button
                type="button"
                onClick={() => setGroupFilters(prev => prev.filter(f => f.id !== row.id))}
                style={{ padding: '3px 6px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem' }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {/* Advanced filters panel */}
      {filtersOpen && (
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '14px 16px', marginBottom: 20,
        }}>
          <FilterGroup title="Platform">
            {PLATFORM_OPTIONS.map(p => (
              <MultiChip
                key={p.id}
                label={p.label}
                active={filters.platforms.includes(p.id)}
                onClick={() => updateFilters({ platforms: toggleInList(filters.platforms, p.id) })}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Compliance">
            {COMPLIANCE_OPTIONS.map(c => (
              <MultiChip
                key={c.id}
                label={c.label}
                active={filters.compliance.includes(c.id)}
                onClick={() => updateFilters({ compliance: toggleInList(filters.compliance, c.id) })}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Management">
            {MANAGEMENT_OPTIONS.map(m => (
              <MultiChip
                key={m.id}
                label={m.label}
                active={filters.management.includes(m.id)}
                onClick={() => updateFilters({ management: toggleInList(filters.management, m.id) })}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="MDE risk">
            {RISK_OPTIONS.map(r => (
              <MultiChip
                key={r.id}
                label={r.label}
                active={filters.risks.includes(r.id)}
                onClick={() => updateFilters({ risks: toggleInList(filters.risks, r.id) })}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="MDE exposure">
            {EXPOSURE_OPTIONS.map(e => (
              <MultiChip
                key={e.id}
                label={e.label}
                active={filters.exposures.includes(e.id)}
                onClick={() => updateFilters({ exposures: toggleInList(filters.exposures, e.id) })}
              />
            ))}
          </FilterGroup>

          <div>
            <div style={{
              fontSize: '0.65rem', fontWeight: 700, color: C.dim, textTransform: 'uppercase',
              letterSpacing: '0.06em', marginBottom: 8,
            }}>Last seen</div>
            <select
              value={lastSeenMode}
              onChange={e => setLastSeenMode(e.target.value)}
              style={{
                background: '#18181b', border: `1px solid ${C.border}`, color: C.text,
                borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem', minWidth: 220,
              }}
            >
              {LAST_SEEN_OPTIONS.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>

          {filteredRows.length !== allRows.length && (
            <div style={{ marginTop: 14, fontSize: '0.75rem', color: C.dim }}>
              Showing {filteredRows.length.toLocaleString()} of {allRows.length.toLocaleString()} devices
            </div>
          )}
        </div>
      )}

      {/* Summary cards — reflect active filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <SummaryCard label="Total devices" value={aggregateSummary.total} />
        <SummaryCard label="Compliant" value={aggregateSummary.compliant} accent={C.green} />
        <SummaryCard label="Non-compliant" value={aggregateSummary.nonCompliant} accent={C.red} />
        <SummaryCard label="Grace period" value={aggregateSummary.gracePeriod} accent={C.yellow} />
        <SummaryCard label="High MDE risk" value={aggregateSummary.highRisk} accent={C.red} />
        <SummaryCard label="MAM only" value={aggregateSummary.mamOnly} accent={C.blue} />
      </div>

      {tableRows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10 }}>
          <button
            type="button"
            onClick={toggleSelectAllVisible}
            style={{ padding: '5px 10px', background: 'transparent', border: 'none', color: C.blue, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', borderRadius: 4 }}
          >
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
          {selectedDevices.size > 0 && (
            <button
              type="button"
              onClick={clearSelection}
              style={{ padding: '5px 10px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', borderRadius: 4 }}
            >
              Clear {selectedDevices.size}
            </button>
          )}
        </div>
      )}

      {selectedDevices.size > 0 && (
        <div style={{
          background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.25)',
          borderRadius: 8, padding: '12px 16px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: C.green, fontWeight: 600 }}>
              {selectedDevices.size} device{selectedDevices.size !== 1 ? 's' : ''} selected
            </span>
            <button
              type="button"
              onClick={clearSelection}
              style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: '0.75rem', fontFamily: 'inherit', padding: 0 }}
            >
              Clear selection
            </button>
          </div>
          <div style={{ width: 1, height: 20, background: C.border, flexShrink: 0 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Btn onClick={() => void copySelectedDevices()}>Copy names</Btn>
            <Btn onClick={exportSelectedDevicesCsv}>Export CSV</Btn>
          </div>
          {exportMsg && (
            <div style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: C.blueBg, color: C.blue, fontSize: '0.8125rem' }}>
              {exportMsg}
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {isLoading && (
          <div style={{ padding: 24, textAlign: 'center', color: C.dim }}>
            <Spinner /> Loading device data…
          </div>
        )}

        {!isLoading && tableRows.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: C.dim, fontSize: '0.8125rem' }}>
            No devices match the current filters. Trigger a backup run if tenant data is missing.
          </div>
        )}

        {!isLoading && tableRows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
              <thead>
                <tr style={{ background: '#0f0f11' }}>
                  <th style={{ ...thStyle, width: 36, paddingLeft: 12 }}>
                    <button
                      type="button"
                      onClick={toggleSelectAllVisible}
                      title={allVisibleSelected ? 'Deselect all visible devices' : 'Select all visible devices'}
                      aria-label={allVisibleSelected ? 'Deselect all visible devices' : 'Select all visible devices'}
                      aria-pressed={allVisibleSelected}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      }}
                    >
                      <Checkbox checked={allVisibleSelected} indeterminate={someVisibleSelected} />
                    </button>
                  </th>
                  {selectedTenant === 'all' && (
                    <th style={thStyle}>Tenant</th>
                  )}
                  {([
                    ['deviceName', 'Device'],
                    ['platform', 'Platform'],
                    ['osVersion', 'OS Version'],
                    [null, 'Patch'],
                    ['complianceState', 'Compliance'],
                    [null, 'Management'],
                    ['mdeRiskScore', 'MDE Risk'],
                    [null, 'Exposure'],
                    [null, 'Health'],
                    [null, 'Onboarding'],
                    [null, 'User'],
                    ['lastSync', 'Last Seen'],
                  ] as const).map(([key, label]) => (
                    <th
                      key={label}
                      style={{ ...thStyle, cursor: key ? 'pointer' : 'default' }}
                      onClick={() => key && toggleSort(key as SortKey)}
                    >
                      {label}{key ? sortIndicator(key as SortKey) : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map(row => {
                  const rowKey = deviceRowKey(row);
                  const isSelected = selectedDevices.has(rowKey);
                  const isExpanded = expandedId === rowKey;
                  const hasExtra = row.model || row.manufacturer || row.isEncrypted != null || row.jailBroken != null || row.mdeRbacGroupName;
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        style={{
                          borderBottom: '1px solid #18181b',
                          cursor: hasExtra ? 'pointer' : 'default',
                          background: isSelected ? 'rgba(34,197,94,0.05)' : 'transparent',
                        }}
                        onClick={() => hasExtra && setExpandedId(isExpanded ? null : rowKey)}
                      >
                        <td
                          style={{ ...tdStyle, paddingLeft: 12, verticalAlign: 'middle' }}
                          onClick={e => { e.stopPropagation(); toggleDevice(rowKey); }}
                          title={isSelected ? 'Deselect' : 'Select'}
                        >
                          <Checkbox checked={isSelected} />
                        </td>
                        {selectedTenant === 'all' && (
                          <td style={tdStyle}>{row.tenantName}</td>
                        )}
                        <td style={{ ...tdStyle, fontFamily: 'monospace', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.deviceName}>
                          {row.deviceName}
                        </td>
                        <td style={tdStyle}>{row.platform}</td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.osVersion ?? '—'}</td>
                        <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.patchVersion ?? '—'}</td>
                        <td style={tdStyle}><ComplianceBadge state={row.complianceState} /></td>
                        <td style={tdStyle}>{row.managementType}</td>
                        <td style={tdStyle}><RiskBadge risk={row.mdeRiskScore} /></td>
                        <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{row.mdeExposureLevel ?? '—'}</td>
                        <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{row.mdeHealthStatus ?? '—'}</td>
                        <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{row.mdeOnboardingStatus ?? '—'}</td>
                        <td style={{ ...tdStyle, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.primaryUser ?? undefined}>
                          {row.primaryUser ?? '—'}
                        </td>
                        <td style={tdStyle}>
                          {row.mdeLastSeen
                            ? new Date(row.mdeLastSeen).toLocaleDateString()
                            : row.lastSync
                              ? new Date(row.lastSync).toLocaleDateString()
                              : '—'}
                        </td>
                      </tr>
                      {isExpanded && hasExtra && (
                        <tr style={{ borderBottom: '1px solid #18181b', background: '#0a0a0c' }}>
                          <td colSpan={selectedTenant === 'all' ? 14 : 13} style={{ padding: '8px 12px', fontSize: '0.72rem', color: C.dim }}>
                            {row.model && <span style={{ marginRight: 16 }}>Model: {row.model}</span>}
                            {row.manufacturer && <span style={{ marginRight: 16 }}>Manufacturer: {row.manufacturer}</span>}
                            {row.isEncrypted != null && <span style={{ marginRight: 16 }}>Encrypted: {row.isEncrypted ? 'Yes' : 'No'}</span>}
                            {row.jailBroken != null && <span style={{ marginRight: 16 }}>Jailbroken: {row.jailBroken ? 'Yes' : 'No'}</span>}
                            {row.mdeRbacGroupName && <span>MDE group: {row.mdeRbacGroupName}</span>}
                            {row.complianceGracePeriodExpirationDateTime && (
                              <span style={{ marginLeft: 16 }}>Grace expires: {new Date(row.complianceGracePeriodExpirationDateTime).toLocaleDateString()}</span>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!isLoading && activeTenants.map(t => {
        const d = tenantData[t.slug];
        if (!d || d.status === 'ready' || d.status === 'loading') return null;
        return (
          <div key={t.slug} style={{ marginTop: 12, fontSize: '0.75rem', color: d.status === 'error' ? C.red : C.dim }}>
            {t.displayName}: {d.status === 'error' ? d.error : 'No backup data — trigger a backup run first'}
          </div>
        );
      })}
    </div>
  );
}

const thStyle = {
  padding: '8px 10px',
  textAlign: 'left' as const,
  color: '#52525b',
  fontWeight: 600,
  fontSize: '0.65rem',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  borderBottom: '1px solid #27272a',
  whiteSpace: 'nowrap' as const,
};

const tdStyle = {
  padding: '7px 10px',
  color: '#a1a1aa',
  whiteSpace: 'nowrap' as const,
};
