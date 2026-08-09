'use client';

import { useState } from 'react';

type Mode   = 'portal' | 'full';
type Status = 'idle' | 'busy' | 'done' | 'error';

export default function ResetPage() {
  const [password,   setPassword]   = useState('');
  const [mode,       setMode]       = useState<Mode>('portal');
  const [dropMssql,  setDropMssql]  = useState(false);
  const [status,     setStatus]     = useState<Status>('idle');
  const [message,    setMessage]    = useState('');

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    setStatus('busy');
    setMessage('');

    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim(), mode, dropMssql }),
      });
      const d = await res.json() as { ok?: boolean; error?: string; dropLog?: string[] };
      if (!res.ok || !d.ok) throw new Error(d.error ?? 'Reset failed');

      setStatus('done');
      const dropSummary = d.dropLog?.length
        ? ` MSSQL tables dropped: ${d.dropLog.length}.`
        : '';
      if (mode === 'portal') {
        setMessage(`Portal reset complete.${dropSummary} Redirecting to setup…`);
        setTimeout(() => { window.location.href = '/setup'; }, 1500);
      } else {
        setMessage(
          `Full reset initiated.${dropSummary} The container is restarting — ` +
          'please wait ~30 seconds then navigate to /setup.'
        );
      }
    } catch (err: unknown) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Reset failed');
    }
  }

  return (
    <main style={s.page}>
      <div style={s.card}>
        <h1 style={s.h1}>Factory Reset</h1>
        <p style={s.subtitle}>
          Clears all Config365 platform settings and returns the portal to the initial
          setup wizard.
        </p>

        {status !== 'done' ? (
          <form onSubmit={handleReset}>
            {/* ── Mode selector ── */}
            <fieldset style={s.fieldset}>
              <legend style={s.legend}>Reset scope</legend>

              <label style={s.radioRow}>
                <input
                  type="radio" name="mode" value="portal"
                  checked={mode === 'portal'} onChange={() => setMode('portal')}
                />
                <span style={{ marginLeft: 10 }}>
                  <strong>Portal only</strong>
                  <span style={s.desc}>
                    {' '}— clears all settings &amp; credentials. Gitea repos and history are
                    preserved. Container keeps running.
                  </span>
                </span>
              </label>

              <label style={{ ...s.radioRow, marginTop: 12 }}>
                <input
                  type="radio" name="mode" value="full"
                  checked={mode === 'full'} onChange={() => setMode('full')}
                />
                <span style={{ marginLeft: 10 }}>
                  <strong>Full factory reset</strong>
                  <span style={s.desc}>
                    {' '}— also wipes all Gitea data (repos, users, tokens). Container
                    restarts automatically.
                  </span>
                </span>
              </label>
            </fieldset>

            {mode === 'full' && (
              <div style={s.warning}>
                ⚠&nbsp;<strong>Irreversible.</strong> All Gitea repositories, automation
                history, and tokens will be permanently deleted.
              </div>
            )}

            {/* ── MSSQL drop option ── */}
            <label style={s.checkRow}>
              <input
                type="checkbox"
                checked={dropMssql}
                onChange={e => setDropMssql(e.target.checked)}
              />
              <span style={{ marginLeft: 10 }}>
                <strong>Drop MSSQL tables</strong>
                <span style={s.desc}>
                  {' '}— deletes all portal and token tables from the configured MSSQL
                  databases (c365p_* and c365t_*). Skipped silently if MSSQL is not
                  configured.
                </span>
              </span>
            </label>

            {dropMssql && (
              <div style={{ ...s.warning, marginTop: 8 }}>
                ⚠&nbsp;This permanently deletes all MSP, tenant, IAM, and token data
                from MSSQL. It cannot be undone.
              </div>
            )}

            {/* ── Password ── */}
            <div style={s.group}>
              <label style={s.label} htmlFor="reset-pwd">Reset password</label>
              <input
                id="reset-pwd"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter reset password"
                required
                autoComplete="off"
                style={s.input}
              />
            </div>

            {status === 'error' && <div style={s.errMsg}>{message}</div>}

            <button
              type="submit"
              disabled={status === 'busy' || !password.trim()}
              style={mode === 'full' ? s.btnDanger : s.btnPrimary}
            >
              {status === 'busy'
                ? 'Resetting…'
                : mode === 'full' ? '⚠ Full Factory Reset' : 'Reset Portal'}
            </button>
          </form>
        ) : (
          <div style={s.doneMsg}>
            {message}
            {mode === 'full' && (
              <div style={{ marginTop: 12 }}>
                <a href="/setup" style={s.link}>Go to /setup</a>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    margin: 0,
    background: '#09090b',
    color: '#e4e4e7',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '24px',
    boxSizing: 'border-box',
  },
  card: {
    background: '#18181b',
    border: '1px solid #27272a',
    borderRadius: '12px',
    padding: '40px',
    maxWidth: '520px',
    width: '100%',
  },
  h1: {
    fontSize: '1.35rem',
    fontWeight: 600,
    margin: '0 0 8px',
  },
  subtitle: {
    color: '#71717a',
    fontSize: '0.875rem',
    marginBottom: '24px',
    lineHeight: '1.55',
  },
  fieldset: {
    border: '1px solid #27272a',
    borderRadius: '8px',
    padding: '14px 16px 16px',
    marginBottom: '14px',
  },
  legend: {
    fontSize: '0.75rem',
    color: '#a1a1aa',
    padding: '0 6px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  radioRow: {
    display: 'flex',
    alignItems: 'flex-start',
    cursor: 'pointer',
    fontSize: '0.875rem',
    lineHeight: '1.4',
  },
  checkRow: {
    display: 'flex',
    alignItems: 'flex-start',
    cursor: 'pointer',
    fontSize: '0.875rem',
    lineHeight: '1.4',
    marginBottom: '14px',
  },
  desc: {
    color: '#71717a',
    fontSize: '0.8rem',
  },
  warning: {
    background: 'rgba(239,68,68,0.08)',
    border: '1px solid rgba(239,68,68,0.28)',
    borderRadius: '8px',
    padding: '11px 14px',
    fontSize: '0.8rem',
    color: '#fca5a5',
    marginBottom: '14px',
    lineHeight: '1.5',
  },
  group: { marginBottom: '16px' },
  label: {
    display: 'block',
    fontSize: '0.78rem',
    color: '#a1a1aa',
    marginBottom: '6px',
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    background: '#09090b',
    border: '1px solid #3f3f46',
    borderRadius: '7px',
    color: '#e4e4e7',
    fontSize: '0.875rem',
    boxSizing: 'border-box',
    outline: 'none',
  },
  btnPrimary: {
    width: '100%',
    padding: '10px',
    background: '#3b82f6',
    color: '#fff',
    border: 'none',
    borderRadius: '7px',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnDanger: {
    width: '100%',
    padding: '10px',
    background: '#ef4444',
    color: '#fff',
    border: 'none',
    borderRadius: '7px',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  errMsg: {
    color: '#f87171',
    fontSize: '0.8rem',
    marginBottom: '12px',
  },
  doneMsg: {
    color: '#86efac',
    fontSize: '0.875rem',
    lineHeight: '1.6',
  },
  link: {
    color: '#60a5fa',
    fontSize: '0.875rem',
  },
};
