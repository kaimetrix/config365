'use client';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { TreeEntry } from '@/lib/server/gitea';
import type { Tenant } from '@/lib/server/tenant-store';
import { sortKeysDeep, stripMetadataFields, normalizeZeroLike, stripNullAndEmpty, normalizeFieldTypes } from '@/lib/normalize-for-compare';
import {
  type MonitorConfig,
  getSidecarPath,
  getFolderSidecarPath,
  isPathIgnored,
  isPathIncluded,
  mergeMonitorConfigs,
  applyFieldFilter,
} from '@/lib/monitor-config';
import {
  AUDIT_STATUS_PATH,
  ORG_AUDIT_DISABLED_PATH,
  REMEDIATION_PATH,
  computeMailboxAuditDrift,
  isOrgAuditRemediationEnabled,
  parseJsonContent,
} from '@/lib/mailbox-audit-drift';

interface Props {
  mspSlug: string;
  tenants: Tenant[];
  tree: TreeEntry[];
  baselinePaths?: string[];
  selectedTenantSlug?: string;
  scope: string;
  giteaOrg: string;
  repo: string;
}

type ViewerTreeEntry = TreeEntry & { baselineOnly?: boolean };

/* ── JSON normalization (for drift comparison) ────────────── */

/**
 * Full normalization for per-file drift detection:
 *   1. Strip metadata fields from the shared JSON config (id, timestamps, @odata.*, etc.)
 *   2. Apply monitor-sidecar include/exclude filter
 *   3. Sort keys for stable string comparison
 *
 * filePath (backup-root-relative, e.g. "intune/device-configurations/foo.json") is used
 * to pick the correct per-policy-type field exclusion list from normalize-for-compare.ts.
 */
function normalizeForCompare(rawStr: string, config: MonitorConfig, filePath?: string): string {
  try {
    const jsonStr  = rawStr.replace(/^\uFEFF/, ''); // strip UTF-8 BOM
    const parsed   = JSON.parse(jsonStr);
    const stripped = stripMetadataFields(parsed, filePath);
    const typed    = normalizeFieldTypes(stripped);
    const zeroed   = normalizeZeroLike(typed);
    const cleaned  = stripNullAndEmpty(zeroed);
    const filtered = config ? applyFieldFilter(cleaned, config) : cleaned;
    return JSON.stringify(sortKeysDeep(filtered));
  } catch {
    return rawStr;
  }
}

/* ── JSON line annotation ────────────────────────────────── */

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
      if (!skippedRoot && skipNextBracket) {
        skippedRoot = true;
        skipFirstElement = true;
      } else {
        stack.pop();
      }
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

/** Drops child paths whose parent is already in the set. */
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

/* ── File classification ────────────────────────────────── */

function classifyService(path: string): string {
  const p = path.toLowerCase();
  if (p.includes('conditional-access') || p.includes('entra') || p.includes('azure-ad')) return 'entra';
  if (p.includes('sharepoint') || p.includes('onedrive')) return 'sharepoint';
  if (p.includes('intune') || p.includes('compliance') || p.includes('configuration') || p.includes('app-protection') || p.includes('admx') || p.includes('endpoint')) return 'intune';
  if (p.includes('defender') || p.includes('atp')) return 'defender';
  if (p.includes('exchange') || p.includes('exo') || p.includes('mail')) return 'exchange';
  if (p.includes('information-protection') || p.includes('purview') || p.includes('sensitivity-label')) return 'purview';
  return 'other';
}

const SVC_COLORS: Record<string, string> = {
  entra: '#60a5fa', intune: '#a78bfa', defender: '#f87171', exchange: '#fbbf24', purview: '#34d399', sharepoint: '#10b981', other: '#71717a',
};

const FILE_PANEL_WIDTH_KEY = 'config365-viewer-file-panel-width';
const FILE_PANEL_MIN_WIDTH = 220;
const FILE_PANEL_MAX_WIDTH = 720;
const FILE_PANEL_DEFAULT_WIDTH = 360;

function readStoredFilePanelWidth(): number {
  if (typeof window === 'undefined') return FILE_PANEL_DEFAULT_WIDTH;
  const stored = Number.parseInt(localStorage.getItem(FILE_PANEL_WIDTH_KEY) ?? '', 10);
  if (!Number.isFinite(stored)) return FILE_PANEL_DEFAULT_WIDTH;
  return Math.min(FILE_PANEL_MAX_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, stored));
}

const CONTENT_SEARCH_DEBOUNCE_MS = 350;
const CONTENT_SEARCH_BATCH = 10;
const CONTENT_SEARCHABLE_FILE = /\.(json|ps1|sh)$/i;

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function pathMatchesFilename(path: string, name: string, query: string): boolean {
  if (!query) return true;
  return path.toLowerCase().includes(query) || name.toLowerCase().includes(query);
}

function keepTreeEntriesForFilePaths(entries: ViewerTreeEntry[], filePaths: Set<string>): ViewerTreeEntry[] {
  if (filePaths.size === 0) return [];
  const keepPaths = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      keepPaths.add(parts.slice(0, i).join('/'));
    }
  }
  return entries.filter(e => keepPaths.has(e.path));
}

function collectAncestorDirPaths(filePaths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return [...dirs];
}

/* ── Tree builder ────────────────────────────────────────── */

type TreeNode = { name: string; path: string; type: 'file' | 'dir'; children: TreeNode[]; baselineOnly?: boolean };

function buildTree(entries: ViewerTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs: Record<string, TreeNode> = {};

  function ensureDir(parts: string[], upTo: number): TreeNode[] {
    if (upTo === 0) return root;
    const dirPath = parts.slice(0, upTo).join('/');
    if (!dirs[dirPath]) {
      const parent = ensureDir(parts, upTo - 1);
      const node: TreeNode = { name: parts[upTo - 1], path: dirPath, type: 'dir', children: [] };
      dirs[dirPath] = node;
      parent.push(node);
    }
    return dirs[dirPath].children;
  }

  for (const e of entries) {
    const parts = e.path.split('/');
    const parent = ensureDir(parts, parts.length - 1);
    parent.push({
      name: parts.at(-1) ?? e.path,
      path: e.path,
      type: e.type,
      children: [],
      baselineOnly: e.baselineOnly,
    });
  }

  function sort(nodes: TreeNode[]): TreeNode[] {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children.length) sort(n.children);
    return nodes;
  }
  return sort(root);
}

/* ── Diff renderer ───────────────────────────────────────── */

function renderDiff(before: string, after: string): React.ReactNode[] {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const m = bLines.length;
  const n = aLines.length;

  type Op = { b: string; a: string; same: boolean };
  const ops: Op[] = [];

  if (m * n <= 400_000) {
    // LCS diff — aligns matching lines so an extra/missing line on one side
    // doesn't cascade and make every subsequent line appear different.
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = bLines[i - 1] === aLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    let i = m, j = n;
    const raw: Op[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && bLines[i - 1] === aLines[j - 1]) {
        raw.push({ b: bLines[i - 1], a: aLines[j - 1], same: true });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        raw.push({ b: '', a: aLines[j - 1], same: false });
        j--;
      } else {
        raw.push({ b: bLines[i - 1], a: '', same: false });
        i--;
      }
    }
    ops.push(...raw.reverse());
  } else {
    // Positional fallback for very large files
    const max = Math.max(m, n);
    for (let i = 0; i < max; i++) {
      const b = bLines[i] ?? '';
      const a = aLines[i] ?? '';
      ops.push({ b, a, same: b === a });
    }
  }

  return ops.map(({ b, a, same }, i) => (
    <tr key={i} style={{ background: same ? 'transparent' : 'rgba(234,179,8,0.05)' }}>
      <td style={{ width: '50%', padding: '1px 10px', borderRight: '1px solid #27272a', color: same ? '#71717a' : (b ? '#fca5a5' : '#3f3f46'), whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.75rem', fontFamily: 'monospace' }}>{b || ' '}</td>
      <td style={{ width: '50%', padding: '1px 10px', color: same ? '#71717a' : (a ? '#86efac' : '#3f3f46'), whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.75rem', fontFamily: 'monospace' }}>{a || ' '}</td>
    </tr>
  ));
}

/* ── Monitor Panel component ─────────────────────────────── */

interface MonitorPanelState {
  include: string[];
  exclude: string[];
}

interface MonitorPanelProps {
  filePath: string;
  mspSlug: string;
  fileState: MonitorPanelState;
  folderState: MonitorPanelState;
  fileSha: string | undefined;
  folderSha: string | undefined;
  onUpdate: (fileState: MonitorPanelState, folderState: MonitorPanelState, fileSha?: string, folderSha?: string) => void;
}

function MonitorPanel({ filePath, mspSlug, fileState, folderState, fileSha, folderSha, onUpdate }: MonitorPanelProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<'file' | 'folder' | null>(null);
  const [msg, setMsg] = useState('');

  // Baseline sidecars live under baseline/ just like policy files
  const fileSidecarPath   = `baseline/${getSidecarPath(filePath)}`;
  const folderSidecarPath = `baseline/${getFolderSidecarPath(filePath)}`;

  const summaryParts: string[] = [];
  const fExc = fileState.exclude.length + folderState.exclude.length;
  const fInc = fileState.include.length + folderState.include.length;
  if (fExc > 0) summaryParts.push(`excluding ${fExc} field${fExc !== 1 ? 's' : ''}`);
  if (fInc > 0) summaryParts.push(`monitoring ${fInc} field${fInc !== 1 ? 's' : ''}`);
  const summary = summaryParts.length ? summaryParts.join(' · ') : 'no config';
  const hasAnyConfig = fExc + fInc > 0;

  async function save(scope: 'file' | 'folder') {
    setSaving(scope); setMsg('');
    const st = scope === 'file' ? fileState : folderState;
    const path = scope === 'file' ? fileSidecarPath : folderSidecarPath;
    const currentSha = scope === 'file' ? fileSha : folderSha;
    const cfg: Record<string, string[]> = {};
    if (st.include.length) cfg.include = st.include;
    if (st.exclude.length) cfg.exclude = st.exclude;
    const hasConfig = Object.keys(cfg).length > 0;
    try {
      if (!hasConfig) {
        // Delete sidecar if it exists
        if (currentSha) {
          await fetch('/api/git/file', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, sha: currentSha, scope: 'baseline', mspSlug, message: `portal: clear monitor config for ${path}` }),
          });
          onUpdate(
            scope === 'file' ? fileState : fileState,
            scope === 'folder' ? folderState : folderState,
            scope === 'file' ? undefined : fileSha,
            scope === 'folder' ? undefined : folderSha,
          );
        }
      } else {
        const content = JSON.stringify(cfg, null, 2) + '\n';
        const checkRes = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&scope=baseline&mspSlug=${mspSlug}`);
        const checkData = await checkRes.json();
        const existingSha = checkData.exists ? checkData.sha : undefined;
        const res = await fetch('/api/git/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content, sha: existingSha, scope: 'baseline', mspSlug, message: `portal: update monitor config for ${path}` }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        // Re-fetch sha
        const newCheck = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&scope=baseline&mspSlug=${mspSlug}`);
        const newData  = await newCheck.json();
        onUpdate(
          scope === 'file'   ? fileState   : fileState,
          scope === 'folder' ? folderState : folderState,
          scope === 'file'   ? newData.sha : fileSha,
          scope === 'folder' ? newData.sha : folderSha,
        );
      }
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Error saving');
    } finally {
      setSaving(null);
    }
  }

  function removeTag(scope: 'file' | 'folder', type: 'include' | 'exclude', val: string) {
    if (scope === 'file') {
      onUpdate({ ...fileState, [type]: fileState[type].filter(p => p !== val) }, folderState, fileSha, folderSha);
    } else {
      onUpdate(fileState, { ...folderState, [type]: folderState[type].filter(p => p !== val) }, fileSha, folderSha);
    }
  }

  function clearAll(scope: 'file' | 'folder') {
    if (scope === 'file') {
      onUpdate({ include: [], exclude: [] }, folderState, fileSha, folderSha);
    } else {
      onUpdate(fileState, { include: [], exclude: [] }, fileSha, folderSha);
    }
  }

  function TagList({ paths, type, scope }: { paths: string[]; type: 'include' | 'exclude'; scope: 'file' | 'folder' }) {
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
            <button
              onClick={() => removeTag(scope, type, p)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 1px', fontSize: '0.7rem', lineHeight: 1 }}
            >✕</button>
          </span>
        ))}
      </>
    );
  }

  function Section({ label, pathHint, state, scope }: { label: string; pathHint: string; state: MonitorPanelState; scope: 'file' | 'folder' }) {
    const isEmpty = !state.include.length && !state.exclude.length;
    return (
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e1e21' }}>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#52525b', marginBottom: 6 }}>{label}</div>
        <div style={{ fontSize: '0.6rem', color: '#3f3f46', fontFamily: 'monospace', marginBottom: 8, wordBreak: 'break-all' }}>{pathHint}</div>
        {isEmpty ? (
          <div style={{ fontSize: '0.72rem', color: '#3f3f46', fontStyle: 'italic', marginBottom: 8 }}>No config — click JSON fields above to add</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            {state.include.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', color: '#52525b', fontWeight: 600, width: 52, flexShrink: 0, paddingTop: 2 }}>Include</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <TagList paths={state.include} type="include" scope={scope} />
                </div>
              </div>
            )}
            {state.exclude.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', color: '#52525b', fontWeight: 600, width: 52, flexShrink: 0, paddingTop: 2 }}>Exclude</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <TagList paths={state.exclude} type="exclude" scope={scope} />
                </div>
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => save(scope)} disabled={saving === scope}
            style={{ padding: '4px 10px', fontSize: '0.72rem', background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 4, cursor: saving === scope ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving === scope ? 0.5 : 1 }}
          >
            {saving === scope ? 'Saving…' : 'Save'}
          </button>
          {!isEmpty && (
            <button
              onClick={() => clearAll(scope)}
              style={{ padding: '4px 10px', fontSize: '0.72rem', background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid #27272a', background: '#0c0c0e' }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: '0.65rem', color: '#52525b', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#71717a' }}>Baseline Field Monitoring</span>
        <span style={{ fontSize: '0.65rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 4, padding: '1px 6px', marginLeft: 2 }}>all tenants</span>
        <span style={{
          fontSize: '0.7rem', color: hasAnyConfig ? '#a78bfa' : '#3f3f46',
          background: hasAnyConfig ? 'rgba(167,139,250,0.1)' : 'transparent',
          border: hasAnyConfig ? '1px solid rgba(167,139,250,0.2)' : 'none',
          borderRadius: 4, padding: hasAnyConfig ? '1px 6px' : '0',
          marginLeft: 4,
        }}>
          {summary}
        </span>
        {msg && <span style={{ fontSize: '0.7rem', color: '#86efac', marginLeft: 'auto' }}>{msg}</span>}
      </div>

      {/* Body */}
      {open && (
        <div style={{ borderTop: '1px solid #1e1e21' }}>
          <div style={{ padding: '6px 14px', background: 'rgba(245,158,11,0.06)', borderBottom: '1px solid rgba(245,158,11,0.15)', fontSize: '0.68rem', color: '#f59e0b' }}>
            ⚠ These rules are saved to the <strong>baseline repo</strong> and apply to <strong>all tenants</strong>, not just this one.
          </div>
          <Section
            label="File-level config"
            pathHint={fileSidecarPath}
            state={fileState}
            scope="file"
          />
          <Section
            label="Folder default"
            pathHint={folderSidecarPath}
            state={folderState}
            scope="folder"
          />
        </div>
      )}
    </div>
  );
}

/* ── Component ───────────────────────────────────────────── */

export default function ViewerClient({ mspSlug, tenants, tree, baselinePaths = [], selectedTenantSlug, scope, giteaOrg, repo }: Props) {
  const router = useRouter();
  const [treeLoading, setTreeLoading] = useState(false);
  const pendingNavRef = useRef<{ scope: string; tenant?: string } | null>(null);

  const [selectedFile, setSelectedFile]           = useState<string | null>(null);
  const [content, setContent]                     = useState('');
  const [baselineContent, setBaselineContent]     = useState<string | null>(null);
  const [sha, setSha]                             = useState<string | undefined>();
  const [loading, setLoading]                     = useState(false);
  const [error, setError]                         = useState('');
  const [success, setSuccess]                     = useState('');
  const [copying, setCopying]                     = useState(false);
  const [triggering, setTriggering]               = useState(false);
  const [expandedDirs, setExpandedDirs]           = useState<Set<string>>(new Set());
  const [tenantSearch, setTenantSearch]           = useState('');
  const [showDiff, setShowDiff]                   = useState(false);
  const [selectedPaths, setSelectedPaths]         = useState<Set<string>>(new Set());
  const [scopeDropdownOpen, setScopeDropdownOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(FILE_PANEL_DEFAULT_WIDTH);
  const [filePanelResizing, setFilePanelResizing] = useState(false);
  const filePanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const filePanelWidthRef = useRef(filePanelWidth);

  useEffect(() => {
    setFilePanelWidth(readStoredFilePanelWidth());
  }, []);

  useEffect(() => {
    filePanelWidthRef.current = filePanelWidth;
  }, [filePanelWidth]);

  const startFilePanelResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    filePanelResizeRef.current = { startX: e.clientX, startWidth: filePanelWidthRef.current };
    setFilePanelResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const drag = filePanelResizeRef.current;
      if (!drag) return;
      const next = Math.min(
        FILE_PANEL_MAX_WIDTH,
        Math.max(FILE_PANEL_MIN_WIDTH, drag.startWidth + (e.clientX - drag.startX)),
      );
      setFilePanelWidth(next);
    }

    function onUp() {
      if (!filePanelResizeRef.current) return;
      filePanelResizeRef.current = null;
      setFilePanelResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(FILE_PANEL_WIDTH_KEY, String(filePanelWidthRef.current));
      } catch { /* ignore quota / private mode */ }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Conflicts filter state
  const [diffMap, setDiffMap]       = useState<Map<string, boolean>>(new Map());
  const [fileFilter, setFileFilter] = useState<'all' | 'conflicts'>('all');
  const [preloading, setPreloading] = useState(false);
  const [exporting, setExporting]   = useState(false);

  // File search state
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [searchInContent, setSearchInContent] = useState(false);
  const [contentMatchPaths, setContentMatchPaths] = useState<Set<string>>(new Set());
  const [contentSearchLoading, setContentSearchLoading] = useState(false);
  const [contentSearchProgress, setContentSearchProgress] = useState({ done: 0, total: 0 });
  const contentSearchGenRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(fileSearchQuery), CONTENT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fileSearchQuery]);

  // Script tab state (platform scripts only)
  const [activeTab, setActiveTab]             = useState<'json' | 'script'>('json');
  const [scriptContent, setScriptContent]     = useState<string | null>(null);
  const [baselineScript, setBaselineScript]   = useState<string | null>(null);
  const [scriptDiffers, setScriptDiffers]     = useState(false);

  // Monitor sidecar state
  const [monitorConfig, setMonitorConfig]           = useState<MonitorConfig>(null);
  const [fileMonitorState, setFileMonitorState]     = useState<MonitorPanelState>({ include: [], exclude: [] });
  const [folderMonitorState, setFolderMonitorState] = useState<MonitorPanelState>({ include: [], exclude: [] });
  const [fileSidecarSha, setFileSidecarSha]         = useState<string | undefined>();
  const [folderSidecarSha, setFolderSidecarSha]     = useState<string | undefined>();

  const displayTree = useMemo((): ViewerTreeEntry[] => {
    if (scope === 'baseline' || baselinePaths.length === 0) return tree;
    const tenantPaths = new Set(tree.map(e => e.path));
    const injected: ViewerTreeEntry[] = baselinePaths
      .filter(p => !tenantPaths.has(p) && diffMap.get(p) === true)
      .map(p => ({
        name: p.split('/').at(-1)!,
        path: p,
        type: 'file' as const,
        size: 0,
        sha: '',
        baselineOnly: true,
      }));
    return injected.length ? [...tree, ...injected] : tree;
  }, [tree, baselinePaths, scope, diffMap]);

  const searchQueryNorm = normalizeSearchQuery(fileSearchQuery);
  const debouncedSearchNorm = normalizeSearchQuery(debouncedSearchQuery);

  const filenameMatchPaths = useMemo(() => {
    if (!searchQueryNorm) return null;
    const matches = new Set<string>();
    for (const entry of displayTree) {
      if (entry.type !== 'file') continue;
      if (pathMatchesFilename(entry.path, entry.name, searchQueryNorm)) {
        matches.add(entry.path);
      }
    }
    return matches;
  }, [displayTree, searchQueryNorm]);

  const filteredDisplayTree = useMemo((): ViewerTreeEntry[] => {
    if (!searchQueryNorm) return displayTree;

    const matchingFiles = new Set<string>(filenameMatchPaths ?? []);
    if (searchInContent) {
      for (const path of contentMatchPaths) matchingFiles.add(path);
    }

    return keepTreeEntriesForFilePaths(displayTree, matchingFiles);
  }, [displayTree, searchQueryNorm, filenameMatchPaths, searchInContent, contentMatchPaths]);

  const filteredFileCount = useMemo(
    () => filteredDisplayTree.filter(e => e.type === 'file').length,
    [filteredDisplayTree],
  );

  const treeNodes = buildTree(filteredDisplayTree);

  const repoFilePath = useCallback((filePath: string) => {
    if (scope !== 'baseline') return `backups/${filePath}`;
    return `baseline/${filePath}`;
  }, [scope]);

  const gitFileQueryString = useCallback(() => {
    if (scope === 'baseline') return `scope=baseline&mspSlug=${encodeURIComponent(mspSlug)}`;
    return `scope=tenant&slug=${encodeURIComponent(selectedTenantSlug ?? '')}`;
  }, [scope, mspSlug, selectedTenantSlug]);

  useEffect(() => {
    if (!searchInContent || !debouncedSearchNorm) {
      setContentMatchPaths(new Set());
      setContentSearchLoading(false);
      setContentSearchProgress({ done: 0, total: 0 });
      return;
    }

    if (scope === 'tenant' && !selectedTenantSlug) {
      setContentMatchPaths(new Set());
      setContentSearchLoading(false);
      return;
    }

    const generation = ++contentSearchGenRef.current;
    const controller = new AbortController();
    const candidates = displayTree.filter(
      e => e.type === 'file' && CONTENT_SEARCHABLE_FILE.test(e.name),
    );
    const toScan = candidates.filter(
      e => !pathMatchesFilename(e.path, e.name, debouncedSearchNorm),
    );

    setContentSearchLoading(true);
    setContentSearchProgress({ done: 0, total: toScan.length });
    setContentMatchPaths(new Set());

    (async () => {
      const matches = new Set<string>();

      for (let i = 0; i < toScan.length; i += CONTENT_SEARCH_BATCH) {
        if (controller.signal.aborted || contentSearchGenRef.current !== generation) return;

        const batch = toScan.slice(i, i + CONTENT_SEARCH_BATCH);
        await Promise.all(batch.map(async (entry) => {
          try {
            const apiPath = repoFilePath(entry.path);
            const res = await fetch(
              `/api/git/file?path=${encodeURIComponent(apiPath)}&${gitFileQueryString()}`,
              { signal: controller.signal },
            );
            const data = await res.json() as { exists?: boolean; content?: string };
            if (res.ok && data.exists && typeof data.content === 'string') {
              if (data.content.toLowerCase().includes(debouncedSearchNorm)) {
                matches.add(entry.path);
              }
            }
          } catch (err: unknown) {
            if ((err as Error)?.name === 'AbortError') throw err;
          }
        }));

        if (controller.signal.aborted || contentSearchGenRef.current !== generation) return;
        setContentMatchPaths(new Set(matches));
        setContentSearchProgress({ done: Math.min(i + CONTENT_SEARCH_BATCH, toScan.length), total: toScan.length });
      }

      if (contentSearchGenRef.current === generation) {
        setContentMatchPaths(new Set(matches));
        setContentSearchLoading(false);
      }
    })().catch((err: unknown) => {
      if ((err as Error)?.name !== 'AbortError' && contentSearchGenRef.current === generation) {
        setContentSearchLoading(false);
      }
    });

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInContent, debouncedSearchNorm, displayTree, scope, selectedTenantSlug, mspSlug, repoFilePath, gitFileQueryString]);

  useEffect(() => {
    if (!searchQueryNorm) return;
    const dirs = collectAncestorDirPaths(
      filteredDisplayTree.filter(e => e.type === 'file').map(e => e.path),
    );
    if (dirs.length === 0) return;
    setExpandedDirs(prev => {
      const next = new Set(prev);
      for (const dir of dirs) next.add(dir);
      return next;
    });
  }, [searchQueryNorm, filteredDisplayTree]);

  /* ── Diff-status fetch (conflicts detection) ────────────── */

  useEffect(() => {
    if (scope === 'baseline' || !selectedTenantSlug) {
      setDiffMap(new Map());
      setPreloading(false);
      return;
    }

    const controller = new AbortController();
    setDiffMap(new Map());
    setPreloading(true);

    fetch(
      `/api/git/diff-status?mspSlug=${encodeURIComponent(mspSlug)}&slug=${encodeURIComponent(selectedTenantSlug)}`,
      { signal: controller.signal },
    )
      .then(r => r.json())
      .then((data: { results?: Record<string, boolean> }) => {
        setDiffMap(new Map(Object.entries(data.results ?? {})));
        setPreloading(false);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setPreloading(false);
      });

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, selectedTenantSlug]);

  /* ── Sidecar loading ──────────────────────────────────── */

  async function loadMonitorSidecars(filePath: string) {
    // Sidecars live under baseline/ in the baseline repo
    const fp = `baseline/${getSidecarPath(filePath)}`;
    const dp = `baseline/${getFolderSidecarPath(filePath)}`;
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
    const merged = mergeMonitorConfigs(fileCfg, folderCfg);
    setMonitorConfig(merged);
    return merged;
  }

  async function fetchMailboxAuditDriftSnapshot() {
    if (!selectedTenantSlug) return null;
    const bqs = `&scope=baseline&mspSlug=${mspSlug}`;
    const tqs = `&scope=tenant&slug=${selectedTenantSlug}`;
    const [rem, org, status] = await Promise.all([
      fetch(`/api/git/file?path=${encodeURIComponent(`baseline/${REMEDIATION_PATH}`)}${bqs}`).then(r => r.json()).catch(() => ({ exists: false })),
      fetch(`/api/git/file?path=${encodeURIComponent(`baseline/${ORG_AUDIT_DISABLED_PATH}`)}${bqs}`).then(r => r.json()).catch(() => ({ exists: false })),
      fetch(`/api/git/file?path=${encodeURIComponent(`backups/${AUDIT_STATUS_PATH}`)}${tqs}`).then(r => r.json()).catch(() => ({ exists: false })),
    ]);
    if (!rem.exists) return null;
    const remediation = parseJsonContent(rem.content ?? '') as Parameters<typeof computeMailboxAuditDrift>[0];
    const orgEnabled = org.exists ? isOrgAuditRemediationEnabled(parseJsonContent(org.content ?? '')) : false;
    const drift = computeMailboxAuditDrift(remediation, parseJsonContent(status.content ?? ''), orgEnabled);
    return { remediation, drift };
  }

  /* ── Export conflicts ─────────────────────────────────── */

  async function exportConflicts() {
    if (!selectedTenantSlug || exporting) return;
    const conflictPaths = [...diffMap.entries()].filter(([, v]) => v).map(([k]) => k);
    if (conflictPaths.length === 0) return;

    setExporting(true);
    const BATCH = 5;
    const conflicts: Array<{ path: string; service: string; baseline: unknown; current: unknown }> = [];
    let auditDriftSnapshot: Awaited<ReturnType<typeof fetchMailboxAuditDriftSnapshot>> | undefined;

    for (let i = 0; i < conflictPaths.length; i += BATCH) {
      const batch = conflictPaths.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(async (filePath) => {
        if (filePath === REMEDIATION_PATH || filePath === AUDIT_STATUS_PATH) {
          if (auditDriftSnapshot === undefined) {
            auditDriftSnapshot = await fetchMailboxAuditDriftSnapshot();
          }
          if (!auditDriftSnapshot) return null;
          return {
            path: filePath,
            service: classifyService(filePath),
            baseline: auditDriftSnapshot.remediation,
            current: {
              targetAuditEnabled: auditDriftSnapshot.drift.targetAuditEnabled,
              nonCompliantMailboxes: auditDriftSnapshot.drift.nonCompliant,
            },
          };
        }

        const blUrl = `/api/git/file?path=${encodeURIComponent(`baseline/${filePath}`)}&scope=baseline&mspSlug=${mspSlug}`;
        const tnUrl = `/api/git/file?path=${encodeURIComponent(`backups/${filePath}`)}&scope=tenant&slug=${selectedTenantSlug}`;
        const [bl, tn] = await Promise.all([
          fetch(blUrl).then(r => r.json()).catch(() => ({ exists: false })),
          fetch(tnUrl).then(r => r.json()).catch(() => ({ exists: false })),
        ]);
        const parse = (c?: string) => { try { return JSON.parse((c ?? '').replace(/^\uFEFF/, '')); } catch { return c ?? null; } };
        return { path: filePath, service: classifyService(filePath), baseline: parse(bl.content), current: parse(tn.content) };
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) conflicts.push(r.value);
      }
    }

    const tenantName = tenants.find(t => t.slug === selectedTenantSlug)?.displayName ?? selectedTenantSlug;
    const exportData = {
      tenant:        tenantName,
      tenantSlug:    selectedTenantSlug,
      mspSlug,
      exportedAt:    new Date().toISOString(),
      conflictCount: conflicts.length,
      conflicts,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `conflicts-${selectedTenantSlug}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
  }

  /* ── File loading ─────────────────────────────────────── */

  async function loadFile(filePath: string) {
    setSelectedFile(filePath);
    setContent('');
    setSha(undefined);
    setBaselineContent(null);
    setError('');
    setSuccess('');
    setShowDiff(false);
    setSelectedPaths(new Set());
    setScopeDropdownOpen(false);
    setMonitorConfig(null);
    setFileMonitorState({ include: [], exclude: [] });
    setFolderMonitorState({ include: [], exclude: [] });
    setFileSidecarSha(undefined);
    setFolderSidecarSha(undefined);
    setActiveTab('json');
    setScriptContent(null);
    setBaselineScript(null);
    setScriptDiffers(false);
    setLoading(true);
    try {
      if (filePath === REMEDIATION_PATH && scope !== 'baseline') {
        await loadMonitorSidecars(filePath);
        const snap = await fetchMailboxAuditDriftSnapshot();
        if (snap) {
          setBaselineContent(JSON.stringify(snap.remediation, null, 2));
          setContent(JSON.stringify({
            derivedDrift: true,
            targetAuditEnabled: snap.drift.targetAuditEnabled,
            nonCompliantCount: snap.drift.nonCompliant.length,
            nonCompliantMailboxes: snap.drift.nonCompliant,
          }, null, 2));
          setShowDiff(true);
          return;
        }
      }

      // filePath is the backup-root-relative path (backups/ prefix already stripped).
      // The tenant repo stores files under backups/, so re-add the prefix for that fetch.
      // The baseline repo stores policy files under baseline/, added back when fetching below.
      const tenantPath = scope !== 'baseline' ? `backups/${filePath}` : filePath;
      const qscope = scope === 'baseline' ? 'baseline' : 'tenant';
      const qslug  = scope !== 'baseline' ? `&slug=${selectedTenantSlug}` : `&mspSlug=${mspSlug}`;
      const res    = await fetch(`/api/git/file?path=${encodeURIComponent(tenantPath)}&scope=${qscope}${qslug}`);
      const data   = await res.json();
      if (!res.ok) throw new Error(data.error);
      setContent(data.exists ? data.content : '(file not found)');
      setSha(data.exists ? data.sha : undefined);

      // Load monitor sidecar from baseline (applies to both modes)
      const mergedConfig = await loadMonitorSidecars(filePath);

      if (scope !== 'baseline') {
        try {
          // Baseline policy files live under baseline/ in the repo
          const baselinePath = `baseline/${filePath}`;
          const br = await fetch(`/api/git/file?path=${encodeURIComponent(baselinePath)}&scope=baseline&mspSlug=${mspSlug}`);
          const bd = await br.json();
          if (br.ok && bd.exists) {
            setBaselineContent(bd.content);
            // Update diffMap with monitor-config-aware comparison for this file
            try {
              const tenantNorm   = normalizeForCompare(data.exists ? data.content : '', mergedConfig, filePath);
              const baselineNorm = normalizeForCompare(bd.content, mergedConfig, filePath);
              const hasDiff = tenantNorm !== baselineNorm;
              setDiffMap(prev => { const next = new Map(prev); next.set(filePath, hasDiff); return next; });
              if (hasDiff) setShowDiff(true);
            } catch { /* leave existing diffMap entry */ }
          } else {
            setBaselineContent(null);
          }
        } catch { setBaselineContent(null); }
      }

      // Suppress unused variable warning — mergedConfig is used in isDiff below via monitorConfig state
      void mergedConfig;

      // For platform scripts, also load the sibling .ps1/.sh file
      const isPlatformScript = /^intune\/platform-scripts-(powershell|bash)\//.test(filePath);
      if (isPlatformScript && scope !== 'baseline') {
        try {
          const ext = filePath.includes('-bash/') ? '.sh' : '.ps1';
          const scriptRelPath = filePath.replace(/\.json$/i, ext);
          const tnScriptUrl = `/api/git/file?path=${encodeURIComponent(`backups/${scriptRelPath}`)}&scope=tenant&slug=${selectedTenantSlug}`;
          const blScriptUrl = `/api/git/file?path=${encodeURIComponent(`baseline/${scriptRelPath}`)}&scope=baseline&mspSlug=${mspSlug}`;
          const [tnScr, blScr] = await Promise.all([
            fetch(tnScriptUrl).then(r => r.json()).catch(() => ({ exists: false })),
            fetch(blScriptUrl).then(r => r.json()).catch(() => ({ exists: false })),
          ]);
          const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
          const tnText = tnScr.exists ? (tnScr.content as string) : null;
          const blText = blScr.exists ? (blScr.content as string) : null;
          setScriptContent(tnText);
          setBaselineScript(blText);
          if (tnText !== null && blText !== null) {
            setScriptDiffers(norm(tnText) !== norm(blText));
          }
        } catch { /* non-fatal — script tab just won't show */ }
      }
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  }

  /* ── Sidecar write helper ─────────────────────────────── */

  async function writeSidecar(filePath: string, filter: MonitorConfig) {
    // Write file-level sidecar: baseline/Policy.monitor.json
    const sp = `baseline/${getSidecarPath(filePath)}`;
    const checkRes  = await fetch(`/api/git/file?path=${encodeURIComponent(sp)}&scope=baseline&mspSlug=${mspSlug}`);
    const checkData = await checkRes.json();
    const existingSha = checkData.exists ? checkData.sha : undefined;

    if (!filter || (!filter.include?.length && !filter.exclude?.length)) {
      // Clear sidecar
      if (existingSha) {
        await fetch('/api/git/file', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sp, sha: existingSha, scope: 'baseline', mspSlug, message: `portal: clear monitor config for ${sp}` }),
        });
      }
      setFileSidecarSha(undefined);
      setFileMonitorState({ include: [], exclude: [] });
      setMonitorConfig(mergeMonitorConfigs(null, folderMonitorState.include.length || folderMonitorState.exclude.length
        ? { include: folderMonitorState.include, exclude: folderMonitorState.exclude } : null));
    } else {
      const cfg: Record<string, string[]> = {};
      if (filter.include?.length) cfg.include = filter.include;
      if (filter.exclude?.length) cfg.exclude = filter.exclude;
      const content = JSON.stringify(cfg, null, 2) + '\n';
      await fetch('/api/git/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sp, content, sha: existingSha, scope: 'baseline', mspSlug, message: `portal: update monitor config for ${sp}` }),
      });
      const newCheck = await fetch(`/api/git/file?path=${encodeURIComponent(sp)}&scope=baseline&mspSlug=${mspSlug}`);
      const newData  = await newCheck.json();
      setFileSidecarSha(newData.sha);
      setFileMonitorState({ include: filter.include ?? [], exclude: filter.exclude ?? [] });
      const folderCfg: MonitorConfig = folderMonitorState.include.length || folderMonitorState.exclude.length
        ? { include: folderMonitorState.include, exclude: folderMonitorState.exclude } : null;
      setMonitorConfig(mergeMonitorConfigs(filter, folderCfg));
    }
  }

  /* ── Copy to baseline ─────────────────────────────────── */

  async function copyToBaselineRaw(filePath: string, jsonContent: string, sidecar: MonitorConfig, labelSuffix = '') {
    setCopying(true); setError(''); setSuccess('');
    try {
      // 1. Always write full JSON — policy files live under baseline/ in the baseline repo
      const baselinePath = `baseline/${filePath}`;
      const checkRes  = await fetch(`/api/git/file?path=${encodeURIComponent(baselinePath)}&scope=baseline&mspSlug=${mspSlug}`);
      const checkData = await checkRes.json();
      const bSha = checkData.exists ? checkData.sha : undefined;
      const res = await fetch('/api/git/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: baselinePath,
          content: jsonContent,
          message: `portal: copy backups/${filePath} from tenant ${selectedTenantSlug} to baseline${labelSuffix}`,
          sha: bSha,
          scope: 'baseline',
          mspSlug,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setBaselineContent(jsonContent);

      // 2. Write (or clear) sidecar separately
      await writeSidecar(filePath, sidecar);

      const sidecarNote = sidecar
        ? sidecar.include?.length
          ? ` (monitoring ${sidecar.include.length} field${sidecar.include.length !== 1 ? 's' : ''})`
          : sidecar.exclude?.length
          ? ` (excluding ${sidecar.exclude.length} field${sidecar.exclude.length !== 1 ? 's' : ''})`
          : ''
        : '';
      setSuccess(`"${filePath}" copied to baseline${sidecarNote}.`);
      setSelectedPaths(new Set());
      setScopeDropdownOpen(false);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setCopying(false); }
  }

  async function copyToBaseline() {
    if (!selectedFile || !content) return;
    if (!confirm(`Copy "${selectedFile}" to baseline? This will overwrite any existing baseline version and clear the monitor sidecar.`)) return;
    await copyToBaselineRaw(selectedFile, content, null);
  }

  async function writeFolderSidecar(filePath: string, filter: MonitorConfig) {
    const fp = `baseline/${getFolderSidecarPath(filePath)}`;
    const checkRes  = await fetch(`/api/git/file?path=${encodeURIComponent(fp)}&scope=baseline&mspSlug=${mspSlug}`);
    const checkData = await checkRes.json();
    const existingSha = checkData.exists ? checkData.sha : undefined;
    if (!filter || (!filter.include?.length && !filter.exclude?.length)) {
      if (existingSha) {
        await fetch('/api/git/file', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fp, sha: existingSha, scope: 'baseline', mspSlug, message: `portal: clear folder monitor config for ${fp}` }),
        });
      }
      setFolderSidecarSha(undefined);
      setFolderMonitorState({ include: [], exclude: [] });
    } else {
      const cfg: Record<string, string[]> = {};
      if (filter.include?.length) cfg.include = filter.include;
      if (filter.exclude?.length) cfg.exclude = filter.exclude;
      const content = JSON.stringify(cfg, null, 2) + '\n';
      await fetch('/api/git/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fp, content, sha: existingSha, scope: 'baseline', mspSlug, message: `portal: update folder monitor config for ${fp}` }),
      });
      const nc = await fetch(`/api/git/file?path=${encodeURIComponent(fp)}&scope=baseline&mspSlug=${mspSlug}`);
      const nd = await nc.json();
      setFolderSidecarSha(nd.sha);
      setFolderMonitorState({ include: filter.include ?? [], exclude: filter.exclude ?? [] });
      const fileCfg: MonitorConfig = fileMonitorState.include.length || fileMonitorState.exclude.length
        ? { include: fileMonitorState.include, exclude: fileMonitorState.exclude } : null;
      setMonitorConfig(mergeMonitorConfigs(fileCfg, filter));
    }
  }

  async function copyToBaselineWithFilter(filter: { include?: string[]; exclude?: string[] }, sidecarScope: 'file' | 'folder' = 'file') {
    if (!selectedFile || !content) return;
    const mode  = filter.include?.length ? 'include' : 'exclude';
    const paths = filter.include ?? filter.exclude ?? [];
    const scopeLabel = sidecarScope === 'folder' ? 'entire folder' : 'this file';
    if (!confirm(`Copy "${selectedFile}" to baseline?\nMonitor ${mode}: ${paths.length} field(s) (${scopeLabel}).\nFull JSON will always be written; the sidecar controls drift comparison.`)) return;
    setCopying(true); setError(''); setSuccess('');
    try {
      // 1. Write full JSON to baseline — policy files live under baseline/ in the baseline repo
      const baselinePath = `baseline/${selectedFile}`;
      const checkRes  = await fetch(`/api/git/file?path=${encodeURIComponent(baselinePath)}&scope=baseline&mspSlug=${mspSlug}`);
      const checkData = await checkRes.json();
      const bSha = checkData.exists ? checkData.sha : undefined;
      const res = await fetch('/api/git/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: baselinePath, content, sha: bSha, scope: 'baseline', mspSlug,
          message: `portal: copy backups/${selectedFile} from tenant ${selectedTenantSlug} to baseline`,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setBaselineContent(content);
      // 2. Write sidecar at the correct scope
      if (sidecarScope === 'folder') {
        await writeFolderSidecar(selectedFile, filter);
      } else {
        await writeSidecar(selectedFile, filter);
      }
      setSuccess(`"${selectedFile}" copied to baseline (${mode} ${paths.length} field${paths.length !== 1 ? 's' : ''}, ${scopeLabel}).`);
      setSelectedPaths(new Set());
      setScopeDropdownOpen(false);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setCopying(false); }
  }

  /* ── Field selection ──────────────────────────────────── */

  const handleLineClick = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        for (const p of [...next]) {
          if (p === path || p.startsWith(path + '.')) next.delete(p);
        }
      } else {
        for (const p of [...next]) {
          if (p.startsWith(path + '.')) next.delete(p);
        }
        const parts = path.split('.');
        const parentSelected = parts.some((_, i) =>
          i > 0 && next.has(parts.slice(0, i).join('.'))
        );
        if (!parentSelected) next.add(path);
      }
      return next;
    });
    setScopeDropdownOpen(false);
  }, []);

  /* ── Monitor panel state update ──────────────────────── */

  function handleMonitorUpdate(
    newFileState: MonitorPanelState,
    newFolderState: MonitorPanelState,
    newFileSha?: string,
    newFolderSha?: string,
  ) {
    setFileMonitorState(newFileState);
    setFolderMonitorState(newFolderState);
    if (newFileSha !== undefined) setFileSidecarSha(newFileSha);
    if (newFolderSha !== undefined) setFolderSidecarSha(newFolderSha);
    const fileCfg:   MonitorConfig = newFileState.include.length   || newFileState.exclude.length   ? { include: newFileState.include,   exclude: newFileState.exclude }   : null;
    const folderCfg: MonitorConfig = newFolderState.include.length || newFolderState.exclude.length ? { include: newFolderState.include, exclude: newFolderState.exclude } : null;
    setMonitorConfig(mergeMonitorConfigs(fileCfg, folderCfg));
  }

  /* ── Navigation / misc ────────────────────────────────── */

  function navigate(newScope: string, newTenant?: string) {
    const alreadyHere =
      newScope === 'baseline'
        ? scope === 'baseline'
        : scope === 'tenant' && selectedTenantSlug === newTenant;
    if (alreadyHere) return;

    setDiffMap(new Map());
    setFileFilter('all');
    pendingNavRef.current = { scope: newScope, tenant: newTenant };
    setTreeLoading(true);
    const base = `/msps/${mspSlug}/viewer?scope=${newScope}`;
    router.push(newTenant ? `${base}&tenant=${newTenant}` : base);
  }

  useEffect(() => {
    const pending = pendingNavRef.current;
    if (!pending) return;
    const arrived =
      pending.scope === 'baseline'
        ? scope === 'baseline'
        : scope === 'tenant' && selectedTenantSlug === pending.tenant;
    if (arrived) {
      pendingNavRef.current = null;
      setTreeLoading(false);
    }
  }, [selectedTenantSlug, scope, tree]);

  async function triggerDeploy() {
    if (!selectedTenantSlug) return;
    setTriggering(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/pipelines/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: selectedTenantSlug, workflow: 'deploy.yml' }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSuccess(`Deploy triggered for ${tenants.find(t => t.slug === selectedTenantSlug)?.displayName ?? selectedTenantSlug}.`);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setTriggering(false); }
  }

  function toggleDir(path: string) {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  /* ── Derived values ───────────────────────────────────── */

  const filteredTenants = tenants.filter(t =>
    t.displayName.toLowerCase().includes(tenantSearch.toLowerCase())
  );

  // Compare monitor-filtered + normalized content for drift detection
  const isDiff = (() => {
    if (baselineContent === null) return false;
    try {
      const tenantNorm   = normalizeForCompare(content, monitorConfig, selectedFile ?? undefined);
      const baselineNorm = normalizeForCompare(baselineContent, monitorConfig, selectedFile ?? undefined);
      return tenantNorm !== baselineNorm;
    } catch {
      return baselineContent !== content;
    }
  })();

  const minimalPaths    = getMinimalPaths(selectedPaths);
  const selectionCount  = minimalPaths.length;
  const hasSelection    = selectionCount > 0;
  const hasMonitorSidecar = fileMonitorState.include.length + fileMonitorState.exclude.length +
    folderMonitorState.include.length + folderMonitorState.exclude.length > 0;

  /* ── Annotated JSON renderer ──────────────────────────── */

  function renderAnnotatedJson(jsonStr: string): React.ReactNode {
    let lines: AnnotatedLine[];
    try {
      const parsed = JSON.parse(jsonStr.replace(/^\uFEFF/, ''));
      const pretty = JSON.stringify(parsed, null, 2);
      lines = annotateJsonLines(pretty);
    } catch {
      return (
        <pre style={{ margin: 0, padding: '12px 16px', fontSize: '0.78rem', lineHeight: '1.6', color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace" }}>
          {jsonStr}
        </pre>
      );
    }

    return (
      <div style={{ fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '0.78rem', lineHeight: '1.65', padding: '8px 0' }}>
        {lines.map((a, i) => {
          const hasPath  = a.path !== null;
          const ignored  = hasPath && isPathIgnored(a.path, monitorConfig);
          const included = hasPath && isPathIncluded(a.path, monitorConfig);
          const isSelected = hasPath && selectedPaths.has(a.path!);
          const isAncestorSelected = hasPath && !isSelected && (() => {
            const parts = a.path!.split('.');
            return parts.some((_, idx) => idx > 0 && selectedPaths.has(parts.slice(0, idx).join('.')));
          })();

          let bg = 'transparent';
          let borderColor = 'transparent';
          let textColor = '#d4d4d8';

          if (ignored) {
            textColor = '#3f3f46';
          } else if (included) {
            textColor = '#86efac';
            borderColor = 'rgba(34,197,94,0.2)';
          }

          if (isSelected) {
            bg = 'rgba(34,197,94,0.12)';
            borderColor = '#22c55e';
            textColor = '#86efac';
          } else if (isAncestorSelected) {
            bg = 'rgba(34,197,94,0.05)';
            borderColor = 'rgba(34,197,94,0.3)';
          }

          return (
            <div
              key={i}
              title={a.path ?? undefined}
              onClick={hasPath ? () => handleLineClick(a.path!) : undefined}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 16px',
                background: bg,
                borderLeft: `2px solid ${borderColor}`,
                cursor: hasPath ? 'pointer' : 'default',
                userSelect: 'text',
                transition: 'background 0.08s',
              }}
              onMouseEnter={e => {
                if (hasPath && !isSelected && !isAncestorSelected && !ignored) {
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
                }
              }}
              onMouseLeave={e => {
                if (hasPath && !isSelected && !isAncestorSelected) {
                  (e.currentTarget as HTMLElement).style.background = ignored ? 'transparent' : bg;
                }
              }}
            >
              <pre style={{
                margin: 0, padding: 0, border: 'none', background: 'transparent',
                color: textColor,
                fontStyle: ignored ? 'italic' : 'normal',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1,
              }}>
                {a.line}
              </pre>
              {hasPath && (isSelected || included) && (
                <span style={{
                  fontSize: '0.6rem',
                  color: isSelected ? '#22c55e' : '#52525b',
                  flexShrink: 0, fontFamily: 'inherit',
                }}>
                  {a.path}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  /* ── File tree renderer ─────────────────────────────────── */

  function dirHasConflict(node: TreeNode): boolean {
    if (node.type === 'file') return diffMap.get(node.path) === true;
    return node.children.some(dirHasConflict);
  }

  function renderNode(node: TreeNode, depth = 0): React.ReactNode {
    if (node.type === 'dir') {
      if (fileFilter === 'conflicts' && !dirHasConflict(node)) return null;
      const open = expandedDirs.has(node.path);
      return (
        <div key={node.path}>
          <div
            onClick={() => toggleDir(node.path)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: `5px 12px 5px ${12 + depth * 14}px`,
              cursor: 'pointer', color: '#71717a', fontSize: '0.8125rem', transition: 'background 0.1s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span style={{ fontSize: '0.7rem', opacity: 0.5, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
            <span style={{ fontSize: '0.8rem' }}>📁</span>
            <span title={node.path} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          </div>
          {open && <div>{node.children.map(c => renderNode(c, depth + 1))}</div>}
        </div>
      );
    }

    if (fileFilter === 'conflicts' && diffMap.get(node.path) !== true) return null;

    const active    = selectedFile === node.path;
    const svc       = classifyService(node.path);
    const hasDiff   = diffMap.get(node.path) === true;
    return (
      <div
        key={node.path}
        onClick={() => loadFile(node.path)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: `6px 12px 6px ${12 + depth * 14}px`,
          cursor: 'pointer', fontSize: '0.8125rem',
          background: active ? 'rgba(34,197,94,0.08)' : 'transparent',
          color: active ? '#22c55e' : '#a1a1aa',
          borderLeft: active ? '2px solid #22c55e' : '2px solid transparent',
          transition: 'background 0.1s, color 0.1s',
        }}
        onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = '#18181b'; (e.currentTarget as HTMLElement).style.color = '#e4e4e7'; } }}
        onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#a1a1aa'; } }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: SVC_COLORS[svc] ?? '#71717a', flexShrink: 0 }} />
        <span title={node.path} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.78rem' }}>{node.name}</span>
        {hasDiff && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0 }} title="Differs from baseline" />}
        {node.baselineOnly && <span style={{ fontSize: '0.6rem', color: '#c084fc', background: 'rgba(192,132,252,0.1)', border: '1px solid rgba(192,132,252,0.25)', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>baseline</span>}
        {node.name.endsWith('.assignment.json') && <span style={{ fontSize: '0.6rem', color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 3, padding: '0 3px', flexShrink: 0 }}>ASN</span>}
        {!node.name.endsWith('.assignment.json') && node.name.endsWith('.json') && <span style={{ fontSize: '0.6rem', color: '#3f3f46', flexShrink: 0 }}>JSON</span>}
      </div>
    );
  }

  /* ── Render ───────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', height: '100%', gap: 0, background: '#09090b', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>

      {/* ── Panel 1: Tenant list ─────────────────────────────── */}
      <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #27272a', background: '#111113' }}>
        <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid #27272a' }}>
          <div style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Tenants</div>
          <input
            value={tenantSearch} onChange={e => setTenantSearch(e.target.value)} placeholder="Search…"
            style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 5, color: '#e4e4e7', fontSize: '0.75rem', padding: '5px 9px', width: '100%', outline: 'none', fontFamily: 'inherit' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          <div
            onClick={() => navigate('baseline')}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, cursor: 'pointer', fontSize: '0.8125rem', marginBottom: 1, background: scope === 'baseline' ? 'rgba(34,197,94,0.12)' : 'transparent', color: scope === 'baseline' ? '#22c55e' : '#71717a', transition: 'background 0.1s, color 0.1s' }}
            onMouseEnter={e => { if (scope !== 'baseline') { (e.currentTarget as HTMLElement).style.background = '#18181b'; (e.currentTarget as HTMLElement).style.color = '#e4e4e7'; }}}
            onMouseLeave={e => { if (scope !== 'baseline') { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#71717a'; }}}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: scope === 'baseline' ? '#22c55e' : '#3f3f46', flexShrink: 0 }} />
            Baseline
          </div>
          {filteredTenants.map(t => {
            const active = scope === 'tenant' && selectedTenantSlug === t.slug;
            return (
              <div
                key={t.slug} onClick={() => navigate('tenant', t.slug)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 5, cursor: 'pointer', fontSize: '0.8125rem', marginBottom: 1, background: active ? 'rgba(34,197,94,0.12)' : 'transparent', color: active ? '#22c55e' : '#a1a1aa', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = '#18181b'; (e.currentTarget as HTMLElement).style.color = '#e4e4e7'; }}}
                onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.color = '#a1a1aa'; }}}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: active ? '#22c55e' : '#3f3f46', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.displayName}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Panel 2: File tree (width resizable) ───────────────── */}
      <div style={{ width: filePanelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#0f0f11', position: 'relative' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minHeight: 38 }}>
          <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Files
          </span>
          {tree.length > 0 && (
            <span style={{ background: '#27272a', color: '#71717a', padding: '1px 6px', borderRadius: 10, fontSize: '0.65rem' }}>
              {fileFilter === 'conflicts'
                ? `${[...diffMap.values()].filter(Boolean).length} conflict${[...diffMap.values()].filter(Boolean).length !== 1 ? 's' : ''}`
                : searchQueryNorm
                  ? `${filteredFileCount} match${filteredFileCount !== 1 ? 'es' : ''}`
                  : displayTree.filter(e => e.type === 'file').length}
            </span>
          )}
          {scope !== 'baseline' && selectedTenantSlug && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 3, alignItems: 'center' }}>
              {(['all', 'conflicts'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFileFilter(f)}
                  style={{
                    padding: '2px 7px', fontSize: '0.6rem', fontWeight: 600,
                    borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                    textTransform: 'capitalize', letterSpacing: '0.04em',
                    background: fileFilter === f ? (f === 'conflicts' ? 'rgba(251,191,36,0.12)' : 'rgba(34,197,94,0.1)') : 'transparent',
                    color:      fileFilter === f ? (f === 'conflicts' ? '#fbbf24' : '#22c55e') : '#52525b',
                    border:     fileFilter === f ? `1px solid ${f === 'conflicts' ? 'rgba(251,191,36,0.3)' : 'rgba(34,197,94,0.3)'}` : '1px solid transparent',
                  }}
                >{f}</button>
              ))}
              {[...diffMap.values()].some(Boolean) && (
                <button
                  onClick={exportConflicts}
                  disabled={exporting || preloading}
                  title={exporting ? 'Exporting…' : 'Export all conflicts as JSON'}
                  style={{
                    padding: '2px 6px', fontSize: '0.65rem', borderRadius: 4, cursor: exporting || preloading ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit', background: 'transparent', color: exporting ? '#52525b' : '#71717a',
                    border: '1px solid transparent', opacity: exporting || preloading ? 0.5 : 1,
                    marginLeft: 2,
                  }}
                >{exporting ? '…' : '↓'}</button>
              )}
            </div>
          )}
        </div>
        {(treeLoading || preloading) && (
          <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid #27272a', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: '0.7rem', color: '#fbbf24', fontWeight: 500 }}>
              {treeLoading ? 'Loading files…' : 'Comparing to baseline…'}
            </span>
            <div style={{ height: 3, borderRadius: 2, background: '#27272a', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: '40%',
                borderRadius: 2,
                background: 'linear-gradient(90deg, transparent, #f59e0b, transparent)',
                animation: 'diffBarSlide 1.2s ease-in-out infinite',
              }} />
            </div>
            <style>{`@keyframes diffBarSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
          </div>
        )}
        <div style={{ padding: '6px 10px 8px', borderBottom: '1px solid #27272a', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            value={fileSearchQuery}
            onChange={e => setFileSearchQuery(e.target.value)}
            placeholder={searchInContent ? 'Search filenames and content…' : 'Search filenames…'}
            style={{
              width: '100%',
              background: '#18181b',
              border: '1px solid #27272a',
              borderRadius: 5,
              color: '#e4e4e7',
              fontSize: '0.75rem',
              padding: '6px 9px',
              outline: 'none',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setSearchInContent(v => !v)}
              title={searchInContent ? 'Also searching file contents' : 'Search filenames only'}
              style={{
                padding: '2px 8px',
                fontSize: '0.6rem',
                fontWeight: 600,
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: 'inherit',
                letterSpacing: '0.04em',
                background: searchInContent ? 'rgba(96,165,250,0.12)' : 'transparent',
                color: searchInContent ? '#60a5fa' : '#52525b',
                border: searchInContent ? '1px solid rgba(96,165,250,0.3)' : '1px solid #27272a',
              }}
            >
              + content
            </button>
            {searchInContent && debouncedSearchNorm && contentSearchLoading && (
              <span style={{ fontSize: '0.65rem', color: '#71717a', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, border: '2px solid #3f3f46', borderTopColor: '#60a5fa', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                {contentSearchProgress.total > 0
                  ? `Searching content ${contentSearchProgress.done}/${contentSearchProgress.total}…`
                  : 'Searching content…'}
              </span>
            )}
            {fileSearchQuery && (
              <button
                type="button"
                onClick={() => { setFileSearchQuery(''); setContentMatchPaths(new Set()); }}
                style={{
                  marginLeft: 'auto',
                  padding: '2px 7px',
                  fontSize: '0.6rem',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: 'transparent',
                  color: '#71717a',
                  border: '1px solid #27272a',
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {treeNodes.length === 0 ? (
            <div style={{ padding: '48px 16px', textAlign: 'center', color: '#52525b', fontSize: '0.8125rem' }}>
              {scope === 'tenant' && !selectedTenantSlug
                ? 'Select a tenant'
                : fileSearchQuery.trim()
                  ? (searchInContent && contentSearchLoading ? 'Searching…' : 'No files match your search')
                  : 'No files found'}
            </div>
          ) : treeNodes.map(n => renderNode(n))}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file list"
          title="Drag to resize file list"
          onMouseDown={startFilePanelResize}
          style={{
            position: 'absolute',
            top: 0,
            right: -3,
            width: 6,
            height: '100%',
            cursor: 'col-resize',
            zIndex: 2,
            background: filePanelResizing ? 'rgba(34,197,94,0.35)' : 'transparent',
            borderRight: filePanelResizing ? '1px solid #22c55e' : '1px solid #27272a',
            transition: filePanelResizing ? 'none' : 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => {
            if (filePanelResizing) return;
            (e.currentTarget as HTMLElement).style.background = 'rgba(34,197,94,0.12)';
          }}
          onMouseLeave={e => {
            if (filePanelResizing) return;
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        />
      </div>

      {/* ── Panel 3: Content / Diff ──────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', borderLeft: '1px solid #27272a' }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #27272a', flexShrink: 0, flexWrap: 'wrap', minHeight: 44 }}>
          {/* File path */}
          {selectedFile ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              {scope !== 'baseline' && (
                <span style={{ flexShrink: 0, fontSize: '0.65rem', fontWeight: 600, color: '#a16207', background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 4, padding: '1px 6px', fontFamily: 'monospace' }}>backups/</span>
              )}
              <code style={{ fontSize: '0.78rem', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedFile}</code>
            </div>
          ) : (
            <span style={{ fontSize: '0.8rem', color: '#52525b', flex: 1 }}>Select a file to view its content</span>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {/* Field selection: Clear + scoped copy dropdown */}
            {hasSelection && scope !== 'baseline' && selectedFile && (
              <>
                <button
                  onClick={() => { setSelectedPaths(new Set()); setScopeDropdownOpen(false); }}
                  style={{ padding: '5px 10px', fontSize: '0.75rem', background: '#18181b', border: '1px solid #27272a', color: '#71717a', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}
                >× Clear</button>
                <div style={{ position: 'relative' }}>
                  <button
                    onClick={() => setScopeDropdownOpen(o => !o)} disabled={copying}
                    style={{ padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', borderRadius: 5, cursor: copying ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: copying ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 5 }}
                  >Apply to {selectionCount} field{selectionCount !== 1 ? 's' : ''} ▾</button>
                  {scopeDropdownOpen && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setScopeDropdownOpen(false)} />
                      <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 10, background: '#18181b', border: '1px solid #27272a', borderRadius: 6, minWidth: 280, boxShadow: '0 4px 20px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
                        {/* Warning banner */}
                        <div style={{ padding: '6px 12px', background: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.2)', fontSize: '0.68rem', color: '#f59e0b' }}>
                          ⚠ Saves to <strong>baseline</strong> — applies to <strong>all tenants</strong>
                        </div>
                        <div style={{ padding: '4px 0' }}>
                          <div style={{ padding: '4px 12px 2px', fontSize: '0.6rem', fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>This file — baseline (all tenants)</div>
                          {[
                            { label: '✓ Monitor selected fields', sub: `baseline sidecar include (file): ${selectionCount} path${selectionCount !== 1 ? 's' : ''}`, color: '#e4e4e7', action: () => copyToBaselineWithFilter({ include: minimalPaths }, 'file') },
                            { label: '✕ Ignore selected fields',  sub: `baseline sidecar exclude (file): ${selectionCount} path${selectionCount !== 1 ? 's' : ''}`, color: '#fca5a5', action: () => copyToBaselineWithFilter({ exclude: minimalPaths }, 'file') },
                          ].map((item, i) => (
                            <button key={i} onClick={() => { setScopeDropdownOpen(false); item.action(); }}
                              style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', color: item.color, fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', display: 'block' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#27272a'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                              {item.label}
                              <span style={{ display: 'block', fontSize: '0.7rem', color: '#52525b', marginTop: 1 }}>{item.sub}</span>
                            </button>
                          ))}
                          <div style={{ height: 1, background: '#27272a', margin: '4px 0' }} />
                          <div style={{ padding: '4px 12px 2px', fontSize: '0.6rem', fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Entire folder — baseline (all tenants)</div>
                          {[
                            { label: '✓ Monitor selected fields', sub: `baseline sidecar include (folder): ${selectionCount} path${selectionCount !== 1 ? 's' : ''}`, color: '#e4e4e7', action: () => copyToBaselineWithFilter({ include: minimalPaths }, 'folder') },
                            { label: '✕ Ignore selected fields',  sub: `baseline sidecar exclude (folder): ${selectionCount} path${selectionCount !== 1 ? 's' : ''}`, color: '#fca5a5', action: () => copyToBaselineWithFilter({ exclude: minimalPaths }, 'folder') },
                          ].map((item, i) => (
                            <button key={i} onClick={() => { setScopeDropdownOpen(false); item.action(); }}
                              style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', color: item.color, fontSize: '0.8125rem', cursor: 'pointer', fontFamily: 'inherit', display: 'block' }}
                              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#27272a'; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                              {item.label}
                              <span style={{ display: 'block', fontSize: '0.7rem', color: '#52525b', marginTop: 1 }}>{item.sub}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}

            {selectedFile && isDiff && (
              <button
                onClick={() => setShowDiff(d => !d)}
                style={{ padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, border: '1px solid ' + (showDiff ? '#f59e0b' : '#27272a'), borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit', background: showDiff ? 'rgba(245,158,11,0.1)' : '#18181b', color: showDiff ? '#fbbf24' : '#71717a' }}
              >⚠ Show diff</button>
            )}

            {selectedFile && (
              <button onClick={() => content && navigator.clipboard?.writeText(content)}
                style={{ padding: '5px 10px', fontSize: '0.75rem', background: '#18181b', border: '1px solid #27272a', color: '#71717a', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
                📋 Copy
              </button>
            )}

            {scope !== 'baseline' && selectedFile && !hasSelection && (
              <button
                onClick={copyToBaseline} disabled={copying}
                style={{ padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600, background: '#18181b', border: '1px solid #27272a', color: '#71717a', borderRadius: 5, cursor: copying ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: copying ? 0.5 : 1 }}
              >{copying ? '…' : '→ Baseline'}</button>
            )}

            {scope !== 'baseline' && selectedTenantSlug && (
              <button
                onClick={triggerDeploy} disabled={triggering}
                style={{ padding: '5px 12px', fontSize: '0.75rem', fontWeight: 600, background: '#22c55e', border: 'none', color: '#000', borderRadius: 5, cursor: triggering ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: triggering ? 0.6 : 1 }}
              >{triggering ? '…' : '▶ Deploy'}</button>
            )}
          </div>
        </div>

        {/* Field selection hint */}
        {selectedFile && !loading && content && content !== '(file not found)' && !hasSelection && (
          <div style={{ padding: '3px 16px', flexShrink: 0, fontSize: '0.7rem', color: '#3f3f46' }}>
            Click JSON lines to select fields — monitoring rules are saved to the <span style={{ color: '#52525b' }}>baseline</span> and apply to all tenants
          </div>
        )}
        {hasSelection && (
          <div style={{ padding: '3px 16px', flexShrink: 0, fontSize: '0.7rem', color: '#a78bfa' }}>
            {selectionCount} field{selectionCount !== 1 ? 's' : ''} selected — &quot;Apply to {selectionCount} field{selectionCount !== 1 ? 's' : ''} ▾&quot; saves to <span style={{ color: '#f59e0b' }}>baseline · all tenants</span>
          </div>
        )}

        {/* Messages */}
        {(error || success) && (
          <div style={{ padding: '6px 16px', flexShrink: 0 }}>
            {error   && <div style={{ color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{error}</div>}
            {success && <div style={{ color: '#86efac', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 5, padding: '7px 12px', fontSize: '0.8125rem' }}>{success}</div>}
          </div>
        )}

        {/* Baseline match indicator */}
        {baselineContent !== null && !error && selectedFile && !loading && (
          <div style={{ padding: '0 16px 3px', flexShrink: 0 }}>
            {isDiff ? (
              <div style={{ fontSize: '0.78rem', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>⚠</span><span>Differs from baseline{hasMonitorSidecar ? ' (monitored fields only)' : ''}</span>
              </div>
            ) : (
              <div style={{ fontSize: '0.78rem', color: '#22c55e', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>✓</span><span>Matches baseline{hasMonitorSidecar ? ' (monitored fields only)' : ''}</span>
              </div>
            )}
          </div>
        )}

        {/* Content area */}
        <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>

          {/* Field monitoring panel — inside scroll area, above JSON (matches legacy design) */}
          {selectedFile && !loading && content && content !== '(file not found)' && (
            <MonitorPanel
              filePath={selectedFile}
              mspSlug={mspSlug}
              fileState={fileMonitorState}
              folderState={folderMonitorState}
              fileSha={fileSidecarSha}
              folderSha={folderSidecarSha}
              onUpdate={handleMonitorUpdate}
            />
          )}

          {!selectedFile && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: '#52525b' }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="6" y="4" width="22" height="28" rx="2"/><path d="M10 2v3h3"/>
                <line x1="12" y1="17" x2="24" y2="17"/><line x1="12" y1="21" x2="20" y2="21"/>
              </svg>
              <p style={{ fontSize: '0.875rem' }}>Select a file to view its content</p>
            </div>
          )}

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: '#71717a' }}>
              <div style={{ width: 14, height: 14, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Loading…
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Tab bar — only for platform scripts that have a sibling script file */}
          {selectedFile && !loading && scriptContent !== null && (
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #27272a', background: '#0f0f11', flexShrink: 0 }}>
              {(['json', 'script'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{ padding: '6px 16px', fontSize: '0.75rem', fontWeight: 600, background: activeTab === tab ? '#18181b' : 'transparent', border: 'none', borderBottom: activeTab === tab ? '2px solid #22c55e' : '2px solid transparent', color: activeTab === tab ? '#e4e4e7' : '#52525b', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {tab === 'json' ? 'JSON' : 'Script'}
                  {tab === 'script' && scriptDiffers && (
                    <span style={{ fontSize: '0.6rem', background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.3)', color: '#fbbf24', borderRadius: 3, padding: '0 4px' }}>diff</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {selectedFile && !loading && activeTab === 'json' && !showDiff && content && renderAnnotatedJson(content)}

          {selectedFile && !loading && activeTab === 'json' && showDiff && isDiff && (
            <div style={{ overflow: 'auto' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid #27272a', padding: '6px 16px', fontSize: '0.75rem', fontWeight: 600, color: '#52525b', background: '#0f0f11', position: 'sticky', top: 0 }}>
                <div style={{ width: '50%', paddingRight: 10 }}>Baseline{hasMonitorSidecar ? ' (monitored fields)' : ''}</div>
                <div style={{ width: '50%', paddingLeft: 10, borderLeft: '1px solid #27272a' }}>Tenant ({selectedTenantSlug})</div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>{renderDiff(
                  (() => { try { return JSON.stringify(sortKeysDeep(applyFieldFilter(stripMetadataFields(JSON.parse((baselineContent ?? '{}').replace(/^\uFEFF/, '')), selectedFile ?? undefined), monitorConfig ?? {})), null, 2); } catch { return baselineContent ?? ''; } })(),
                  (() => { try { return JSON.stringify(sortKeysDeep(applyFieldFilter(stripMetadataFields(JSON.parse(content.replace(/^\uFEFF/, '')), selectedFile ?? undefined), monitorConfig ?? {})), null, 2); } catch { return content; } })(),
                )}</tbody>
              </table>
            </div>
          )}

          {/* Script tab — plain-text side-by-side diff of the sibling .ps1/.sh file */}
          {selectedFile && !loading && activeTab === 'script' && scriptContent !== null && (
            <div style={{ overflow: 'auto' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid #27272a', padding: '6px 16px', fontSize: '0.75rem', fontWeight: 600, color: '#52525b', background: '#0f0f11', position: 'sticky', top: 0 }}>
                <div style={{ width: '50%', paddingRight: 10 }}>Baseline script</div>
                <div style={{ width: '50%', paddingLeft: 10, borderLeft: '1px solid #27272a' }}>Tenant script ({selectedTenantSlug})</div>
              </div>
              {baselineScript !== null ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>{renderDiff(baselineScript, scriptContent)}</tbody>
                </table>
              ) : (
                <pre style={{ margin: 0, padding: '12px 16px', fontSize: '0.78rem', lineHeight: '1.6', color: '#d4d4d8', fontFamily: "'JetBrains Mono', Consolas, monospace" }}>{scriptContent}</pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
