'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Msp } from '@/lib/server/tenant-store';
import { BootstrapProgress } from '@/components/BootstrapProgress';

export default function NewTenantForm({ msps, defaultMspId }: { msps: Msp[]; defaultMspId?: string }) {
  const router = useRouter();
  const [slug, setSlug]                 = useState('');
  const [displayName, setName]          = useState('');
  const [domain, setDomain]             = useState('');
  const [mspId, setMspId]               = useState(defaultMspId ?? (msps[0]?.id ?? ''));
  const [clientId, setClientId]         = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId]         = useState('');
  const [busy, setBusy]                 = useState(false);
  const [error, setError]               = useState('');
  const [provisioningSlug, setProvSlug] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, displayName, domain: domain || null, mspId, clientId: clientId || null, clientSecret: clientSecret || null, tenantId: tenantId || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setProvSlug(slug);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  if (provisioningSlug) {
    return (
      <div>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 4 }}>Provisioning Tenant</h2>
        <p style={{ color: '#71717a', fontSize: '0.82rem', marginBottom: 16 }}>
          Creating Gitea repository and configuring variables for <strong>{provisioningSlug}</strong>.
        </p>
        <BootstrapProgress
          scope={`tenant:${provisioningSlug}`}
          title={`Tenant: ${provisioningSlug}`}
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
          <label>MSP *</label>
          <select value={mspId} onChange={e => setMspId(e.target.value)} required>
            {msps.map(m => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Display Name *</label>
            <input value={displayName} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Slug *</label>
            <input value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} required placeholder="contoso" />
          </div>
        </div>
        <div className="form-group">
          <label>Tenant Domain</label>
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="contoso.onmicrosoft.com" />
          <p className="form-hint">The tenant&apos;s .onmicrosoft.com domain, used to identify the tenant in Microsoft Graph and pipeline operations.</p>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Azure AD Tenant ID</label>
            <input value={tenantId} onChange={e => setTenantId(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Azure AD Client ID <span style={{ fontWeight: 400, opacity: 0.6 }}>(override)</span></label>
            <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck={false} />
          </div>
        </div>
        <div className="form-group">
          <label>Azure AD Client Secret <span style={{ fontWeight: 400, opacity: 0.6 }}>(override)</span></label>
          <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="Enter client secret" autoComplete="new-password" />
          <p className="form-hint">Optional. Overrides the MSP-level app registration for device code flow on this tenant.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create Tenant'}</button>
          <a href="/admin" className="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </>
  );
}
