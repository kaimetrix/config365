'use client';
import { useState } from 'react';

interface Props {
  mspSlug: string;
  giteaOrg: string;
  hasInternalKey: boolean;
}

export default function RotateKeyClient({ mspSlug, giteaOrg, hasInternalKey }: Props) {
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState('');
  const [keyConfigured, setKeyConfigured] = useState(hasInternalKey);

  async function rotateKey() {
    const action = keyConfigured ? 'rotate' : 'generate';
    if (!confirm(`This will ${action} the PORTAL_INTERNAL_KEY for ${giteaOrg} and push the new key automatically. Continue?`)) return;
    setBusy(true); setMsg('');
    try {
      const res = await fetch(`/api/msps/${mspSlug}/internal-key`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setKeyConfigured(true);
      setMsg(`Key ${action}d successfully. New key preview: ${data.keyPreview}`);
    } catch (e: unknown) {
      setMsg(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 540 }}>
      <h3 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: 4 }}>Delegated Auth — Internal Key</h3>
      <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: 16 }}>
        The <code>PORTAL_INTERNAL_KEY</code> authenticates Gitea pipelines when they request delegated
        access tokens from the internal token API. Generate it once during setup; rotate if the key
        is compromised (the new key is pushed to <code>{giteaOrg}</code> automatically).
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn btn-sm"
          onClick={rotateKey}
          disabled={busy}
          style={{ background: keyConfigured ? 'var(--bg-2)' : 'var(--accent)' }}
        >
          {busy ? 'Working…' : keyConfigured ? 'Rotate Internal Key' : 'Generate Internal Key'}
        </button>
        {keyConfigured && !msg && (
          <span style={{ fontSize: '0.8rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="7"/>
              <path d="M5 8l2 2 4-4" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            </svg>
            PORTAL_INTERNAL_KEY configured
          </span>
        )}
      </div>
      {msg && (
        <div className={msg.startsWith('Error') ? 'msg-error' : 'msg-success'} style={{ marginTop: 12, fontSize: '0.82rem' }}>
          {msg}
        </div>
      )}
    </div>
  );
}
