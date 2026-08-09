'use client';
import { useState, useMemo, useEffect } from 'react';
import SecureScoreTrendChart, { type ScoreHistoryPoint } from '@/components/secure-score/SecureScoreTrendChart';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ControlStateUpdate {
  state: string;
  updatedDateTime?: string | null;
  assignedTo?: string | null;
  comment?: string | null;
}

interface ControlProfile {
  id: string;
  title: string;
  controlCategory: string;
  service: string;
  maxScore: number;
  currentScore: number | null;
  // New fields (added in updated backup script)
  computedStatus?: string;       // scored | default | notApplicable
  statusDescription?: string | null;
  controlStateUpdates?: ControlStateUpdate[] | null;
  // Legacy field (old backups only, no longer written)
  implementationStatus?: string | null;
  actionType: string;
  actionUrl: string | null;
  tier: string;
  userImpact: string;
  implementationCost: string;
  threats: string[];
  remediation: string | null;
  remediationImpact: string | null;
  rank: number;
}

interface ScoreData {
  currentScore: number;
  maxScore: number;
  activeUserCount: number;
  createdDateTime: string;
  enabledServices: string[];
}

export interface SecureScoreClientProps {
  tenantName: string;
  mspSlug: string;
  tenantSlug: string;
  score: ScoreData | null;
  controls: ControlProfile[];
  backedUpAt?: string | null;
  notBacked?: boolean;
  licenceWarning?: boolean;
  licenceDetail?: string;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function getEffectiveStatus(c: ControlProfile): string {
  // Admin-set override wins (most recent state, skip Default)
  const updates = c.controlStateUpdates ?? [];
  const sorted = [...updates].sort(
    (a, b) => (b.updatedDateTime ?? '').localeCompare(a.updatedDateTime ?? ''),
  );
  const latest = sorted[0];
  if (latest?.state && latest.state !== 'Default') {
    return latest.state.toLowerCase(); // 'ignored' | 'thirdparty' | 'reviewed'
  }
  // Use computedStatus from new backups
  if (c.computedStatus) return c.computedStatus;
  // Fallback: compute from scores (existing backups before this fix)
  if (c.currentScore === null || c.currentScore === undefined) return 'notApplicable';
  if (c.currentScore >= c.maxScore && c.maxScore > 0) return 'scored';
  return 'default';
}

const STATUS_LABELS: Record<string, string> = {
  scored:        'Completed',
  default:       'Needs action',
  notApplicable: 'Not applicable',
  ignored:       'Ignored',
  thirdparty:    'Third party',
  reviewed:      'Reviewed',
};

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  scored:        { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.25)'   },
  default:       { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.25)'  },
  notApplicable: { color: '#71717a', bg: 'rgba(113,113,122,0.1)', border: 'rgba(113,113,122,0.2)' },
  ignored:       { color: '#52525b', bg: 'rgba(82,82,91,0.1)',    border: 'rgba(82,82,91,0.2)'    },
  thirdparty:    { color: '#818cf8', bg: 'rgba(129,140,248,0.1)', border: 'rgba(129,140,248,0.25)'},
  reviewed:      { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.25)' },
};

const CATEGORY_COLORS: Record<string, string> = {
  Identity:       '#818cf8',
  Device:         '#34d399',
  Apps:           '#60a5fa',
  Data:           '#f472b6',
  Infrastructure: '#fb923c',
};

function statusStyle(status: string): React.CSSProperties {
  const s = STATUS_COLORS[status] ?? STATUS_COLORS.notApplicable;
  return {
    display: 'inline-block',
    padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600,
    color: s.color, background: s.bg, border: `1px solid ${s.border}`,
    whiteSpace: 'nowrap',
  };
}

function categoryDot(cat: string) {
  const color = CATEGORY_COLORS[cat] ?? '#71717a';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: '#a1a1aa' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
      {cat}
    </span>
  );
}

function scoreColor(pct: number): string {
  if (pct >= 75) return '#22c55e';
  if (pct >= 50) return '#f59e0b';
  return '#ef4444';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function stripHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Score ring ────────────────────────────────────────────────────────────────

function ScoreRing({ pct, color }: { pct: number; color: string }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width="110" height="110" viewBox="0 0 110 110" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="55" cy="55" r={r} fill="none" stroke="#27272a" strokeWidth="9" />
      <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="9"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.5s ease' }} />
    </svg>
  );
}

// ── Category breakdown bar ────────────────────────────────────────────────────

function CategoryBreakdown({ controls }: { controls: ControlProfile[] }) {
  const cats = Object.keys(CATEGORY_COLORS);
  const totals = cats.map(cat => {
    const group = controls.filter(c => c.controlCategory === cat);
    const earned = group.reduce((s, c) => s + (c.currentScore ?? 0), 0);
    const max    = group.reduce((s, c) => s + (c.maxScore ?? 0), 0);
    return { cat, earned, max };
  }).filter(c => c.max > 0);

  if (totals.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: '0.7rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 12 }}>
        Score by category
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {totals.map(({ cat, earned, max }) => {
          const pct = max > 0 ? (earned / max) * 100 : 0;
          const color = CATEGORY_COLORS[cat] ?? '#71717a';
          return (
            <div key={cat}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: '0.78rem', color: '#a1a1aa', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
                  {cat}
                </span>
                <span style={{ fontSize: '0.75rem', color: '#71717a', fontFamily: 'monospace' }}>
                  {Math.round(earned)} / {Math.round(max)}
                </span>
              </div>
              <div style={{ height: 6, background: '#27272a', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Expandable control row ────────────────────────────────────────────────────

const fmtScore = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);

function ControlRow({ c, overallMaxScore }: { c: ControlProfile; overallMaxScore: number }) {
  const [expanded, setExpanded] = useState(false);
  const status = getEffectiveStatus(c);
  const isApplicable = status !== 'notApplicable';
  const scoreImpact = isApplicable && overallMaxScore > 0
    ? ((c.maxScore - (c.currentScore ?? 0)) / overallMaxScore) * 100
    : null;

  const pointsDisplay = c.currentScore !== null && c.currentScore !== undefined
    ? `${fmtScore(Number(c.currentScore))} / ${fmtScore(Number(c.maxScore))}`
    : '— / ' + fmtScore(Number(c.maxScore));

  const statusDesc = stripHtml(c.statusDescription);

  return (
    <>
      <tr onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer', background: expanded ? '#0d1117' : undefined }}>
        <td style={{ fontSize: '0.75rem', color: '#52525b', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          {c.rank ? `#${c.rank}` : '—'}
        </td>
        <td style={{ fontWeight: 500, fontSize: '0.82rem', color: '#e4e4e7' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#52525b', fontSize: '0.65rem', transition: 'transform 0.15s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            {c.title}
          </span>
        </td>
        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: scoreImpact && scoreImpact > 0 ? '#f59e0b' : '#52525b', whiteSpace: 'nowrap' }}>
          {scoreImpact !== null && scoreImpact > 0 ? `+${scoreImpact.toFixed(2)}%` : '—'}
        </td>
        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'nowrap', color: isApplicable ? '#e4e4e7' : '#52525b' }}>
          {pointsDisplay}
        </td>
        <td><span style={statusStyle(status)}>{STATUS_LABELS[status] ?? status}</span></td>
        <td>{categoryDot(c.controlCategory)}</td>
        <td style={{ fontSize: '0.75rem', color: '#71717a', whiteSpace: 'nowrap' }}>{c.service || '—'}</td>
      </tr>
      {expanded && (
        <tr style={{ background: '#0d1117' }}>
          <td colSpan={7} style={{ padding: '10px 16px 14px 40px', borderBottom: '1px solid #1f1f23' }}>
            {statusDesc && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: '0.68rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Current status</div>
                <div style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>{statusDesc}</div>
              </div>
            )}
            {c.remediation && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.68rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Remediation</div>
                <div
                  className="secure-score-remediation"
                  style={{ fontSize: '0.8rem', color: '#a1a1aa', lineHeight: 1.6 }}
                  dangerouslySetInnerHTML={{ __html: c.remediation }}
                />
              </div>
            )}
            {c.remediationImpact && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.68rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Impact</div>
                <div style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>{stripHtml(c.remediationImpact)}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {c.tier && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Tier: {c.tier}</span>}
              {c.userImpact && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>User impact: {c.userImpact}</span>}
              {c.implementationCost && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Cost: {c.implementationCost}</span>}
              {c.threats && c.threats.length > 0 && (
                <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Threats: {c.threats.join(', ')}</span>
              )}
              {c.actionUrl && (
                <a href={c.actionUrl} target="_blank" rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  style={{ fontSize: '0.72rem', color: '#60a5fa', textDecoration: 'none', marginLeft: 'auto' }}>
                  View in Microsoft ↗
                </a>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortCol = 'rank' | 'scoreImpact' | 'pointsAchieved' | 'status' | 'category' | 'product';
type SortDir = 'asc' | 'desc';

function sortIndicator(col: SortCol, active: SortCol, dir: SortDir) {
  if (col !== active) return <span style={{ opacity: 0.25, fontSize: '0.65rem', marginLeft: 3 }}>↕</span>;
  return <span style={{ fontSize: '0.65rem', marginLeft: 3 }}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

// ── Main client component ─────────────────────────────────────────────────────

type FilterType = 'all' | 'default' | 'scored' | 'notApplicable' | 'ignored';

export default function SecureScoreClient({
  tenantName: _tenantName,
  mspSlug,
  tenantSlug,
  score,
  controls,
  backedUpAt,
  notBacked,
  licenceWarning,
  licenceDetail,
}: SecureScoreClientProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [historyDays, setHistoryDays] = useState<30 | 90>(30);
  const [history, setHistory] = useState<ScoreHistoryPoint[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (licenceWarning || notBacked) return;
    let cancelled = false;
    setHistoryLoading(true);
    fetch(`/api/tenants/${tenantSlug}/secure-score/history?days=${historyDays}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.points) return;
        setHistory(data.points.map((p: ScoreHistoryPoint) => ({
          date: p.date,
          percent: p.percent,
          currentScore: p.currentScore,
          maxScore: p.maxScore,
        })));
      })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [tenantSlug, historyDays, licenceWarning, notBacked]);

  function handleSort(col: SortCol) {
    if (col === sortCol) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  const categories = useMemo(() => {
    const cats = [...new Set(controls.map(c => c.controlCategory).filter(Boolean))].sort();
    return cats;
  }, [controls]);

  const filtered = useMemo(() => {
    let list = controls;
    if (filter === 'default')       list = list.filter(c => getEffectiveStatus(c) === 'default');
    else if (filter === 'scored')   list = list.filter(c => getEffectiveStatus(c) === 'scored');
    else if (filter === 'notApplicable') list = list.filter(c => getEffectiveStatus(c) === 'notApplicable');
    else if (filter === 'ignored')  list = list.filter(c => ['ignored', 'thirdparty', 'reviewed'].includes(getEffectiveStatus(c)));
    if (categoryFilter !== 'all') list = list.filter(c => c.controlCategory === categoryFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.title.toLowerCase().includes(q) || (c.remediation ?? '').toLowerCase().includes(q));
    }
    // Dynamic sort based on sortCol / sortDir
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'rank':
          cmp = (a.rank ?? 9999) - (b.rank ?? 9999);
          break;
        case 'scoreImpact':
          cmp = (b.maxScore - (b.currentScore ?? 0)) - (a.maxScore - (a.currentScore ?? 0));
          break;
        case 'pointsAchieved':
          cmp = (a.currentScore ?? -1) - (b.currentScore ?? -1);
          break;
        case 'status':
          cmp = (STATUS_LABELS[getEffectiveStatus(a)] ?? '').localeCompare(STATUS_LABELS[getEffectiveStatus(b)] ?? '');
          break;
        case 'category':
          cmp = (a.controlCategory ?? '').localeCompare(b.controlCategory ?? '');
          break;
        case 'product':
          cmp = (a.service ?? '').localeCompare(b.service ?? '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [controls, filter, categoryFilter, search, sortCol, sortDir]);

  const pct = score && score.maxScore > 0 ? (score.currentScore / score.maxScore) * 100 : null;
  const ringColor = pct !== null ? scoreColor(pct) : '#71717a';
  const overallMaxScore = score?.maxScore ?? 0;

  const needsActionCount   = controls.filter(c => getEffectiveStatus(c) === 'default').length;
  const completedCount     = controls.filter(c => getEffectiveStatus(c) === 'scored').length;
  const notApplicableCount = controls.filter(c => getEffectiveStatus(c) === 'notApplicable').length;
  const ignoredCount       = controls.filter(c => ['ignored', 'thirdparty', 'reviewed'].includes(getEffectiveStatus(c))).length;

  const filterBtn = (f: FilterType, label: string, count: number) => (
    <button key={f} onClick={() => setFilter(f)} style={{
      padding: '5px 12px', fontSize: '0.78rem', borderRadius: 5, cursor: 'pointer',
      fontFamily: 'inherit', fontWeight: filter === f ? 700 : 400,
      background: filter === f ? '#18181b' : 'transparent',
      border: `1px solid ${filter === f ? '#3f3f46' : '#27272a'}`,
      color: filter === f ? '#e4e4e7' : '#71717a',
    }}>
      {label} <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{count}</span>
    </button>
  );

  return (
    <div>
      <a href={`/msps/${mspSlug}`} style={{ fontSize: '0.8rem', color: '#52525b', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 20 }}>
        ← Back to dashboard
      </a>

      {licenceWarning && (
        <div style={{ padding: '14px 18px', borderRadius: 8, background: '#1a1200', border: '1px solid #78350f', marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#fbbf24', marginBottom: 4 }}>Secure Score unavailable</div>
          <div style={{ fontSize: '0.8rem', color: '#92400e' }}>{licenceDetail ?? 'This tenant does not have the required permissions for Secure Score (SecurityEvents.Read.All).'}</div>
        </div>
      )}
      {notBacked && !licenceWarning && (
        <div style={{ padding: '14px 18px', borderRadius: 8, background: '#111113', border: '1px solid #27272a', marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#a1a1aa', marginBottom: 4 }}>No Secure Score data yet</div>
          <div style={{ fontSize: '0.8rem', color: '#52525b' }}>The nightly backup hasn&apos;t run yet or the Secure Score step has not completed. Run a backup to populate this view.</div>
        </div>
      )}

      {score && (
        <>
          <div style={{ display: 'flex', gap: 32, marginBottom: 28, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 110, height: 110, flexShrink: 0 }}>
              <ScoreRing pct={pct ?? 0} color={ringColor} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '1.4rem', fontWeight: 800, color: ringColor, lineHeight: 1 }}>
                  {Math.round(score.currentScore)}
                </span>
                <span style={{ fontSize: '0.65rem', color: '#52525b', marginTop: 2 }}>/ {Math.round(score.maxScore)}</span>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e4e4e7' }}>
                {pct?.toFixed(1)}% <span style={{ fontSize: '0.8rem', fontWeight: 400, color: '#52525b' }}>of max achievable score</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#71717a' }}>
                {score.activeUserCount} active users · {score.enabledServices?.length ?? 0} services monitored
              </div>
              <div style={{ fontSize: '0.75rem', color: '#52525b' }}>
                Score date: {fmtDate(score.createdDateTime)} · Backed up: {fmtDate(backedUpAt)}
              </div>
            </div>

            {controls.length > 0 && (
              <div style={{ minWidth: 260, flex: '0 0 260px' }}>
                <CategoryBreakdown controls={controls} />
              </div>
            )}
          </div>

          <div style={{ marginBottom: 28, padding: '16px 18px', background: '#111113', border: '1px solid #27272a', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: '0.7rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                Score over time
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {([30, 90] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => setHistoryDays(d)}
                    style={{
                      padding: '4px 10px', fontSize: '0.72rem', borderRadius: 4, cursor: 'pointer',
                      fontFamily: 'inherit', fontWeight: historyDays === d ? 700 : 400,
                      background: historyDays === d ? '#18181b' : 'transparent',
                      border: `1px solid ${historyDays === d ? '#3f3f46' : '#27272a'}`,
                      color: historyDays === d ? '#e4e4e7' : '#71717a',
                    }}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
            {historyLoading ? (
              <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '0.82rem' }}>
                Loading history…
              </div>
            ) : (
              <SecureScoreTrendChart data={history} height={180} color={ringColor} />
            )}
            {history.length > 0 && (
              <div style={{ fontSize: '0.72rem', color: '#3f3f46', marginTop: 8 }}>
                {history.length} day{history.length !== 1 ? 's' : ''} of history · from nightly backup
              </div>
            )}
          </div>
        </>
      )}

      {controls.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {filterBtn('all',           'All',            controls.length)}
              {filterBtn('default',       'Needs action',   needsActionCount)}
              {filterBtn('scored',        'Completed',      completedCount)}
              {filterBtn('notApplicable', 'Not applicable', notApplicableCount)}
              {ignoredCount > 0 && filterBtn('ignored', 'Ignored', ignoredCount)}
            </div>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
              style={{ padding: '5px 10px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#a1a1aa', fontSize: '0.78rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
              <option value="all">All categories</option>
              {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
            <div style={{ flex: 1, position: 'relative', minWidth: 160 }}>
              <svg style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#52525b', pointerEvents: 'none' }} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="6.5" cy="6.5" r="4" /><path d="M11 11l3 3" />
              </svg>
              <input type="text" placeholder="Search controls…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ width: '100%', padding: '5px 10px 5px 28px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#d4d4d8', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }} />
            </div>
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  {([
                    ['rank',          'Rank',            '48px'],
                    [null,            'Control',         'auto'],
                    ['scoreImpact',   'Score impact',    undefined],
                    ['pointsAchieved','Points achieved', undefined],
                    ['status',        'Status',          undefined],
                    ['category',      'Category',        undefined],
                    ['product',       'Product',         undefined],
                  ] as [SortCol | null, string, string | undefined][]).map(([col, label, w]) => (
                    <th
                      key={label}
                      onClick={col ? () => handleSort(col) : undefined}
                      title={col ? `Sort by ${label}` : undefined}
                      style={{
                        width: w,
                        whiteSpace: 'nowrap',
                        cursor: col ? 'pointer' : undefined,
                        userSelect: col ? 'none' : undefined,
                      }}
                    >
                      {label}
                      {col && sortIndicator(col, sortCol, sortDir)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: '#52525b', padding: '24px 0', fontSize: '0.85rem' }}>No controls match your filters.</td></tr>
                ) : (
                  filtered.map(c => <ControlRow key={c.id} c={c} overallMaxScore={overallMaxScore} />)
                )}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '0.72rem', color: '#3f3f46', marginTop: 8 }}>
            Showing {filtered.length} of {controls.length} controls · Click a row to expand details
          </div>
        </>
      )}
    </div>
  );
}
