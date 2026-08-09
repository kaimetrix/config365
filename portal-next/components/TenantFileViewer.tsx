'use client';
import { useState, useEffect } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';

interface Props {
  mspSlug: string;
  tenants: Tenant[];
  basePath: string;
  scope: 'baseline' | 'tenant';
  selectedTenantSlug?: string;
}

export default function TenantFileViewer({ mspSlug, tenants, basePath, scope, selectedTenantSlug }: Props) {
  const [files, setFiles]     = useState<Array<{ name: string; path: string; sha: string }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [sha, setSha]         = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [tenant, setTenant]   = useState(selectedTenantSlug ?? tenants[0]?.slug ?? '');

  useEffect(() => { loadTree(); }, [tenant]);

  async function loadTree() {
    setLoading(true); setError(''); setFiles([]); setSelected(null); setContent('');
    try {
      const qs = scope === 'baseline' ? `scope=baseline&mspSlug=${mspSlug}` : `slug=${tenant}`;
      const res  = await fetch(`/api/git/tree?path=${encodeURIComponent(basePath)}&${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');
      setFiles((data as Array<{ name: string; path: string; type: string; sha: string }>).filter(f => f.type === 'file'));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }

  async function loadFile(path: string) {
    setSelected(path); setLoading(true); setError(''); setContent(''); setSha(undefined); setSuccess('');
    try {
      const qs = scope === 'baseline' ? `scope=baseline&mspSlug=${mspSlug}` : `slug=${tenant}`;
      const res  = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setContent(data.exists ? data.content : '');
      setSha(data.exists ? data.sha : undefined);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }

  async function saveFile() {
    if (!selected) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const qs = scope === 'baseline'
        ? { scope: 'baseline', mspSlug }
        : { scope: 'tenant', slug: tenant };
      const res = await fetch('/api/git/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected, content, message: `portal: update ${selected}`, sha, ...qs }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSuccess('Saved.');
      // refresh SHA
      const r2 = await fetch(`/api/git/file?path=${encodeURIComponent(selected)}&${scope === 'baseline' ? `scope=baseline&mspSlug=${mspSlug}` : `slug=${tenant}`}`);
      const d2 = await r2.json();
      if (d2.exists) setSha(d2.sha);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', height: '100%', background: '#09090b', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>

      {/* File list */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #27272a', background: '#0f0f11' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em', flex: 1 }}>
            Files {files.length > 0 && <span style={{ background: '#27272a', color: '#71717a', padding: '1px 6px', borderRadius: 10, fontSize: '0.65rem', marginLeft: 4 }}>{files.length}</span>}
          </span>
          <button onClick={loadTree} disabled={loading} style={{ fontSize: '0.72rem', color: '#52525b', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>
            {loading ? '…' : '↻'}
          </button>
        </div>

        {scope === 'tenant' && (
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #27272a' }}>
            <select value={tenant} onChange={e => { setTenant(e.target.value); }} style={{ width: '100%', background: '#18181b', border: '1px solid #27272a', color: '#d4d4d8', borderRadius: 5, padding: '5px 8px', fontSize: '0.8125rem', fontFamily: 'inherit', outline: 'none' }}>
              {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
            </select>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && files.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 12px', color: '#71717a', fontSize: '0.8rem' }}>
              <div style={{ width: 12, height: 12, border: '1.5px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
              Loading…
            </div>
          )}
          {!loading && files.length === 0 && !error && (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: '#52525b', fontSize: '0.8125rem' }}>No files found</div>
          )}
          {files.map(f => {
            const act = selected === f.path;
            return (
              <div key={f.path} onClick={() => loadFile(f.path)} style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '7px 12px', cursor: 'pointer', fontSize: '0.8125rem',
                background: act ? 'rgba(34,197,94,0.08)' : 'transparent',
                color: act ? '#22c55e' : '#a1a1aa',
                borderLeft: act ? '2px solid #22c55e' : '2px solid transparent',
              }}
              onMouseEnter={e => { if (!act) { (e.currentTarget as HTMLElement).style.background = '#18181b'; (e.currentTarget as HTMLElement).style.color = '#e4e4e7'; } }}
              onMouseLeave={e => { if (!act) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#a1a1aa'; } }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', flexShrink: 0, opacity: act ? 1 : 0.3 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.78rem' }}>{f.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Content panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #27272a', flexShrink: 0, minHeight: 44 }}>
          {selected ? (
            <code style={{ fontSize: '0.78rem', color: '#a1a1aa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected}</code>
          ) : (
            <span style={{ color: '#52525b', fontSize: '0.8rem', flex: 1 }}>Select a file to view and edit</span>
          )}
          {selected && !loading && (
            <button onClick={saveFile} disabled={saving} style={{ padding: '5px 16px', fontSize: '0.78rem', fontWeight: 600, background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : '💾 Save'}
            </button>
          )}
        </div>

        {(error || success) && (
          <div style={{ padding: '6px 16px', flexShrink: 0 }}>
            {error   && <div style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{error}</div>}
            {success && <div style={{ color: '#86efac', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{success}</div>}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto' }}>
          {!selected && !loading && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="6" y="4" width="22" height="28" rx="2"/>
                <line x1="12" y1="15" x2="24" y2="15"/><line x1="12" y1="19" x2="24" y2="19"/><line x1="12" y1="23" x2="20" y2="23"/>
              </svg>
              <p style={{ fontSize: '0.875rem' }}>Select a file to view and edit</p>
            </div>
          )}
          {loading && selected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: '#71717a' }}>
              <div style={{ width: 14, height: 14, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Loading…
            </div>
          )}
          {selected && !loading && (
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              style={{
                width: '100%', height: '100%', background: 'transparent', border: 'none',
                color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace",
                fontSize: '0.78rem', lineHeight: '1.6', padding: '12px 16px',
                resize: 'none', outline: 'none', boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
