'use client';
import { useState, useEffect, useCallback } from 'react';

interface GroupEntry {
  name: string;
  path: string;
  sha: string;
  configPath: string;
  deployBehavior: string;
  configSha?: string;
  isDirty: boolean;
}

interface Props {
  mspSlug: string;
}

export default function GroupsClient({ mspSlug }: Props) {
  const [groups, setGroups]         = useState<GroupEntry[]>([]);
  const [loading, setLoading]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [toast, setToast]           = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [modalGroup, setModalGroup] = useState<GroupEntry | null>(null);
  const [modalContent, setModalContent] = useState('');
  const [modalLoading, setModalLoading] = useState(false);
  const [pendingChanges, setPending] = useState<Map<string, string>>(new Map());

  function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  const loadGroups = useCallback(async () => {
    setLoading(true); setError(''); setPending(new Map());
    try {
      const res  = await fetch(`/api/git/tree?path=baseline/groups&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load');

      const entries: typeof data = Array.isArray(data) ? data : [];
      const jsonFiles = entries.filter((f: { name: string; type: string }) => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('.config.json'));

      // Load deploy behavior for each group (from sidecar .config.json)
      const loaded: GroupEntry[] = await Promise.all(jsonFiles.map(async (f: { name: string; path: string; sha: string }) => {
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
        } catch { /* no config file */ }
        const displayName = f.name.replace(/\.json$/, '');
        return { name: displayName, path: f.path, sha: f.sha, configPath, deployBehavior, configSha, isDirty: false };
      }));

      setGroups(loaded);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }, [mspSlug]);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  function onBehaviorChange(path: string, value: string) {
    const original = groups.find(g => g.path === path);
    const newPending = new Map(pendingChanges);
    if (value === original?.deployBehavior) {
      newPending.delete(path);
    } else {
      newPending.set(path, value);
    }
    setPending(newPending);
    setGroups(prev => prev.map(g => g.path === path ? { ...g, isDirty: newPending.has(path) } : g));
  }

  async function saveChanges() {
    if (pendingChanges.size === 0) return;
    setSaving(true); setError('');
    const entries = Array.from(pendingChanges.entries());
    let succeeded = 0, failed = 0;
    for (const [path, deployBehavior] of entries) {
      const group = groups.find(g => g.path === path);
      if (!group) continue;
      try {
        const configContent = JSON.stringify({ deployBehavior }, null, 2);
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: group.configPath, content: configContent,
            message: `portal: set deployBehavior for ${group.name}`,
            sha: group.configSha, scope: 'baseline', mspSlug,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        succeeded++;
      } catch (e: unknown) {
        showToast(`Failed to update "${group.name}": ${e instanceof Error ? e.message : 'Error'}`, 'error');
        failed++;
      }
    }
    setSaving(false);
    if (succeeded > 0) {
      showToast(`${succeeded} group${succeeded !== 1 ? 's' : ''} updated successfully.`, 'success');
      await loadGroups();
    }
    void failed;
  }

  async function openModal(group: GroupEntry) {
    setModalGroup(group);
    setModalContent('');
    setModalLoading(true);
    try {
      const res  = await fetch(`/api/git/file?path=${encodeURIComponent(group.path)}&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      setModalContent(data.exists ? JSON.stringify(JSON.parse(data.content), null, 2) : '(empty)');
    } catch (e: unknown) {
      setModalContent(`Error: ${e instanceof Error ? e.message : 'Failed to load'}`);
    } finally { setModalLoading(false); }
  }

  const hasPending = pendingChanges.size > 0;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#f4f4f5' }}>Baseline Group Deploy Behavior</div>
          <div style={{ fontSize: '0.8125rem', color: '#71717a', marginTop: 2 }}>Configure how each Entra ID baseline group is handled during deployment.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={loadGroups}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: '0.78rem', fontWeight: 500, background: 'transparent', border: '1px solid #27272a', color: '#71717a', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
          >
            {loading ? '…' : '↻ Refresh'}
          </button>
          <button
            onClick={saveChanges}
            disabled={!hasPending || saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 16px', fontSize: '0.8125rem', fontWeight: 600, background: hasPending ? '#22c55e' : '#22c55e', color: '#000', border: 'none', borderRadius: 6, cursor: (!hasPending || saving) ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: !hasPending ? 0.4 : 1, transition: 'background 0.12s' }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: '0.8125rem', flexShrink: 0 }}>{error}</div>}

      {/* Groups panel */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Panel header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px 36px 60px', gap: 12, padding: '10px 16px', borderBottom: '1px solid #27272a', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>
          <span>Group</span>
          <span>Deploy Behavior</span>
          <span></span>
          <span style={{ textAlign: 'center' }}>Changed</span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.875rem' }}>Loading groups from baseline repo…</div>
          )}
          {!loading && groups.length === 0 && !error && (
            <div style={{ padding: '48px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.875rem' }}>
              No group files found in the baseline repository under <code>groups/</code>.
            </div>
          )}
          {groups.map(group => {
            const currentBehavior = pendingChanges.get(group.path) ?? group.deployBehavior;
            const isDirty = pendingChanges.has(group.path);
            return (
              <div
                key={group.path}
                style={{ display: 'grid', gridTemplateColumns: '1fr 200px 36px 60px', gap: 12, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid #1a1a1d', background: isDirty ? 'rgba(234,179,8,0.04)' : 'transparent', transition: 'background 0.1s' }}
                onMouseEnter={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
                onMouseLeave={e => { if (!isDirty) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <div>
                  <div style={{ fontSize: '0.8125rem', color: '#d4d4d8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={group.name}>{group.name}</div>
                  <div style={{ fontSize: '0.6875rem', color: '#52525b', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{group.path.split('/').pop()}</div>
                </div>
                <select
                  value={currentBehavior}
                  onChange={e => onBehaviorChange(group.path, e.target.value)}
                  style={{ width: '100%', background: '#18181b', border: `1px solid ${isDirty ? '#eab308' : '#3f3f46'}`, borderRadius: 6, color: '#d4d4d8', fontSize: '0.75rem', padding: '5px 8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', cursor: 'pointer' }}
                >
                  <option value="alwaysDeploy">Always deploy &amp; update</option>
                  <option value="deployIfNotExists">Deploy once, never update</option>
                </select>
                <button
                  onClick={() => openModal(group)}
                  title="View JSON"
                  style={{ background: 'transparent', border: '1px solid #27272a', borderRadius: 5, color: '#52525b', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', margin: 'auto', transition: 'all 0.12s', flexShrink: 0 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#3f3f46'; (e.currentTarget as HTMLElement).style.color = '#a1a1aa'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#27272a'; (e.currentTarget as HTMLElement).style.color = '#52525b'; }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <ellipse cx="8" cy="8" rx="6" ry="4"/>
                    <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
                  </svg>
                </button>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#eab308', visibility: isDirty ? 'visible' : 'hidden' }} title="Unsaved change" />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, animation: 'slideIn 0.15s ease' }}>
          <div style={{
            padding: '10px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, maxWidth: 360,
            background: toast.type === 'success' ? '#14532d' : toast.type === 'error' ? '#450a0a' : '#1c1c1f',
            color: toast.type === 'success' ? '#86efac' : toast.type === 'error' ? '#fca5a5' : '#a1a1aa',
            border: `1px solid ${toast.type === 'success' ? '#166534' : toast.type === 'error' ? '#7f1d1d' : '#3f3f46'}`,
          }}>
            {toast.msg}
          </div>
        </div>
      )}

      {/* Modal */}
      {modalGroup && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setModalGroup(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, width: 'min(680px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #27272a', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f4f4f5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{modalGroup.name}</div>
                <div style={{ fontSize: '0.6875rem', color: '#52525b', fontFamily: 'monospace', marginTop: 2 }}>{modalGroup.path}</div>
              </div>
              <button
                onClick={() => setModalGroup(null)}
                style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#71717a', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, fontSize: '1rem', fontFamily: 'inherit' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ef4444'; (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#3f3f46'; (e.currentTarget as HTMLElement).style.color = '#71717a'; }}
              >✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {modalLoading ? (
                <div style={{ color: '#52525b', fontSize: '0.8125rem', padding: '24px 0', textAlign: 'center' }}>Loading…</div>
              ) : (
                <pre style={{ margin: 0, fontSize: '0.75rem', fontFamily: "'JetBrains Mono', monospace", color: '#86efac', background: '#0a0a0b', border: '1px solid #27272a', borderRadius: 6, padding: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>
                  {modalContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  );
}
