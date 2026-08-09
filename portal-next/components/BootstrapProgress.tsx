'use client';
import { useState, useEffect } from 'react';

export type EntryStatus = 'running' | 'success' | 'error' | 'skipped';

export interface BootstrapEntry {
  id:     string;
  scope:  string;
  label:  string;
  status: EntryStatus;
  error?: string;
  ts:     number;
}

interface Props {
  scope:      string;
  title?:     string;
  /** Called once when polling stops (inProgress transitions to false).
   *  Receives `true` when any entry in the scope has status "error". */
  onDone?:    (hasErrors: boolean) => void;
  /** When true, always shows the last logged entries even when not in progress */
  alwaysShow?: boolean;
  /** Poll interval in ms. Default 5000. */
  pollMs?:    number;
  /** When set, shows a "queued" placeholder before the scope has any activity */
  pendingLabel?: string;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14, border: '2px solid #3b82f6',
      borderTopColor: 'transparent', borderRadius: '50%',
      animation: 'spin 0.7s linear infinite', flexShrink: 0,
    }} />
  );
}

function Check() {
  return <span style={{ color: '#22c55e', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>✓</span>;
}

function Cross() {
  return <span style={{ color: '#ef4444', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>✕</span>;
}

function Dash() {
  return <span style={{ color: '#52525b', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>–</span>;
}

function StatusIcon({ status }: { status: EntryStatus }) {
  if (status === 'running') return <Spinner />;
  if (status === 'success') return <Check />;
  if (status === 'error')   return <Cross />;
  return <Dash />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BootstrapProgress({ scope, title, onDone, alwaysShow = false, pollMs = 5000, pendingLabel }: Props) {
  const [entries, setEntries]       = useState<BootstrapEntry[]>([]);
  const [inProgress, setInProgress] = useState(false);
  const [done, setDone]             = useState(false);

  useEffect(() => {
    if (done) return; // Stop polling once the scope has completed

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/admin/platform/bootstrap-log?scope=${encodeURIComponent(scope)}`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = await res.json() as { entries: BootstrapEntry[]; inProgress: boolean };
        if (cancelled) return;
        setEntries(data.entries);
        setInProgress(data.inProgress);
        if (!data.inProgress && data.entries.length > 0) {
          setDone(true);
          const hasErrors = data.entries.some(e => e.status === 'error');
          onDone?.(hasErrors);
          return; // Do not schedule another poll
        }
      } catch { /* network error — schedule next poll as normal */ }

      // Only schedule the next poll AFTER this request has fully completed
      if (!cancelled) {
        timeoutId = setTimeout(poll, pollMs);
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [scope, done, onDone, pollMs]);

  // Nothing to show yet — either render a pending placeholder or nothing
  if (!alwaysShow && !inProgress && entries.length === 0) {
    if (!pendingLabel) return null;
    return (
      <div style={{
        background: '#0f0f11', border: '1px solid #27272a', borderRadius: 8,
        padding: '12px 16px', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem',
      }}>
        {title && (
          <div style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 600, fontSize: '0.8rem', color: '#e4e4e7', marginBottom: 8 }}>
            {title}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#52525b' }}>
          <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>○</span>
          <span>{pendingLabel}</span>
        </div>
      </div>
    );
  }

  const succeeded = entries.filter(e => e.status === 'success').length;
  const failed    = entries.filter(e => e.status === 'error').length;
  const running   = entries.filter(e => e.status === 'running').length;

  return (
    <div style={{
      background: '#0f0f11', border: '1px solid #27272a', borderRadius: 8,
      padding: '12px 16px', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {title && (
        <div style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 600, fontSize: '0.8rem', color: '#e4e4e7', marginBottom: 10 }}>
          {title}
        </div>
      )}

      {entries.length === 0 && inProgress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#71717a' }}>
          <Spinner /> <span>Waiting for activity…</span>
        </div>
      )}

      <div style={{ maxHeight: 320, overflowY: 'auto', scrollbarGutter: 'stable', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(entry => (
          <div key={entry.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusIcon status={entry.status} />
              <span style={{
                color: entry.status === 'error' ? '#fca5a5'
                     : entry.status === 'skipped' ? '#52525b'
                     : '#d4d4d8',
                flex: 1, overflowWrap: 'anywhere',
              }}>
                {entry.label}
              </span>
            </div>
            {entry.error && (
              <div style={{ marginLeft: 22, color: '#f87171', fontSize: '0.72rem', marginTop: 2, overflowWrap: 'anywhere' }}>
                {entry.error}
              </div>
            )}
          </div>
        ))}
      </div>

      {!inProgress && entries.length > 0 && (
        <div style={{
          marginTop: 10, paddingTop: 8, borderTop: '1px solid #27272a',
          fontFamily: 'system-ui, sans-serif', fontSize: '0.75rem',
          color: failed > 0 ? '#fca5a5' : '#22c55e',
        }}>
          {failed > 0
            ? `Completed with ${failed} error${failed > 1 ? 's' : ''} — ${succeeded} succeeded`
            : `All ${succeeded} step${succeeded !== 1 ? 's' : ''} completed successfully`
          }
        </div>
      )}

      {inProgress && running > 0 && (
        <div style={{
          marginTop: 10, paddingTop: 8, borderTop: '1px solid #27272a',
          fontFamily: 'system-ui, sans-serif', fontSize: '0.75rem', color: '#71717a',
        }}>
          {running} step{running !== 1 ? 's' : ''} running…
        </div>
      )}
    </div>
  );
}
