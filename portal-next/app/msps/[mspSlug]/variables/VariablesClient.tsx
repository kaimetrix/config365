'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';

interface VariableDefinition {
  description?: string;
  default?: string;
  groups?: Record<string, string>;
}

interface Props {
  mspSlug: string;
  tenants: Tenant[];
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

const S = {
  inp: { width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' },
  ta: { width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '8px 10px', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit', resize: 'vertical' as const, minHeight: 72, lineHeight: 1.45 },
  sel: { width: '100%', maxWidth: 360, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4e7', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' },
  lbl: { display: 'block' as const, fontSize: '0.6875rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 6 },
  card: { background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: 16, marginBottom: 16 },
  btn: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', fontSize: '0.8125rem', fontWeight: 500, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  btnPrimary: { background: '#166534', border: '1px solid #22c55e', borderRadius: 6, color: '#fff', fontSize: '0.8125rem', fontWeight: 600, padding: '7px 16px', cursor: 'pointer', fontFamily: 'inherit' },
  btnDanger: { background: 'transparent', border: 'none', color: '#52525b', cursor: 'pointer', fontSize: '1.1rem', padding: '0 4px', lineHeight: 1 },
};

function tokenFor(name: string) {
  return `{{VAR:${name}}}`;
}

export default function VariablesClient({ mspSlug, tenants }: Props) {
  const [variables, setVariables] = useState<Record<string, VariableDefinition>>({});
  const [groupsConfig, setGroupsConfig] = useState<Record<string, { membership?: { direct?: string[] } }>>({});
  const groupNames = useMemo(() => Object.keys(groupsConfig).sort(), [groupsConfig]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [selectedTenant, setSelectedTenant] = useState('');
  const [tenantOverrides, setTenantOverrides] = useState<Record<string, string>>({});
  const [tenantMemberGroups, setTenantMemberGroups] = useState<string[]>([]);
  const [tenantSha, setTenantSha] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baselineDirty, setBaselineDirty] = useState(false);
  const [tenantDirty, setTenantDirty] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [newName, setNewName] = useState('');

  const variableNames = useMemo(() => Object.keys(variables).sort(), [variables]);
  const isDirty = baselineDirty || tenantDirty;

  function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  const loadBaseline = useCallback(async () => {
    const [varsRes, groupsRes] = await Promise.all([
      fetch(`/api/git/variables-config?mspSlug=${encodeURIComponent(mspSlug)}`),
      fetch(`/api/git/groups-config?mspSlug=${encodeURIComponent(mspSlug)}`),
    ]);
    const varsData = await varsRes.json();
    const groupsData = await groupsRes.json();
    const groups = (groupsData.groups ?? {}) as Record<string, { membership?: { direct?: string[] } }>;
    setVariables(varsData.variables ?? {});
    setGroupsConfig(groups);
    const names = Object.keys(groups).sort();
    setSelectedGroup(prev => (prev && names.includes(prev) ? prev : names[0] ?? ''));
    return groups;
  }, [mspSlug]);

  const loadTenantOverrides = useCallback(async (slug: string, groups: Record<string, { membership?: { direct?: string[] } }>) => {
    if (!slug) {
      setTenantOverrides({});
      setTenantMemberGroups([]);
      setTenantSha(undefined);
      setTenantDirty(false);
      return;
    }
    const [varsRes, groupsRes] = await Promise.all([
      fetch(`/api/git/file?path=${encodeURIComponent('config/variables.json')}&slug=${encodeURIComponent(slug)}`),
      fetch(`/api/git/file?path=${encodeURIComponent('config/tenant-groups.json')}&slug=${encodeURIComponent(slug)}`),
    ]);
    const data = await varsRes.json();
    const groupsData = await groupsRes.json();
    if (data.exists) {
      const parsed = JSON.parse(data.content ?? '{}') as { variables?: Record<string, string> };
      setTenantOverrides(parsed.variables ?? {});
      setTenantSha(data.sha);
    } else {
      setTenantOverrides({});
      setTenantSha(undefined);
    }
    const cached = groupsData.exists
      ? (JSON.parse(groupsData.content ?? '{}') as { groups?: string[] }).groups ?? []
      : [];
    const direct = Object.entries(groups)
      .filter(([, def]) => (def.membership?.direct ?? []).some(d => d.toLowerCase() === slug.toLowerCase()))
      .map(([name]) => name);
    setTenantMemberGroups([...new Set([...cached, ...direct])]);
    setTenantDirty(false);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const groups = await loadBaseline();
        setBaselineDirty(false);
        if (selectedTenant) await loadTenantOverrides(selectedTenant, groups);
      } catch (e: unknown) {
        showToast(e instanceof Error ? e.message : 'Failed to load', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadBaseline]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedTenant || loading) return;
    void loadTenantOverrides(selectedTenant, groupsConfig);
  }, [selectedTenant, groupsConfig, loadTenantOverrides, loading]);

  function updateDefault(name: string, value: string) {
    setVariables(prev => ({ ...prev, [name]: { ...prev[name], default: value } }));
    setBaselineDirty(true);
  }

  function updateGroupValue(name: string, groupName: string, value: string) {
    setVariables(prev => {
      const current = prev[name] ?? {};
      const groups = { ...(current.groups ?? {}) };
      if (value.trim()) groups[groupName] = value;
      else delete groups[groupName];
      return { ...prev, [name]: { ...current, groups } };
    });
    setBaselineDirty(true);
  }

  function updateTenantOverride(name: string, value: string) {
    setTenantOverrides(prev => {
      const next = { ...prev };
      if (value.trim()) next[name] = value;
      else delete next[name];
      return next;
    });
    setTenantDirty(true);
  }

  function addVariable() {
    const trimmed = newName.trim();
    if (!trimmed) { showToast('Enter a variable name', 'error'); return; }
    if (!NAME_PATTERN.test(trimmed)) {
      showToast('Name may only contain letters, numbers, underscore, dot, or hyphen', 'error');
      return;
    }
    if (variables[trimmed]) { showToast('Variable already exists', 'error'); return; }
    setVariables(prev => ({ ...prev, [trimmed]: { default: '', groups: {} } }));
    setNewName('');
    setBaselineDirty(true);
  }

  function removeVariable(name: string) {
    if (!confirm(`Remove variable "${name}"?`)) return;
    setVariables(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setTenantOverrides(prev => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setBaselineDirty(true);
    if (Object.keys(tenantOverrides).includes(name)) setTenantDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      if (baselineDirty) {
        const res = await fetch('/api/git/variables-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mspSlug, variables }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to save variables');
        setBaselineDirty(false);
      }
      if (tenantDirty && selectedTenant) {
        const content = JSON.stringify({ variables: tenantOverrides }, null, 2);
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'config/variables.json',
            content,
            message: 'portal: update tenant variables',
            sha: tenantSha,
            slug: selectedTenant,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Failed to save tenant assignments');
        setTenantDirty(false);
        await loadTenantOverrides(selectedTenant, groupsConfig);
      }
      showToast('Saved', 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  function copyToken(name: string) {
    void navigator.clipboard.writeText(tokenFor(name));
    showToast(`Copied ${tokenFor(name)}`, 'info');
  }

  function inheritedForTenant(name: string): string {
    const def = variables[name];
    if (!def) return '';
    let value = def.default ?? '';
    for (const g of groupNames) {
      if (!tenantMemberGroups.includes(g)) continue;
      const gv = def.groups?.[g]?.trim();
      if (gv) value = gv;
    }
    return value;
  }

  if (loading) {
    return <div style={{ color: '#71717a', fontSize: '0.8125rem' }}>Loading…</div>;
  }

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 100,
          background: toast.type === 'error' ? '#450a0a' : toast.type === 'success' ? '#052e16' : '#18181b',
          border: `1px solid ${toast.type === 'error' ? '#7f1d1d' : toast.type === 'success' ? '#166534' : '#3f3f46'}`,
          color: '#e4e4e7', padding: '10px 14px', borderRadius: 8, fontSize: '0.8125rem',
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        {isDirty && (
          <button type="button" style={{ ...S.btnPrimary, opacity: saving ? 0.7 : 1 }} disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      {/* ── 1. Variables ── */}
      <section style={S.card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '0.9375rem', fontWeight: 600, color: '#e4e4e7' }}>Variables</h2>
        <p style={{ margin: '0 0 16px', fontSize: '0.75rem', color: '#71717a' }}>
          Create named variables and their default values. Reference them in policy files as <code style={{ color: '#a1a1aa' }}>{'{{VAR:Name}}'}</code>.
        </p>

        {variableNames.length === 0 ? (
          <p style={{ color: '#52525b', fontSize: '0.8125rem', marginBottom: 12 }}>No variables yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }}>
            {variableNames.map(name => (
              <div key={name} style={{ border: '1px solid #27272a', borderRadius: 8, padding: 12, background: '#0c0c0e' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, color: '#e4e4e7', fontSize: '0.875rem' }}>{name}</span>
                  <button type="button" style={{ ...S.btn, padding: '2px 8px', fontSize: '0.7rem', fontFamily: 'monospace' }} onClick={() => copyToken(name)}>
                    {tokenFor(name)}
                  </button>
                  <button type="button" style={{ ...S.btnDanger, marginLeft: 'auto' }} title="Remove" onClick={() => removeVariable(name)}>×</button>
                </div>
                <label style={S.lbl}>Default value</label>
                <textarea
                  style={S.ta}
                  rows={4}
                  placeholder="Default value for all tenants (unless overridden)"
                  value={variables[name]?.default ?? ''}
                  onChange={e => updateDefault(name, e.target.value)}
                />
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ ...S.inp, maxWidth: 280 }}
            placeholder="New variable name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addVariable(); }}
          />
          <button type="button" style={S.btn} onClick={addVariable}>+ Add variable</button>
        </div>
      </section>

      {/* ── 2. Baseline groups ── */}
      <section style={S.card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '0.9375rem', fontWeight: 600, color: '#e4e4e7' }}>Baseline groups</h2>
        <p style={{ margin: '0 0 16px', fontSize: '0.75rem', color: '#71717a' }}>
          Override variable values for tenants that belong to a baseline group. Leave blank to use the default.
        </p>

        {groupNames.length === 0 ? (
          <p style={{ color: '#52525b', fontSize: '0.8125rem' }}>No baseline groups defined.</p>
        ) : variableNames.length === 0 ? (
          <p style={{ color: '#52525b', fontSize: '0.8125rem' }}>Create a variable first.</p>
        ) : (
          <>
            <label style={S.lbl}>Group</label>
            <select style={{ ...S.sel, marginBottom: 16 }} value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)}>
              {groupNames.map(g => <option key={g} value={g}>{g}</option>)}
            </select>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {variableNames.map(name => {
                const def = variables[name];
                const defaultVal = def?.default ?? '';
                return (
                  <div key={name}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e4e4e7', marginBottom: 6 }}>{name}</div>
                    {defaultVal && (
                      <div style={{ fontSize: '0.7rem', color: '#52525b', marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                        Default: {defaultVal.length > 80 ? `${defaultVal.slice(0, 80)}…` : defaultVal}
                      </div>
                    )}
                    <textarea
                      style={S.ta}
                      rows={3}
                      placeholder="Leave empty to use default"
                      value={def?.groups?.[selectedGroup] ?? ''}
                      onChange={e => updateGroupValue(name, selectedGroup, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* ── 3. Tenants ── */}
      <section style={S.card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '0.9375rem', fontWeight: 600, color: '#e4e4e7' }}>Tenants</h2>
        <p style={{ margin: '0 0 16px', fontSize: '0.75rem', color: '#71717a' }}>
          Override variable values for a specific tenant. Leave blank to inherit from baseline group or default.
        </p>

        {tenants.length === 0 ? (
          <p style={{ color: '#52525b', fontSize: '0.8125rem' }}>No tenants configured.</p>
        ) : variableNames.length === 0 ? (
          <p style={{ color: '#52525b', fontSize: '0.8125rem' }}>Create a variable first.</p>
        ) : (
          <>
            <label style={S.lbl}>Tenant</label>
            <select
              style={{ ...S.sel, marginBottom: 16 }}
              value={selectedTenant}
              onChange={e => {
                if (tenantDirty && !confirm('Unsaved tenant changes will be lost. Continue?')) return;
                setSelectedTenant(e.target.value);
              }}
            >
              <option value="">Select tenant…</option>
              {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
            </select>

            {selectedTenant && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {variableNames.map(name => {
                  const inherited = inheritedForTenant(name);
                  return (
                    <div key={name}>
                      <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e4e4e7', marginBottom: 6 }}>{name}</div>
                      {inherited && (
                        <div style={{ fontSize: '0.7rem', color: '#52525b', marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                          Inherited: {inherited.length > 80 ? `${inherited.slice(0, 80)}…` : inherited}
                        </div>
                      )}
                      <textarea
                        style={S.ta}
                        rows={3}
                        placeholder="Leave empty to inherit"
                        value={tenantOverrides[name] ?? ''}
                        onChange={e => updateTenantOverride(name, e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
