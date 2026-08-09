'use client';
import { useState, useEffect, useCallback } from 'react';
import RiskBadge from '@/components/RiskBadge';

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
  osBuild: string | null;
  patchVersion: string | null;
  lastSeen: string;
  riskScore: string;
  healthStatus: string;
  onboardingStatus: string;
  logonUsers: Array<{ userPrincipalName?: string }>;
  registeredOwner: { displayName?: string; userPrincipalName?: string } | null;
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

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function getImpactedDevices(devices: DefenderDevice[], threshold: string): DefenderDevice[] {
  if (!threshold) return [];
  return devices.filter(d => d.osVersion && compareVersions(d.osVersion, threshold) < 0);
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


interface Props { mspSlug: string; tenants: Array<{ slug: string; displayName: string }> }

export default function OsVersionClient({ mspSlug, tenants }: Props) {
  const [platform, setPlatform] = useState<Platform>('android');
  const [osVersions, setOsVersions] = useState<OsVersions | null>(null);
  const [osLoading, setOsLoading] = useState(true);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [polLoading, setPolLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: 'success' | 'error' | '' }>({ msg: '', type: '' });
  const [form, setForm] = useState<Record<string, string>>({});

  // Defender device data keyed by tenant slug
  const [tenantData, setTenantData] = useState<Map<string, TenantDeviceEntry>>(new Map());
  const [expandedTenants, setExpandedTenants] = useState<Set<string>>(new Set());

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
    setPolLoading(true); setPolicies([]); setStatus({ msg: '', type: '' });
    fetch(`/api/git/baseline-policies?mspSlug=${mspSlug}&platform=${platform}`)
      .then(r => r.json())
      .then(d => { if (d.policies) { setPolicies(d.policies); prefillForm(d.policies); } })
      .catch(() => {})
      .finally(() => setPolLoading(false));
  }, [mspSlug, platform]);

  useEffect(() => { loadPolicies(); }, [loadPolicies]);

  // Populate form dropdowns when OS versions load
  useEffect(() => {
    if (osVersions && policies.length) prefillForm(policies);
  }, [osVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load defender device backups for all tenants when platform changes
  useEffect(() => {
    if (!tenants.length) return;
    setExpandedTenants(new Set());
    const initial = new Map<string, TenantDeviceEntry>(
      tenants.map(t => [t.slug, { status: 'loading', devices: [] }])
    );
    setTenantData(new Map(initial));

    for (const t of tenants) {
      const path = `backups/defender-devices/${platform}-devices.json`;
      fetch(`/api/git/file?slug=${encodeURIComponent(t.slug)}&path=${encodeURIComponent(path)}`)
        .then(r => r.json())
        .then(data => {
          if (!data.exists) {
            setTenantData(prev => new Map(prev).set(t.slug, { status: 'nodata', devices: [] }));
            return;
          }
          const raw = (data.content ?? '').trim();
          const devices: DefenderDevice[] = raw ? JSON.parse(raw) : [];
          setTenantData(prev => new Map(prev).set(t.slug, { status: 'ready', devices }));
        })
        .catch(e => {
          setTenantData(prev => new Map(prev).set(t.slug, { status: 'error', devices: [], error: (e as Error).message }));
        });
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

    setApplying(true); setStatus({ msg: '', type: '' });
    try {
      let updated = 0;
      for (const p of policies) {
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

  function computeImpacted(devices: DefenderDevice[]) {
    const required     = isMobile ? (form.minimumRequiredOsVersion ?? '') : (form.osMinimumVersion ?? '');
    const warning      = isMobile ? (form.minimumWarningOsVersion  ?? '') : '';
    const patchReq     = platform === 'android' ? (form.minimumRequiredPatchVersion ?? '') : '';
    const patchWarn    = platform === 'android' ? (form.minimumWarningPatchVersion  ?? '') : '';

    const blockedByOs    = getImpactedDevices(devices, required);
    const blockedByPatch = getImpactedByPatch(devices, patchReq);
    const blockedIds     = new Set([...blockedByOs, ...blockedByPatch].map(d => d.id));
    const blocked        = devices.filter(d => blockedIds.has(d.id));

    const warnByOs    = getImpactedDevices(devices, warning);
    const warnByPatch = getImpactedByPatch(devices, patchWarn);
    const warnCandIds = new Set([...warnByOs, ...warnByPatch].map(d => d.id));
    const warnedOnly  = devices.filter(d => warnCandIds.has(d.id) && !blockedIds.has(d.id));

    return { blocked, warnedOnly };
  }

  function toggleTenant(slug: string) {
    setExpandedTenants(prev => {
      const next = new Set(prev);
      next.has(slug) ? next.delete(slug) : next.add(slug);
      return next;
    });
  }

  function renderPolicySection(pols: Policy[], groupLabel: string | null, fields: [string, string][]) {
    if (!pols.length) return null;
    const firstData = pols.find(p => p.data)?.data ?? {};
    const refValues = Object.fromEntries(fields.map(([k]) => [k, normVal(firstData[k])]));
    const allSame = pols.every(p => !p.data || fields.every(([k]) => normVal(p.data![k]) === refValues[k]));

    return (
      <div style={{ marginBottom: 12 }}>
        {groupLabel && <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, marginTop: 4 }}>{groupLabel}</div>}
        {allSame ? (
          <>
            {pols.length > 1 && <div style={{ fontSize: '0.72rem', color: '#71717a', marginBottom: 6 }}>{pols.length} files — all matching</div>}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem', marginBottom: 4 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #27272a' }}>
                  <th style={{ padding: '4px 12px 4px 0', textAlign: 'left', fontSize: '0.72rem', color: '#52525b' }}>Field</th>
                  <th style={{ padding: '4px 0', textAlign: 'left', fontSize: '0.72rem', color: '#52525b' }}>Current value</th>
                </tr>
              </thead>
              <tbody>
                {fields.map(([k, label]) => {
                  const val = refValues[k];
                  return (
                    <tr key={k} style={{ borderBottom: '1px solid #18181b' }}>
                      <td style={{ padding: '6px 12px 6px 0', fontFamily: 'monospace', fontSize: '0.75rem', color: '#71717a' }}>{k}</td>
                      <td style={{ padding: '6px 0', fontSize: '0.8rem' }}>
                        {val !== null ? <span style={{ color: '#e4e4e7' }}>{val}</span> : <span style={{ color: '#3f3f46', fontStyle: 'italic' }}>— not set —</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <div style={{ color: '#fbbf24', fontSize: '0.75rem', marginBottom: 8 }}>
            ⚠ Values differ across {pols.length} files
            {pols.map(p => (
              <div key={p.path} style={{ background: '#18181b', borderRadius: 6, padding: '8px 10px', marginTop: 6 }}>
                <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>{p.name}</div>
                {fields.map(([k]) => {
                  const val = normVal(p.data?.[k]);
                  return <div key={k} style={{ display: 'flex', gap: 8, fontSize: '0.72rem', color: '#71717a' }}>
                    <span style={{ fontFamily: 'monospace', minWidth: 220 }}>{k}</span>
                    {val !== null ? <span style={{ color: '#d4d4d8' }}>{val}</span> : <span style={{ color: '#3f3f46', fontStyle: 'italic' }}>— not set —</span>}
                  </div>;
                })}
              </div>
            ))}
          </div>
        )}
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
  const hasThreshold = !!(required || warning || form.osMinimumVersion);

  return (
    <div style={{ maxWidth: 900 }}>
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
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 12 }}>Current Policy</h3>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn" onClick={applyPolicy} disabled={applying || policies.length === 0}>
            {applying ? <><Spinner /> Applying…</> : 'Apply Now'}
          </button>
          {status.msg && (
            <span style={{ fontSize: '0.82rem', color: status.type === 'success' ? '#22c55e' : '#f87171' }}>
              {status.msg}
            </span>
          )}
        </div>
      </div>

      {/* ── Section 4: Impacted Devices ─────────────────────────────── */}
      <div className="card">
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 12 }}>Impacted Devices</h3>

        {!tenants.length ? (
          <div style={{ color: '#52525b', fontSize: '0.82rem' }}>No managed tenants found.</div>
        ) : !hasThreshold ? (
          <div style={{ color: '#52525b', fontSize: '0.82rem' }}>
            Set a required or warning OS version threshold above to see impacted devices per tenant.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #27272a' }}>
                  <th style={{ padding: '5px 12px 5px 0', textAlign: 'left', fontSize: '0.68rem', color: '#52525b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tenant</th>
                  <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#f87171', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Blocked</th>
                  <th style={{ padding: '5px 12px 5px 0', textAlign: 'center', fontSize: '0.68rem', color: '#fbbf24', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Warning</th>
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
                        <td colSpan={4} style={{ padding: '8px 0', color: '#52525b', fontSize: '0.72rem', fontStyle: 'italic' }}><Spinner /> Loading…</td>
                      </tr>
                    );
                  }
                  if (entry.status === 'error') {
                    return (
                      <tr key={t.slug} style={{ borderBottom: '1px solid #18181b' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: '#d4d4d8' }}>{t.displayName}</td>
                        <td colSpan={4} style={{ padding: '8px 0', color: '#f87171', fontSize: '0.72rem' }}>Error: {entry.error}</td>
                      </tr>
                    );
                  }
                  if (entry.status === 'nodata') {
                    return (
                      <tr key={t.slug} style={{ borderBottom: '1px solid #18181b' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: '#71717a' }}>{t.displayName}</td>
                        <td colSpan={4} style={{ padding: '8px 0', color: '#3f3f46', fontSize: '0.72rem', fontStyle: 'italic' }}>No backup data — trigger a backup run first</td>
                      </tr>
                    );
                  }

                  const { blocked, warnedOnly } = computeImpacted(entry.devices);
                  const totalImpacted = blocked.length + warnedOnly.length;
                  const isExpanded = expandedTenants.has(t.slug);

                  return (
                    <>
                      <tr key={t.slug} style={{ borderBottom: isExpanded ? 'none' : '1px solid #18181b', cursor: totalImpacted > 0 ? 'pointer' : 'default' }}
                        onClick={() => totalImpacted > 0 && toggleTenant(t.slug)}>
                        <td style={{ padding: '8px 12px 8px 0', color: '#d4d4d8', fontWeight: 500 }}>{t.displayName}</td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>
                          {blocked.length > 0
                            ? <span style={{ color: '#f87171', fontWeight: 600 }}>{blocked.length}</span>
                            : <span style={{ color: '#3f3f46' }}>0</span>}
                        </td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>
                          {warnedOnly.length > 0
                            ? <span style={{ color: '#fbbf24', fontWeight: 600 }}>{warnedOnly.length}</span>
                            : <span style={{ color: '#3f3f46' }}>0</span>}
                        </td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>
                          {totalImpacted > 0
                            ? <span style={{ color: '#e4e4e7', fontWeight: 600 }}>{totalImpacted}</span>
                            : <span style={{ color: '#22c55e', fontSize: '0.72rem' }}>✓ Clean</span>}
                        </td>
                        <td style={{ padding: '8px 0', textAlign: 'right', color: '#52525b', fontSize: '0.65rem' }}>
                          {totalImpacted > 0 && (isExpanded ? '▲' : '▼')}
                        </td>
                      </tr>
                      {isExpanded && totalImpacted > 0 && (
                        <tr key={`${t.slug}-detail`} style={{ borderBottom: '1px solid #18181b' }}>
                          <td colSpan={5} style={{ padding: '0 0 8px 0', background: '#0a0a0c' }}>
                            <div style={{ overflowX: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
                                <thead>
                                  <tr style={{ background: '#0f0f11' }}>
                                    {['Device', 'OS', 'Version', 'Patch', 'Impact', 'Last Seen', 'User', 'Risk'].map(h => (
                                      <th key={h} style={{ padding: '5px 10px', textAlign: 'left', color: '#52525b', fontWeight: 600, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #27272a', whiteSpace: 'nowrap' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {[...blocked, ...warnedOnly].slice(0, 200).map(d => {
                                    const isBlocked = blocked.some(b => b.id === d.id);
                                    const upn = d.logonUsers?.[0]?.userPrincipalName ?? d.registeredOwner?.userPrincipalName ?? '—';
                                    return (
                                      <tr key={d.id} style={{ borderBottom: '1px solid #18181b' }}>
                                        <td style={{ padding: '5px 10px', color: '#d4d4d8', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.computerDnsName}>{d.computerDnsName || d.id}</td>
                                        <td style={{ padding: '5px 10px', color: '#71717a', whiteSpace: 'nowrap' }}>{d.osPlatform}</td>
                                        <td style={{ padding: '5px 10px', color: '#fbbf24', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{d.osVersion || '—'}</td>
                                        <td style={{ padding: '5px 10px', color: '#fbbf24', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{d.patchVersion || '—'}</td>
                                        <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>
                                          <span style={{ fontSize: '0.65rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: isBlocked ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.1)', color: isBlocked ? '#f87171' : '#fbbf24', border: `1px solid ${isBlocked ? 'rgba(239,68,68,0.25)' : 'rgba(251,191,36,0.25)'}` }}>
                                            {isBlocked ? 'Blocked' : 'Warning'}
                                          </span>
                                        </td>
                                        <td style={{ padding: '5px 10px', color: '#52525b', whiteSpace: 'nowrap' }}>{d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : '—'}</td>
                                        <td style={{ padding: '5px 10px', color: '#a1a1aa', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={upn}>{upn}</td>
                                        <td style={{ padding: '5px 10px' }}><RiskBadge risk={d.riskScore} /></td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              {blocked.length + warnedOnly.length > 200 && (
                                <div style={{ padding: '6px 10px', color: '#52525b', fontSize: '0.7rem' }}>Showing 200 of {blocked.length + warnedOnly.length} impacted devices.</div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
