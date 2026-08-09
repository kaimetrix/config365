'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Msp } from '@/lib/server/tenant-store';

export default function EditMspForm({ msp, graphClientId: initialGraphClientId }: { msp: Msp; graphClientId: string }) {
  const router = useRouter();
  const [displayName,    setName]           = useState(msp.displayName);
  const [giteaOrg,       setOrg]            = useState(msp.giteaOrg);
  const [graphClientId,  setGraphClientId]  = useState(initialGraphClientId);
  const [graphClientSecret, setGraphSecret] = useState('');
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body: Record<string, string> = { displayName, giteaOrg };
      if (graphClientId.trim())     body.graphClientId     = graphClientId.trim();
      if (graphClientSecret.trim()) body.graphClientSecret = graphClientSecret.trim();
      const res = await fetch(`/api/msps?slug=${msp.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      router.push('/admin');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  async function deleteMsp() {
    if (!confirm(`Delete MSP "${msp.displayName}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/msps?slug=${msp.slug}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      router.push('/admin');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); setBusy(false); }
  }

  return (
    <>
      {error && <div className="msg-error">{error}</div>}
      <form onSubmit={save}>
        <div className="form-group">
          <label>Display Name</label>
          <input value={displayName} onChange={e => setName(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Gitea Org</label>
          <input value={giteaOrg} onChange={e => setOrg(e.target.value)} />
        </div>

        <hr style={{ margin: '16px 0', opacity: 0.2 }} />
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Graph access app — used for delegated authentication (device code flow) and pipeline tokens.
          This is a separate app registration from the portal sign-in app.
        </p>

        <div className="form-group">
          <label>Graph Client ID</label>
          <input
            value={graphClientId}
            onChange={e => setGraphClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            spellCheck={false}
          />
        </div>
        <div className="form-group">
          <label>Graph Client Secret {initialGraphClientId ? <span style={{ fontWeight: 400, opacity: 0.6 }}>(leave blank to keep existing)</span> : null}</label>
          <input
            type="password"
            value={graphClientSecret}
            onChange={e => setGraphSecret(e.target.value)}
            placeholder={initialGraphClientId ? '••••••••••••••••' : 'Enter client secret'}
            autoComplete="new-password"
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <a href="/admin" className="btn btn-ghost">Cancel</a>
          </div>
          <button type="button" className="btn btn-danger" onClick={deleteMsp} disabled={busy}>Delete MSP</button>
        </div>
      </form>
    </>
  );
}
