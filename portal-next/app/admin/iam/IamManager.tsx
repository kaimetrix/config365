'use client';
import { useState } from 'react';
import type { IamAssignment, Msp } from '@/lib/server/tenant-store';

interface Props { msps: Msp[]; assignments: IamAssignment[]; }

export default function IamManager({ msps, assignments }: Props) {
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState('');

  // Add form state
  const [userId, setUserId]         = useState('');
  const [email, setEmail]           = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole]             = useState<'platform-admin' | 'msp-admin'>('msp-admin');
  const [mspSlug, setMspSlug]       = useState('');

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/admin/iam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, email, displayName, role, mspSlug: role === 'msp-admin' ? mspSlug : null }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSuccess('Assignment saved. Reload to see changes.');
      setUserId(''); setEmail(''); setDisplayName(''); setMspSlug('');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Remove this IAM assignment?')) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/admin/iam?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      location.reload();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20, alignItems: 'start' }}>
      {/* Assignments table */}
      <div>
        {error && <div className="msg-error">{error}</div>}
        {success && <div className="msg-success">{success}</div>}
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>MSP</th><th></th></tr></thead>
            <tbody>
              {assignments.length === 0 ? (
                <tr><td colSpan={5} className="empty-state">No assignments yet.</td></tr>
              ) : assignments.map(a => (
                <tr key={a.id}>
                  <td>{a.email}</td>
                  <td style={{ color: 'var(--muted)' }}>{a.displayName || '—'}</td>
                  <td><span className={`badge ${a.role === 'platform-admin' ? 'badge-success' : 'badge-running'}`}>{a.role}</span></td>
                  <td style={{ color: 'var(--muted)' }}>{a.mspSlug ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-danger btn-sm" onClick={() => remove(a.id)} disabled={busy}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add form */}
      <div className="card">
        <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 16 }}>Add Assignment</h3>
        <form onSubmit={add}>
          <div className="form-group">
            <label>Azure AD Object ID *</label>
            <input value={userId} onChange={e => setUserId(e.target.value)} required placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div className="form-group">
            <label>Email *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Display Name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Role *</label>
            <select value={role} onChange={e => setRole(e.target.value as 'platform-admin' | 'msp-admin')}>
              <option value="msp-admin">MSP Admin</option>
              <option value="platform-admin">Platform Admin</option>
            </select>
          </div>
          {role === 'msp-admin' && (
            <div className="form-group">
              <label>MSP *</label>
              <select value={mspSlug} onChange={e => setMspSlug(e.target.value)} required>
                <option value="">Select MSP…</option>
                {msps.map(m => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}
              </select>
            </div>
          )}
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Add'}</button>
        </form>
      </div>
    </div>
  );
}
