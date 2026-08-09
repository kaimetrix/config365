'use client';
import { useState, useEffect, useCallback } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';

const STATE_SYNC_OPTIONS = [
  { value: 'preserve',    label: 'Preserve',          desc: 'Leave the enabled/disabled state exactly as it is in the tenant. Automation never touches CA policy states.' },
  { value: 'baseline',    label: 'Baseline (Strict)',  desc: 'Always sync the enabled/disabled state from the baseline. Full lifecycle control via the baseline.' },
  { value: 'enableOnly',  label: 'Enable Only (Cautious)', desc: 'Only enable policies — automation will never disable a CA policy.' },
];

interface CaPolicy {
  name: string;
  path: string;
  sha: string;
  configPath: string;
  deployBehavior: string;
  configSha?: string;
  isDirty: boolean;
}

interface NamedLocation {
  name: string;
  path: string;
  sha: string;
  configPath: string;
  deployBehavior: string;
  configSha?: string;
}

interface TenantOption {
  slug: string;
  displayName: string;
  stateSync: string;
  sha?: string;
  loaded: boolean;
  expanded: boolean;
  isDirty: boolean;
}

interface Props {
  mspSlug: string;
  tenants: Tenant[];
}

export default function CaOptionsClient({ mspSlug, tenants }: Props) {
  const [policies, setPolicies]     = useState<CaPolicy[]>([]);
  const [tenantRows, setTenantRows] = useState<TenantOption[]>(
    tenants.map(t => ({ slug: t.slug, displayName: t.displayName, stateSync: 'preserve', loaded: false, expanded: false, isDirty: false }))
  );
  const [loading, setLoading]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [toast, setToast]           = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [policyPending, setPolicyPending] = useState<Map<string, string>>(new Map());
  const [tenantPending, setTenantPending] = useState<Map<string, string>>(new Map());
  const [showPolicies, setShowPolicies]   = useState(false);

  // Named locations
  const [namedLocations, setNamedLocations]           = useState<NamedLocation[]>([]);
  const [locPending, setLocPending]                   = useState<Map<string, string>>(new Map());
  const [locLoading, setLocLoading]                   = useState(false);

  // Optional applications
  const [optApps, setOptApps]             = useState<{ appId: string; name: string }[]>([]);
  const [optAppsSha, setOptAppsSha]       = useState<string | undefined>();
  const [optAppsLoading, setOptAppsLoading] = useState(false);
  const [optAppsPending, setOptAppsPending] = useState<{ appId: string; name: string }[] | null>(null);
  const [newAppId, setNewAppId]           = useState('');
  const [newAppName, setNewAppName]       = useState('');

  function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  const loadPolicies = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`/api/git/tree?path=baseline/conditional-access/policies&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');
      const entries: Array<{ name: string; path: string; sha: string; type: string }> = Array.isArray(data) ? data : [];
      const jsonFiles = entries.filter(f => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('.config.json'));

      const loaded: CaPolicy[] = await Promise.all(jsonFiles.map(async f => {
        const configPath = f.path.replace(/\.json$/, '.config.json');
        let deployBehavior = 'alwaysDeploy';
        let configSha: string | undefined;
        try {
          const cfgRes  = await fetch(`/api/git/file?path=${encodeURIComponent(configPath)}&scope=baseline&mspSlug=${mspSlug}`);
          const cfgData = await cfgRes.json();
          if (cfgData.exists) {
            const parsed = JSON.parse(cfgData.content ?? '{}');
            deployBehavior = parsed.deployBehavior ?? 'alwaysDeploy';
            configSha = cfgData.sha;
          }
        } catch { /* no config */ }
        return { name: f.name.replace(/\.json$/, ''), path: f.path, sha: f.sha, configPath, deployBehavior, configSha, isDirty: false };
      }));
      setPolicies(loaded);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }, [mspSlug]);

  useEffect(() => { loadPolicies(); }, [loadPolicies]);

  const loadNamedLocations = useCallback(async () => {
    setLocLoading(true);
    try {
      const res  = await fetch(`/api/git/tree?path=baseline/conditional-access/named-locations&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      if (!res.ok) return;
      const entries: Array<{ name: string; path: string; sha: string; type: string }> = Array.isArray(data) ? data : [];
      const jsonFiles = entries.filter(f => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('.config.json') && f.name !== '.gitkeep');
      const loaded: NamedLocation[] = await Promise.all(jsonFiles.map(async f => {
        const configPath = f.path.replace(/\.json$/, '.config.json');
        let deployBehavior = 'alwaysDeploy';
        let configSha: string | undefined;
        try {
          const cfgRes  = await fetch(`/api/git/file?path=${encodeURIComponent(configPath)}&scope=baseline&mspSlug=${mspSlug}`);
          const cfgData = await cfgRes.json();
          if (cfgData.exists) {
            const parsed = JSON.parse(cfgData.content ?? '{}');
            deployBehavior = parsed.deployBehavior ?? 'alwaysDeploy';
            configSha = cfgData.sha;
          }
        } catch { /* no sidecar */ }
        return { name: f.name.replace(/\.json$/, ''), path: f.path, sha: f.sha, configPath, deployBehavior, configSha };
      }));
      setNamedLocations(loaded);
    } catch { /* silent */ }
    finally { setLocLoading(false); }
  }, [mspSlug]);

  useEffect(() => { loadNamedLocations(); }, [loadNamedLocations]);

  const loadOptionalApps = useCallback(async () => {
    setOptAppsLoading(true);
    try {
      const res  = await fetch(`/api/git/file?path=baseline/conditional-access/optional-applications.json&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      if (data.exists) {
        const parsed = JSON.parse(data.content ?? '{}');
        const apps = Object.entries(parsed.applications ?? {}).map(([appId, name]) => ({ appId, name: name as string }));
        setOptApps(apps);
        setOptAppsSha(data.sha);
      }
    } catch { /* silent */ }
    finally { setOptAppsLoading(false); }
  }, [mspSlug]);

  useEffect(() => { loadOptionalApps(); }, [loadOptionalApps]);

  async function loadTenantOptions(slug: string) {
    try {
      const res  = await fetch(`/api/git/file?path=options/ca-options.json&slug=${slug}`);
      const data = await res.json();
      let stateSync = 'preserve';
      let sha: string | undefined;
      if (data.exists) {
        const parsed = JSON.parse(data.content ?? '{}');
        stateSync = parsed.stateSync ?? 'preserve';
        sha = data.sha;
      }
      setTenantRows(prev => prev.map(r => r.slug === slug ? { ...r, stateSync, sha, loaded: true } : r));
    } catch { /* silent */ }
  }

  async function toggleTenant(slug: string) {
    const row = tenantRows.find(r => r.slug === slug);
    if (!row) return;
    const nowExpanded = !row.expanded;
    setTenantRows(prev => prev.map(r => r.slug === slug ? { ...r, expanded: nowExpanded } : r));
    if (nowExpanded && !row.loaded) {
      await loadTenantOptions(slug);
    }
  }

  function onTenantSyncChange(slug: string, value: string) {
    const row = tenantRows.find(r => r.slug === slug);
    const newPending = new Map(tenantPending);
    if (value === row?.stateSync) {
      newPending.delete(slug);
    } else {
      newPending.set(slug, value);
    }
    setTenantPending(newPending);
    setTenantRows(prev => prev.map(r => r.slug === slug ? { ...r, isDirty: newPending.has(slug) } : r));
  }

  function onPolicyBehaviorChange(path: string, value: string) {
    const original = policies.find(p => p.path === path);
    const newPending = new Map(policyPending);
    if (value === original?.deployBehavior) {
      newPending.delete(path);
    } else {
      newPending.set(path, value);
    }
    setPolicyPending(newPending);
    setPolicies(prev => prev.map(p => p.path === path ? { ...p, isDirty: newPending.has(path) } : p));
  }

  function onLocBehaviorChange(path: string, value: string) {
    const original = namedLocations.find(l => l.path === path);
    const newPending = new Map(locPending);
    if (value === original?.deployBehavior) newPending.delete(path);
    else newPending.set(path, value);
    setLocPending(newPending);
  }

  function addOptApp() {
    const id = newAppId.trim(); const nm = newAppName.trim();
    if (!id) return;
    const base = optAppsPending ?? optApps;
    if (base.some(a => a.appId === id)) return;
    setOptAppsPending([...base, { appId: id, name: nm }]);
    setNewAppId(''); setNewAppName('');
  }

  function removeOptApp(appId: string) {
    const base = optAppsPending ?? optApps;
    setOptAppsPending(base.filter(a => a.appId !== appId));
  }

  async function saveChanges() {
    const hasChanges = policyPending.size > 0 || tenantPending.size > 0 || locPending.size > 0 || optAppsPending !== null;
    if (!hasChanges) return;
    setSaving(true);
    let succeeded = 0, failed = 0;

    // Save policy deploy behaviors
    for (const [path, deployBehavior] of policyPending.entries()) {
      const policy = policies.find(p => p.path === path);
      if (!policy) continue;
      try {
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: policy.configPath, content: JSON.stringify({ deployBehavior }, null, 2),
            message: `portal: set deployBehavior for CA policy ${policy.name}`,
            sha: policy.configSha, scope: 'baseline', mspSlug,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        succeeded++;
      } catch (e: unknown) {
        showToast(`Failed to update "${policy.name}": ${e instanceof Error ? e.message : 'Error'}`, 'error');
        failed++;
      }
    }

    // Save named location deploy behaviors
    for (const [path, deployBehavior] of locPending.entries()) {
      const loc = namedLocations.find(l => l.path === path);
      if (!loc) continue;
      try {
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: loc.configPath, content: JSON.stringify({ deployBehavior }, null, 2),
            message: `portal: set deployBehavior for named location ${loc.name}`,
            sha: loc.configSha, scope: 'baseline', mspSlug,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        succeeded++;
      } catch (e: unknown) {
        showToast(`Failed to update "${loc.name}": ${e instanceof Error ? e.message : 'Error'}`, 'error');
        failed++;
      }
    }

    // Save optional applications
    if (optAppsPending !== null) {
      try {
        const applications = Object.fromEntries(optAppsPending.map(a => [a.appId, a.name]));
        const content = JSON.stringify({
          description: 'Optional application IDs that will be validated before deployment. If the service principal doesn\'t exist in the tenant, the app will be filtered out of CA policies.',
          applications,
        }, null, 2);
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'baseline/conditional-access/optional-applications.json',
            content, message: 'portal: update optional applications', sha: optAppsSha, scope: 'baseline', mspSlug,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        succeeded++;
      } catch (e: unknown) {
        showToast(`Failed to save optional apps: ${e instanceof Error ? e.message : 'Error'}`, 'error');
        failed++;
      }
    }

    // Save tenant stateSync options
    for (const [slug, stateSync] of tenantPending.entries()) {
      const row = tenantRows.find(r => r.slug === slug);
      try {
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'options/ca-options.json', content: JSON.stringify({ stateSync }, null, 2),
            message: `portal: update CA options for ${slug}`,
            sha: row?.sha, slug,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        succeeded++;
      } catch (e: unknown) {
        const name = tenantRows.find(r => r.slug === slug)?.displayName ?? slug;
        showToast(`Failed to update "${name}": ${e instanceof Error ? e.message : 'Error'}`, 'error');
        failed++;
      }
    }

    setSaving(false);
    void failed;
    if (succeeded > 0) {
      showToast(`${succeeded} change${succeeded !== 1 ? 's' : ''} saved.`, 'success');
      setPolicyPending(new Map());
      setLocPending(new Map());
      setTenantPending(new Map());
      setOptAppsPending(null);
      await Promise.all([loadPolicies(), loadNamedLocations(), loadOptionalApps()]);
      for (const row of tenantRows.filter(r => r.expanded)) {
        await loadTenantOptions(row.slug);
      }
      setTenantRows(prev => prev.map(r => ({ ...r, isDirty: false })));
    }
  }

  const hasPending = policyPending.size > 0 || tenantPending.size > 0 || locPending.size > 0 || optAppsPending !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#f4f4f5' }}>CA Options</div>
          <div style={{ fontSize: '0.8125rem', color: '#71717a', marginTop: 2 }}>Configure Conditional Access policy state sync behavior per tenant.</div>
        </div>
        <button
          onClick={saveChanges}
          disabled={!hasPending || saving}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 16px', fontSize: '0.8125rem', fontWeight: 600, background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, cursor: (!hasPending || saving) ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: !hasPending ? 0.4 : 1, transition: 'background 0.12s', flexShrink: 0 }}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {error && <div style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: '0.8125rem' }}>{error}</div>}

      {/* State Sync Legend */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8' }}>State Sync Options</div>
          <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)' }}>Reference</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderTop: '1px solid #27272a' }}>
          {STATE_SYNC_OPTIONS.map(opt => (
            <div key={opt.value} style={{ padding: '10px 14px', borderRight: '1px solid #1a1a1d', fontSize: '0.75rem', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, color: '#a1a1aa', marginBottom: 3 }}>{opt.label}</div>
              <div style={{ color: '#52525b' }}>{opt.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-tenant state sync */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 200px 90px 36px', gap: 10, padding: '10px 16px', borderBottom: '1px solid #27272a', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          <span></span>
          <span>Tenant</span>
          <span>State Sync</span>
          <span>Status</span>
          <span></span>
        </div>

        {tenantRows.map(row => {
          const currentSync = tenantPending.get(row.slug) ?? row.stateSync;
          const isDirty = tenantPending.has(row.slug);
          return (
            <div key={row.slug} style={{ borderBottom: '1px solid #1a1a1d' }}>
              <div
                onClick={() => toggleTenant(row.slug)}
                style={{ display: 'grid', gridTemplateColumns: '28px 1fr 200px 90px 36px', gap: 10, alignItems: 'center', padding: '10px 16px', cursor: 'pointer', background: isDirty ? 'rgba(234,179,8,0.04)' : 'transparent', transition: 'background 0.1s' }}
                onMouseEnter={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
                onMouseLeave={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = isDirty ? 'rgba(234,179,8,0.04)' : 'transparent'; }}
              >
                <span style={{ color: '#3f3f46', fontSize: '0.7rem', textAlign: 'center', transition: 'transform 0.15s', display: 'inline-block', transform: row.expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
                <span style={{ fontSize: '0.8125rem', color: '#d4d4d8', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.displayName}</span>
                <div onClick={e => e.stopPropagation()}>
                  <select
                    value={currentSync}
                    onChange={e => onTenantSyncChange(row.slug, e.target.value)}
                    disabled={!row.loaded}
                    style={{ width: '100%', background: '#18181b', border: `1px solid ${isDirty ? '#eab308' : '#3f3f46'}`, borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '5px 8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', cursor: row.loaded ? 'pointer' : 'not-allowed', opacity: row.loaded ? 1 : 0.4 }}
                  >
                    {STATE_SYNC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <span>
                  {row.loaded ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: isDirty ? 'rgba(234,179,8,0.1)' : 'rgba(113,113,122,0.1)', color: isDirty ? '#eab308' : '#71717a', border: `1px solid ${isDirty ? 'rgba(234,179,8,0.2)' : 'rgba(113,113,122,0.2)'}` }}>
                      {isDirty ? 'Changed' : 'Saved'}
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: 'transparent', color: '#3f3f46', border: '1px solid #27272a' }}>—</span>
                  )}
                </span>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#eab308', visibility: isDirty ? 'visible' : 'hidden' }} />
                </div>
              </div>
              {/* Expanded row: per-tenant info */}
              {row.expanded && (
                <div style={{ background: '#0d0d10', borderTop: '1px solid #1a1a1d', padding: '10px 16px 10px 56px' }}>
                  {!row.loaded ? (
                    <div style={{ color: '#52525b', fontSize: '0.8rem' }}>Loading tenant options…</div>
                  ) : (
                    <div style={{ fontSize: '0.8125rem', color: '#71717a' }}>
                      CA state sync: <strong style={{ color: '#a1a1aa' }}>{STATE_SYNC_OPTIONS.find(o => o.value === currentSync)?.label ?? currentSync}</strong>
                      <br />
                      <span style={{ fontSize: '0.75rem', color: '#52525b' }}>{STATE_SYNC_OPTIONS.find(o => o.value === currentSync)?.desc}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* CA Policies with deploy behavior */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setShowPolicies(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'transparent', border: 'none', borderBottom: showPolicies ? '1px solid #27272a' : 'none', width: '100%', cursor: 'pointer', fontSize: '0.75rem', color: '#71717a', fontFamily: 'inherit', textAlign: 'left' }}
        >
          <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: showPolicies ? 'rotate(90deg)' : 'none', color: '#3f3f46' }}>▶</span>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8' }}>CA Policy Deploy Behaviors</span>
          {policies.length > 0 && (
            <span style={{ fontSize: '0.6875rem', padding: '1px 6px', borderRadius: 10, background: 'rgba(59,130,246,0.15)', color: '#60a5fa', fontWeight: 600 }}>{policies.length}</span>
          )}
          {loading && <span style={{ color: '#52525b', fontSize: '0.72rem' }}>Loading…</span>}
        </button>

        {showPolicies && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, padding: '6px 16px', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.07em', background: '#0d0d10', borderBottom: '1px solid #1a1a1d' }}>
              <span>Policy</span>
              <span>Deploy Behavior</span>
            </div>
            {policies.length === 0 && !loading && (
              <div style={{ padding: 16, textAlign: 'center', color: '#3f3f46', fontSize: '0.75rem' }}>No CA policies found in baseline.</div>
            )}
            {policies.map(policy => {
              const currentBehavior = policyPending.get(policy.path) ?? policy.deployBehavior;
              const isDirty = policyPending.has(policy.path);
              return (
                <div key={policy.path} style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'center', padding: '7px 16px', borderBottom: '1px solid #1a1a1d', background: isDirty ? 'rgba(234,179,8,0.04)' : 'transparent' }}
                  onMouseEnter={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
                  onMouseLeave={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = isDirty ? 'rgba(234,179,8,0.04)' : 'transparent'; }}
                >
                  <div style={{ fontSize: '0.8125rem', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={policy.name}>{policy.name}</div>
                  <select
                    value={currentBehavior}
                    onChange={e => onPolicyBehaviorChange(policy.path, e.target.value)}
                    style={{ width: '100%', background: '#18181b', border: `1px solid ${isDirty ? '#eab308' : '#3f3f46'}`, borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '4px 8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', cursor: 'pointer' }}
                  >
                    <option value="alwaysDeploy">Always deploy &amp; update</option>
                    <option value="deployIfNotExists">Deploy once, never update</option>
                  </select>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Named Location Deploy Behavior */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #27272a' }}>
          <div>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8' }}>Named Location Deploy Behavior</div>
            <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>Configure whether each named location is deployed once or always updated.</div>
          </div>
          <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)', flexShrink: 0 }}>Baseline repo</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, padding: '6px 16px', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.07em', background: '#0d0d10', borderBottom: '1px solid #1a1a1d' }}>
          <span>Named Location</span>
          <span>Deploy Behavior</span>
        </div>
        {locLoading && <div style={{ padding: '12px 16px', color: '#52525b', fontSize: '0.75rem' }}>Loading named locations…</div>}
        {!locLoading && namedLocations.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: '#3f3f46', fontSize: '0.75rem' }}>No named locations found in baseline.</div>
        )}
        {namedLocations.map(loc => {
          const current = locPending.get(loc.path) ?? loc.deployBehavior;
          const isDirty = locPending.has(loc.path);
          return (
            <div key={loc.path} style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'center', padding: '7px 16px', borderBottom: '1px solid #1a1a1d', background: isDirty ? 'rgba(234,179,8,0.04)' : 'transparent' }}
              onMouseEnter={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
              onMouseLeave={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = isDirty ? 'rgba(234,179,8,0.04)' : 'transparent'; }}
            >
              <div style={{ fontSize: '0.8125rem', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={loc.name}>{loc.name}</div>
              <select
                value={current}
                onChange={e => onLocBehaviorChange(loc.path, e.target.value)}
                style={{ width: '100%', background: '#18181b', border: `1px solid ${isDirty ? '#eab308' : '#3f3f46'}`, borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '4px 8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                <option value="alwaysDeploy">Always deploy &amp; update</option>
                <option value="deployIfNotExists">Deploy once, never update</option>
              </select>
            </div>
          );
        })}
      </div>

      {/* Optional Applications */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid #27272a' }}>
          <div>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8' }}>Optional Applications</div>
            <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>Apps that may not exist in every tenant — absent apps are silently removed from policy conditions at deploy time.</div>
          </div>
          <span style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)', flexShrink: 0 }}>Baseline repo</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 36px', gap: 12, padding: '6px 16px', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.07em', background: '#0d0d10', borderBottom: '1px solid #1a1a1d' }}>
          <span>App ID</span>
          <span>Friendly Name</span>
          <span></span>
        </div>
        {optAppsLoading && <div style={{ padding: '12px 16px', color: '#52525b', fontSize: '0.75rem' }}>Loading…</div>}
        {(optAppsPending ?? optApps).map(app => (
          <div key={app.appId} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 36px', gap: 12, alignItems: 'center', padding: '7px 16px', borderBottom: '1px solid #1a1a1d' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#18181b'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
          >
            <span style={{ fontSize: '0.8125rem', color: '#71717a', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.appId}</span>
            <span style={{ fontSize: '0.8125rem', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
            <button
              onClick={() => removeOptApp(app.appId)}
              title="Remove"
              style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 4, color: '#71717a', cursor: 'pointer', fontSize: '0.8rem', padding: '2px 8px', fontFamily: 'inherit' }}
            >×</button>
          </div>
        ))}
        {(optAppsPending ?? optApps).length === 0 && !optAppsLoading && (
          <div style={{ padding: '10px 16px', color: '#3f3f46', fontSize: '0.75rem', fontStyle: 'italic' }}>No optional applications configured.</div>
        )}
        {/* Add row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8, padding: '8px 16px', borderTop: '1px solid #1a1a1d', background: '#0d0d10' }}>
          <input
            value={newAppId}
            onChange={e => setNewAppId(e.target.value)}
            placeholder="App ID (GUID)"
            style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '5px 8px', outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Enter') addOptApp(); }}
          />
          <input
            value={newAppName}
            onChange={e => setNewAppName(e.target.value)}
            placeholder="Friendly name"
            style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '5px 8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Enter') addOptApp(); }}
          />
          <button
            onClick={addOptApp}
            disabled={!newAppId.trim()}
            style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', fontSize: '0.8125rem', fontWeight: 600, padding: '5px 12px', cursor: newAppId.trim() ? 'pointer' : 'not-allowed', opacity: newAppId.trim() ? 1 : 0.5, fontFamily: 'inherit' }}
          >+ Add</button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, animation: 'slideIn 0.15s ease' }}>
          <div style={{ padding: '10px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, maxWidth: 360, background: toast.type === 'success' ? '#14532d' : toast.type === 'error' ? '#450a0a' : '#1c1c1f', color: toast.type === 'success' ? '#86efac' : toast.type === 'error' ? '#fca5a5' : '#a1a1aa', border: `1px solid ${toast.type === 'success' ? '#166534' : toast.type === 'error' ? '#7f1d1d' : '#3f3f46'}` }}>
            {toast.msg}
          </div>
        </div>
      )}
      <style>{`@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  );
}
