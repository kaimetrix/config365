'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BootstrapProgress } from '@/components/BootstrapProgress';

export default function NewMspForm() {
  const router = useRouter();
  const [slug, setSlug]                   = useState('');
  const [displayName, setName]            = useState('');
  const [giteaOrg, setGiteaOrg]           = useState('');
  const [graphClientId, setGraphClientId] = useState('');
  const [graphClientSecret, setGraphSecret] = useState('');
  const [busy, setBusy]                   = useState(false);
  const [error, setError]                 = useState('');
  const [provisioningSlug, setProvSlug]   = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body: Record<string, string> = { slug, displayName };
      if (giteaOrg.trim())          body.giteaOrg          = giteaOrg.trim();
      if (graphClientId.trim())     body.graphClientId     = graphClientId.trim();
      if (graphClientSecret.trim()) body.graphClientSecret = graphClientSecret.trim();
      const res = await fetch('/api/msps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      // Show provisioning progress instead of immediately navigating away
      setProvSlug(slug);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  if (provisioningSlug) {
    return (
      <div>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 4 }}>Provisioning MSP</h2>
        <p style={{ color: '#71717a', fontSize: '0.82rem', marginBottom: 16 }}>
          Creating Gitea repositories and seeding workflow templates for <strong>{provisioningSlug}</strong>.
        </p>
        <BootstrapProgress
          scope={`msp:${provisioningSlug}`}
          title={`MSP: ${provisioningSlug}`}
          onDone={() => router.push('/admin')}
        />
        <p style={{ color: '#52525b', fontSize: '0.75rem', marginTop: 12 }}>
          You can also{' '}
          <button onClick={() => router.push('/admin')} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '0.75rem', padding: 0, textDecoration: 'underline' }}>
            go to admin
          </button>{' '}now — provisioning continues in the background.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && <div className="msg-error">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-group">
          <label>Display Name *</label>
          <input value={displayName} onChange={e => setName(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Slug *</label>
          <input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} required placeholder="my-msp" />
          <p className="form-hint">Lowercase letters, numbers, hyphens only.</p>
        </div>
        <div className="form-group">
          <label>Gitea Org (optional)</label>
          <input value={giteaOrg} onChange={e => setGiteaOrg(e.target.value)} placeholder="Defaults to slug" />
        </div>

        <hr style={{ margin: '16px 0', opacity: 0.2 }} />
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Graph access app — used for delegated authentication (device code flow) and pipeline tokens.
          This is a separate app registration from the portal sign-in app. You can also set these later.
        </p>

        <div className="form-group">
          <label>Graph Client ID (optional)</label>
          <input
            value={graphClientId}
            onChange={e => setGraphClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            spellCheck={false}
          />
        </div>
        <div className="form-group">
          <label>Graph Client Secret (optional)</label>
          <input
            type="password"
            value={graphClientSecret}
            onChange={e => setGraphSecret(e.target.value)}
            placeholder="Enter client secret"
            autoComplete="new-password"
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create MSP'}</button>
          <a href="/admin" className="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </>
  );
}
