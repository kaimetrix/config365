'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Msp, TenantConfig } from '@/lib/server/tenant-store';

export default function EditTenantForm({ tenant, msps, hasClientSecret, backUrl = '/admin' }: { tenant: TenantConfig; msps: Msp[]; hasClientSecret: boolean; backUrl?: string }) {
  const router = useRouter();
  const [displayName,   setName]       = useState(tenant.displayName);
  const [domain,        setDomain]     = useState(tenant.domain ?? '');
  const [clientId,      setClientId]   = useState(tenant.clientId ?? '');
  const [tenantId,      setTenantId]   = useState(tenant.tenantId ?? '');
  const [clientSecret,  setSecret]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState('');
  const [syncMsg, setSyncMsg] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body: Record<string, string | null> = {
        displayName,
        domain:    domain    || null,
        clientId:  clientId  || null,
        tenantId:  tenantId  || null,
      };
      if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
      const res = await fetch(`/api/tenants/${tenant.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      router.push(backUrl);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  async function syncFromTemplate() {
    if (!confirm(
      `Sync tenant-${tenant.slug} with tenant-template?\n\n` +
      `This copies workflows and .baseline-ignore from the MSP template into this tenant repo (does not touch backups or README).`,
    )) return;
    setSyncBusy(true);
    setError('');
    setSyncMsg('');
    try {
      const res = await fetch(`/api/tenants/${tenant.slug}/sync-template`, { method: 'POST' });
      const data = await res.json() as {
        error?: string;
        message?: string;
        updated?: string[];
        errors?: Array<{ path: string; error: string }>;
      };
      if (!res.ok && res.status !== 207) throw new Error(data.error ?? 'Sync failed');
      const detail = data.updated?.length
        ? ` Updated: ${data.updated.join(', ')}.`
        : '';
      const errDetail = data.errors?.length
        ? ` Errors: ${data.errors.map(e => e.path).join(', ')}.`
        : '';
      setSyncMsg((data.message ?? 'Done') + detail + errDetail);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncBusy(false);
    }
  }

  async function deleteTenant() {
    if (!confirm(`Delete tenant "${tenant.displayName}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tenants?slug=${tenant.slug}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      router.push(backUrl);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); setBusy(false); }
  }

  return (
    <>
      {error && <div className="msg-error">{error}</div>}
      {syncMsg && <div className="msg-success" style={{ marginBottom: 12 }}>{syncMsg}</div>}
      <form onSubmit={save}>
        <div className="form-group">
          <label>Display Name</label>
          <input value={displayName} onChange={e => setName(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Tenant Domain</label>
          <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="contoso.onmicrosoft.com" />
          <small style={{ opacity: 0.6 }}>The tenant&apos;s .onmicrosoft.com domain, used for Exchange Online connections and pipeline operations.</small>
        </div>
        <div className="form-group">
          <label>Azure AD Tenant ID</label>
          <input value={tenantId} onChange={e => setTenantId(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Azure AD Client ID</label>
          <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Leave blank to use MSP-level app" />
        </div>
        <div className="form-group">
          <label>
            Azure AD Client Secret
            {hasClientSecret
              ? <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 6 }}>(stored — leave blank to keep)</span>
              : <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 6 }}>(leave blank to use MSP-level app)</span>}
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setSecret(e.target.value)}
            placeholder={hasClientSecret ? '••••••••••••••••' : 'Optional tenant-level override'}
            autoComplete="new-password"
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn" disabled={busy || syncBusy}>{busy ? 'Saving…' : 'Save'}</button>
            <a href={backUrl} className="btn btn-ghost">Cancel</a>
          </div>
          <button type="button" className="btn btn-danger" onClick={deleteTenant} disabled={busy || syncBusy}>Delete Tenant</button>
        </div>
      </form>

      <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border, #333)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Repository</div>
        <p style={{ opacity: 0.65, fontSize: '0.85rem', margin: '0 0 12px' }}>
          Copy workflows and <code>.baseline-ignore</code> from <code>tenant-template</code> into this tenant repo.
          Use when Actions / Backup / Deploy are missing after create.
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={syncFromTemplate}
          disabled={busy || syncBusy}
        >
          {syncBusy ? 'Syncing…' : 'Sync with tenant-template'}
        </button>
      </div>
    </>
  );
}
