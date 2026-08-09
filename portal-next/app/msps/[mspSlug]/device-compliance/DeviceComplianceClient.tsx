'use client';
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
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
  blue: '#60a5fa',
  blueBg: 'rgba(96,165,250,0.12)',
} as const;

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

interface TableRow extends DeviceComplianceRow {
  tenantName: string;
  tenantSlug: string;
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
    return allRows.filter(row => {
      const [matched] = applyDeviceFilters([row], effectiveFilters);
      if (!matched) return false;
      if (lastSeenMode === 'never' && !deviceHasNoLastSeen(row)) return false;
      return true;
    });
  }, [allRows, effectiveFilters, lastSeenMode]);

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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <SummaryCard label="Total devices" value={aggregateSummary.total} />
        <SummaryCard label="Compliant" value={aggregateSummary.compliant} accent={C.green} />
        <SummaryCard label="Non-compliant" value={aggregateSummary.nonCompliant} accent={C.red} />
        <SummaryCard label="Grace period" value={aggregateSummary.gracePeriod} accent={C.yellow} />
        <SummaryCard label="High MDE risk" value={aggregateSummary.highRisk} accent={C.red} />
        <SummaryCard label="MAM only" value={aggregateSummary.mamOnly} accent={C.blue} />
      </div>

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
                  const rowKey = `${row.tenantSlug}:${row.id}`;
                  const isExpanded = expandedId === rowKey;
                  const hasExtra = row.model || row.manufacturer || row.isEncrypted != null || row.jailBroken != null || row.mdeRbacGroupName;
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        style={{ borderBottom: '1px solid #18181b', cursor: hasExtra ? 'pointer' : 'default' }}
                        onClick={() => hasExtra && setExpandedId(isExpanded ? null : rowKey)}
                      >
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
                          <td colSpan={selectedTenant === 'all' ? 13 : 12} style={{ padding: '8px 12px', fontSize: '0.72rem', color: C.dim }}>
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
