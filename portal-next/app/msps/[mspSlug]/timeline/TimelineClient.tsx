'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

/* ── Types ────────────────────────────────────────────────────────────── */
interface TenantOption { slug: string; displayName: string; giteaOrg: string; }
interface CommitInfo { sha: string; message: string; author: string; date: string; }
interface FileEvent {
  id: string;
  path: string;
  fileName: string;
  dirPath: string;
  changeType: 'added' | 'modified' | 'removed';
  service: string;
  commit: CommitInfo;
  prevSha: string | null;
}

interface Props {
  mspSlug: string;
  tenants: TenantOption[];
  initialTenant?: string;
}

/* ── Service colors ───────────────────────────────────────────────────── */
const SERVICE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  entra:      { bg: 'rgba(59,130,246,0.15)',   fg: '#60a5fa', border: '#3b82f6' },
  intune:     { bg: 'rgba(139,92,246,0.15)',   fg: '#a78bfa', border: '#8b5cf6' },
  defender:   { bg: 'rgba(239,68,68,0.15)',    fg: '#f87171', border: '#ef4444' },
  exchange:   { bg: 'rgba(245,158,11,0.15)',   fg: '#fbbf24', border: '#f59e0b' },
  sharepoint: { bg: 'rgba(16,185,129,0.15)',   fg: '#34d399', border: '#10b981' },
  teams:      { bg: 'rgba(99,102,241,0.15)',   fg: '#818cf8', border: '#6366f1' },
  other:      { bg: 'rgba(113,113,122,0.2)',   fg: '#a1a1aa', border: '#52525b' },
};

/* ── Date helpers ─────────────────────────────────────────────────────── */
function daysAgo(n: number): Date { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d; }
function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmt(date: string): string {
  return new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(date: string): string {
  return new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

import { normalizedJsonText } from '@/lib/timeline-json';

/* ── Line diff ────────────────────────────────────────────────────────── */
interface DiffHunk { type: 'same' | 'add' | 'remove'; text: string; }

function computeLineDiff(before: string, after: string): DiffHunk[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > 400 || b.length > 400) {
    const setA = new Set(a), setB = new Set(b);
    const result: DiffHunk[] = [];
    for (const line of a) result.push(setB.has(line) ? { type: 'same', text: line } : { type: 'remove', text: line });
    for (const line of b) if (!setA.has(line)) result.push({ type: 'add', text: line });
    return result;
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: DiffHunk[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { result.unshift({ type: 'same', text: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { result.unshift({ type: 'add', text: b[j - 1] }); j--; }
    else { result.unshift({ type: 'remove', text: a[i - 1] }); i--; }
  }
  return result;
}

interface SbRow { type: 'same' | 'change'; left: { num: number; text: string } | null; right: { num: number; text: string } | null; }

function buildSideBySideRows(hunks: DiffHunk[]): SbRow[] {
  const rows: SbRow[] = [];
  let ln = 0, rn = 0, i = 0;
  while (i < hunks.length) {
    if (hunks[i].type === 'same') {
      ln++; rn++;
      rows.push({ type: 'same', left: { num: ln, text: hunks[i].text }, right: { num: rn, text: hunks[i].text } });
      i++;
    } else {
      const removes: string[] = [], adds: string[] = [];
      while (i < hunks.length && hunks[i].type !== 'same') {
        if (hunks[i].type === 'remove') removes.push(hunks[i].text);
        else adds.push(hunks[i].text);
        i++;
      }
      const maxLen = Math.max(removes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const hasL = j < removes.length;
        const hasR = j < adds.length;
        if (hasL) ln++;
        if (hasR) rn++;
        rows.push({
          type: 'change',
          left:  hasL ? { num: ln, text: removes[j] } : null,
          right: hasR ? { num: rn, text: adds[j] } : null,
        });
      }
    }
  }
  return rows;
}

/* ── Main component ───────────────────────────────────────────────────── */
export default function TimelineClient({ tenants, initialTenant }: Props) {
  const [selectedTenant, setSelectedTenant] = useState(initialTenant ?? '');
  const [preset, setPreset] = useState('7');
  const [fromDate, setFromDate] = useState(() => toInputDate(daysAgo(7)));
  const [toDate, setToDate]     = useState(() => toInputDate(new Date()));
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo]     = useState('');

  const [loading, setLoading]       = useState(false);
  const [loadError, setLoadError]   = useState('');
  const [allEvents, setAllEvents]   = useState<FileEvent[]>([]);
  const [filtered, setFiltered]     = useState<FileEvent[]>([]);
  const [search, setSearch]         = useState('');
  const [serviceFilter, setServiceFilter] = useState('all');

  const [selectedEvent, setSelectedEvent] = useState<FileEvent | null>(null);
  const [beforeText, setBeforeText]       = useState('');
  const [afterText, setAfterText]         = useState('');
  const [parseError, setParseError]       = useState(false);
  const [loadingDiff, setLoadingDiff]     = useState(false);
  const [diffError, setDiffError]         = useState('');

  const tenantRef = useRef(selectedTenant);
  tenantRef.current = selectedTenant;
  const listRef = useRef<HTMLDivElement>(null);

  /* ── Apply filters ─────────────────────────────────────────────────── */
  useEffect(() => {
    let evs = [...allEvents];
    if (serviceFilter !== 'all') evs = evs.filter(e => e.service === serviceFilter);
    if (search) {
      const q = search.toLowerCase();
      evs = evs.filter(e =>
        e.fileName.toLowerCase().includes(q) ||
        e.dirPath.toLowerCase().includes(q) ||
        e.commit.message.toLowerCase().includes(q) ||
        e.path.toLowerCase().includes(q)
      );
    }
    setFiltered(evs);
  }, [allEvents, search, serviceFilter]);

  /* ── Load timeline via API ─────────────────────────────────────────── */
  const loadTimeline = useCallback(async (tenantSlug: string, from: string, to: string) => {
    setLoading(true);
    setLoadError('');
    setAllEvents([]);
    setFiltered([]);
    setSelectedEvent(null);
    setBeforeText('');
    setAfterText('');

    try {
      const params = new URLSearchParams({ slug: tenantSlug, from, to, branch: 'main', limit: '100' });
      const res = await fetch(`/api/timeline/events?${params}`);
      const data = await res.json() as { events?: FileEvent[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (tenantRef.current !== tenantSlug) return;
      setAllEvents(data.events ?? []);
    } catch (err) {
      if (tenantRef.current === tenantSlug) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load timeline');
      }
    } finally {
      if (tenantRef.current === tenantSlug) setLoading(false);
    }
  }, []);

  /* ── Initial tenant deep-link ──────────────────────────────────────── */
  useEffect(() => {
    if (initialTenant && tenants.some(t => t.slug === initialTenant)) {
      setSelectedTenant(initialTenant);
      loadTimeline(initialTenant, fromDate, toDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Preset change ─────────────────────────────────────────────────── */
  function applyPreset(days: string) {
    setPreset(days);
    if (days === 'custom') {
      setCustomFrom(fromDate);
      setCustomTo(toDate);
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    const f = toInputDate(daysAgo(parseInt(days)));
    const t = toInputDate(new Date());
    setFromDate(f); setToDate(t);
    if (selectedTenant) loadTimeline(selectedTenant, f, t);
  }

  function applyCustom() {
    if (!customFrom || !customTo) return;
    setFromDate(customFrom); setToDate(customTo);
    setShowCustom(false);
    if (selectedTenant) loadTimeline(selectedTenant, customFrom, customTo);
  }

  function handleTenantChange(slug: string) {
    setSelectedTenant(slug);
    setAllEvents([]); setFiltered([]); setSelectedEvent(null);
    setBeforeText(''); setAfterText(''); setLoadError('');
    if (slug) loadTimeline(slug, fromDate, toDate);
  }

  /* ── Load diff for selected event ─────────────────────────────────── */
  async function selectEvent(ev: FileEvent) {
    setSelectedEvent(ev);
    setLoadingDiff(true);
    setDiffError('');
    setBeforeText('');
    setAfterText('');
    setParseError(false);

    try {
      const params = new URLSearchParams({
        slug: selectedTenant,
        path: ev.path,
        sha: ev.commit.sha,
        changeType: ev.changeType,
      });
      if (ev.prevSha) params.set('prevSha', ev.prevSha);
      const res  = await fetch(`/api/timeline/diff?${params}`);
      const data = await res.json() as { before?: string | null; after?: string | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      let before = '', after = '', hadParseError = false;
      try {
        before = normalizedJsonText(data.before ?? null);
        after  = normalizedJsonText(data.after ?? null);
      } catch {
        hadParseError = true;
        before = data.before ?? '';
        after  = data.after ?? '';
      }
      setBeforeText(before);
      setAfterText(after);
      setParseError(hadParseError);
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      setLoadingDiff(false);
    }
  }

  /* ── Scrubber data ─────────────────────────────────────────────────── */
  const scrubberCommits = (() => {
    const map: Record<string, { date: number; count: number }> = {};
    for (const ev of filtered) {
      const t = new Date(ev.commit.date).getTime();
      if (!map[ev.commit.sha]) map[ev.commit.sha] = { date: t, count: 0 };
      map[ev.commit.sha].count++;
    }
    return Object.entries(map).map(([sha, v]) => ({ sha, ...v })).sort((a, b) => a.date - b.date);
  })();

  const scrubMin = scrubberCommits[0]?.date ?? 0;
  const scrubMax = scrubberCommits.at(-1)?.date ?? 1;
  const scrubRange = scrubMax - scrubMin || 1;
  const maxCount = Math.max(...scrubberCommits.map(c => c.count), 1);

  function scrollToCommit(sha: string) {
    listRef.current
      ?.querySelector(`[data-commit="${sha}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const hasEvents = filtered.length > 0;

  /* ── Render ───────────────────────────────────────────────────────── */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>

      {/* ── Controls top bar ──────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, padding: '0 0 12px', flexWrap: 'wrap', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <svg style={{ position: 'absolute', left: 9, pointerEvents: 'none', color: '#52525b', width: 14, height: 14 }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="6"/><polyline points="8 4 8 8 11 10"/>
            </svg>
            <select
              value={selectedTenant}
              onChange={e => handleTenantChange(e.target.value)}
              style={{
                paddingLeft: 30, paddingRight: 12, height: 32,
                background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6,
                color: '#d4d4d8', fontSize: '0.8125rem', cursor: 'pointer',
                fontFamily: 'inherit', outline: 'none', minWidth: 180,
              }}
            >
              <option value="">— Select a tenant —</option>
              {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 2 }}>
            {['7', '14', '30', '60', '90', 'custom'].map(d => (
              <button
                key={d}
                onClick={() => applyPreset(d)}
                style={{
                  padding: '5px 10px', fontSize: '0.75rem', fontWeight: 600,
                  border: '1px solid ' + (preset === d ? '#22c55e' : '#27272a'),
                  borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                  background: preset === d ? 'rgba(34,197,94,0.12)' : '#18181b',
                  color: preset === d ? '#22c55e' : '#71717a',
                  transition: 'all 0.12s',
                }}
              >
                {d === 'custom' ? 'Custom' : `${d}d`}
              </button>
            ))}
          </div>

          {showCustom && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                style={{ height: 32, padding: '0 8px', fontSize: '0.8125rem', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', width: 130 }} />
              <span style={{ color: '#52525b' }}>→</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                style={{ height: 32, padding: '0 8px', fontSize: '0.8125rem', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', width: 130 }} />
              <button onClick={applyCustom} style={{
                height: 32, padding: '0 12px', background: '#22c55e', color: '#000',
                border: 'none', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer',
              }}>Apply</button>
            </div>
          )}
        </div>

        {selectedTenant && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#52525b', width: 13, height: 13, pointerEvents: 'none' }}
                viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/>
              </svg>
              <input
                placeholder="Search files…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  paddingLeft: 28, height: 32, width: 180, background: '#18181b',
                  border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8',
                  fontSize: '0.8125rem', fontFamily: 'inherit', outline: 'none',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {['all', 'entra', 'intune', 'defender', 'exchange', 'other'].map(f => (
                <button
                  key={f}
                  onClick={() => setServiceFilter(f)}
                  style={{
                    padding: '5px 9px', fontSize: '0.72rem', fontWeight: 600,
                    border: '1px solid ' + (serviceFilter === f ? '#22c55e' : '#27272a'),
                    borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
                    background: serviceFilter === f ? 'rgba(34,197,94,0.12)' : '#18181b',
                    color: serviceFilter === f ? '#22c55e' : '#71717a',
                    textTransform: 'capitalize',
                  }}
                >
                  {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────── */}
      {loadError && (
        <div style={{
          padding: '10px 14px', marginBottom: 8, borderRadius: 6, flexShrink: 0,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5',
          fontSize: '0.8125rem',
        }}>
          {loadError}
        </div>
      )}

      {/* ── Scrubber ──────────────────────────────────────────────────── */}
      {hasEvents && (
        <div style={{
          height: 52, flexShrink: 0, background: '#0f0f11',
          border: '1px solid #27272a', borderRadius: 6, marginBottom: 8, padding: '8px 14px',
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: '28px', left: 14, right: 14,
            height: 2, background: '#27272a', borderRadius: 1,
          }} />
          {scrubberCommits.map(c => {
            const pct  = ((c.date - scrubMin) / scrubRange) * 100;
            const size = 7 + Math.round((c.count / maxCount) * 8);
            const isSel = selectedEvent?.commit.sha === c.sha;
            return (
              <div
                key={c.sha}
                onClick={() => scrollToCommit(c.sha)}
                title={`${c.count} file change${c.count !== 1 ? 's' : ''}`}
                style={{
                  position: 'absolute', top: `calc(28px - ${size/2}px)`,
                  left: `calc(14px + ${pct.toFixed(1)}% - ${size/2}px)`,
                  width: size, height: size, borderRadius: '50%',
                  background: isSel ? '#22c55e' : '#3b82f6',
                  boxShadow: isSel ? '0 0 0 3px rgba(34,197,94,0.3)' : 'none',
                  cursor: 'pointer', transition: 'background 0.12s',
                }}
              />
            );
          })}
          <div style={{ position: 'absolute', bottom: 4, left: 14, right: 14, display: 'flex', justifyContent: 'space-between' }}>
            {scrubMin > 0 && (
              <span style={{ fontSize: '0.65rem', color: '#52525b' }}>{fmtDate(new Date(scrubMin).toISOString())}</span>
            )}
            {scrubMax > scrubMin && (
              <span style={{ fontSize: '0.65rem', color: '#52525b' }}>{fmtDate(new Date(scrubMax).toISOString())}</span>
            )}
          </div>
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 0', display: 'flex', gap: 8, overflow: 'hidden', minHeight: 0 }}>

        {loading && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#71717a' }}>
            <div style={{ width: 20, height: 20, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <span style={{ fontSize: '0.8125rem' }}>Loading commit history…</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {!loading && !selectedTenant && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="24" cy="24" r="20"/><polyline points="24 12 24 24 32 30"/>
            </svg>
            <p style={{ fontSize: '0.875rem' }}>Select a tenant to view its commit timeline</p>
          </div>
        )}

        {!loading && selectedTenant && !loadError && !hasEvents && allEvents.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="24" cy="24" r="20"/><line x1="16" y1="16" x2="32" y2="32"/><line x1="32" y1="16" x2="16" y2="32"/>
            </svg>
            <p style={{ fontSize: '0.875rem' }}>No file changes found in this date range</p>
          </div>
        )}

        {!loading && hasEvents && (
          <>
            <div style={{
              width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
              minHeight: 0, overflow: 'hidden',
              background: '#0f0f11', border: '1px solid #27272a', borderRadius: 6,
            }}>
              <div style={{
                padding: '8px 12px', borderBottom: '1px solid #27272a',
                fontSize: '0.6875rem', fontWeight: 600, color: '#52525b',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                flexShrink: 0,
              }}>
                <span>File Changes</span>
                <span style={{ background: '#27272a', color: '#71717a', padding: '1px 7px', borderRadius: 10, fontSize: '0.65rem' }}>
                  {filtered.length}
                </span>
              </div>
              <div ref={listRef} style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                {filtered.map(ev => {
                  const svc  = SERVICE_COLORS[ev.service] ?? SERVICE_COLORS.other;
                  const isSel = selectedEvent?.id === ev.id;
                  const ctMap = { added: { label: 'Added', color: '#22c55e' }, removed: { label: 'Deleted', color: '#f87171' }, modified: { label: 'Modified', color: '#fbbf24' } };
                  const ct = ctMap[ev.changeType] ?? ctMap.modified;
                  return (
                    <div
                      key={ev.id}
                      data-commit={ev.commit.sha}
                      onClick={() => selectEvent(ev)}
                      style={{
                        display: 'flex', alignItems: 'stretch', gap: 0,
                        borderBottom: '1px solid #1a1a1d', cursor: 'pointer',
                        background: isSel ? 'rgba(34,197,94,0.06)' : 'transparent',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = '#18181b'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSel ? 'rgba(34,197,94,0.06)' : 'transparent'; }}
                    >
                      <div style={{ width: 3, background: svc.border, flexShrink: 0 }} />
                      <div style={{ flex: 1, padding: '9px 11px', minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5, flexWrap: 'wrap' }}>
                          <span style={{
                            fontSize: '0.6rem', fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                            background: svc.bg, color: svc.fg, textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>{ev.service}</span>
                          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: ct.color }}>{ct.label}</span>
                          <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#52525b', flexShrink: 0 }}>{fmt(ev.commit.date)}</span>
                        </div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 500, color: isSel ? '#22c55e' : '#d4d4d8', fontFamily: 'monospace', lineHeight: 1.35, wordBreak: 'break-all' }}>
                          {ev.path}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {ev.commit.message}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{
              flex: '1 1 0', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
              background: '#09090b', border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden',
            }}>
              {!selectedEvent && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#52525b' }}>
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="24" cy="24" r="20"/><polyline points="24 12 24 24 32 30"/>
                  </svg>
                  <p style={{ fontSize: '0.875rem' }}>Select a file change to view its diff</p>
                </div>
              )}

              {selectedEvent && (
                <div style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
                    {(() => {
                      const svc = SERVICE_COLORS[selectedEvent.service] ?? SERVICE_COLORS.other;
                      const ctMap = { added: 'Added', removed: 'Deleted', modified: 'Modified' };
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: svc.bg, color: svc.fg, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              {selectedEvent.service}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e4e4e7', fontFamily: 'monospace', lineHeight: 1.4, wordBreak: 'break-all', marginBottom: 8 }}>
                            {selectedEvent.path}
                          </div>
                          <div style={{ display: 'flex', gap: 16, fontSize: '0.75rem', color: '#71717a', flexWrap: 'wrap' }}>
                            <span><span style={{ color: '#52525b' }}>Status:</span> {ctMap[selectedEvent.changeType] ?? selectedEvent.changeType}</span>
                            <span><span style={{ color: '#52525b' }}>Date:</span> {fmt(selectedEvent.commit.date)}</span>
                            <span><span style={{ color: '#52525b' }}>Author:</span> {selectedEvent.commit.author}</span>
                            <span><span style={{ color: '#52525b' }}>Commit:</span> <code style={{ fontSize: '0.7rem' }}>{selectedEvent.commit.sha.slice(0, 7)}</code></span>
                          </div>
                          <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#a1a1aa' }}>{selectedEvent.commit.message}</div>
                        </>
                      );
                    })()}
                  </div>

                  <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', overflowX: 'auto', fontFamily: 'monospace', overscrollBehavior: 'contain' }}>
                    {loadingDiff && (
                      <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 10, color: '#71717a' }}>
                        <div style={{ width: 14, height: 14, border: '2px solid #27272a', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                        Loading diff…
                      </div>
                    )}
                    {!loadingDiff && diffError && (
                      <div style={{ padding: 24, color: '#fca5a5', fontSize: '0.8rem' }}>{diffError}</div>
                    )}
                    {!loadingDiff && !diffError && (
                      <SideBySideDiffViewer
                        before={beforeText}
                        after={afterText}
                        changeType={selectedEvent.changeType}
                        parseError={parseError}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Side-by-side diff viewer ─────────────────────────────────────────── */
function SideBySideDiffViewer({
  before, after, changeType, parseError,
}: {
  before: string;
  after: string;
  changeType: 'added' | 'modified' | 'removed';
  parseError: boolean;
}) {
  if (changeType === 'added' && after) {
    const lines = after.split('\n');
    return (
      <DiffTable
        rows={lines.map((text, i) => ({
          type: 'change' as const,
          left: null,
          right: { num: i + 1, text },
        }))}
        label="New file"
        parseError={parseError}
      />
    );
  }

  if (changeType === 'removed' && before) {
    const lines = before.split('\n');
    return (
      <DiffTable
        rows={lines.map((text, i) => ({
          type: 'change' as const,
          left: { num: i + 1, text },
          right: null,
        }))}
        label="File deleted"
        parseError={parseError}
      />
    );
  }

  if (!before && !after) {
    return <div style={{ padding: 24, color: '#52525b', fontSize: '0.8rem' }}>Content unavailable</div>;
  }

  const hunks = computeLineDiff(before, after);
  const adds  = hunks.filter(h => h.type === 'add').length;
  const rems  = hunks.filter(h => h.type === 'remove').length;

  if (adds === 0 && rems === 0) {
    return <div style={{ padding: 24, color: '#52525b', fontSize: '0.8rem' }}>Content is identical</div>;
  }

  return (
    <DiffTable
      rows={buildSideBySideRows(hunks)}
      label={`−${rems} +${adds}`}
      parseError={parseError}
    />
  );
}

function DiffTable({ rows, label, parseError }: { rows: SbRow[]; label: string; parseError: boolean }) {
  const CONTEXT = 3;
  const changed = new Set(rows.map((r, i) => r.type === 'change' ? i : -1).filter(i => i >= 0));
  const visible = new Set<number>();
  changed.forEach(ci => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) {
      const idx = ci + d;
      if (idx >= 0 && idx < rows.length) visible.add(idx);
    }
  });

  return (
    <div>
      <div style={{
        padding: '8px 14px', borderBottom: '1px solid #27272a', fontSize: '0.75rem',
        color: '#71717a', display: 'flex', justifyContent: 'space-between',
      }}>
        <span>{label}</span>
        {parseError && <span style={{ color: '#fbbf24' }}>Raw text mode — not valid JSON</span>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', lineHeight: '1.5' }}>
        <thead>
          <tr>
            <th colSpan={2} style={{ padding: '6px 10px', textAlign: 'left', color: '#52525b', borderBottom: '1px solid #27272a', fontWeight: 600 }}>Before</th>
            <th colSpan={2} style={{ padding: '6px 10px', textAlign: 'left', color: '#52525b', borderBottom: '1px solid #27272a', fontWeight: 600 }}>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            if (!visible.has(i)) return null;
            const leftBg  = row.left  ? (row.type === 'change' ? 'rgba(239,68,68,0.08)' : 'transparent') : 'transparent';
            const rightBg = row.right ? (row.type === 'change' ? 'rgba(34,197,94,0.08)' : 'transparent') : 'transparent';
            return (
              <tr key={i}>
                <td style={{ padding: '0 6px', color: '#3f3f46', textAlign: 'right', userSelect: 'none', width: 36, background: leftBg, borderRight: '1px solid #1e1e20' }}>
                  {row.left?.num ?? ''}
                </td>
                <td style={{ padding: '0 10px 0 0', color: row.type === 'change' ? '#fca5a5' : '#71717a', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: leftBg, borderRight: '1px solid #27272a' }}>
                  {row.left?.text ?? ''}
                </td>
                <td style={{ padding: '0 6px', color: '#3f3f46', textAlign: 'right', userSelect: 'none', width: 36, background: rightBg, borderRight: '1px solid #1e1e20' }}>
                  {row.right?.num ?? ''}
                </td>
                <td style={{ padding: '0 10px 0 0', color: row.type === 'change' ? '#86efac' : '#71717a', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: rightBg }}>
                  {row.right?.text ?? ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
