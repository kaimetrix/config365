'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { TreeEntry } from '@/lib/server/gitea';

type TabId = 'deploy' | 'remove' | 'groups';

// ─── Groups types ─────────────────────────────────────────────────────────────
interface DynamicRule { type: 'license'; skuPartNumbers: string[] }
interface GroupData {
  membership?: { direct?: string[]; dynamic?: DynamicRule[] };
  content?: { folders?: string[]; filePatterns?: string[]; files?: string[] };
}
interface GroupsConfig { [name: string]: GroupData }
interface Tenant { slug: string; displayName: string }
interface Props { mspSlug: string; deployTree: TreeEntry[]; removeTree: TreeEntry[]; giteaOrg: string; tenants: Tenant[] }

// ─── Monitor types ─────────────────────────────────────────────────────────────
type MonitorConfig = { include?: string[]; exclude?: string[] } | null;
interface MonitorPanelState { include: string[]; exclude: string[] }

// ─── Monitor helpers ──────────────────────────────────────────────────────────
function getSidecarPath(fp: string) { return fp.replace(/\.json$/i, '.monitor.json'); }
function getFolderSidecarPath(fp: string) {
  const dir = fp.includes('/') ? fp.split('/').slice(0, -1).join('/') : '';
  return dir ? `${dir}/_default.monitor.json` : '_default.monitor.json';
}
function isPathIgnored(path: string | null, config: MonitorConfig): boolean {
  if (!path || !config) return false;
  if (config.exclude?.length) {
    if (config.exclude.some(e => path === e || path.startsWith(e + '.'))) return true;
  }
  if (config.include?.length) {
    return !config.include.some(e => path === e || path.startsWith(e + '.') || e.startsWith(path + '.'));
  }
  return false;
}
function isPathIncluded(path: string | null, config: MonitorConfig): boolean {
  if (!path || !config?.include?.length) return false;
  return config.include.some(e => path === e || path.startsWith(e + '.') || e.startsWith(path + '.'));
}
function mergeMonitorConfigs(fileConfig: MonitorConfig, folderConfig: MonitorConfig): MonitorConfig {
  if (!fileConfig && !folderConfig) return null;
  if (!fileConfig) return folderConfig;
  if (!folderConfig) return fileConfig;
  const inc = [...new Set([...(fileConfig.include ?? []), ...(folderConfig.include ?? []).filter(p => !(fileConfig.exclude ?? []).includes(p))])];
  const exc = [...new Set([...(fileConfig.exclude ?? []), ...(folderConfig.exclude ?? []).filter(p => !(fileConfig.include ?? []).includes(p))])];
  return (inc.length || exc.length) ? { ...(inc.length ? { include: inc } : {}), ...(exc.length ? { exclude: exc } : {}) } : null;
}

// ─── JSON line annotation ─────────────────────────────────────────────────────
interface AnnotatedLine { line: string; path: string | null }
function annotateJsonLines(jsonStr: string): AnnotatedLine[] {
  if (!jsonStr) return [];
  const rawLines = jsonStr.split('\n');
  const result: AnnotatedLine[] = [];
  const stack: string[] = [];
  const firstNonEmpty = rawLines.find(l => l.trim().length > 0)?.trim() ?? '';
  let skipNextBracket = firstNonEmpty === '[';
  let skippedRoot = false;
  let skipFirstElement = false;
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    const keyMatch = trimmed.match(/^"([^"\\]*)"\s*:\s*(.*)/);
    if (keyMatch) {
      const [, key, rest] = keyMatch;
      const path = stack.length > 0 ? stack.join('.') + '.' + key : key;
      result.push({ line: rawLine, path });
      const restTrimmed = rest.trim().replace(/,$/, '');
      if (restTrimmed === '{' || restTrimmed === '[') stack.push(key);
    } else if (trimmed === '[' || trimmed === '[,') {
      if (!skippedRoot && skipNextBracket) { skippedRoot = true; skipFirstElement = true; }
      else { stack.pop(); }
      result.push({ line: rawLine, path: null });
    } else if (trimmed === '{' || trimmed === '{,') {
      if (skipFirstElement) skipFirstElement = false;
      result.push({ line: rawLine, path: null });
    } else if (trimmed === '}' || trimmed === '},' || trimmed === ']' || trimmed === '],') {
      if (stack.length > 0) stack.pop();
      result.push({ line: rawLine, path: null });
    } else {
      result.push({ line: rawLine, path: null });
    }
  }
  return result;
}
function getMinimalPaths(paths: Set<string>): string[] {
  const all = [...paths];
  return all.filter(path => {
    const parts = path.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join('.'))) return false;
    }
    return true;
  });
}

// ─── Tree builder ─────────────────────────────────────────────────────────────
type TreeNode = { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[] };
function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs: Record<string, TreeNode> = {};
  function ensureDir(parts: string[], upTo: number): TreeNode[] {
    if (upTo === 0) return root;
    const dirPath = parts.slice(0, upTo).join('/');
    if (!dirs[dirPath]) {
      const parent = ensureDir(parts, upTo - 1);
      const node: TreeNode = { name: parts[upTo - 1], path: dirPath, type: 'dir', children: [] };
      dirs[dirPath] = node; parent.push(node);
    }
    return dirs[dirPath].children;
  }
  for (const e of entries) {
    const parts = e.path.split('/');
    const parent = ensureDir(parts, parts.length - 1);
    parent.push({ name: parts.at(-1) ?? e.path, path: e.path, type: e.type, children: [] });
  }
  function sort(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => { if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; return a.name.localeCompare(b.name); });
    for (const n of nodes) if (n.children.length) sort(n.children);
    return nodes;
  }
  return sort(root);
}
function unwrapRoot(nodes: TreeNode[], rootName: string): TreeNode[] {
  if (nodes.length === 1 && nodes[0].name === rootName && nodes[0].type === 'dir') return nodes[0].children;
  return nodes;
}

// ─── Small shared UI ──────────────────────────────────────────────────────────
function GroupSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 16px 0', padding: '10px 0', borderBottom: '1px solid #1a1a1a' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function TagList({ tags, onRemove, mono, emptyText }: { tags: string[]; onRemove: (v: string) => void; mono?: boolean; emptyText: string }) {
  if (tags.length === 0) return <span style={{ fontSize: '0.72rem', color: '#3f3f46', fontStyle: 'italic' }}>{emptyText}</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {tags.map(t => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#1e1e22', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 7px', fontSize: mono ? '0.68rem' : '0.72rem', fontFamily: mono ? 'monospace' : 'inherit', color: '#d4d4d8' }}>
          {t}
          <button onClick={() => onRemove(t)} style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '0.7rem' }}>✕</button>
        </span>
      ))}
    </div>
  );
}
function AddInput({ placeholder, onAdd, mono, datalist }: { placeholder: string; onAdd: (v: string) => void; mono?: boolean; datalist?: string[] }) {
  const [val, setVal] = useState('');
  const id = `dl-${placeholder.replace(/\W/g, '')}`;
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && val.trim()) { onAdd(val); setVal(''); } }} placeholder={placeholder} list={datalist ? id : undefined}
        style={{ flex: 1, background: '#18181b', border: '1px solid #3f3f46', color: '#d4d4d8', borderRadius: 5, padding: '4px 8px', fontSize: mono ? '0.7rem' : '0.75rem', fontFamily: mono ? 'monospace' : 'inherit', outline: 'none' }} />
      {datalist && <datalist id={id}>{datalist.map(d => <option key={d} value={d} />)}</datalist>}
      <button onClick={() => { if (val.trim()) { onAdd(val); setVal(''); } }} style={{ padding: '4px 10px', fontSize: '0.72rem', background: '#27272a', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>Add</button>
    </div>
  );
}

const isSidecar = (name: string) => name.endsWith('.monitor.json') || name.endsWith('.config.json') || name === '.gitkeep';

function toRemovePath(deployPath: string): string | null {
  if (!deployPath.startsWith('baseline/')) return null;
  return deployPath.replace(/^baseline\//, 'baseline-remove/');
}

function buildRemovalManifest(rawContent: string): string {
  if (!rawContent.trim()) return rawContent;
  try {
    const obj = JSON.parse(rawContent) as Record<string, unknown>;
    if (!obj.reason) obj.reason = 'Staged for removal via portal';
    return JSON.stringify(obj, null, 2) + '\n';
  } catch {
    return rawContent.endsWith('\n') ? rawContent : rawContent + '\n';
  }
}

// ─── Monitor Panel (Baseline mode — no copy-to-baseline, just sidecar edit) ───
interface BMonitorPanelProps {
  filePath: string;
  mspSlug: string;
  fileState: MonitorPanelState;
  folderState: MonitorPanelState;
  fileSha: string | undefined;
  folderSha: string | undefined;
  onUpdate: (fs: MonitorPanelState, ds: MonitorPanelState, fsha?: string, dsha?: string) => void;
}

function BMonitorPanel({ filePath, mspSlug, fileState, folderState, fileSha, folderSha, onUpdate }: BMonitorPanelProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<'file' | 'folder' | null>(null);
  const [msg, setMsg] = useState('');

  const fileSP   = getSidecarPath(filePath);
  const folderSP = getFolderSidecarPath(filePath);
  const fExc = fileState.exclude.length + folderState.exclude.length;
  const fInc = fileState.include.length + folderState.include.length;
  const summaryParts: string[] = [];
  if (fExc > 0) summaryParts.push(`excluding ${fExc} field${fExc !== 1 ? 's' : ''}`);
  if (fInc > 0) summaryParts.push(`monitoring ${fInc} field${fInc !== 1 ? 's' : ''}`);
  const summary = summaryParts.length ? summaryParts.join(' · ') : 'no config';
  const hasAnyConfig = fExc + fInc > 0;

  async function saveSidecar(scope: 'file' | 'folder') {
    setSaving(scope); setMsg('');
    const st  = scope === 'file' ? fileState : folderState;
    const sp  = scope === 'file' ? fileSP : folderSP;
    const sha = scope === 'file' ? fileSha : folderSha;
    const cfg: Record<string, string[]> = {};
    if (st.include.length) cfg.include = st.include;
    if (st.exclude.length) cfg.exclude = st.exclude;
    const hasConfig = Object.keys(cfg).length > 0;
    try {
      if (!hasConfig) {
        if (sha) {
          await fetch('/api/git/file', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: sp, sha, scope: 'baseline', mspSlug, message: `portal: clear monitor config for ${sp}` }) });
        }
        onUpdate(
          scope === 'file' ? { include: [], exclude: [] } : fileState,
          scope === 'folder' ? { include: [], exclude: [] } : folderState,
          scope === 'file' ? undefined : fileSha,
          scope === 'folder' ? undefined : folderSha,
        );
      } else {
        const content = JSON.stringify(cfg, null, 2) + '\n';
        const chk = await fetch(`/api/git/file?path=${encodeURIComponent(sp)}&scope=baseline&mspSlug=${mspSlug}`);
        const chkd = await chk.json();
        const res = await fetch('/api/git/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sp, content, sha: chkd.exists ? chkd.sha : undefined, scope: 'baseline', mspSlug, message: `portal: update monitor config for ${sp}` }) });
        if (!res.ok) throw new Error((await res.json()).error);
        const nc = await fetch(`/api/git/file?path=${encodeURIComponent(sp)}&scope=baseline&mspSlug=${mspSlug}`);
        const nd = await nc.json();
        onUpdate(
          scope === 'file'   ? st          : fileState,
          scope === 'folder' ? st          : folderState,
          scope === 'file'   ? nd.sha      : fileSha,
          scope === 'folder' ? nd.sha      : folderSha,
        );
      }
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Error');
    } finally { setSaving(null); }
  }

  function removeTag(scope: 'file' | 'folder', type: 'include' | 'exclude', val: string) {
    if (scope === 'file') onUpdate({ ...fileState, [type]: fileState[type].filter(p => p !== val) }, folderState, fileSha, folderSha);
    else onUpdate(fileState, { ...folderState, [type]: folderState[type].filter(p => p !== val) }, fileSha, folderSha);
  }
  function clearAll(scope: 'file' | 'folder') {
    if (scope === 'file') onUpdate({ include: [], exclude: [] }, folderState, fileSha, folderSha);
    else onUpdate(fileState, { include: [], exclude: [] }, fileSha, folderSha);
  }

  function MonitorTagList({ paths, type, scope }: { paths: string[]; type: 'include' | 'exclude'; scope: 'file' | 'folder' }) {
    if (paths.length === 0) return <span style={{ fontSize: '0.72rem', color: '#3f3f46', fontStyle: 'italic' }}>none</span>;
    return (
      <>
        {paths.map(p => (
          <span key={p} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            background: type === 'include' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${type === 'include' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            borderRadius: 4, padding: '1px 6px 1px 7px', fontSize: '0.7rem',
            color: type === 'include' ? '#86efac' : '#fca5a5', fontFamily: 'monospace',
          }}>
            {p}
            <button onClick={() => removeTag(scope, type, p)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 1px', fontSize: '0.7rem', lineHeight: 1 }}>✕</button>
          </span>
        ))}
      </>
    );
  }

  function SidecarSection({ label, pathHint, state, scope }: { label: string; pathHint: string; state: MonitorPanelState; scope: 'file' | 'folder' }) {
    const isEmpty = !state.include.length && !state.exclude.length;
    return (
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e1e21' }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#52525b', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: '0.6rem', color: '#3f3f46', fontFamily: 'monospace', marginBottom: 6, wordBreak: 'break-all' }}>baseline/{pathHint}</div>
        {isEmpty ? (
          <div style={{ fontSize: '0.72rem', color: '#3f3f46', fontStyle: 'italic', marginBottom: 6 }}>No config — click JSON fields above to add</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
            {state.include.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', color: '#52525b', fontWeight: 600, width: 52, flexShrink: 0, paddingTop: 2 }}>Include</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}><MonitorTagList paths={state.include} type="include" scope={scope} /></div>
              </div>
            )}
            {state.exclude.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', color: '#52525b', fontWeight: 600, width: 52, flexShrink: 0, paddingTop: 2 }}>Exclude</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}><MonitorTagList paths={state.exclude} type="exclude" scope={scope} /></div>
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => saveSidecar(scope)} disabled={saving === scope}
            style={{ padding: '4px 10px', fontSize: '0.72rem', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 4, cursor: saving === scope ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving === scope ? 0.5 : 1 }}>
            {saving === scope ? 'Saving…' : 'Save'}
          </button>
          {!isEmpty && (
            <button onClick={() => clearAll(scope)} style={{ padding: '4px 10px', fontSize: '0.72rem', background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
              Clear all
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid #27272a', background: '#0c0c0e' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ fontSize: '0.65rem', color: '#52525b', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#71717a' }}>Field Monitoring</span>
        <span style={{ fontSize: '0.7rem', color: hasAnyConfig ? '#a78bfa' : '#3f3f46', background: hasAnyConfig ? 'rgba(167,139,250,0.1)' : 'transparent', border: hasAnyConfig ? '1px solid rgba(167,139,250,0.2)' : 'none', borderRadius: 4, padding: hasAnyConfig ? '1px 6px' : '0', marginLeft: 4 }}>
          {summary}
        </span>
        {msg && <span style={{ fontSize: '0.7rem', color: '#86efac', marginLeft: 'auto' }}>{msg}</span>}
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #1e1e21' }}>
          <SidecarSection label="File-level config" pathHint={fileSP}   state={fileState}   scope="file" />
          <SidecarSection label="Folder default"    pathHint={folderSP} state={folderState} scope="folder" />
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function BaselineClient({ mspSlug, deployTree, removeTree, giteaOrg: _giteaOrg, tenants }: Props) {
  const router = useRouter();
  const [tab, setTab]             = useState<TabId>('deploy');
  const [selectedPath, setPath]   = useState<string | null>(null);
  const [content, setContent]     = useState('');
  const [sha, setSha]             = useState<string | undefined>();
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');
  const [expandedDirs, setExp]    = useState<Set<string>>(new Set());
  const [isEditMode, setEditMode] = useState(false);

  // Field selection
  const [selectedPaths, setSelectedPaths]   = useState<Set<string>>(new Set());
  const [scopeDropdownOpen, setScopeOpen]   = useState(false);

  // Monitor sidecar state
  const [monitorConfig, setMonitorConfig]           = useState<MonitorConfig>(null);
  const [fileMonitorState, setFileMonitorState]     = useState<MonitorPanelState>({ include: [], exclude: [] });
  const [folderMonitorState, setFolderMonitorState] = useState<MonitorPanelState>({ include: [], exclude: [] });
  const [fileSidecarSha, setFileSidecarSha]         = useState<string | undefined>();
  const [folderSidecarSha, setFolderSidecarSha]     = useState<string | undefined>();

  // Import ZIP
  const zipInputRef                     = useRef<HTMLInputElement>(null);
  const importAbortRef                  = useRef<AbortController | null>(null);
  const [importing, setImporting]       = useState(false);
  const [importPhase, setImportPhase]   = useState<'reading' | 'uploading' | 'committing' | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importFileCount, setImportFileCount] = useState(0);
  const [importUploaded, setImportUploaded]   = useState(0);
  const [importPath, setImportPath]     = useState('');
  const [showImport, setShowImport]     = useState(false);

  // Groups tab
  const [groupsConfig, setGroupsConfig]           = useState<GroupsConfig>({});
  const [groupsLoading, setGroupsLoading]         = useState(false);
  const [selectedGroup, setSelectedGroup]         = useState<string | null>(null);
  const [groupEditor, setGroupEditor]             = useState<GroupData>({});
  const [groupSaving, setGroupSaving]             = useState(false);
  const [groupSyncing, setGroupSyncing]           = useState(false);
  const [groupSyncStatus, setGroupSyncStatus]     = useState('');
  const [showNewGroup, setShowNewGroup]           = useState(false);
  const [newGroupName, setNewGroupName]           = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // File actions (deploy / remove tabs)
  type FileActionConfirm = 'git' | 'tenants' | null;
  const [fileActionConfirm, setFileActionConfirm] = useState<FileActionConfirm>(null);
  const [fileActionBusy, setFileActionBusy]       = useState(false);

  const deployNodes = unwrapRoot(buildTree(deployTree), 'baseline');
  const removeNodes = unwrapRoot(buildTree(removeTree), 'baseline-remove');
  const activeNodes = tab === 'remove' ? removeNodes : deployNodes;

  function switchTab(t: TabId) {
    setTab(t); setPath(null); setContent(''); setSha(undefined); setError(''); setSuccess('');
    setShowImport(false); setEditMode(false); setSelectedPaths(new Set()); setScopeOpen(false);
    setFileActionConfirm(null);
    resetMonitor();
  }

  function resetMonitor() {
    setMonitorConfig(null);
    setFileMonitorState({ include: [], exclude: [] });
    setFolderMonitorState({ include: [], exclude: [] });
    setFileSidecarSha(undefined);
    setFolderSidecarSha(undefined);
  }

  // ── Sidecar loading ──────────────────────────────────────────────────────────
  async function loadMonitorSidecars(filePath: string) {
    const fp = getSidecarPath(filePath);
    const dp = getFolderSidecarPath(filePath);
    const qs = `&scope=baseline&mspSlug=${mspSlug}`;
    const [fr, dr] = await Promise.all([
      fetch(`/api/git/file?path=${encodeURIComponent(fp)}${qs}`).then(r => r.json()).catch(() => ({ exists: false })),
      fetch(`/api/git/file?path=${encodeURIComponent(dp)}${qs}`).then(r => r.json()).catch(() => ({ exists: false })),
    ]);
    const fileCfg:   MonitorConfig = fr.exists ? JSON.parse(fr.content) as MonitorConfig : null;
    const folderCfg: MonitorConfig = dr.exists ? JSON.parse(dr.content) as MonitorConfig : null;
    setFileSidecarSha(fr.exists ? fr.sha : undefined);
    setFolderSidecarSha(dr.exists ? dr.sha : undefined);
    setFileMonitorState({ include: fileCfg?.include ?? [], exclude: fileCfg?.exclude ?? [] });
    setFolderMonitorState({ include: folderCfg?.include ?? [], exclude: folderCfg?.exclude ?? [] });
    setMonitorConfig(mergeMonitorConfigs(fileCfg, folderCfg));
  }

  // ── File loading ─────────────────────────────────────────────────────────────
  async function loadFile(path: string) {
    setPath(path); setSha(undefined); setContent(''); setLoading(true); setError(''); setSuccess('');
    setEditMode(false); setSelectedPaths(new Set()); setScopeOpen(false); setFileActionConfirm(null);
    resetMonitor();
    try {
      const res  = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&scope=baseline&mspSlug=${mspSlug}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.exists) { setContent(data.content); setSha(data.sha); }
      else setContent('');
      // Load monitor sidecars (only for deploy tab JSON files)
      if (tab === 'deploy' && path.endsWith('.json') && !isSidecar(path.split('/').at(-1) ?? '')) {
        await loadMonitorSidecars(path);
      }
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }

  // ── Git file helpers ─────────────────────────────────────────────────────────
  async function gitPutFile(path: string, fileContent: string, message: string, existingSha?: string) {
    const res = await fetch('/api/git/file', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: fileContent, sha: existingSha, scope: 'baseline', mspSlug, message }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
  }

  async function gitDeleteFile(path: string, fileSha: string, message: string) {
    const res = await fetch('/api/git/file', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, sha: fileSha, scope: 'baseline', mspSlug, message }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? 'Delete failed');
  }

  async function deleteDeploySidecars(deployPath: string) {
    if (!deployPath.endsWith('.json') || isSidecar(deployPath.split('/').at(-1) ?? '')) return;
    const sidecarPath = getSidecarPath(deployPath);
    if (fileSidecarSha) {
      await gitDeleteFile(sidecarPath, fileSidecarSha, `portal: delete monitor sidecar for ${deployPath}`);
      return;
    }
    try {
      const chk = await fetch(`/api/git/file?path=${encodeURIComponent(sidecarPath)}&scope=baseline&mspSlug=${mspSlug}`);
      const data = await chk.json();
      if (data.exists && data.sha) {
        await gitDeleteFile(sidecarPath, data.sha, `portal: delete monitor sidecar for ${deployPath}`);
      }
    } catch { /* non-fatal */ }
  }

  function clearFileSelection() {
    setFileActionConfirm(null);
    setPath(null); setContent(''); setSha(undefined);
    resetMonitor();
  }

  async function removeFromGit() {
    if (!selectedPath || !sha) return;
    setFileActionBusy(true); setError(''); setSuccess('');
    const pathToDelete = selectedPath;
    try {
      await gitDeleteFile(pathToDelete, sha, `portal: remove from git ${pathToDelete}`);
      if (tab === 'deploy') await deleteDeploySidecars(pathToDelete);
      clearFileSelection();
      setSuccess(`Removed ${pathToDelete} from Git. Refreshing…`);
      setTimeout(() => router.refresh(), 800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Remove from Git failed');
    } finally {
      setFileActionBusy(false);
    }
  }

  async function removeFromTenants() {
    if (!selectedPath || !sha || tab !== 'deploy') return;
    const removePath = toRemovePath(selectedPath);
    if (!removePath) { setError('Only files under baseline/ can be staged for tenant removal.'); return; }

    setFileActionBusy(true); setError(''); setSuccess('');
    try {
      const manifest = selectedPath.endsWith('.json') && !isSidecar(selectedPath.split('/').at(-1) ?? '')
        ? buildRemovalManifest(content)
        : (content.endsWith('\n') ? content : content + '\n');

      const chk = await fetch(`/api/git/file?path=${encodeURIComponent(removePath)}&scope=baseline&mspSlug=${mspSlug}`);
      const existing = await chk.json();
      await gitPutFile(
        removePath,
        manifest,
        `portal: stage ${selectedPath} for tenant removal`,
        existing.exists ? existing.sha : undefined,
      );

      await gitDeleteFile(selectedPath, sha, `portal: move ${selectedPath} to ${removePath}`);
      await deleteDeploySidecars(selectedPath);

      clearFileSelection();
      setSuccess(`Staged ${removePath} for tenant removal. Run deploy with Allow DELETE to apply. Refreshing…`);
      setTimeout(() => router.refresh(), 800);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Remove from tenants failed');
    } finally {
      setFileActionBusy(false);
    }
  }

  // ── Save file ────────────────────────────────────────────────────────────────
  async function saveFile() {
    if (!selectedPath) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/git/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, content, message: `portal: update ${selectedPath}`, sha, scope: 'baseline', mspSlug }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const res2 = await fetch(`/api/git/file?path=${encodeURIComponent(selectedPath)}&scope=baseline&mspSlug=${mspSlug}`);
      const d2 = await res2.json();
      if (d2.exists) setSha(d2.sha);
      setSuccess('Saved successfully.');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setSaving(false); }
  }

  // ── Import ZIP ───────────────────────────────────────────────────────────────
  function cancelImport() {
    importAbortRef.current?.abort();
  }

  async function importZip(file: File) {
    setImporting(true);
    setImportPhase('reading');
    setImportProgress(0);
    setImportFileCount(0);
    setImportUploaded(0);
    setError('');
    setSuccess('');

    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      const { extractBaselineZipInBrowser } = await import('@/lib/client/zip-import-browser');
      const { runBaselineImport } = await import('@/lib/client/baseline-import');

      const pathPrefix = importPath.replace(/\/$/, '');
      const extracted = await extractBaselineZipInBrowser(file, pathPrefix);
      const result = await runBaselineImport({
        files: extracted,
        mspSlug,
        scope: 'baseline',
        pathPrefix,
        message: `import: ${file.name}`,
        signal: controller.signal,
        onProgress: (p) => {
          setImportPhase(p.phase === 'done' ? 'committing' : p.phase);
          setImportProgress(p.percent);
          setImportFileCount(p.total);
          setImportUploaded(p.uploaded);
        },
      });

      setImportPhase('committing');
      setImportProgress(100);
      setSuccess(`Imported ${result.imported} file(s) from ${file.name}. Refreshing…`);
      setShowImport(false);
      setTimeout(() => router.refresh(), 1500);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      importAbortRef.current = null;
      setImporting(false);
      setImportPhase(null);
      setImportProgress(0);
      setImportFileCount(0);
      if (zipInputRef.current) zipInputRef.current.value = '';
    }
  }

  // ── Groups ───────────────────────────────────────────────────────────────────
  const loadGroupsConfig = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res  = await fetch(`/api/git/groups-config?mspSlug=${mspSlug}`);
      const data = await res.json();
      setGroupsConfig(data.groups ?? {});
    } catch { /* silent */ }
    finally { setGroupsLoading(false); }
  }, [mspSlug]);

  useEffect(() => { if (tab === 'groups') loadGroupsConfig(); }, [tab, loadGroupsConfig]);

  function selectGroup(name: string) {
    setSelectedGroup(name); setShowDeleteConfirm(false); setGroupSyncStatus('');
    const g = groupsConfig[name] ?? {};
    setGroupEditor({
      membership: { direct: [...(g.membership?.direct ?? [])], dynamic: (g.membership?.dynamic ?? []).map(r => ({ ...r, skuPartNumbers: [...r.skuPartNumbers] })) },
      content: { folders: [...(g.content?.folders ?? [])], filePatterns: [...(g.content?.filePatterns ?? [])], files: [...(g.content?.files ?? [])] },
    });
  }

  async function saveGroup(name: string, data: GroupData) {
    setGroupSaving(true); setError(''); setSuccess('');
    try {
      const updated = { ...groupsConfig, [name]: data };
      const res = await fetch('/api/git/groups-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mspSlug, groups: updated }) });
      if (!res.ok) throw new Error((await res.json()).error);
      setGroupsConfig(updated); setSuccess('Group saved.');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setGroupSaving(false); }
  }

  async function deleteGroup(name: string) {
    setGroupSaving(true); setError('');
    try {
      const updated = { ...groupsConfig }; delete updated[name];
      const res = await fetch('/api/git/groups-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mspSlug, groups: updated }) });
      if (!res.ok) throw new Error((await res.json()).error);
      setGroupsConfig(updated); setSelectedGroup(null); setShowDeleteConfirm(false);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Delete failed'); }
    finally { setGroupSaving(false); }
  }

  async function createGroup(name: string) {
    const trimmed = name.trim();
    if (!trimmed || groupsConfig[trimmed]) return;
    const blank: GroupData = { membership: { direct: [], dynamic: [] }, content: { folders: [], filePatterns: [], files: [] } };
    await saveGroup(trimmed, blank); setSelectedGroup(trimmed); setGroupEditor(blank); setShowNewGroup(false); setNewGroupName('');
  }

  async function syncGroup(name: string) {
    setGroupSyncing(true); setGroupSyncStatus('');
    try {
      await saveGroup(name, groupEditor);
      const res = await fetch('/api/git/groups-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mspSlug, groupName: name }) });
      const data = await res.json();
      const errPart = data.errors?.length > 0 ? `, ${data.errors.length} error(s)` : '';
      setGroupSyncStatus(`Updated ${data.updated?.length ?? 0} tenant(s)${errPart}`);
    } catch (e: unknown) { setGroupSyncStatus(`Sync failed: ${e instanceof Error ? e.message : 'error'}`); }
    finally { setGroupSyncing(false); }
  }

  function editorAddToList(field: 'folders' | 'filePatterns' | 'files', value: string) {
    if (!value.trim()) return;
    setGroupEditor(prev => { const arr = [...(prev.content?.[field] ?? [])]; if (!arr.includes(value.trim())) arr.push(value.trim()); return { ...prev, content: { ...prev.content, [field]: arr } }; });
  }
  function editorRemoveFromList(field: 'folders' | 'filePatterns' | 'files', value: string) {
    setGroupEditor(prev => ({ ...prev, content: { ...prev.content, [field]: (prev.content?.[field] ?? []).filter(v => v !== value) } }));
  }
  function editorAddDirect(tenant: string) {
    if (!tenant.trim()) return;
    setGroupEditor(prev => { const arr = [...(prev.membership?.direct ?? [])]; if (!arr.includes(tenant.trim())) arr.push(tenant.trim()); return { ...prev, membership: { ...prev.membership, direct: arr } }; });
  }
  function editorRemoveDirect(tenant: string) {
    setGroupEditor(prev => ({ ...prev, membership: { ...prev.membership, direct: (prev.membership?.direct ?? []).filter(t => t !== tenant) } }));
  }
  function editorAddLicenseRule() {
    setGroupEditor(prev => ({ ...prev, membership: { ...prev.membership, dynamic: [...(prev.membership?.dynamic ?? []), { type: 'license', skuPartNumbers: [] }] } }));
  }
  function editorRemoveLicenseRule(idx: number) {
    setGroupEditor(prev => ({ ...prev, membership: { ...prev.membership, dynamic: (prev.membership?.dynamic ?? []).filter((_, i) => i !== idx) } }));
  }
  function editorAddSku(ruleIdx: number, sku: string) {
    if (!sku.trim()) return;
    setGroupEditor(prev => {
      const rules = [...(prev.membership?.dynamic ?? [])];
      const rule = { ...rules[ruleIdx], skuPartNumbers: [...(rules[ruleIdx].skuPartNumbers ?? [])] };
      if (!rule.skuPartNumbers.includes(sku.trim())) rule.skuPartNumbers.push(sku.trim());
      rules[ruleIdx] = rule;
      return { ...prev, membership: { ...prev.membership, dynamic: rules } };
    });
  }
  function editorRemoveSku(ruleIdx: number, sku: string) {
    setGroupEditor(prev => {
      const rules = [...(prev.membership?.dynamic ?? [])];
      rules[ruleIdx] = { ...rules[ruleIdx], skuPartNumbers: rules[ruleIdx].skuPartNumbers.filter(s => s !== sku) };
      return { ...prev, membership: { ...prev.membership, dynamic: rules } };
    });
  }

  function toggleDir(path: string) {
    setExp(prev => { const next = new Set(prev); next.has(path) ? next.delete(path) : next.add(path); return next; });
  }

  // ── Field selection ──────────────────────────────────────────────────────────
  const handleLineClick = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        for (const p of [...next]) { if (p === path || p.startsWith(path + '.')) next.delete(p); }
      } else {
        for (const p of [...next]) { if (p.startsWith(path + '.')) next.delete(p); }
        const parts = path.split('.');
        const parentSelected = parts.some((_, i) => i > 0 && next.has(parts.slice(0, i).join('.')));
        if (!parentSelected) next.add(path);
      }
      return next;
    });
    setScopeOpen(false);
  }, []);

  function applyToMonitor(type: 'include' | 'exclude', scope: 'file' | 'folder') {
    const paths = getMinimalPaths(selectedPaths);
    if (scope === 'file') {
      setFileMonitorState(prev => {
        const next = { ...prev, [type]: [...new Set([...prev[type], ...paths])] };
        const fileCfg: MonitorConfig = next.include.length || next.exclude.length ? { include: next.include, exclude: next.exclude } : null;
        const folderCfg: MonitorConfig = folderMonitorState.include.length || folderMonitorState.exclude.length ? { include: folderMonitorState.include, exclude: folderMonitorState.exclude } : null;
        setMonitorConfig(mergeMonitorConfigs(fileCfg, folderCfg));
        return next;
      });
    } else {
      setFolderMonitorState(prev => {
        const next = { ...prev, [type]: [...new Set([...prev[type], ...paths])] };
        const fileCfg: MonitorConfig = fileMonitorState.include.length || fileMonitorState.exclude.length ? { include: fileMonitorState.include, exclude: fileMonitorState.exclude } : null;
        const folderCfg: MonitorConfig = next.include.length || next.exclude.length ? { include: next.include, exclude: next.exclude } : null;
        setMonitorConfig(mergeMonitorConfigs(fileCfg, folderCfg));
        return next;
      });
    }
    setSelectedPaths(new Set());
    setScopeOpen(false);
  }

  // ── Monitor panel update handler ─────────────────────────────────────────────
  function handleMonitorUpdate(nf: MonitorPanelState, nd: MonitorPanelState, nfsha?: string, ndsha?: string) {
    setFileMonitorState(nf); setFolderMonitorState(nd);
    if (nfsha !== undefined) setFileSidecarSha(nfsha);
    if (ndsha !== undefined) setFolderSidecarSha(ndsha);
    const fc: MonitorConfig = nf.include.length || nf.exclude.length ? { include: nf.include, exclude: nf.exclude } : null;
    const dc: MonitorConfig = nd.include.length || nd.exclude.length ? { include: nd.include, exclude: nd.exclude } : null;
    setMonitorConfig(mergeMonitorConfigs(fc, dc));
  }

  // ── Render annotated JSON ────────────────────────────────────────────────────
  function renderAnnotatedJson(jsonStr: string): React.ReactNode {
    let lines: AnnotatedLine[];
    try {
      const parsed = JSON.parse(jsonStr);
      const pretty = JSON.stringify(parsed, null, 2);
      lines = annotateJsonLines(pretty);
    } catch {
      return (
        <pre style={{ margin: 0, padding: '12px 16px', fontSize: '0.78rem', lineHeight: '1.6', color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace", whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {jsonStr}
        </pre>
      );
    }

    return (
      <div style={{ fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '0.78rem', lineHeight: '1.65', padding: '8px 0' }}>
        {lines.map((a, i) => {
          const hasPath = a.path !== null;
          const ignored  = hasPath && isPathIgnored(a.path, monitorConfig);
          const included = hasPath && isPathIncluded(a.path, monitorConfig);
          const isSelected = hasPath && selectedPaths.has(a.path!);
          const isAncestorSelected = hasPath && !isSelected && (() => {
            const parts = a.path!.split('.');
            return parts.some((_, idx) => idx > 0 && selectedPaths.has(parts.slice(0, idx).join('.')));
          })();

          let bg = 'transparent', borderColor = 'transparent', textColor = '#d4d4d8';
          if (ignored) { textColor = '#3f3f46'; }
          else if (included) { textColor = '#86efac'; borderColor = 'rgba(34,197,94,0.2)'; }
          if (isSelected) { bg = 'rgba(167,139,250,0.12)'; borderColor = '#a78bfa'; textColor = '#c4b5fd'; }
          else if (isAncestorSelected) { bg = 'rgba(167,139,250,0.05)'; borderColor = 'rgba(167,139,250,0.3)'; }

          return (
            <div key={i} title={a.path ?? undefined}
              onClick={hasPath && !ignored ? () => handleLineClick(a.path!) : undefined}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 16px', background: bg, borderLeft: `2px solid ${borderColor}`, cursor: (hasPath && !ignored) ? 'pointer' : 'default', userSelect: 'text', transition: 'background 0.08s' }}
              onMouseEnter={e => { if (hasPath && !isSelected && !isAncestorSelected && !ignored) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { if (hasPath && !isSelected && !isAncestorSelected) (e.currentTarget as HTMLElement).style.background = ignored ? 'transparent' : bg; }}>
              <pre style={{ margin: 0, padding: 0, border: 'none', background: 'transparent', color: textColor, fontStyle: ignored ? 'italic' : 'normal', whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1 }}>
                {a.line}
              </pre>
              {hasPath && (isSelected || included) && (
                <span style={{ fontSize: '0.6rem', color: isSelected ? '#a78bfa' : '#52525b', flexShrink: 0, fontFamily: 'inherit' }}>{a.path}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Tree node renderer ───────────────────────────────────────────────────────
  function renderNode(node: TreeNode, depth = 0): React.ReactNode {
    if (isSidecar(node.name)) return null;
    if (node.type === 'dir') {
      const open = expandedDirs.has(node.path);
      return (
        <div key={node.path}>
          <div onClick={() => toggleDir(node.path)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `5px 12px 5px ${12 + depth * 14}px`, cursor: 'pointer', color: '#71717a', fontSize: '0.8125rem' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
            <span style={{ fontSize: '0.7rem', opacity: 0.5, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
            <span>📁</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          </div>
          {open && <div>{node.children.map(c => renderNode(c, depth + 1))}</div>}
        </div>
      );
    }
    const active = selectedPath === node.path;
    const isRemoveEntry = tab === 'remove';
    return (
      <div key={node.path} onClick={() => loadFile(node.path)} style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: `6px 12px 6px ${12 + depth * 14}px`,
        cursor: 'pointer', fontSize: '0.8125rem',
        background: active ? (isRemoveEntry ? 'rgba(248,113,113,0.08)' : 'rgba(34,197,94,0.08)') : 'transparent',
        color: active ? (isRemoveEntry ? '#f87171' : '#22c55e') : '#a1a1aa',
        borderLeft: active ? `2px solid ${isRemoveEntry ? '#f87171' : '#22c55e'}` : '2px solid transparent',
      }}
      onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = '#18181b'; (e.currentTarget as HTMLElement).style.color = '#e4e4e7'; } }}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#a1a1aa'; } }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: isRemoveEntry ? '#f87171' : '#22c55e', flexShrink: 0, opacity: active ? 1 : 0.3 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.78rem' }}>{node.name}</span>
      </div>
    );
  }

  const isFileTab = tab === 'deploy' || tab === 'remove';
  const isDeployJson = tab === 'deploy' && selectedPath?.endsWith('.json') && !isSidecar(selectedPath?.split('/').at(-1) ?? '');
  const minimalPaths   = getMinimalPaths(selectedPaths);
  const selectionCount = minimalPaths.length;
  const hasSelection   = selectionCount > 0;
  const hasMonitorSidecar = fileMonitorState.include.length + fileMonitorState.exclude.length + folderMonitorState.include.length + folderMonitorState.exclude.length > 0;

  return (
    <div style={{ display: 'flex', height: '100%', background: '#09090b', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>

      {/* ── Left: tabs + tree ─────────────────────────────── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #27272a', background: '#0f0f11' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
          {([
            { id: 'deploy',  label: 'Deploy',  count: deployTree.length,  activeColor: '#22c55e' },
            { id: 'remove',  label: 'Remove',  count: removeTree.length,  activeColor: '#f59e0b' },
            { id: 'groups',  label: 'Groups',  count: Object.keys(groupsConfig).length || null, activeColor: '#a78bfa' },
          ] as const).map(t => (
            <button key={t.id} onClick={() => switchTab(t.id as TabId)}
              style={{ flex: 1, padding: '10px 8px', fontSize: '0.72rem', fontWeight: 600, textAlign: 'center', cursor: 'pointer', background: 'transparent', border: 'none', borderBottom: `2px solid ${tab === t.id ? t.activeColor : 'transparent'}`, color: tab === t.id ? t.activeColor : '#52525b', transition: 'color 0.12s, border-color 0.12s', fontFamily: 'inherit' }}>
              {t.label}
              {t.count !== null && (
                <span style={{ display: 'inline-block', marginLeft: 5, fontSize: '0.65rem', fontWeight: 600, padding: '1px 5px', borderRadius: 10, background: tab === t.id ? `${t.activeColor}22` : '#27272a', color: tab === t.id ? t.activeColor : '#71717a' }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tree */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {isFileTab && (
            activeNodes.length === 0
              ? <div style={{ padding: '40px 16px', textAlign: 'center', color: '#52525b', fontSize: '0.8125rem' }}>
                  {tab === 'remove' ? 'No items staged for removal' : 'Baseline is empty'}
                </div>
              : activeNodes.map(n => renderNode(n))
          )}

          {tab === 'groups' && (
            <div style={{ padding: '8px 0' }}>
              <button onClick={() => setShowNewGroup(v => !v)} style={{ display: 'block', width: 'calc(100% - 24px)', margin: '0 12px 8px', padding: '7px 12px', fontSize: '0.78rem', fontWeight: 600, background: 'transparent', border: '1px dashed #3f3f46', borderRadius: 6, cursor: 'pointer', color: '#a78bfa', fontFamily: 'inherit', textAlign: 'left' }}>
                + New Group
              </button>
              {showNewGroup && (
                <div style={{ padding: '0 12px 10px', display: 'flex', gap: 6 }}>
                  <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') createGroup(newGroupName); if (e.key === 'Escape') setShowNewGroup(false); }} placeholder="Group name…" autoFocus
                    style={{ flex: 1, background: '#18181b', border: '1px solid #3f3f46', color: '#d4d4d8', borderRadius: 5, padding: '5px 8px', fontSize: '0.78rem', outline: 'none', fontFamily: 'inherit' }} />
                  <button onClick={() => createGroup(newGroupName)} style={{ padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, background: '#a78bfa', color: '#000', border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
                </div>
              )}
              {groupsLoading && <div style={{ padding: '20px 12px', color: '#52525b', fontSize: '0.8rem' }}>Loading…</div>}
              {!groupsLoading && Object.keys(groupsConfig).length === 0 && (
                <div style={{ padding: '20px 12px', color: '#52525b', fontSize: '0.78rem' }}>No groups defined yet</div>
              )}
              {Object.keys(groupsConfig).sort().map(name => {
                const active = selectedGroup === name;
                const dynCount = groupsConfig[name]?.membership?.dynamic?.length ?? 0;
                return (
                  <div key={name} onClick={() => selectGroup(name)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', cursor: 'pointer', fontSize: '0.8rem', background: active ? 'rgba(167,139,250,0.1)' : 'transparent', color: active ? '#a78bfa' : '#a1a1aa', borderLeft: `2px solid ${active ? '#a78bfa' : 'transparent'}` }}>
                    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                      <circle cx="7" cy="6" r="3"/><circle cx="14" cy="6" r="3"/>
                      <path d="M1 17c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6"/>
                    </svg>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    <span style={{ fontSize: '0.62rem', color: '#52525b', flexShrink: 0 }}>{dynCount === 0 ? 'direct' : `${dynCount} rule${dynCount === 1 ? '' : 's'}`}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: editor ─────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <input ref={zipInputRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) importZip(f); }} />

        {/* Toolbar */}
        {isFileTab && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: showImport ? 'none' : '1px solid #27272a', flexShrink: 0, flexWrap: 'wrap', minHeight: 44 }}>
              {selectedPath ? (
                <code style={{ fontSize: '0.78rem', color: '#a1a1aa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPath}</code>
              ) : (
                <span style={{ color: '#52525b', fontSize: '0.8rem', flex: 1 }}>Select a file to view and edit</span>
              )}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                {/* Field selection: Clear + scope dropdown */}
                {hasSelection && isDeployJson && (
                  <>
                    <button onClick={() => { setSelectedPaths(new Set()); setScopeOpen(false); }}
                      style={{ padding: '5px 10px', fontSize: '0.75rem', background: '#18181b', border: '1px solid #27272a', color: '#71717a', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>× Clear</button>
                    <div style={{ position: 'relative' }}>
                      <button onClick={() => setScopeOpen(o => !o)}
                        style={{ padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5 }}>
                        Apply to {selectionCount} field{selectionCount !== 1 ? 's' : ''} ▾
                      </button>
                      {scopeDropdownOpen && (
                        <>
                          <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setScopeOpen(false)} />
                          <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 10, background: '#18181b', border: '1px solid #27272a', borderRadius: 6, minWidth: 260, boxShadow: '0 4px 20px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
                            <div style={{ padding: '4px 0' }}>
                              <div style={{ padding: '4px 12px 2px', fontSize: '0.6rem', fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>This file</div>
                              {([
                                { label: '✓ Monitor selected fields', sub: 'include (file)', color: '#e4e4e7', fn: () => applyToMonitor('include', 'file') },
                                { label: '✕ Ignore selected fields',  sub: 'exclude (file)', color: '#fca5a5', fn: () => applyToMonitor('exclude', 'file') },
                              ] as const).map((item, i) => (
                                <button key={i} onClick={item.fn}
                                  style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', color: item.color, fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', display: 'block' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#27272a'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                                  {item.label}
                                  <span style={{ display: 'block', fontSize: '0.7rem', color: '#52525b', marginTop: 1 }}>{item.sub}: {selectionCount} path{selectionCount !== 1 ? 's' : ''}</span>
                                </button>
                              ))}
                              <div style={{ height: 1, background: '#27272a', margin: '4px 0' }} />
                              <div style={{ padding: '4px 12px 2px', fontSize: '0.6rem', fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Entire folder</div>
                              {([
                                { label: '✓ Monitor selected fields', sub: 'include (folder)', color: '#e4e4e7', fn: () => applyToMonitor('include', 'folder') },
                                { label: '✕ Ignore selected fields',  sub: 'exclude (folder)', color: '#fca5a5', fn: () => applyToMonitor('exclude', 'folder') },
                              ] as const).map((item, i) => (
                                <button key={i} onClick={item.fn}
                                  style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', color: item.color, fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', display: 'block' }}
                                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#27272a'; }}
                                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                                  {item.label}
                                  <span style={{ display: 'block', fontSize: '0.7rem', color: '#52525b', marginTop: 1 }}>{item.sub}: {selectionCount} path{selectionCount !== 1 ? 's' : ''}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}

                {tab === 'deploy' && (
                  <button onClick={() => setShowImport(v => !v)} style={{ padding: '5px 12px', fontSize: '0.75rem', fontWeight: 600, background: showImport ? '#27272a' : 'transparent', border: '1px solid #3f3f46', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', color: '#a1a1aa', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.5.5 0 0 1 .5.5v6.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 .708-.708L7.5 8.293V1.5A.5.5 0 0 1 8 1zM2 14a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 14z"/></svg>
                    Import ZIP
                  </button>
                )}

                {/* View/Edit toggle — only for deploy JSON files */}
                {isDeployJson && !loading && content && (
                  <button onClick={() => { setEditMode(m => !m); setSelectedPaths(new Set()); setScopeOpen(false); }}
                    style={{ padding: '5px 10px', fontSize: '0.75rem', background: isEditMode ? 'rgba(234,179,8,0.1)' : '#18181b', border: `1px solid ${isEditMode ? 'rgba(234,179,8,0.3)' : '#27272a'}`, color: isEditMode ? '#fbbf24' : '#71717a', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {isEditMode ? '◁ View' : '✎ Edit'}
                  </button>
                )}

                {selectedPath && !loading && isEditMode && (
                  <button onClick={saveFile} disabled={saving} style={{ padding: '5px 16px', fontSize: '0.78rem', fontWeight: 600, background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>
                    {saving ? 'Saving…' : '💾 Save'}
                  </button>
                )}

                {selectedPath && sha && !loading && tab === 'deploy' && toRemovePath(selectedPath) && (
                  <button onClick={() => setFileActionConfirm(a => a === 'tenants' ? null : 'tenants')} disabled={fileActionBusy}
                    style={{ padding: '5px 10px', fontSize: '0.75rem', background: fileActionConfirm === 'tenants' ? 'rgba(245,158,11,0.12)' : 'transparent', border: '1px solid #92400e', borderRadius: 5, cursor: fileActionBusy ? 'not-allowed' : 'pointer', color: '#fbbf24', fontFamily: 'inherit', opacity: fileActionBusy ? 0.6 : 1 }}>
                    Remove from tenants
                  </button>
                )}

                {selectedPath && sha && !loading && (
                  <button onClick={() => setFileActionConfirm(a => a === 'git' ? null : 'git')} disabled={fileActionBusy}
                    style={{ padding: '5px 10px', fontSize: '0.75rem', background: fileActionConfirm === 'git' ? 'rgba(239,68,68,0.12)' : 'transparent', border: '1px solid #7f1d1d', borderRadius: 5, cursor: fileActionBusy ? 'not-allowed' : 'pointer', color: '#f87171', fontFamily: 'inherit', opacity: fileActionBusy ? 0.6 : 1 }}>
                    Remove from Git
                  </button>
                )}
              </div>
            </div>

            {fileActionConfirm === 'tenants' && selectedPath && sha && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid #27272a', background: 'rgba(245,158,11,0.06)', flexShrink: 0 }}>
                <p style={{ fontSize: '0.8rem', color: '#fcd34d', marginBottom: 8 }}>
                  Move <code style={{ fontSize: '0.75rem' }}>{selectedPath}</code> to{' '}
                  <code style={{ fontSize: '0.75rem' }}>{toRemovePath(selectedPath)}</code>?
                  <span style={{ display: 'block', marginTop: 4, fontSize: '0.72rem', color: '#a8a29e' }}>
                    The deploy copy is removed from baseline. On the next tenant deploy with <strong>Allow DELETE</strong>, matching resources are removed from Intune / Entra.
                  </span>
                  {selectedPath.endsWith('.json') && !isSidecar(selectedPath.split('/').at(-1) ?? '') && (
                    <span style={{ display: 'block', marginTop: 4, fontSize: '0.72rem', color: '#a8a29e' }}>
                      Any monitor sidecar for this file is also removed.
                    </span>
                  )}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={removeFromTenants} disabled={fileActionBusy} style={{ padding: '5px 14px', fontSize: '0.75rem', fontWeight: 600, background: '#d97706', color: '#000', border: 'none', borderRadius: 5, cursor: fileActionBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: fileActionBusy ? 0.7 : 1 }}>
                    {fileActionBusy ? 'Staging…' : 'Confirm'}
                  </button>
                  <button onClick={() => setFileActionConfirm(null)} disabled={fileActionBusy} style={{ padding: '5px 14px', fontSize: '0.75rem', background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                </div>
              </div>
            )}

            {fileActionConfirm === 'git' && selectedPath && sha && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid #27272a', background: 'rgba(239,68,68,0.06)', flexShrink: 0 }}>
                <p style={{ fontSize: '0.8rem', color: '#fca5a5', marginBottom: 8 }}>
                  Permanently remove <code style={{ fontSize: '0.75rem' }}>{selectedPath}</code> from Git?
                  {tab === 'deploy' && selectedPath.endsWith('.json') && !isSidecar(selectedPath.split('/').at(-1) ?? '') && (
                    <span style={{ display: 'block', marginTop: 4, fontSize: '0.72rem', color: '#f87171' }}>
                      The monitor sidecar will also be removed if present. Tenants are not affected unless you use Remove from tenants first.
                    </span>
                  )}
                  {tab === 'remove' && (
                    <span style={{ display: 'block', marginTop: 4, fontSize: '0.72rem', color: '#71717a' }}>
                      This cancels the staged removal — the file will no longer be deleted from tenants on deploy.
                    </span>
                  )}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={removeFromGit} disabled={fileActionBusy} style={{ padding: '5px 14px', fontSize: '0.75rem', fontWeight: 600, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 5, cursor: fileActionBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: fileActionBusy ? 0.7 : 1 }}>
                    {fileActionBusy ? 'Removing…' : 'Confirm'}
                  </button>
                  <button onClick={() => setFileActionConfirm(null)} disabled={fileActionBusy} style={{ padding: '5px 14px', fontSize: '0.75rem', background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Import ZIP panel */}
            {showImport && tab === 'deploy' && (
              <div style={{ padding: '10px 16px', borderBottom: '1px solid #27272a', background: '#0c0c0e', flexShrink: 0 }}>
                <div style={{ fontSize: '0.78rem', color: '#71717a', marginBottom: 8 }}>
                  Upload a <code>.zip</code> of JSON files. The ZIP is unpacked in your browser, then sent as JSON (with progress). Path prefix is optional — baseline repo layout (<code>baseline/</code>, <code>baseline-remove/</code>, double-wrapped exports) is detected automatically.
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <label style={{ fontSize: '0.75rem', color: '#71717a', whiteSpace: 'nowrap' }}>Path prefix:</label>
                    <input value={importPath} onChange={e => setImportPath(e.target.value)} placeholder="Optional — auto-detects baseline/ layout"
                      disabled={importing}
                      style={{ background: '#18181b', border: '1px solid #3f3f46', color: '#d4d4d8', borderRadius: 5, padding: '5px 10px', fontSize: '0.75rem', fontFamily: 'monospace', width: 300, outline: 'none', opacity: importing ? 0.6 : 1 }} />
                  </div>
                  <button onClick={() => zipInputRef.current?.click()} disabled={importing}
                    style={{ padding: '5px 16px', fontSize: '0.78rem', fontWeight: 600, background: importing ? '#27272a' : '#3f3f46', color: '#d4d4d8', border: '1px solid #52525b', borderRadius: 6, cursor: importing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {importing ? <><div style={{ width: 10, height: 10, border: '2px solid #52525b', borderTopColor: '#d4d4d8', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Importing…</> : '📦 Choose ZIP file…'}
                  </button>
                  {importing && (
                    <button onClick={cancelImport} style={{ padding: '5px 12px', fontSize: '0.75rem', background: 'transparent', border: '1px solid #52525b', color: '#a1a1aa', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Cancel
                    </button>
                  )}
                </div>
                {importing && importPhase && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>
                      <span>
                        {importPhase === 'reading' && 'Reading ZIP…'}
                        {importPhase === 'uploading' && (importFileCount > 0 ? `Uploading ${importUploaded}/${importFileCount} files…` : 'Uploading…')}
                        {importPhase === 'committing' && 'Committing to Gitea…'}
                      </span>
                      <span>{importPhase === 'reading' ? '…' : `${importProgress}%`}</span>
                    </div>
                    <div style={{ height: 4, background: '#27272a', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: importPhase === 'reading' ? '30%' : `${Math.max(importProgress, importPhase === 'committing' ? 100 : 0)}%`,
                        background: '#a78bfa',
                        borderRadius: 2,
                        transition: 'width 0.2s ease',
                        animation: importPhase === 'reading' ? 'pulse 1.2s ease-in-out infinite' : undefined,
                      }} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Field selection hint */}
            {isDeployJson && !loading && content && !isEditMode && (
              hasSelection ? (
                <div style={{ padding: '3px 16px', flexShrink: 0, fontSize: '0.7rem', color: '#a78bfa' }}>
                  {selectionCount} field{selectionCount !== 1 ? 's' : ''} selected — use &quot;Apply to {selectionCount} field{selectionCount !== 1 ? 's' : ''} ▾&quot; to add to monitor config
                </div>
              ) : (
                <div style={{ padding: '3px 16px', flexShrink: 0, fontSize: '0.7rem', color: '#3f3f46' }}>
                  Click JSON fields to select them for monitor config{hasMonitorSidecar ? ' · sidecar active' : ''}
                </div>
              )
            )}
          </>
        )}

        {tab === 'groups' && selectedGroup && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
            <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: '0.875rem' }}>{selectedGroup}</span>
            <span style={{ color: '#52525b', fontSize: '0.68rem' }}>config group</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setShowDeleteConfirm(v => !v)} style={{ padding: '4px 10px', fontSize: '0.72rem', background: 'transparent', border: '1px solid #7f1d1d', borderRadius: 5, cursor: 'pointer', color: '#f87171', fontFamily: 'inherit' }}>Delete</button>
            <button onClick={() => saveGroup(selectedGroup, groupEditor)} disabled={groupSaving} style={{ padding: '4px 14px', fontSize: '0.72rem', fontWeight: 600, background: '#22c55e', color: '#000', border: 'none', borderRadius: 5, cursor: groupSaving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: groupSaving ? 0.6 : 1 }}>{groupSaving ? 'Saving…' : 'Save'}</button>
          </div>
        )}

        {/* Messages */}
        {(error || success) && (
          <div style={{ padding: '6px 16px', flexShrink: 0 }}>
            {error   && <div style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{error}</div>}
            {success && <div style={{ color: '#86efac', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{success}</div>}
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {isFileTab && (
            <>
              {!selectedPath && (
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
                  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <ellipse cx="20" cy="10" rx="15" ry="5"/>
                    <path d="M5 10v10c0 2.8 6.7 5 15 5s15-2.2 15-5V10"/>
                    <path d="M5 20v10c0 2.8 6.7 5 15 5s15-2.2 15-5V20"/>
                  </svg>
                  <p style={{ fontSize: '0.875rem' }}>Select a file from the tree to view and edit</p>
                </div>
              )}
              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: '#71717a' }}>
                  <div style={{ width: 14, height: 14, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  Loading…
                </div>
              )}

              {/* Deploy tab: annotated JSON view with monitor panel (or edit textarea) */}
              {selectedPath && !loading && isDeployJson && !isEditMode && (
                <>
                  {/* Monitor panel at top of scroll area — matches legacy design */}
                  <BMonitorPanel
                    filePath={selectedPath}
                    mspSlug={mspSlug}
                    fileState={fileMonitorState}
                    folderState={folderMonitorState}
                    fileSha={fileSidecarSha}
                    folderSha={folderSidecarSha}
                    onUpdate={handleMonitorUpdate}
                  />
                  {content ? renderAnnotatedJson(content) : <div style={{ padding: 24, color: '#52525b', fontSize: '0.8125rem' }}>File is empty</div>}
                </>
              )}

              {/* Edit mode textarea */}
              {selectedPath && !loading && isEditMode && (
                <textarea value={content} onChange={e => setContent(e.target.value)}
                  style={{ width: '100%', height: '100%', background: 'transparent', border: 'none', color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '0.78rem', lineHeight: '1.6', padding: '12px 16px', resize: 'none', outline: 'none', boxSizing: 'border-box' }} />
              )}

              {/* Non-JSON files or remove tab: always use textarea (read-only for remove) */}
              {selectedPath && !loading && !isDeployJson && content && (
                <textarea value={content} onChange={tab === 'deploy' ? e => setContent(e.target.value) : undefined} readOnly={tab === 'remove'}
                  style={{ width: '100%', height: '100%', background: 'transparent', border: 'none', color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '0.78rem', lineHeight: '1.6', padding: '12px 16px', resize: 'none', outline: 'none', boxSizing: 'border-box' }} />
              )}
            </>
          )}

          {tab === 'groups' && (
            <>
              {!selectedGroup && (
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
                  <svg width="36" height="36" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <circle cx="7" cy="6" r="3"/><circle cx="14" cy="6" r="3"/>
                    <path d="M1 17c0-3.3 2.7-6 6-6h6c3.3 0 6 2.7 6 6"/>
                  </svg>
                  <p style={{ fontSize: '0.875rem' }}>Select a group from the left panel to edit it</p>
                </div>
              )}
              {selectedGroup && (
                <div style={{ overflowY: 'auto', height: '100%', padding: '0 0 40px' }}>
                  {showDeleteConfirm && (
                    <div style={{ margin: '12px 16px', padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6 }}>
                      <p style={{ fontSize: '0.8rem', color: '#fca5a5', marginBottom: 8 }}>Delete group <strong>{selectedGroup}</strong>? This removes it from <code>groups-config.json</code>.</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => deleteGroup(selectedGroup)} disabled={groupSaving} style={{ padding: '5px 14px', fontSize: '0.75rem', fontWeight: 600, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>Confirm Delete</button>
                        <button onClick={() => setShowDeleteConfirm(false)} style={{ padding: '5px 14px', fontSize: '0.75rem', background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                      </div>
                    </div>
                  )}

                  <div style={{ padding: '8px 16px 4px', fontSize: '0.72rem', color: '#52525b', lineHeight: 1.6 }}>
                    Tenants that are <strong style={{ color: '#d4d4d8' }}>members</strong> of this group have the content below included in their deployment.
                  </div>

                  <GroupSection title="Membership — Direct Members">
                    <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginBottom: 8 }}>Use <strong style={{ color: '#d4d4d8' }}>Sync to tenant repos</strong> to propagate changes.</div>
                    <TagList tags={groupEditor.membership?.direct ?? []} onRemove={t => editorRemoveDirect(t)} emptyText="No direct members" />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <AddInput placeholder="Search tenants…" datalist={tenants.map(t => t.slug)} onAdd={v => editorAddDirect(v)} />
                    </div>
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={() => syncGroup(selectedGroup)} disabled={groupSyncing} style={{ padding: '4px 12px', fontSize: '0.72rem', fontWeight: 600, background: '#1e3a2f', border: '1px solid #166534', color: '#4ade80', borderRadius: 5, cursor: groupSyncing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: groupSyncing ? 0.7 : 1 }}>
                        {groupSyncing ? 'Syncing…' : 'Sync to tenant repos'}
                      </button>
                      {groupSyncStatus && <span style={{ fontSize: '0.68rem', color: groupSyncStatus.includes('error') ? '#f87171' : '#4ade80' }}>{groupSyncStatus}</span>}
                    </div>
                  </GroupSection>

                  <GroupSection title="Membership — Dynamic Rules">
                    <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginBottom: 8 }}>Tenants that satisfy <em>any</em> rule are automatically included at deploy time.</div>
                    {(groupEditor.membership?.dynamic ?? []).map((rule, idx) => (
                      <div key={idx} style={{ border: '1px solid #27272a', borderRadius: 5, padding: '8px 10px', marginBottom: 6, background: '#1a1a1a' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: '0.68rem', color: '#a78bfa', fontWeight: 600, letterSpacing: '0.04em' }}>LICENSE MATCH</span>
                          <button onClick={() => editorRemoveLicenseRule(idx)} style={{ background: 'none', border: 'none', color: '#52525b', fontSize: '0.72rem', cursor: 'pointer', padding: 0 }}>✕ remove</button>
                        </div>
                        <div style={{ fontSize: '0.68rem', color: '#52525b', marginBottom: 6 }}>Tenant qualifies if it holds any of these SKU part numbers:</div>
                        <TagList tags={rule.skuPartNumbers} onRemove={sku => editorRemoveSku(idx, sku)} mono emptyText="No SKUs yet" />
                        <div style={{ marginTop: 6 }}><AddInput placeholder="e.g. SPE_E3" onAdd={sku => editorAddSku(idx, sku)} mono /></div>
                      </div>
                    ))}
                    <button onClick={editorAddLicenseRule} style={{ marginTop: 6, padding: '4px 12px', fontSize: '0.72rem', background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>+ Add license rule</button>
                  </GroupSection>

                  <GroupSection title="Excluded for non-members — Baseline Folders">
                    <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginBottom: 8 }}>These folders are only deployed to member tenants.</div>
                    <TagList tags={groupEditor.content?.folders ?? []} onRemove={v => editorRemoveFromList('folders', v)} emptyText="No folders assigned" />
                    <div style={{ marginTop: 6 }}><AddInput placeholder="e.g. msp-scripts" onAdd={v => editorAddToList('folders', v)} /></div>
                  </GroupSection>

                  <GroupSection title="Excluded for non-members — File Patterns">
                    <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginBottom: 8 }}>Glob patterns matched against baseline file paths.</div>
                    <TagList tags={groupEditor.content?.filePatterns ?? []} onRemove={v => editorRemoveFromList('filePatterns', v)} mono emptyText="No file patterns" />
                    <div style={{ marginTop: 6 }}><AddInput placeholder="e.g. **/*.MSP.json" mono onAdd={v => editorAddToList('filePatterns', v)} /></div>
                  </GroupSection>

                  <GroupSection title="Manual file assignments">
                    <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginBottom: 8 }}>Individual baseline files included for members regardless of patterns.</div>
                    <TagList tags={groupEditor.content?.files ?? []} onRemove={v => editorRemoveFromList('files', v)} mono emptyText="No files assigned" />
                    <div style={{ marginTop: 6 }}><AddInput placeholder="e.g. conditional-access/policies/Foo.json" mono onAdd={v => editorAddToList('files', v)} /></div>
                  </GroupSection>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
