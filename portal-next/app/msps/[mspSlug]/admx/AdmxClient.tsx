'use client';
import { useState, useEffect, useRef } from 'react';

interface AdmxDef {
  baseName: string;
  displayName: string;
  fileName: string;
  description: string;
  languageCodes: string[];
  hasAdmx: boolean;
}

interface StagedAdml { fileName: string; base64: string }

function Spinner() {
  return <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: 'currentColor', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />;
}

interface ExpanderProps {
  def: AdmxDef;
  mode: 'full' | 'adml';
  mspSlug: string;
  onDone: () => void;
  onCancel: () => void;
}

function UploadExpander({ def, mode, mspSlug, onDone, onCancel }: ExpanderProps) {
  const admxInputRef = useRef<HTMLInputElement>(null);
  const admlInputRef = useRef<HTMLInputElement>(null);
  const [admxB64, setAdmxB64]         = useState<string | null>(null);
  const [admxName, setAdmxName]       = useState('');
  const [staged, setStaged]           = useState<StagedAdml[]>([]);
  const [pendingFile, setPending]     = useState<{ name: string; b64: string } | null>(null);
  const [langCode, setLangCode]       = useState('en-US');
  const [uploading, setUploading]     = useState(false);
  const [feedback, setFeedback]       = useState<{ msg: string; type: 'error' | 'success' | '' }>({ msg: '', type: '' });

  const canSubmit = mode === 'full' ? !!admxB64 : staged.length > 0;

  function readAsB64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        resolve(url.slice(url.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function onAdmxPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.admx')) { setFeedback({ msg: 'Only .admx files accepted', type: 'error' }); return; }
    try { const b64 = await readAsB64(file); setAdmxB64(b64); setAdmxName(file.name); setFeedback({ msg: '', type: '' }); }
    catch { setFeedback({ msg: 'Failed to read file', type: 'error' }); }
  }

  async function onAdmlPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.adml')) { setFeedback({ msg: 'Only .adml files accepted', type: 'error' }); return; }
    try { const b64 = await readAsB64(file); setPending({ name: file.name, b64 }); setFeedback({ msg: '', type: '' }); }
    catch { setFeedback({ msg: 'Failed to read file', type: 'error' }); }
  }

  function addAdml() {
    if (!pendingFile) return;
    if (!langCode.trim()) { setFeedback({ msg: 'Enter a language code', type: 'error' }); return; }
    if (!/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(langCode)) { setFeedback({ msg: `Invalid language code "${langCode}"`, type: 'error' }); return; }
    const fileName = `${def.baseName}.${langCode}.adml`;
    if (staged.find(s => s.fileName === fileName)) { setFeedback({ msg: `Language "${langCode}" already staged`, type: 'error' }); return; }
    setStaged(prev => [...prev, { fileName, base64: pendingFile.b64 }]);
    setPending(null); setLangCode('en-US'); setFeedback({ msg: '', type: '' });
    if (admlInputRef.current) admlInputRef.current.value = '';
  }

  async function submit() {
    setUploading(true); setFeedback({ msg: '', type: '' });
    try {
      const res = await fetch('/api/git/admx', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mspSlug,
          baseName: def.baseName,
          displayName: def.displayName,
          description: def.description,
          admxBase64: admxB64 ?? undefined,
          admlFiles: staged,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setFeedback({ msg: 'Saved successfully.', type: 'success' });
      setTimeout(onDone, 800);
    } catch (e: unknown) {
      setFeedback({ msg: e instanceof Error ? e.message : 'Upload failed', type: 'error' });
    } finally { setUploading(false); }
  }

  const S: Record<string, React.CSSProperties> = {
    wrap:   { padding: '14px 18px', background: '#0e0e10', borderBottom: '1px solid #27272a', display: 'flex', flexDirection: 'column', gap: 10 },
    row:    { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' },
    label:  { fontSize: '0.8125rem', color: '#a1a1aa', width: 140, flexShrink: 0, paddingTop: 6 },
    pickBtn:{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, background: '#18181b', border: '1px solid #3f3f46', color: '#a1a1aa', cursor: 'pointer', position: 'relative' as const },
    input:  { position: 'absolute' as const, inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' },
    chosen: { fontSize: '0.8125rem', color: '#22c55e', fontWeight: 500 },
    chip:   { display: 'inline-flex', alignItems: 'center', gap: 5, background: '#1c1c1f', border: '1px solid #27272a', borderRadius: 4, padding: '2px 8px', fontSize: '0.75rem', color: '#a1a1aa' },
    langIn: { width: 72, background: '#18181b', border: '1px solid #27272a', borderRadius: 6, padding: '5px 8px', fontSize: '0.8125rem', color: '#e4e4e7', fontFamily: 'inherit' },
  };

  return (
    <div style={S.wrap}>
      {mode === 'full' && (
        <div style={S.row}>
          <span style={S.label}>.admx file <span style={{ color: '#f87171' }}>*</span></span>
          <div style={S.pickBtn}>
            <input ref={admxInputRef} type="file" accept=".admx" style={S.input} onChange={onAdmxPick} />
            {admxName ? 'Change…' : 'Choose file…'}
          </div>
          {admxName && <span style={S.chosen}>{admxName}</span>}
        </div>
      )}

      <div style={S.row}>
        <span style={S.label}>.adml language files</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={S.pickBtn}>
              <input ref={admlInputRef} type="file" accept=".adml" style={S.input} onChange={onAdmlPick} />
              {pendingFile ? 'Change…' : 'Choose .adml…'}
            </div>
            {pendingFile && <span style={{ fontSize: '0.8125rem', color: '#e4e4e7', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingFile.name}</span>}
            <input value={langCode} onChange={e => setLangCode(e.target.value)} placeholder="en-US" title="Language code" style={S.langIn} />
            <button onClick={addAdml} disabled={!pendingFile} style={{ padding: '5px 10px', borderRadius: 6, fontSize: '0.8125rem', background: 'transparent', border: '1px solid #3f3f46', color: '#71717a', cursor: pendingFile ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
              + Add
            </button>
          </div>
          {staged.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {staged.map(s => (
                <span key={s.fileName} style={S.chip}>
                  {s.fileName}
                  <button onClick={() => setStaged(prev => prev.filter(x => x.fileName !== s.fileName))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#52525b', fontSize: '0.875rem', padding: 0, lineHeight: 1 }}>✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={submit} disabled={!canSubmit || uploading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 14px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, background: canSubmit && !uploading ? '#22c55e' : '#1a2e1a', color: canSubmit && !uploading ? '#052e16' : '#52525b', border: 'none', cursor: canSubmit && !uploading ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
          {uploading ? <><Spinner /> Uploading…</> : (mode === 'adml' ? 'Save Language File(s)' : 'Upload')}
        </button>
        <button onClick={onCancel} style={{ padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', background: 'transparent', border: '1px solid #27272a', color: '#71717a', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
        {feedback.msg && <span style={{ fontSize: '0.8125rem', color: feedback.type === 'error' ? '#f87171' : '#22c55e' }}>{feedback.msg}</span>}
      </div>
    </div>
  );
}

interface Props { mspSlug: string }

export default function AdmxClient({ mspSlug }: Props) {
  const [defs, setDefs]         = useState<AdmxDef[]>([]);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState<{ baseName: string; mode: 'full' | 'adml' } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError]       = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/git/admx?mspSlug=${mspSlug}`);
      const d   = await res.json();
      if (!res.ok) throw new Error(d.error);
      setDefs(d.definitions ?? []);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [mspSlug]);

  async function deleteDef(def: AdmxDef) {
    if (!confirm(`Delete "${def.displayName}" and all its files? This cannot be undone.`)) return;
    setDeleting(def.baseName);
    try {
      const res = await fetch('/api/git/admx', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug, baseName: def.baseName }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Delete failed'); }
    finally { setDeleting(null); }
  }

  function expand(baseName: string, mode: 'full' | 'adml') {
    setExpanded(prev => prev?.baseName === baseName && prev.mode === mode ? null : { baseName, mode });
  }

  const S: Record<string, React.CSSProperties> = {
    card:   { background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #27272a' },
    th:     { textAlign: 'left' as const, padding: '7px 14px', fontSize: '0.6875rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.06em', borderBottom: '1px solid #27272a', whiteSpace: 'nowrap' as const },
    td:     { padding: '10px 14px', color: '#d4d4d8', borderBottom: '1px solid #18181b', verticalAlign: 'middle' as const },
  };

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {error && <div className="msg-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={S.card}>
        <div style={S.header}>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e4e4e7' }}>ADMX Definitions in Baseline</span>
          <span style={{ fontSize: '0.75rem', color: '#52525b' }}>
            {loading ? 'Loading…' : defs.length
              ? `${defs.length} definition${defs.length !== 1 ? 's' : ''}${defs.filter(d => !d.hasAdmx).length ? `  ·  ${defs.filter(d => !d.hasAdmx).length} missing .admx` : ''}`
              : ''}
          </span>
        </div>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 18px', color: '#52525b', fontSize: '0.875rem' }}>
            <Spinner /> Loading definitions…
          </div>
        ) : defs.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.8125rem', lineHeight: 1.6 }}>
            No ADMX definitions found in the baseline repo.<br />
            Upload a new definition using the button below.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr>
                <th style={S.th}>Definition</th>
                <th style={S.th}>Languages</th>
                <th style={S.th}>Status</th>
                <th style={{ ...S.th, width: '1%', textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {defs.map(def => (
                <>
                  <tr key={def.baseName} style={{ cursor: 'default' }}>
                    <td style={S.td}>
                      <div style={{ fontWeight: 500, color: '#e4e4e7' }}>{def.displayName}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>{def.fileName}</div>
                    </td>
                    <td style={S.td}>
                      {def.languageCodes.length
                        ? def.languageCodes.map(l => (
                          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, fontSize: '0.6875rem', fontWeight: 500, background: '#27272a', color: '#a1a1aa', margin: '1px 2px' }}>{l}</span>
                        ))
                        : <span style={{ color: '#52525b', fontSize: '0.75rem' }}>—</span>}
                    </td>
                    <td style={S.td}>
                      {def.hasAdmx
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, fontSize: '0.6875rem', fontWeight: 600, background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}>Complete</span>
                        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, fontSize: '0.6875rem', fontWeight: 600, background: 'rgba(234,179,8,0.1)', color: '#eab308', border: '1px solid rgba(234,179,8,0.2)' }}>Missing .admx</span>}
                    </td>
                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {def.hasAdmx
                          ? <button onClick={() => expand(def.baseName, 'adml')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, background: expanded?.baseName === def.baseName ? 'rgba(99,102,241,0.22)' : 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)', cursor: 'pointer', fontFamily: 'inherit' }}>+ Language</button>
                          : <button onClick={() => expand(def.baseName, 'full')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, background: expanded?.baseName === def.baseName ? 'rgba(234,179,8,0.2)' : 'rgba(234,179,8,0.12)', color: '#eab308', border: '1px solid rgba(234,179,8,0.25)', cursor: 'pointer', fontFamily: 'inherit' }}>Upload .admx</button>}
                        <button onClick={() => deleteDef(def)} disabled={deleting === def.baseName}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, background: 'transparent', color: '#f87171', border: '1px solid #3f1e1e', cursor: deleting === def.baseName ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: deleting === def.baseName ? 0.5 : 1 }}>
                          {deleting === def.baseName ? <Spinner /> : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded?.baseName === def.baseName && (
                    <tr key={def.baseName + '-exp'}>
                      <td colSpan={4} style={{ padding: 0, borderBottom: '1px solid #27272a' }}>
                        <UploadExpander
                          def={def}
                          mode={expanded.mode}
                          mspSlug={mspSlug}
                          onDone={() => { setExpanded(null); load(); }}
                          onCancel={() => setExpanded(null)}
                        />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}

        {/* New definition upload */}
        <div style={{ borderTop: '1px solid #27272a', padding: '12px 18px' }}>
          {expanded?.baseName === '__new__' ? (
            <NewDefinitionForm mspSlug={mspSlug} onDone={() => { setExpanded(null); load(); }} onCancel={() => setExpanded(null)} />
          ) : (
            <button onClick={() => setExpanded({ baseName: '__new__', mode: 'full' })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, background: '#22c55e', color: '#052e16', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              + New ADMX Definition
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NewDefinitionForm({ mspSlug, onDone, onCancel }: { mspSlug: string; onDone: () => void; onCancel: () => void }) {
  const [baseName, setBaseName]   = useState('');
  const [displayName, setDisplay] = useState('');
  const [description, setDesc]    = useState('');
  const [admxB64, setAdmxB64]     = useState<string | null>(null);
  const [admxFileName, setAdmxFN] = useState('');
  const [staged, setStaged]       = useState<StagedAdml[]>([]);
  const [pendingFile, setPending] = useState<{ name: string; b64: string } | null>(null);
  const [langCode, setLangCode]   = useState('en-US');
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback]   = useState('');
  const admxRef = useRef<HTMLInputElement>(null);
  const admlRef = useRef<HTMLInputElement>(null);

  function readB64(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const d = r.result as string; res(d.slice(d.indexOf(',') + 1)); };
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }

  async function submit() {
    if (!baseName.trim() || !displayName.trim() || !admxB64) { setFeedback('Base name, display name, and .admx file are required.'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) { setFeedback('Base name: letters, digits, underscores, hyphens only.'); return; }
    setUploading(true); setFeedback('');
    try {
      const res = await fetch('/api/git/admx', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug, baseName, displayName, description, admxBase64: admxB64, admlFiles: staged }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onDone();
    } catch (e: unknown) { setFeedback(e instanceof Error ? e.message : 'Upload failed'); }
    finally { setUploading(false); }
  }

  const inp: React.CSSProperties = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '6px 10px', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' };
  const pickBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, background: '#18181b', border: '1px solid #3f3f46', color: '#a1a1aa', cursor: 'pointer', position: 'relative' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#e4e4e7', marginBottom: 4 }}>New ADMX Definition</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Base Name <span style={{ color: '#f87171' }}>*</span></label>
          <input value={baseName} onChange={e => setBaseName(e.target.value)} placeholder="e.g. ChromePolicy" style={inp} />
          <div style={{ fontSize: '0.65rem', color: '#52525b', marginTop: 3 }}>Letters, digits, hyphens only</div>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Display Name <span style={{ color: '#f87171' }}>*</span></label>
          <input value={displayName} onChange={e => setDisplay(e.target.value)} placeholder="e.g. Google Chrome" style={inp} />
        </div>
      </div>
      <div className="form-group" style={{ margin: 0 }}>
        <label>Description</label>
        <input value={description} onChange={e => setDesc(e.target.value)} placeholder="Optional description" style={inp} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={pickBtn}>
          <input ref={admxRef} type="file" accept=".admx" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
            onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const b = await readB64(f); setAdmxB64(b); setAdmxFN(f.name); } catch { setFeedback('Failed to read .admx'); } }} />
          {admxFileName ? 'Change .admx…' : 'Choose .admx file…'}
        </div>
        {admxFileName && <span style={{ fontSize: '0.8125rem', color: '#22c55e', fontWeight: 500 }}>{admxFileName}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={pickBtn}>
          <input ref={admlRef} type="file" accept=".adml" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
            onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const b = await readB64(f); setPending({ name: f.name, b64: b }); } catch { setFeedback('Failed to read .adml'); } }} />
          {pendingFile ? 'Change .adml…' : 'Choose .adml…'}
        </div>
        {pendingFile && <span style={{ fontSize: '0.8125rem', color: '#e4e4e7' }}>{pendingFile.name}</span>}
        <input value={langCode} onChange={e => setLangCode(e.target.value)} placeholder="en-US" style={{ ...inp, width: 80 }} />
        <button onClick={() => {
          if (!pendingFile || !langCode.trim()) return;
          const fn = `${baseName || 'policy'}.${langCode}.adml`;
          if (staged.find(s => s.fileName === fn)) return;
          setStaged(prev => [...prev, { fileName: fn, base64: pendingFile.b64 }]);
          setPending(null); setLangCode('en-US'); if (admlRef.current) admlRef.current.value = '';
        }} disabled={!pendingFile} style={{ padding: '5px 10px', borderRadius: 6, fontSize: '0.8125rem', background: 'transparent', border: '1px solid #3f3f46', color: '#71717a', cursor: pendingFile ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>+ Add</button>
        {staged.map(s => (
          <span key={s.fileName} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: '#1c1c1f', border: '1px solid #27272a', borderRadius: 4, padding: '2px 8px', fontSize: '0.75rem', color: '#a1a1aa' }}>
            {s.fileName}
            <button onClick={() => setStaged(p => p.filter(x => x.fileName !== s.fileName))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#52525b', fontSize: '0.875rem', padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
      {feedback && <div style={{ fontSize: '0.8125rem', color: '#f87171' }}>{feedback}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={uploading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, background: '#22c55e', color: '#052e16', border: 'none', cursor: uploading ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: uploading ? 0.6 : 1 }}>
          {uploading ? <><Spinner /> Uploading…</> : 'Create Definition'}
        </button>
        <button onClick={onCancel} style={{ padding: '6px 12px', borderRadius: 6, fontSize: '0.8125rem', background: 'transparent', border: '1px solid #27272a', color: '#71717a', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
      </div>
    </div>
  );
}
