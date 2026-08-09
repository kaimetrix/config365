'use client';
import { useState } from 'react';

export default function GiteaAdmin({ adminUser }: { adminUser: string }) {
  const [newPwd, setNewPwd]   = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');
  const [error, setError]     = useState('');

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPwd !== confirm) { setError('Passwords do not match.'); return; }
    if (newPwd.length < 8)  { setError('Password must be at least 8 characters.'); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-gitea-password', password: newPwd }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setMsg('Password updated successfully.');
      setNewPwd(''); setConfirm('');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <div className="card">
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>Reset Admin Password</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: 16 }}>
          Change the password for <strong>{adminUser}</strong> in Gitea.
        </p>
        {error && <div className="msg-error">{error}</div>}
        {msg   && <div className="msg-success">{msg}</div>}
        <form onSubmit={resetPassword}>
          <div className="form-group">
            <label>New Password</label>
            <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} required minLength={8} />
          </div>
          <div className="form-group">
            <label>Confirm Password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          </div>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Reset Password'}</button>
        </form>
      </div>
    </div>
  );
}
