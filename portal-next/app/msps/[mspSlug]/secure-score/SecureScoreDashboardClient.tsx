'use client';
import { useState, useMemo } from 'react';
import type { TenantScoreRow, CrossTenantControl, SecureScoreHistoryPoint } from './page';
import SecureScoreTrendChart, { SecureScoreSparkline } from '@/components/secure-score/SecureScoreTrendChart';

interface Props {
  rows: TenantScoreRow[];
  mspSlug: string;
  allControls: CrossTenantControl[];
  aggregateHistory: SecureScoreHistoryPoint[];
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function scoreColor(pct: number): string {
  if (pct >= 75) return '#22c55e';
  if (pct >= 50) return '#f59e0b';
  return '#ef4444';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function stripHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function getEffectiveStatus(c: CrossTenantControl): string {
  const updates = c.controlStateUpdates ?? [];
  const sorted = [...updates].sort(
    (a, b) => (b.updatedDateTime ?? '').localeCompare(a.updatedDateTime ?? ''),
  );
  const latest = sorted[0];
  if (latest?.state && latest.state !== 'Default') return latest.state.toLowerCase();
  if (c.computedStatus) return c.computedStatus;
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
  scored:        { color: '#22c55e', bg: 'rgba(34,197,94,0.1)',    border: 'rgba(34,197,94,0.25)'   },
  default:       { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.25)'  },
  notApplicable: { color: '#71717a', bg: 'rgba(113,113,122,0.1)', border: 'rgba(113,113,122,0.2)'  },
  ignored:       { color: '#52525b', bg: 'rgba(82,82,91,0.1)',    border: 'rgba(82,82,91,0.2)'     },
  thirdparty:    { color: '#818cf8', bg: 'rgba(129,140,248,0.1)', border: 'rgba(129,140,248,0.25)' },
  reviewed:      { color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.25)'  },
};

const CATEGORY_COLORS: Record<string, string> = {
  Identity: '#818cf8', Device: '#34d399', Apps: '#60a5fa', Data: '#f472b6', Infrastructure: '#fb923c',
};

function statusBadge(status: string) {
  const s = STATUS_COLORS[status] ?? STATUS_COLORS.notApplicable;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap',
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
    }}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
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

// ── Sort indicator ────────────────────────────────────────────────────────────

function SortInd<T extends string>({ col, active, dir }: { col: T; active: T; dir: 'asc' | 'desc' }) {
  if (col !== active) return <span style={{ opacity: 0.25, fontSize: '0.65rem', marginLeft: 3 }}>↕</span>;
  return <span style={{ fontSize: '0.65rem', marginLeft: 3 }}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

// ── Mini score bar ────────────────────────────────────────────────────────────

function ScoreBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 6, background: '#27272a', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: '0.78rem', fontFamily: 'monospace', color, minWidth: 42, textAlign: 'right' }}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ── Tenant status badge ───────────────────────────────────────────────────────

function TenantStatusBadge({ status }: { status: TenantScoreRow['status'] }) {
  const s: Record<string, React.CSSProperties> = {
    ok:       { color: '#22c55e', background: 'rgba(34,197,94,0.1)',   border: '1px solid rgba(34,197,94,0.25)'   },
    error:    { color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)' },
    notBacked:{ color: '#71717a', background: 'rgba(113,113,122,0.1)', border: '1px solid rgba(113,113,122,0.2)'  },
  };
  const labels = { ok: 'Data available', error: 'Permission error', notBacked: 'Not backed up' };
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap', ...s[status] }}>
      {labels[status]}
    </span>
  );
}

// ── Expandable recommendations row ───────────────────────────────────────────

const fmtScore = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);

function RecommendationRow({ c, mspSlug }: { c: CrossTenantControl; mspSlug: string }) {
  const [expanded, setExpanded] = useState(false);
  const status = getEffectiveStatus(c);
  const isApplicable = status !== 'notApplicable';
  const scoreImpact = isApplicable && c.tenantMaxScore && c.tenantMaxScore > 0
    ? ((c.maxScore - (c.currentScore ?? 0)) / c.tenantMaxScore) * 100
    : null;
  const pointsDisplay = c.currentScore !== null && c.currentScore !== undefined
    ? `${fmtScore(Number(c.currentScore))} / ${fmtScore(Number(c.maxScore))}`
    : `— / ${fmtScore(Number(c.maxScore))}`;
  const statusDesc = stripHtml(c.statusDescription);

  return (
    <>
      <tr onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer', background: expanded ? '#0d1117' : undefined }}>
        <td style={{ fontSize: '0.75rem', fontWeight: 500 }}>
          <a
            href={`/msps/${mspSlug}/tenants/${c.tenantSlug}/secure-score`}
            onClick={e => e.stopPropagation()}
            style={{ color: '#60a5fa', textDecoration: 'none', fontSize: '0.78rem' }}
          >
            {c.tenantName}
          </a>
        </td>
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
        <td>{statusBadge(status)}</td>
        <td>{categoryDot(c.controlCategory)}</td>
        <td style={{ fontSize: '0.75rem', color: '#71717a', whiteSpace: 'nowrap' }}>{c.service || '—'}</td>
      </tr>
      {expanded && (
        <tr style={{ background: '#0d1117' }}>
          <td colSpan={8} style={{ padding: '10px 16px 14px 40px', borderBottom: '1px solid #1f1f23' }}>
            {statusDesc && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: '0.68rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Current status</div>
                <div style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>{statusDesc}</div>
              </div>
            )}
            {c.remediation && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.68rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Remediation</div>
                <div style={{ fontSize: '0.8rem', color: '#a1a1aa', lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: c.remediation }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {c.tier && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Tier: {c.tier}</span>}
              {c.userImpact && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>User impact: {c.userImpact}</span>}
              {c.implementationCost && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Cost: {c.implementationCost}</span>}
              {c.threats?.length > 0 && <span style={{ fontSize: '0.72rem', color: '#71717a' }}>Threats: {c.threats.join(', ')}</span>}
              {c.actionUrl && (
                <a href={c.actionUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
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

// ── Overview tab ──────────────────────────────────────────────────────────────

type OvSortCol = 'name' | 'score' | 'pct' | 'backedUpAt';

function OverviewTab({ rows, mspSlug, aggregateHistory }: { rows: TenantScoreRow[]; mspSlug: string; aggregateHistory: SecureScoreHistoryPoint[] }) {
  const [search, setSearch]   = useState('');
  const [sortCol, setSortCol] = useState<OvSortCol>('score');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function handleSort(col: OvSortCol) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const okRows      = rows.filter(r => r.status === 'ok');
  const avgPct      = okRows.length > 0 ? okRows.reduce((s, r) => s + (r.pct ?? 0), 0) / okRows.length : null;
  const avgColor    = avgPct !== null ? scoreColor(avgPct) : '#71717a';
  const noDataCount = rows.filter(r => r.status === 'notBacked').length;
  const errCount    = rows.filter(r => r.status === 'error').length;

  const filtered = useMemo(() => {
    let list = rows;
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter(r => r.displayName.toLowerCase().includes(q)); }
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'name':       cmp = a.displayName.localeCompare(b.displayName); break;
        case 'score':      cmp = (a.currentScore ?? -1) - (b.currentScore ?? -1); break;
        case 'pct':        cmp = (a.pct ?? -1) - (b.pct ?? -1); break;
        case 'backedUpAt': cmp = (a.backedUpAt ?? '').localeCompare(b.backedUpAt ?? ''); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, search, sortCol, sortDir]);

  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-val" style={{ color: avgColor }}>{avgPct !== null ? `${avgPct.toFixed(1)}%` : '—'}</div>
          <div className="stat-label">Avg. Secure Score</div>
        </div>
        <div className="stat-card">
          <div className="stat-val">{okRows.length}</div>
          <div className="stat-label">Tenants with data</div>
        </div>
        <div className="stat-card">
          <div className="stat-val" style={{ color: noDataCount > 0 ? '#71717a' : undefined }}>{noDataCount}</div>
          <div className="stat-label">Not backed up</div>
        </div>
        {errCount > 0 && (
          <div className="stat-card">
            <div className="stat-val" style={{ color: '#f87171' }}>{errCount}</div>
            <div className="stat-label">Permission errors</div>
          </div>
        )}
      </div>

      {aggregateHistory.length >= 2 && (
        <div style={{ marginBottom: 24, padding: '16px 18px', background: '#111113', border: '1px solid #27272a', borderRadius: 8 }}>
          <div style={{ fontSize: '0.7rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 12 }}>
            Avg. score trend (30 days)
          </div>
          <SecureScoreTrendChart
            data={aggregateHistory.map(p => ({ date: p.date, percent: p.percent }))}
            height={140}
            color={avgColor}
          />
        </div>
      )}

      <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', maxWidth: 280 }}>
          <svg style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#52525b', pointerEvents: 'none' }}
            width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="4" /><path d="M11 11l3 3" />
          </svg>
          <input type="text" placeholder="Search tenants…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ padding: '5px 10px 5px 28px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#d4d4d8', fontSize: '0.78rem', outline: 'none', fontFamily: 'inherit', width: '100%' }} />
        </div>
        <span style={{ fontSize: '0.75rem', color: '#52525b' }}>{filtered.length} of {rows.length} tenants</span>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                Tenant <SortInd col="name" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('score')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                Score <SortInd col="score" active={sortCol} dir={sortDir} />
              </th>
              <th style={{ whiteSpace: 'nowrap' }}>Points</th>
              <th onClick={() => handleSort('pct')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                % <SortInd col="pct" active={sortCol} dir={sortDir} />
              </th>
              <th style={{ whiteSpace: 'nowrap' }}>Trend</th>
              <th>Status</th>
              <th onClick={() => handleSort('backedUpAt')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                Backed up <SortInd col="backedUpAt" active={sortCol} dir={sortDir} />
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: '#52525b', padding: '24px 0', fontSize: '0.85rem' }}>No tenants match your search.</td></tr>
            ) : filtered.map(row => {
              const color = row.pct !== null ? scoreColor(row.pct) : '#71717a';
              const sparkData = row.history.map(p => ({ date: p.date, percent: p.percent }));
              return (
                <tr key={row.slug}>
                  <td style={{ fontWeight: 500, fontSize: '0.85rem', color: '#e4e4e7' }}>{row.displayName}</td>
                  <td style={{ minWidth: 180 }}>
                    {row.pct !== null ? <ScoreBar pct={row.pct} color={color} /> : <span style={{ color: '#52525b', fontSize: '0.78rem' }}>—</span>}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: row.currentScore !== null ? '#e4e4e7' : '#52525b', whiteSpace: 'nowrap' }}>
                    {row.currentScore !== null && row.maxScore !== null ? `${Math.round(row.currentScore)} / ${Math.round(row.maxScore)}` : '—'}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', color, whiteSpace: 'nowrap' }}>
                    {row.pct !== null ? `${row.pct.toFixed(1)}%` : '—'}
                  </td>
                  <td>
                    <SecureScoreSparkline data={sparkData} color={color} />
                  </td>
                  <td><TenantStatusBadge status={row.status} /></td>
                  <td style={{ fontSize: '0.78rem', color: '#71717a', whiteSpace: 'nowrap' }}>{fmtDate(row.backedUpAt)}</td>
                  <td>
                    <a href={`/msps/${mspSlug}/tenants/${row.slug}/secure-score`}
                      style={{ fontSize: '0.75rem', color: '#60a5fa', textDecoration: 'none', padding: '3px 10px', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 4, whiteSpace: 'nowrap' }}>
                      View details →
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── All Recommendations tab ───────────────────────────────────────────────────

type RecSortCol = 'tenant' | 'rank' | 'scoreImpact' | 'pointsAchieved' | 'status' | 'category' | 'product';

type RecFilterType = 'all' | 'default' | 'scored' | 'notApplicable' | 'ignored';

function AllRecommendationsTab({ allControls, mspSlug, tenantNames }: { allControls: CrossTenantControl[]; mspSlug: string; tenantNames: string[] }) {
  const [statusFilter, setStatusFilter] = useState<RecFilterType>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch]   = useState('');
  const [sortCol, setSortCol] = useState<RecSortCol>('rank');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function handleSort(col: RecSortCol) {
    if (col === sortCol) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  }

  const categories = useMemo(() => [...new Set(allControls.map(c => c.controlCategory).filter(Boolean))].sort(), [allControls]);

  const needsActionCount   = useMemo(() => allControls.filter(c => getEffectiveStatus(c) === 'default').length, [allControls]);
  const completedCount     = useMemo(() => allControls.filter(c => getEffectiveStatus(c) === 'scored').length, [allControls]);
  const notApplicableCount = useMemo(() => allControls.filter(c => getEffectiveStatus(c) === 'notApplicable').length, [allControls]);
  const ignoredCount       = useMemo(() => allControls.filter(c => ['ignored', 'thirdparty', 'reviewed'].includes(getEffectiveStatus(c))).length, [allControls]);

  const filtered = useMemo(() => {
    let list = allControls;
    if (statusFilter === 'default')       list = list.filter(c => getEffectiveStatus(c) === 'default');
    else if (statusFilter === 'scored')   list = list.filter(c => getEffectiveStatus(c) === 'scored');
    else if (statusFilter === 'notApplicable') list = list.filter(c => getEffectiveStatus(c) === 'notApplicable');
    else if (statusFilter === 'ignored')  list = list.filter(c => ['ignored', 'thirdparty', 'reviewed'].includes(getEffectiveStatus(c)));
    if (tenantFilter !== 'all')   list = list.filter(c => c.tenantSlug === tenantFilter);
    if (categoryFilter !== 'all') list = list.filter(c => c.controlCategory === categoryFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => c.title.toLowerCase().includes(q) || c.tenantName.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'tenant':        cmp = a.tenantName.localeCompare(b.tenantName); break;
        case 'rank':          cmp = (a.rank ?? 9999) - (b.rank ?? 9999); break;
        case 'scoreImpact':   cmp = (b.maxScore - (b.currentScore ?? 0)) - (a.maxScore - (a.currentScore ?? 0)); break;
        case 'pointsAchieved':cmp = (a.currentScore ?? -1) - (b.currentScore ?? -1); break;
        case 'status':        cmp = (STATUS_LABELS[getEffectiveStatus(a)] ?? '').localeCompare(STATUS_LABELS[getEffectiveStatus(b)] ?? ''); break;
        case 'category':      cmp = (a.controlCategory ?? '').localeCompare(b.controlCategory ?? ''); break;
        case 'product':       cmp = (a.service ?? '').localeCompare(b.service ?? ''); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [allControls, statusFilter, tenantFilter, categoryFilter, search, sortCol, sortDir]);

  const thS = (): React.CSSProperties => ({ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' });

  const filterBtn = (f: RecFilterType, label: string, count: number) => (
    <button key={f} onClick={() => setStatusFilter(f)} style={{
      padding: '5px 12px', fontSize: '0.78rem', borderRadius: 5, cursor: 'pointer',
      fontFamily: 'inherit', fontWeight: statusFilter === f ? 700 : 400,
      background: statusFilter === f ? '#18181b' : 'transparent',
      border: `1px solid ${statusFilter === f ? '#3f3f46' : '#27272a'}`,
      color: statusFilter === f ? '#e4e4e7' : '#71717a',
    }}>
      {label} <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>{count}</span>
    </button>
  );

  if (allControls.length === 0) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: '#52525b', fontSize: '0.85rem' }}>
        No recommendation data available. Run a backup for at least one tenant first.
      </div>
    );
  }

  return (
    <div>
      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {filterBtn('all',           'All',            allControls.length)}
          {filterBtn('default',       'Needs action',   needsActionCount)}
          {filterBtn('scored',        'Completed',      completedCount)}
          {filterBtn('notApplicable', 'Not applicable', notApplicableCount)}
          {ignoredCount > 0 && filterBtn('ignored', 'Ignored', ignoredCount)}
        </div>

        {/* Tenant filter */}
        <select value={tenantFilter} onChange={e => setTenantFilter(e.target.value)}
          style={{ padding: '5px 10px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#a1a1aa', fontSize: '0.78rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
          <option value="all">All tenants</option>
          {tenantNames.map(name => {
            const t = allControls.find(c => c.tenantName === name);
            return t ? <option key={t.tenantSlug} value={t.tenantSlug}>{name}</option> : null;
          })}
        </select>

        {/* Category filter */}
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: '5px 10px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#a1a1aa', fontSize: '0.78rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
          <option value="all">All categories</option>
          {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
        </select>

        {/* Search */}
        <div style={{ flex: 1, position: 'relative', minWidth: 160 }}>
          <svg style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#52525b', pointerEvents: 'none' }}
            width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="4" /><path d="M11 11l3 3" />
          </svg>
          <input type="text" placeholder="Search controls or tenants…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '5px 10px 5px 28px', background: '#111113', border: '1px solid #27272a', borderRadius: 5, color: '#d4d4d8', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }} />
        </div>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => handleSort('tenant')} style={thS()}>
                Tenant <SortInd col="tenant" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('rank')} style={{ ...thS(), width: 48 }}>
                Rank <SortInd col="rank" active={sortCol} dir={sortDir} />
              </th>
              <th>Control</th>
              <th onClick={() => handleSort('scoreImpact')} style={thS()}>
                Score impact <SortInd col="scoreImpact" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('pointsAchieved')} style={thS()}>
                Points achieved <SortInd col="pointsAchieved" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('status')} style={thS()}>
                Status <SortInd col="status" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('category')} style={thS()}>
                Category <SortInd col="category" active={sortCol} dir={sortDir} />
              </th>
              <th onClick={() => handleSort('product')} style={thS()}>
                Product <SortInd col="product" active={sortCol} dir={sortDir} />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: '#52525b', padding: '24px 0', fontSize: '0.85rem' }}>No controls match your filters.</td></tr>
            ) : (
              filtered.map((c, i) => <RecommendationRow key={`${c.tenantSlug}-${c.id}-${i}`} c={c} mspSlug={mspSlug} />)
            )}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: '0.72rem', color: '#3f3f46', marginTop: 8 }}>
        Showing {filtered.length} of {allControls.length} recommendations across {tenantNames.length} tenant{tenantNames.length !== 1 ? 's' : ''} · Click a row to expand details
      </div>
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function SecureScoreDashboardClient({ rows, mspSlug, allControls, aggregateHistory }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'recommendations'>('overview');

  const tenantNames = useMemo(
    () => [...new Set(allControls.map(c => c.tenantName))].sort(),
    [allControls],
  );

  const tabBtn = (tab: 'overview' | 'recommendations', label: string) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      style={{
        padding: '7px 16px', fontSize: '0.85rem', borderRadius: 6, cursor: 'pointer',
        fontFamily: 'inherit', fontWeight: activeTab === tab ? 600 : 400,
        background: 'transparent',
        borderBottom: `2px solid ${activeTab === tab ? '#22c55e' : 'transparent'}`,
        border: 'none',
        borderBottomWidth: 2,
        borderBottomStyle: 'solid' as const,
        borderBottomColor: activeTab === tab ? '#22c55e' : 'transparent',
        color: activeTab === tab ? '#e4e4e7' : '#71717a',
        transition: 'color 0.12s',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #27272a', marginBottom: 24 }}>
        {tabBtn('overview',        'Tenant Overview')}
        {tabBtn('recommendations', `All Recommendations${allControls.length > 0 ? ` (${allControls.length})` : ''}`)}
      </div>

      {activeTab === 'overview' && <OverviewTab rows={rows} mspSlug={mspSlug} aggregateHistory={aggregateHistory} />}
      {activeTab === 'recommendations' && <AllRecommendationsTab allControls={allControls} mspSlug={mspSlug} tenantNames={tenantNames} />}
    </div>
  );
}
