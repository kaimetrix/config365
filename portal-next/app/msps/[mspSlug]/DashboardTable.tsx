'use client';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import TenantActions from './TenantActions';
import { WhatIfModal } from './WhatIfModal';
import { toGiteaWebUrl } from '@/lib/utils';

// ─── Shared types ─────────────────────────────────────────────────────────────

interface WorkflowRun {
  status: string;
  display_title?: string;
  name?: string;
  html_url: string;
  stuckSetup?: boolean;
}

interface GitCommit {
  commit: { message: string; author: { date: string } };
}

export interface TenantRow {
  slug: string;
  displayName: string;
  giteaOrg: string;
  deploy:      WorkflowRun | null;
  backup:      WorkflowRun | null;
  maintenance: WorkflowRun | null;
  latestCommit: GitCommit | null;
  error: string | null;
  lastActivity: string | null;
  secureScore: number | null;
  secureScoreMax: number | null;
}

interface Props {
  rows: TenantRow[];
  mspSlug: string;
  mspOrg:  string;
  mspId:   string;
}

// ─── Approval types ───────────────────────────────────────────────────────────

interface ApprovalItem {
  tenantSlug:  string;
  tenantName:  string;
  mspSlug:     string;
  issueNumber: number;
  title:       string;
  body:        string;
  createdAt:   string;
  issueUrl:    string;
}

interface PlanCounts { creates: number; updates: number; deletes: number }

function parsePlanCounts(body: string): PlanCounts | null {
  const m = body.match(/<!--\s*plan-counts:\s*(\{[^}]+\})\s*-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as PlanCounts; } catch { return null; }
}

function approvalKey(tenantSlug: string, issueNumber: number) {
  return `${tenantSlug}:${issueNumber}`;
}

// ─── Approval sub-row ─────────────────────────────────────────────────────────

function ApprovalSubRow({ item, mspSlug, mspOrg, onDismiss }: { item: ApprovalItem; mspSlug: string; mspOrg: string; onDismiss: (tenantSlug: string, issueNumber: number) => void }) {
  const [acting, setActing]   = useState(false);
  const [msg, setMsg]         = useState('');
  const [msgOk, setMsgOk]     = useState(false);
  const [showWhatif, setShowWhatif] = useState(false);
  const counts = parsePlanCounts(item.body);

  async function act(action: 'approve' | 'reject') {
    setActing(true);
    try {
      const res = await fetch('/api/pipelines/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug: item.mspSlug, tenantSlug: item.tenantSlug, issueNumber: item.issueNumber, action }),
      });
      setMsgOk(res.ok);
      setMsg(res.ok
        ? (action === 'approve' ? 'Approved — deployment will proceed.' : 'Denied — deployment cancelled.')
        : 'Failed to post response.');
      if (res.ok) {
        // Immediately suppress this issue from the display; workflow will close it async
        onDismiss(item.tenantSlug, item.issueNumber);
      }
    } finally {
      setActing(false);
    }
  }

  const btnGhost: React.CSSProperties = {
    fontSize: '0.75rem', padding: '4px 10px', borderRadius: 5,
    background: 'transparent', border: '1px solid #3f3f46',
    color: '#a1a1aa', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  };

  return (
    <>
      {showWhatif && (
        <WhatIfModal
          mspSlug={mspSlug}
          mspOrg={mspOrg}
          tenantSlug={item.tenantSlug}
          tenantName={item.tenantName}
          issueUrl={item.issueUrl}
          onClose={() => setShowWhatif(false)}
        />
      )}
      <tr style={{ background: '#0d1117' }}>
        <td colSpan={8} style={{ padding: '8px 16px 8px 24px', borderTop: '1px solid rgba(245,158,11,0.2)', borderBottom: '1px solid rgba(245,158,11,0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            {/* Left: label + meta */}
            <div>
              <div style={{ fontSize: '0.8125rem', fontWeight: 500, color: '#fbbf24', lineHeight: 1.3 }}>
                Deployment Approval Required
              </div>
              <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>
                {item.title} · Run #{item.issueNumber}
              </div>
            </div>

            {/* Right: plan counts + actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {counts && !msg && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: '1px solid #3f3f46' }}>
                  <span style={{ color: '#22c55e', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>+{counts.creates}</span>
                  <span style={{ color: '#f59e0b', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>~{counts.updates}</span>
                  <span style={{ color: '#f87171', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>-{counts.deletes}</span>
                </div>
              )}

              {msg ? (
                <span style={{ fontSize: '0.78rem', padding: '3px 10px', borderRadius: 5, background: msgOk ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: msgOk ? '#86efac' : '#fca5a5', border: `1px solid ${msgOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}` }}>{msg}</span>
              ) : (
                <>
                  <button onClick={() => setShowWhatif(true)} style={btnGhost}>View WhatIf</button>
                  <button disabled={acting} onClick={() => act('approve')} style={{ ...btnGhost, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: '#86efac', fontWeight: 700, opacity: acting ? 0.6 : 1, cursor: acting ? 'not-allowed' : 'pointer' }}>
                    {acting ? '…' : 'Approve'}
                  </button>
                  <button disabled={acting} onClick={() => act('reject')} style={{ ...btnGhost, border: '1px solid #3b1c1c', color: '#f87171', opacity: acting ? 0.6 : 1, cursor: acting ? 'not-allowed' : 'pointer' }}>
                    {acting ? '…' : 'Reject'}
                  </button>
                </>
              )}
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── RunBadge ─────────────────────────────────────────────────────────────────

function RunBadge({ run }: { run: WorkflowRun | null }) {
  if (!run) return <span className="badge badge-neutral">Idle</span>;
  const map: Record<string, string> = { success: 'badge-success', failure: 'badge-failure', running: 'badge-running', waiting: 'badge-warning', cancelled: 'badge-neutral', skipped: 'badge-neutral', blocked: 'badge-warning' };
  const labels: Record<string, string> = { success: 'OK', failure: 'Failed', running: 'Running', waiting: 'Queued', cancelled: 'Cancelled', skipped: 'Skipped', blocked: 'Blocked' };
  const stuck = !!run.stuckSetup;
  const cls   = stuck ? 'badge-warning' : (map[run.status] ?? 'badge-neutral');
  const label = stuck ? 'Stuck' : (labels[run.status] ?? run.status);
  const active = stuck || run.status === 'running' || run.status === 'waiting';
  const title = stuck
    ? 'Stuck in Set up job — cancelling and retrying once'
    : (run.display_title ?? run.name ?? '');
  return (
    <span className={`badge ${cls}${active ? ' pulse' : ''}`} title={title}>
      {label}
    </span>
  );
}

function reltime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── ScoreBadge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score, max, href }: { score: number | null; max: number | null; href: string }) {
  if (score === null) {
    return <span style={{ color: '#52525b', fontSize: '0.75rem' }}>—</span>;
  }
  const pct = max && max > 0 ? (score / max) * 100 : null;
  const color = pct === null ? '#71717a'
    : pct >= 75 ? '#22c55e'
    : pct >= 50 ? '#f59e0b'
    : '#ef4444';
  const bg = pct === null ? 'rgba(113,113,122,0.1)'
    : pct >= 75 ? 'rgba(34,197,94,0.1)'
    : pct >= 50 ? 'rgba(245,158,11,0.1)'
    : 'rgba(239,68,68,0.1)';
  const border = pct === null ? 'rgba(113,113,122,0.25)'
    : pct >= 75 ? 'rgba(34,197,94,0.25)'
    : pct >= 50 ? 'rgba(245,158,11,0.25)'
    : 'rgba(239,68,68,0.25)';
  return (
    <a
      href={href}
      title={max ? `${score} / ${max} (${pct?.toFixed(0)}%)` : `Score: ${score}`}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '2px 8px', borderRadius: 4,
        background: bg, border: `1px solid ${border}`,
        color, fontSize: '0.75rem', fontWeight: 700,
        fontFamily: 'monospace', textDecoration: 'none',
        whiteSpace: 'nowrap', cursor: 'pointer',
      }}
    >
      {score}
    </a>
  );
}

// ─── DashboardTable ───────────────────────────────────────────────────────────

export default function DashboardTable({ rows, mspSlug, mspOrg, mspId }: Props) {
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy]         = useState<'name' | 'status' | 'activity'>('name');
  const [approvals, setApprovals]     = useState<ApprovalItem[]>([]);
  // Live run overrides fetched from the bulk status endpoint
  const [liveRuns, setLiveRuns]       = useState<Record<string, { deploy: WorkflowRun | null; backup: WorkflowRun | null; maintenance: WorkflowRun | null }>>({});
  // Issue numbers are per tenant repo — key by tenantSlug + issueNumber
  const [dismissed, setDismissed]     = useState<Set<string>>(new Set());

  // Guards against overlapping requests: if a previous poll hasn't responded
  // yet, skip the next tick instead of piling up concurrent fetches.
  const pendingRef = useRef(false);

  const loadStatus = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    fetch(`/api/pipelines/status?mspSlug=${encodeURIComponent(mspSlug)}`)
      .then(r => r.json())
      .then((d: { runs?: typeof liveRuns; approvals?: ApprovalItem[] }) => {
        setLiveRuns(d.runs ?? {});
        const list = d.approvals ?? [];
        setApprovals(list);
        // Once an issue is truly closed (no longer returned), remove from dismissed set
        setDismissed(prev => {
          if (prev.size === 0) return prev;
          const returnedKeys = new Set(list.map(a => approvalKey(a.tenantSlug, a.issueNumber)));
          const next = new Set([...prev].filter(k => returnedKeys.has(k)));
          return next.size === prev.size ? prev : next;
        });
      })
      .catch(() => {/* silent */})
      .finally(() => { pendingRef.current = false; });
  }, [mspSlug]);

  const burstUntilRef = useRef(0);
  const burstIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startBurstPolling = useCallback(() => {
    burstUntilRef.current = Math.max(burstUntilRef.current, Date.now() + 10_000);
    loadStatus();

    if (burstIntervalRef.current) return;

    burstIntervalRef.current = setInterval(() => {
      loadStatus();
      if (Date.now() >= burstUntilRef.current) {
        clearInterval(burstIntervalRef.current!);
        burstIntervalRef.current = null;
      }
    }, 1000);
  }, [loadStatus]);

  useEffect(() => {
    loadStatus();
    const id = setInterval(loadStatus, 30_000);
    window.addEventListener('dashboard-refresh', loadStatus);
    window.addEventListener('dashboard-burst-refresh', startBurstPolling);
    return () => {
      clearInterval(id);
      if (burstIntervalRef.current) {
        clearInterval(burstIntervalRef.current);
        burstIntervalRef.current = null;
      }
      window.removeEventListener('dashboard-refresh', loadStatus);
      window.removeEventListener('dashboard-burst-refresh', startBurstPolling);
    };
  }, [loadStatus, startBurstPolling]);

  const dismissApproval = useCallback((tenantSlug: string, issueNumber: number) => {
    setDismissed(prev => new Set([...prev, approvalKey(tenantSlug, issueNumber)]));
    // Refresh after 45s — by then the workflow should have closed the issue
    setTimeout(loadStatus, 45_000);
  }, [loadStatus]);

  // Map tenantSlug → approval item, excluding dismissed issue numbers
  const approvalBySlug = useMemo(
    () => Object.fromEntries(
      approvals
        .filter(a => !dismissed.has(approvalKey(a.tenantSlug, a.issueNumber)))
        .map(a => [a.tenantSlug, a])
    ),
    [approvals, dismissed]
  );

  // Merge live run data into rows so filters/sort reflect the latest status
  const effectiveRows = useMemo(() => rows.map(r => {
    const live = liveRuns[r.slug];
    if (!live) return r;
    return {
      ...r,
      deploy:      live.deploy      ?? r.deploy,
      backup:      live.backup      ?? r.backup,
      maintenance: live.maintenance ?? r.maintenance,
    };
  }), [rows, liveRuns]);

  const filtered = useMemo(() => {
    let list = effectiveRows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r => r.displayName.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q));
    }
    if (statusFilter === 'active') {
      list = list.filter(r => [r.deploy, r.backup, r.maintenance].some(w => w?.status === 'running' || w?.status === 'waiting'));
    } else if (statusFilter === 'issues') {
      list = list.filter(r => [r.deploy, r.backup, r.maintenance].some(w => w?.status === 'failure'));
    } else if (statusFilter === 'idle') {
      list = list.filter(r => !r.deploy && !r.backup && !r.maintenance);
    }
    if (sortBy === 'name') {
      list = [...list].sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else if (sortBy === 'activity') {
      list = [...list].sort((a, b) => {
        const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return tb - ta;
      });
    } else if (sortBy === 'status') {
      const rank = (r: TenantRow) => {
        if ([r.deploy, r.backup, r.maintenance].some(w => w?.status === 'failure')) return 0;
        if ([r.deploy, r.backup, r.maintenance].some(w => w?.status === 'running' || w?.status === 'waiting')) return 1;
        return 2;
      };
      list = [...list].sort((a, b) => rank(a) - rank(b));
    }
    return list;
  }, [effectiveRows, search, statusFilter, sortBy]);

  return (
    <>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#52525b', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="4"/>
            <path d="M11 11l3 3"/>
          </svg>
          <input
            type="text"
            placeholder="Search tenants…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '8px 12px 8px 34px', background: '#111113', border: '1px solid #27272a', borderRadius: 7, color: '#d4d4d8', fontSize: '0.8125rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
            onFocus={e => (e.currentTarget.style.borderColor = '#3f3f46')}
            onBlur={e => (e.currentTarget.style.borderColor = '#27272a')}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '8px 10px', background: '#111113', border: '1px solid #27272a', borderRadius: 7, color: '#a1a1aa', fontSize: '0.8125rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
          <option value="all">All tenants</option>
          <option value="active">Active pipelines</option>
          <option value="issues">With issues</option>
          <option value="idle">Idle</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'name' | 'status' | 'activity')}
          style={{ padding: '8px 10px', background: '#111113', border: '1px solid #27272a', borderRadius: 7, color: '#a1a1aa', fontSize: '0.8125rem', cursor: 'pointer', outline: 'none', fontFamily: 'inherit' }}>
          <option value="name">Sort: Name</option>
          <option value="status">Sort: Status</option>
          <option value="activity">Sort: Activity</option>
        </select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card empty-state">
          <p>{search || statusFilter !== 'all' ? 'No tenants match your filter.' : 'No tenants yet.'}</p>
          {!search && statusFilter === 'all' && (
            <a href={`/admin/tenants/new?mspId=${mspId}`} className="btn" style={{ marginTop: 12, display: 'inline-flex' }}>Add first tenant</a>
          )}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Deploy</th>
                <th>Backup</th>
                <th>Maintenance</th>
                <th title="Microsoft Secure Score (from nightly backup)">Score</th>
                <th>Last commit</th>
                <th>Last activity</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <>
                  <tr key={row.slug}>
                    <td style={{ fontWeight: 500 }}>{row.displayName}</td>
                    <td>
                      {row.deploy
                        ? <a href={toGiteaWebUrl(row.deploy.html_url)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><RunBadge run={row.deploy} /></a>
                        : <RunBadge run={null} />}
                    </td>
                    <td>
                      {row.backup
                        ? <a href={toGiteaWebUrl(row.backup.html_url)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><RunBadge run={row.backup} /></a>
                        : <RunBadge run={null} />}
                    </td>
                    <td>
                      {row.maintenance
                        ? <a href={toGiteaWebUrl(row.maintenance.html_url)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><RunBadge run={row.maintenance} /></a>
                        : <RunBadge run={null} />}
                    </td>
                    <td>
                      <ScoreBadge
                        score={row.secureScore}
                        max={row.secureScoreMax}
                        href={`/msps/${mspSlug}/tenants/${row.slug}/secure-score`}
                      />
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                      {row.latestCommit ? (
                        <span title={row.latestCommit.commit.message}>{row.latestCommit.commit.message.split('\n')[0].slice(0, 48)}</span>
                      ) : row.error ? (
                        <span style={{ color: 'var(--danger-fg)' }}>{row.error}</span>
                      ) : '—'}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                      {row.lastActivity ? reltime(row.lastActivity) : '—'}
                    </td>
                    <td>
                      <TenantActions
                        slug={row.slug}
                        mspSlug={mspSlug}
                        tenantName={row.displayName}
                        isDeployRunning={row.deploy?.status === 'running' || row.deploy?.status === 'waiting'}
                        isBackupRunning={row.backup?.status === 'running' || row.backup?.status === 'waiting'}
                        isMaintenanceRunning={row.maintenance?.status === 'running' || row.maintenance?.status === 'waiting'}
                      />
                    </td>
                  </tr>
                  {approvalBySlug[row.slug] && (
                    <ApprovalSubRow
                      key={`approval-${row.slug}-${approvalBySlug[row.slug].issueNumber}`}
                      item={approvalBySlug[row.slug]}
                      mspSlug={mspSlug}
                      mspOrg={mspOrg}
                      onDismiss={dismissApproval}
                    />
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
