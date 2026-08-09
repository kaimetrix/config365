'use client';
import { useEffect, useState, useCallback } from 'react';
import { WhatIfModal } from './WhatIfModal';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parsePlanCounts(body: string): PlanCounts | null {
  const m = body.match(/<!--\s*plan-counts:\s*(\{[^}]+\})\s*-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as PlanCounts; } catch { return null; }
}

// ─── ApprovalsSection ─────────────────────────────────────────────────────────

interface Props {
  mspSlug: string;
  mspOrg:  string;
  onCount?: (n: number) => void;
}

export default function ApprovalsSection({ mspSlug, mspOrg, onCount }: Props) {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading]     = useState(true);
  const [acting, setActing]       = useState<number | null>(null);
  const [messages, setMessages]   = useState<Record<number, { ok: boolean; text: string }>>({});
  const [whatif, setWhatif]       = useState<{ item: ApprovalItem } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/pipelines/approvals?mspSlug=${encodeURIComponent(mspSlug)}`)
      .then(r => r.json())
      .then((d: { approvals?: ApprovalItem[] }) => {
        const list = d.approvals ?? [];
        setApprovals(list);
        onCount?.(list.length);
      })
      .catch(() => { setApprovals([]); onCount?.(0); })
      .finally(() => setLoading(false));
  }, [mspSlug, onCount]);

  useEffect(() => { load(); }, [load]);

  async function act(item: ApprovalItem, action: 'approve' | 'reject') {
    setActing(item.issueNumber);
    try {
      const res = await fetch('/api/pipelines/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug: item.mspSlug, tenantSlug: item.tenantSlug, issueNumber: item.issueNumber, action }),
      });
      const ok = res.ok;
      setMessages(prev => ({
        ...prev,
        [item.issueNumber]: {
          ok,
          text: ok
            ? (action === 'approve' ? 'Approved — deployment will proceed.' : 'Denied — deployment cancelled.')
            : 'Failed to post response.',
        },
      }));
      if (ok) {
        setTimeout(() => {
          setApprovals(prev => {
            const next = prev.filter(a => !(a.tenantSlug === item.tenantSlug && a.issueNumber === item.issueNumber));
            onCount?.(next.length);
            return next;
          });
        }, 2500);
      }
    } finally {
      setActing(null);
    }
  }

  if (loading || approvals.length === 0) return null;

  const btnGhost: React.CSSProperties = {
    fontSize: '0.75rem', padding: '4px 10px', borderRadius: 5,
    background: 'transparent', border: '1px solid #3f3f46',
    color: '#a1a1aa', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  };

  return (
    <>
      {whatif && (
        <WhatIfModal
          mspSlug={whatif.item.mspSlug}
          mspOrg={mspOrg}
          tenantSlug={whatif.item.tenantSlug}
          tenantName={whatif.item.tenantName}
          issueUrl={whatif.item.issueUrl}
          onClose={() => setWhatif(null)}
        />
      )}

      <div style={{ marginBottom: 16 }}>
        {approvals.map(item => {
          const msg      = messages[item.issueNumber];
          const isActing = acting === item.issueNumber;
          const counts   = parsePlanCounts(item.body);
          const date     = new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

          return (
            <div key={item.issueNumber} style={{
              background: '#0d1117',
              borderTop: '1px solid rgba(245,158,11,0.2)',
              borderBottom: '1px solid rgba(245,158,11,0.2)',
              padding: '10px 16px 10px 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              marginBottom: 2,
            }}>

              {/* LEFT: two stacked lines */}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 500, color: '#fbbf24', lineHeight: 1.3 }}>
                  Deployment Approval Required
                </div>
                <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>
                  <span style={{
                    display: 'inline-block', padding: '1px 6px', borderRadius: 3,
                    background: 'rgba(34,197,94,0.1)', color: '#86efac',
                    fontSize: '0.68rem', fontWeight: 700, marginRight: 6,
                  }}>{item.tenantName}</span>
                  {item.title} · {date}
                </div>
              </div>

              {/* RIGHT: plan counts + actions all on one line */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {/* Plan counts */}
                {counts && !msg && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: '1px solid #3f3f46' }}>
                    <span style={{ color: '#22c55e', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>+{counts.creates}</span>
                    <span style={{ color: '#f59e0b', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>~{counts.updates}</span>
                    <span style={{ color: '#f87171', fontSize: '0.8rem', fontFamily: 'monospace', fontWeight: 700 }}>-{counts.deletes}</span>
                  </div>
                )}

                {msg ? (
                  <span style={{
                    fontSize: '0.78rem', padding: '3px 10px', borderRadius: 5,
                    background: msg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: msg.ok ? '#86efac' : '#fca5a5',
                    border: `1px solid ${msg.ok ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  }}>{msg.text}</span>
                ) : (
                  <>
                    {/* View WhatIf */}
                    <button onClick={() => setWhatif({ item })} style={btnGhost}>
                      View WhatIf
                    </button>

                    {/* Approve */}
                    <button
                      disabled={isActing}
                      onClick={() => act(item, 'approve')}
                      style={{
                        ...btnGhost,
                        background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)',
                        color: '#86efac', fontWeight: 700, opacity: isActing ? 0.6 : 1,
                        cursor: isActing ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isActing ? '…' : 'Approve'}
                    </button>

                    {/* Reject */}
                    <button
                      disabled={isActing}
                      onClick={() => act(item, 'reject')}
                      style={{
                        ...btnGhost,
                        border: '1px solid #3b1c1c', color: '#f87171',
                        opacity: isActing ? 0.6 : 1, cursor: isActing ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isActing ? '…' : 'Reject'}
                    </button>

                    {/* Refresh */}
                    <button onClick={load} style={{ ...btnGhost, border: 'none', color: '#52525b', padding: '4px' }} title="Refresh">↻</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
