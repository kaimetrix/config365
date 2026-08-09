'use client';
import { useState, useEffect } from 'react';
import { BootstrapProgress } from '@/components/BootstrapProgress';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunnerInfo {
  mode:     string;
  shards:   number;
  registered: boolean;
  registeredRunners: {
    name:     string | null;
    id:       number | null;
    labels:   string[];
    address:  string | null;
  }[];
  // legacy
  name:     string | null;
  capacity: number;
}

interface Props {
  org:         string;
  adminUser:   string;
  baseUrl:     string;
  isAio:       boolean;
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: '#0a0a0b',
  border: '1px solid #27272a', borderRadius: 6, color: '#d4d4d8',
  fontSize: '0.8125rem', outline: 'none', fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: 14, color: '#e4e4e7' }}>{title}</h3>
      {children}
    </div>
  );
}

// ─── Runner Section ───────────────────────────────────────────────────────────

function RunnerSection({ isAio }: { isAio: boolean }) {
  const [info, setInfo]       = useState<RunnerInfo | null>(null);
  const [shards, setShards]   = useState(4);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');
  const [err, setErr]         = useState('');

  useEffect(() => {
    fetch('/api/admin/runner-config')
      .then(r => r.json())
      .then((d: RunnerInfo) => { setInfo(d); setShards(d.shards ?? d.capacity ?? 4); })
      .catch(() => {/* silent in dev */});
  }, []);

  async function saveShards() {
    setSaving(true); setMsg(''); setErr('');
    try {
      const res = await fetch('/api/admin/runner-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shards }),
      });
      const d = await res.json() as { ok?: boolean; error?: string; restartOutput?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setMsg(`Saved — ${shards} parallel worker(s) active.`);
      const refreshed = await fetch('/api/admin/runner-config').then(r => r.json()) as RunnerInfo;
      setInfo(refreshed);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Error'); }
    finally { setSaving(false); }
  }

  return (
    <Card title="Act Runner">
      {info === null ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Loading runner info…</p>
      ) : !info.registered ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>No runner registered yet.</p>
      ) : (
        <>
          <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 12 }}>
            Mode: <code style={{ color: '#d4d4d8' }}>{info.mode ?? 'sharded-host'}</code>
            {' '}— each worker runs one job at a time; Gitea distributes jobs across workers for parallel tenant deploys.
          </p>
          {/* Runner info table */}
          <div className="tbl-wrap" style={{ marginBottom: 16 }}>
            <table>
              <thead><tr><th>Name</th><th>Status</th><th>Labels</th><th>Address</th></tr></thead>
              <tbody>
                {(info.registeredRunners?.length ? info.registeredRunners : [{ name: info.name, id: null, labels: [], address: null }]).map(r => (
                  <tr key={r.name ?? 'runner'}>
                    <td style={{ fontWeight: 500 }}>{r.name ?? '—'}</td>
                    <td><span className="badge badge-success">registered</span></td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'monospace' }}>
                      {(r.labels ?? []).join(', ') || '—'}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{r.address ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Parallel workers control — only meaningful in AIO mode */}
          {isAio && info.mode !== 'docker' && (
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>
                Parallel workers (shards)
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
                Number of independent runner processes. Each shard handles one job at a time; increase to run multiple tenant deploys in parallel (uses more CPU/RAM).
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="number" min={1} max={8} value={shards}
                  onChange={e => setShards(Math.max(1, Math.min(8, parseInt(e.target.value) || 1)))}
                  style={{ ...input, width: 80, textAlign: 'center' }}
                />
                <input
                  type="range" min={1} max={8} value={shards}
                  onChange={e => setShards(parseInt(e.target.value))}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--muted)', minWidth: 72 }}>
                  {shards} {shards === 1 ? 'worker' : 'workers'}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={saveShards}
                  disabled={saving || shards === (info.shards ?? info.capacity)}
                >
                  {saving ? 'Saving…' : 'Apply'}
                </button>
              </div>
              {msg && <div className="msg-success" style={{ marginTop: 8 }}>{msg}</div>}
              {err && <div className="msg-error"  style={{ marginTop: 8 }}>{err}</div>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Intune Win32 packager (Linux intunewin CLI) ─────────────────────────────

interface IntuneWinPackagerInfo {
  path: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  version: string | null;
  sourceUrl: string | null;
}

interface IntuneWinPackagerStatus {
  nativeCli: IntuneWinPackagerInfo;
}

function IntuneWinToolSection({ isAio }: { isAio: boolean }) {
  const [status, setStatus] = useState<IntuneWinPackagerStatus | null>(null);

  useEffect(() => {
    if (!isAio) return;
    fetch('/api/admin/intunewin-tool')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setStatus(data as IntuneWinPackagerStatus); })
      .catch(() => { /* silent */ });
  }, [isAio]);

  if (!isAio) return null;

  const fmtSize = (n: number | null) => {
    if (n == null) return '—';
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  };

  const info = status?.nativeCli;

  return (
    <Card title="Intune Win32 packager">
      <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 12 }}>
        Packages <code>install.ps1</code> into <code>.intunewin</code> for app deploy pipelines using the native{' '}
        <code>intunewin</code> CLI on Linux runners. Version is pinned in the Config365 release image.
      </p>
      {status === null ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Loading…</p>
      ) : (
        <div style={{ fontSize: '0.8125rem', color: '#d4d4d8', lineHeight: 1.6 }}>
          <div>
            {info?.path
              ? <span className="badge badge-success" style={{ marginRight: 6 }}>installed</span>
              : <span className="badge badge-failure" style={{ marginRight: 6 }}>missing</span>}
            intunewin CLI (Linux)
            {info?.version && <> · v{info.version}</>}
          </div>
          {info?.path && <div>Path: <code style={{ fontSize: '0.75rem' }}>{info.path}</code></div>}
          <div>Size: {fmtSize(info?.sizeBytes ?? null)}{info?.modifiedAt && <> · image built {new Date(info.modifiedAt).toLocaleString()}</>}</div>
          {info?.sourceUrl && (
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', wordBreak: 'break-all' }}>Source: {info.sourceUrl}</div>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Gitea Admin Section ──────────────────────────────────────────────────────

function GiteaSection({ adminUser, baseUrl }: { adminUser: string; baseUrl: string }) {
  const [newPwd, setNewPwd]           = useState('');
  const [confirm, setConfirm]         = useState('');
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState('');
  const [error, setError]             = useState('');
  const [showPwd, setShowPwd]         = useState(false);
  const [extUrl, setExtUrl]           = useState('');
  const [extUrlCurrent, setExtUrlCurrent] = useState<string | null>(null);
  const [extUrlBusy, setExtUrlBusy]   = useState(false);
  const [extUrlMsg, setExtUrlMsg]     = useState('');
  const [extUrlErr, setExtUrlErr]     = useState('');

  useEffect(() => {
    fetch('/api/admin/secrets')
      .then(r => r.json())
      .then((d: { gitea_external_url?: string | null }) => {
        setExtUrlCurrent(d.gitea_external_url ?? null);
      })
      .catch(() => {/* silent */});
  }, []);

  async function saveExtUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!extUrl.trim()) return;
    setExtUrlBusy(true); setExtUrlMsg(''); setExtUrlErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-platform-setting', key: 'gitea_external_url', value: extUrl.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setExtUrlCurrent(extUrl.trim());
      setExtUrl('');
      setExtUrlMsg('Saved — takes effect on next container restart.');
    } catch (e: unknown) { setExtUrlErr(e instanceof Error ? e.message : 'Error'); }
    finally { setExtUrlBusy(false); }
  }

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
      if (!res.ok) throw new Error((await res.json() as { error: string }).error);
      setMsg('Password updated successfully.');
      setNewPwd(''); setConfirm('');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Gitea Administration">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
          Admin user: <code style={{ color: '#d4d4d8' }}>{adminUser}</code>
        </span>
        <a href={baseUrl} target="_blank" rel="noopener" className="btn btn-ghost btn-sm">
          Open Gitea ↗
        </a>
      </div>

      {/* ── Gitea External URL ── */}
      <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>
          External URL
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
          Public URL used for clone links and OAuth callbacks when Gitea is served
          under a sub-path (e.g.{' '}
          <code style={{ color: '#d4d4d8' }}>https://yourapp.azurewebsites.net/gitea/</code>).
          Changes take effect on the next container restart.
        </p>
        {extUrlCurrent && (
          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 8 }}>
            Current: <code style={{ color: '#d4d4d8' }}>{extUrlCurrent}</code>
          </div>
        )}
        {extUrlErr && <div className="msg-error"  style={{ marginBottom: 8 }}>{extUrlErr}</div>}
        {extUrlMsg && <div className="msg-success" style={{ marginBottom: 8 }}>{extUrlMsg}</div>}
        <form onSubmit={saveExtUrl} style={{ display: 'flex', gap: 8, maxWidth: 540 }}>
          <input
            type="url"
            placeholder={extUrlCurrent ?? 'https://yourapp.azurewebsites.net/gitea/'}
            value={extUrl}
            onChange={e => setExtUrl(e.target.value)}
            required
            style={{ ...input, flex: 1 }}
          />
          <button type="submit" className="btn btn-sm" disabled={extUrlBusy || !extUrl.trim()}>
            {extUrlBusy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>

      <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 10 }}>
        Reset Admin Password
      </div>
      {error && <div className="msg-error" style={{ marginBottom: 8 }}>{error}</div>}
      {msg   && <div className="msg-success" style={{ marginBottom: 8 }}>{msg}</div>}
      <form onSubmit={resetPassword} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>New Password</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPwd ? 'text' : 'password'}
              value={newPwd}
              onChange={e => setNewPwd(e.target.value)}
              required minLength={8}
              style={{ ...input, paddingRight: 36 }}
            />
            <button type="button" onClick={() => setShowPwd(p => !p)}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 2, fontSize: '0.75rem' }}>
              {showPwd ? 'hide' : 'show'}
            </button>
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Confirm Password</label>
          <input type={showPwd ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} required style={input} />
        </div>
        <div>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Reset Password'}</button>
        </div>
      </form>
    </Card>
  );
}

// ─── Azure AD Settings Section ───────────────────────────────────────────────

function AzureAdSettingsSection() {
  const [info, setInfo]             = useState<{
    clientId: string | null; tenantId: string | null; redirectUri: string | null;
    secretSet: boolean; authMode: string;
  } | null>(null);
  const [secret, setSecret]         = useState('');
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState('');
  const [err, setErr]               = useState('');
  const [newRedirectUri, setNewRedirectUri] = useState('');
  const [uriMsg, setUriMsg]         = useState('');
  const [uriErr, setUriErr]         = useState('');
  const [uriBusy, setUriBusy]       = useState(false);

  // Easy Auth mode toggle state
  const [eaTestResult, setEaTestResult]   = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);
  const [eaTestBusy, setEaTestBusy]       = useState(false);
  const [eaEnableBusy, setEaEnableBusy]   = useState(false);
  const [eaMsg, setEaMsg]                 = useState('');
  const [eaErr, setEaErr]                 = useState('');

  useEffect(() => { loadInfo(); }, []);

  async function loadInfo() {
    try {
      const res = await fetch('/api/admin/secrets');
      const d = await res.json() as {
        azure_client_id?: string | null; azure_tenant_id?: string | null;
        azure_redirect_uri?: string | null; azure_client_secret_set?: boolean; auth_mode?: string;
      };
      setInfo({
        clientId:  d.azure_client_id  ?? null,
        tenantId:  d.azure_tenant_id  ?? null,
        redirectUri: d.azure_redirect_uri ?? null,
        secretSet: !!d.azure_client_secret_set,
        authMode:  d.auth_mode ?? 'oidc',
      });
    } catch { setInfo(null); }
  }

  async function applySecret(e: React.FormEvent) {
    e.preventDefault();
    if (!secret.trim()) return;
    setBusy(true); setMsg(''); setErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-azure-settings', clientSecret: secret.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setMsg('Client secret updated.');
      setSecret('');
      await loadInfo();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  async function applyRedirectUri(e: React.FormEvent) {
    e.preventDefault();
    if (!newRedirectUri.trim()) return;
    setUriBusy(true); setUriMsg(''); setUriErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-azure-settings', redirectUri: newRedirectUri.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setUriMsg('Redirect URI updated. Make sure it also matches what is configured in the Azure App Registration.');
      setNewRedirectUri('');
      await loadInfo();
    } catch (e: unknown) { setUriErr(e instanceof Error ? e.message : 'Error'); }
    finally { setUriBusy(false); }
  }

  async function testEasyAuth() {
    setEaTestBusy(true); setEaTestResult(null); setEaErr('');
    try {
      const res = await fetch('/api/admin/test-connection?resource=easyauth');
      const d   = await res.json() as { ok?: boolean; detail?: string; error?: string };
      const detail =
        (typeof d.detail === 'string' && d.detail.trim()) ||
        (typeof d.error === 'string' && d.error.trim()) ||
        `HTTP ${res.status} — Easy Auth test returned no detail.`;
      setEaTestResult({ ok: d.ok === true, detail });
      if (!d.ok) setEaErr(detail);
    } catch (e: unknown) { setEaErr(e instanceof Error ? e.message : 'Test failed'); }
    finally { setEaTestBusy(false); }
  }

  async function enableEasyAuth() {
    setEaEnableBusy(true); setEaMsg(''); setEaErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-auth-mode', mode: 'easyauth' }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setEaMsg('Easy Auth enabled. Future logins will use Azure App Service authentication headers.');
      setEaTestResult(null);
      await loadInfo();
    } catch (e: unknown) { setEaErr(e instanceof Error ? e.message : 'Error'); }
    finally { setEaEnableBusy(false); }
  }

  async function disableEasyAuth() {
    setEaEnableBusy(true); setEaMsg(''); setEaErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-auth-mode', mode: 'oidc' }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setEaMsg('Switched back to OIDC / Azure AD App Registration authentication.');
      setEaTestResult(null);
      await loadInfo();
    } catch (e: unknown) { setEaErr(e instanceof Error ? e.message : 'Error'); }
    finally { setEaEnableBusy(false); }
  }

  const secretStatus = info === null ? 'Loading…' : info.secretSet ? 'Set' : 'Not set';
  const secretColor  = info === null ? 'var(--muted)' : info.secretSet ? 'var(--success-fg)' : 'var(--danger-fg)';
  const uriIsHttp    = info?.redirectUri?.startsWith('http://') && !info.redirectUri.includes('localhost');
  const isEasyAuth   = info?.authMode === 'easyauth';

  return (
    <Card title="Azure AD Settings">
      {info && (
        <div className="tbl-wrap" style={{ marginBottom: 16 }}>
          <table>
            <tbody>
              <tr>
                <td style={{ color: 'var(--muted)', fontSize: '0.78rem', paddingRight: 16 }}>Auth Mode</td>
                <td>
                  {isEasyAuth ? (
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--success-fg)', background: 'rgba(34,197,94,0.12)', borderRadius: 4, padding: '2px 8px' }}>
                      Easy Auth (Azure App Service)
                    </span>
                  ) : (
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--muted)', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '2px 8px' }}>
                      OIDC / App Registration
                    </span>
                  )}
                </td>
              </tr>
              {!isEasyAuth && (
                <>
                  <tr><td style={{ color: 'var(--muted)', fontSize: '0.78rem', paddingRight: 16 }}>Client ID</td><td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{info.clientId ?? '—'}</td></tr>
                  <tr><td style={{ color: 'var(--muted)', fontSize: '0.78rem', paddingRight: 16 }}>Tenant ID</td><td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{info.tenantId ?? '—'}</td></tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', fontSize: '0.78rem', paddingRight: 16, whiteSpace: 'nowrap' }}>Redirect URI</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {info.redirectUri ?? '—'}
                      {uriIsHttp && <span style={{ marginLeft: 8, color: 'var(--danger-fg)', fontSize: '0.72rem', fontWeight: 600 }}>⚠ http — should be https</span>}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--muted)', fontSize: '0.78rem', paddingRight: 16 }}>Client Secret</td>
                    <td style={{ color: secretColor, fontSize: '0.78rem', fontWeight: 600 }}>{secretStatus}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Easy Auth section ─────────────────────────────────────────── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 20 }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>Azure App Service Easy Auth</div>
        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
          When deployed on{' '}
          <a href="https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>
            Azure App Service with built-in authentication
          </a>{' '}
          enabled, Azure injects identity claims as HTTP headers — no App Registration client secret is required.
        </p>
        {eaErr  && <div className="msg-error"   style={{ marginBottom: 8 }}>{eaErr}</div>}
        {eaMsg  && <div className="msg-success"  style={{ marginBottom: 8 }}>{eaMsg}</div>}
        {eaTestResult && (
          <div className={eaTestResult.ok ? 'msg-success' : 'msg-error'} style={{ marginBottom: 8 }}>
            {eaTestResult.ok ? '✓ ' : '✗ '}{eaTestResult.detail || eaTestResult.error || 'No detail returned'}
          </div>
        )}
        {isEasyAuth ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={testEasyAuth} disabled={eaTestBusy || eaEnableBusy}>
              {eaTestBusy ? 'Testing…' : 'Test Easy Auth'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={disableEasyAuth} disabled={eaTestBusy || eaEnableBusy}>
              {eaEnableBusy ? 'Switching…' : 'Switch to OIDC'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={testEasyAuth} disabled={eaTestBusy || eaEnableBusy}>
              {eaTestBusy ? 'Testing…' : 'Test Easy Auth'}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={enableEasyAuth}
              disabled={eaEnableBusy || eaTestBusy || !eaTestResult?.ok}
              title={!eaTestResult?.ok ? 'Run Test Easy Auth first to verify the header is present' : undefined}
            >
              {eaEnableBusy ? 'Enabling…' : 'Enable Easy Auth'}
            </button>
            {!eaTestResult && (
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Run the test first — Easy Auth must be verified before enabling.</span>
            )}
          </div>
        )}
      </div>

      {/* ── OIDC-only settings (hidden in Easy Auth mode) ──────────────── */}
      {!isEasyAuth && (
        <>
          {err && <div className="msg-error" style={{ marginBottom: 10 }}>{err}</div>}
          {msg && <div className="msg-success" style={{ marginBottom: 10 }}>{msg}</div>}

          <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>Update redirect URI</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
            Use this if the auto-detected URI was incorrect (e.g. <code>http://</code> instead of <code>https://</code> on Azure).
            Must match exactly what is registered in <strong>Azure Portal → App registrations → Authentication</strong>.
          </p>
          {uriErr && <div className="msg-error"  style={{ marginBottom: 8 }}>{uriErr}</div>}
          {uriMsg && <div className="msg-success" style={{ marginBottom: 8 }}>{uriMsg}</div>}
          <form onSubmit={applyRedirectUri} style={{ display: 'flex', gap: 8, maxWidth: 540, marginBottom: 20 }}>
            <input
              type="url"
              placeholder={info?.redirectUri ?? 'https://yourapp.azurewebsites.net/auth/callback'}
              value={newRedirectUri}
              onChange={e => setNewRedirectUri(e.target.value)}
              required
              style={{ ...input, flex: 1 }}
            />
            <button type="submit" className="btn btn-sm" disabled={uriBusy || !newRedirectUri.trim()}>
              {uriBusy ? 'Saving…' : 'Apply'}
            </button>
          </form>

          <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>Update client secret</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
            Generate a new secret in <strong>Azure Portal → App registrations → Certificates &amp; secrets</strong>, then paste it here.
          </p>
          <form onSubmit={applySecret} style={{ display: 'flex', gap: 8, maxWidth: 540 }}>
            <input
              type="password"
              placeholder="New client secret value…"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              required
              style={{ ...input, flex: 1 }}
            />
            <button type="submit" className="btn btn-sm" disabled={busy || !secret.trim()}>
              {busy ? 'Saving…' : 'Apply'}
            </button>
          </form>
        </>
      )}
    </Card>
  );
}

// ─── Gitea API Token Section ──────────────────────────────────────────────────

function GiteaApiTokenSection() {
  const [status, setStatus]     = useState<'loading' | 'valid' | 'invalid'>('loading');
  const [account, setAccount]   = useState<string | null>(null);
  const [newToken, setNewToken] = useState('');
  const [busy, setBusy]         = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [msg, setMsg]           = useState('');
  const [err, setErr]           = useState('');

  useEffect(() => { checkStatus(); }, []);

  async function checkStatus() {
    setStatus('loading');
    try {
      const res = await fetch('/api/admin/secrets');
      const d = await res.json() as { gitea_token_valid?: boolean; gitea_token_account?: string };
      setStatus(d.gitea_token_valid ? 'valid' : 'invalid');
      setAccount(d.gitea_token_account ?? null);
    } catch { setStatus('invalid'); }
  }

  async function applyToken(e: React.FormEvent) {
    e.preventDefault();
    if (!newToken.trim()) return;
    setBusy(true); setMsg(''); setErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-gitea-token', token: newToken.trim() }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setMsg('Token applied — reloading status…');
      setNewToken('');
      await checkStatus();
      setMsg('Token is now active.');
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  async function generateToken() {
    setSyncBusy(true); setMsg(''); setErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate-gitea-token' }),
      });
      const d = await res.json() as { ok?: boolean; login?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setMsg(`New token generated — authenticated as ${d.login}.`);
      await checkStatus();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Error'); }
    finally { setSyncBusy(false); }
  }

  async function syncFromFile() {
    setSyncBusy(true); setMsg(''); setErr('');
    try {
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync-gitea-token-from-file' }),
      });
      const d = await res.json() as { ok?: boolean; login?: string; error?: string };
      if (!res.ok) throw new Error(d.error ?? 'Failed');
      setMsg(`Token synced from file — authenticated as ${d.login}.`);
      await checkStatus();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Error'); }
    finally { setSyncBusy(false); }
  }

  const statusColor = status === 'valid' ? 'var(--success-fg)' : status === 'invalid' ? 'var(--danger-fg)' : 'var(--muted)';
  const statusDot   = status === 'valid' ? '●' : status === 'invalid' ? '✕' : '○';
  const statusLabel = status === 'loading' ? 'Checking…' : status === 'valid' ? `Valid${account ? ` (${account})` : ''}` : 'Invalid';

  return (
    <Card title="Gitea API Token">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ color: statusColor, fontWeight: 700 }}>{statusDot}</span>
        <span style={{ fontSize: '0.82rem', color: statusColor }}>{statusLabel}</span>
        <button onClick={checkStatus} className="btn btn-ghost btn-sm" style={{ marginLeft: 4, padding: '2px 8px', fontSize: '0.75rem' }}>
          Refresh
        </button>
      </div>

      {err && <div className="msg-error" style={{ marginBottom: 10 }}>{err}</div>}
      {msg && <div className="msg-success" style={{ marginBottom: 10 }}>{msg}</div>}

      <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 8 }}>
        Apply a new token
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
        Generate a PAT in Gitea under <code>config365-admin → Settings → Applications</code>, then paste it here.
      </p>
      <form onSubmit={applyToken} style={{ display: 'flex', gap: 8, maxWidth: 540 }}>
        <input
          type="password"
          placeholder="Raw token…"
          value={newToken}
          onChange={e => setNewToken(e.target.value)}
          required
          style={{ ...input, flex: 1 }}
        />
        <button type="submit" className="btn btn-sm" disabled={busy || !newToken.trim()}>
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </form>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 500, color: '#d4d4d8', marginBottom: 6 }}>
          Auto-generate
        </div>
        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 10 }}>
          Creates a fresh Gitea API token automatically. Uses the admin password set via "Reset Admin Password" below, or falls back to the init-data file (always refreshed on Gitea restart).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={generateToken} disabled={syncBusy}>
            {syncBusy ? 'Generating…' : 'Generate new token'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={syncFromFile} disabled={syncBusy}>
            Sync from file
          </button>
        </div>
      </div>
    </Card>
  );
}

// ─── Token generator (for dev/non-AIO mode) ──────────────────────────────────

function TokenSection({ org }: { org: string }) {
  const [busy, setBusy]   = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function getToken() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/admin/runner?org=${encodeURIComponent(org)}`, { method: 'POST' });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setToken(data.token!);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Generate Runner Token">
      <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: 12 }}>
        Use this token to register an external Gitea Actions runner for the platform org.
      </p>
      {error && <div className="msg-error" style={{ marginBottom: 8 }}>{error}</div>}
      {token ? (
        <code style={{ background: '#0a0a0b', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 10px', fontSize: '0.8rem', display: 'block', wordBreak: 'break-all' }}>{token}</code>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={getToken} disabled={busy}>{busy ? 'Generating…' : 'Generate Token'}</button>
      )}
    </Card>
  );
}

// ─── Recent Activity Section ──────────────────────────────────────────────────

function RecentActivitySection() {
  return (
    <Card title="Recent Activity">
      <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 14 }}>
        Live progress of platform provisioning and scripts sync operations.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BootstrapProgress scope="platform"      title="Platform bootstrap" alwaysShow />
        <BootstrapProgress scope="scripts-sync"  title="Scripts sync"       alwaysShow />
      </div>
    </Card>
  );
}

// ─── External Services Section ────────────────────────────────────────────────

interface ServiceRow {
  key:       string;
  label:     string;
  resource:  string;
  configured:boolean;
  canProvision?: boolean;
  recommended?: boolean;
  activeChoice?: boolean;
}

interface TestResult { ok: boolean; detail: string; latencyMs?: number; schemaVersion?: number }

interface BackupHistoryEntry {
  ts: string;
  archiveName: string;
  status: 'success' | 'failed' | 'running' | string;
  sizeBytes?: number;
  error?: string;
  trigger?: string;
  container?: string;
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ExternalServicesSection() {
  const [portalRow, setPortalRow] = useState<ServiceRow | null>(null);
  const [tokenRows, setTokenRows] = useState<ServiceRow[]>([]);
  const [blobRow, setBlobRow]     = useState<ServiceRow | null>(null);
  const [tokenStorageType, setTokenStorageType] = useState('sqlite3');
  const [results, setResults] = useState<Record<string, TestResult | 'testing'>>({});
  const [provision, setProv]  = useState<Record<string, string>>({});
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [blobEdit, setBlobEdit] = useState({ container: '', uri: '', connectionString: '' });
  const [saving, setSaving]   = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');
  const [backupHistory, setBackupHistory] = useState<BackupHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => { loadStatus(); }, []);

  async function loadStatus() {
    try {
      const res = await fetch('/api/admin/secrets');
      const d   = await res.json() as Record<string, unknown>;
      const blobConfigured = !!d.blob_configured;
      const storageType = typeof d.token_storage_type === 'string' ? d.token_storage_type : 'sqlite3';
      const kvConfigured = !!d.keyvault_configured;
      const mssqlTokenConfigured = !!d.mssql_token_configured;
      setTokenStorageType(storageType);
      setPortalRow({
        key: 'mssql_portal_connection_string', label: 'MSSQL Portal DB', resource: 'mssql-portal',
        configured: !!d.mssql_portal_configured, canProvision: true,
      });
      // Key Vault first (recommended), then MSSQL Token — mutually exclusive choices
      setTokenRows([
        {
          key: 'keyvault_url', label: 'Azure Key Vault', resource: 'keyvault',
          configured: kvConfigured, recommended: true,
          activeChoice: storageType === 'keyvault' || (kvConfigured && !mssqlTokenConfigured),
        },
        {
          key: 'mssql_token_connection_string', label: 'MSSQL Token DB', resource: 'mssql-token',
          configured: mssqlTokenConfigured, canProvision: true,
          activeChoice: storageType === 'mssql' || (mssqlTokenConfigured && !kvConfigured),
        },
      ]);
      setBlobRow({
        key: 'blob_storage_container', label: 'Blob Storage', resource: 'blob', configured: blobConfigured,
      });
      if (blobConfigured) void loadBackupHistory();
    } catch { /* ignore */ }
  }

  async function loadBackupHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/admin/gitea-backup');
      const data = await res.json() as { history?: BackupHistoryEntry[] };
      setBackupHistory(Array.isArray(data.history) ? data.history : []);
    } catch { /* ignore */ }
    finally { setHistoryLoading(false); }
  }

  async function runBackupNow() {
    setBackupBusy(true);
    setBackupMsg('');
    try {
      const res = await fetch('/api/admin/gitea-backup', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; detail?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to start backup');
      setBackupMsg(data.detail ?? 'Backup started.');
      // Poll history while the dump may still be running
      let polls = 0;
      const timer = setInterval(() => {
        void loadBackupHistory();
        polls += 1;
        if (polls >= 12) clearInterval(timer);
      }, 5000);
      void loadBackupHistory();
    } catch (e: unknown) {
      setBackupMsg(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function testService(row: ServiceRow) {
    setResults(r => ({ ...r, [row.resource]: 'testing' }));
    try {
      const res  = await fetch(`/api/admin/test-connection?resource=${row.resource}`);
      const data = await res.json() as TestResult & { error?: string };
      const detail =
        (typeof data.detail === 'string' && data.detail.trim()) ||
        (typeof data.error === 'string' && data.error.trim()) ||
        (res.ok ? 'Connection test returned no detail.' : `HTTP ${res.status} — connection test failed with no detail.`);
      setResults(r => ({
        ...r,
        [row.resource]: {
          ok: data.ok === true,
          detail,
          latencyMs: data.latencyMs,
          schemaVersion: data.schemaVersion,
        },
      }));
      if (row.resource === 'blob' && data.ok) void loadBackupHistory();
    } catch (e: unknown) {
      setResults(r => ({ ...r, [row.resource]: { ok: false, detail: (e instanceof Error ? e.message : 'Error') } }));
    }
  }

  async function provisionService(target: 'portal' | 'token') {
    setProv(p => ({ ...p, [target]: 'Provisioning…' }));
    try {
      const res  = await fetch('/api/admin/provision-db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) });
      const data = await res.json() as { ok: boolean; error?: string; schemaVersion?: number; migrationsApplied?: number };
      setProv(p => ({
        ...p,
        [target]: data.ok
          ? `✓ Schema v${data.schemaVersion ?? 1} (${data.migrationsApplied ?? 0} migration(s))`
          : `✗ ${data.error ?? 'Failed'}`,
      }));
    } catch (e: unknown) {
      setProv(p => ({ ...p, [target]: `✗ ${e instanceof Error ? e.message : 'Error'}` }));
    }
  }

  async function saveConnStr() {
    if (!editKey || !editVal.trim()) return;
    setSaving(true); setSaveMsg('');
    try {
      const res  = await fetch('/api/admin/secrets', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'set-platform-setting', key: editKey, value: editVal.trim() }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      const exclusive = editKey === 'keyvault_url' || editKey === 'mssql_token_connection_string';
      setSaveMsg(exclusive
        ? 'Saved as active token storage (other option cleared). Test the connection to confirm.'
        : 'Saved — test the connection to confirm.');
      setEditKey(null); setEditVal('');
      await loadStatus();
    } catch (e: unknown) { setSaveMsg(`Error: ${e instanceof Error ? e.message : 'Unknown'}`); }
    finally { setSaving(false); }
  }

  async function saveBlobStorage() {
    if (!blobEdit.container.trim()) {
      setSaveMsg('Error: Container name is required.');
      return;
    }
    if (!blobEdit.uri.trim() && !blobEdit.connectionString.trim()) {
      setSaveMsg('Error: Provide a Storage Account URI and/or a connection string.');
      return;
    }
    setSaving(true); setSaveMsg('');
    try {
      const body: Record<string, unknown> = {
        action: 'set-blob-storage',
        container: blobEdit.container.trim(),
        uri: blobEdit.uri.trim(),
      };
      if (blobEdit.connectionString.trim()) {
        body.connectionString = blobEdit.connectionString.trim();
      }
      const res = await fetch('/api/admin/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setSaveMsg('Saved — test the connection to confirm.');
      setEditKey(null);
      setBlobEdit({ container: '', uri: '', connectionString: '' });
      await loadStatus();
    } catch (e: unknown) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(row: ServiceRow) {
    setSaveMsg('');
    setEditVal('');
    if (row.resource === 'blob') {
      setEditKey(row.key);
      setBlobEdit({ container: '', uri: '', connectionString: '' });
      return;
    }
    setEditKey(row.key);
  }

  function renderServiceRow(row: ServiceRow, opts?: { nested?: boolean; hideBorder?: boolean }) {
    const result = results[row.resource];
    const provKey = row.resource === 'mssql-portal' ? 'portal' : 'token';
    const showProv = row.canProvision && result && result !== 'testing' && result.ok;
    const labelMin = opts?.nested ? 130 : 150;
    return (
      <div key={row.key} style={{
        borderBottom: opts?.hideBorder ? 'none' : '1px solid var(--border)',
        paddingBottom: opts?.nested ? 10 : 12,
        marginBottom: opts?.nested ? 4 : 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500, fontSize: '0.83rem', color: '#d4d4d8', minWidth: labelMin }}>{row.label}</span>
          {row.recommended && (
            <span style={{
              fontSize: '0.68rem', fontWeight: 700, borderRadius: 4, padding: '2px 6px',
              background: '#1e3a5f', color: '#93c5fd',
            }}>
              Recommended
            </span>
          )}
          {row.activeChoice && (
            <span style={{
              fontSize: '0.68rem', fontWeight: 700, borderRadius: 4, padding: '2px 6px',
              background: '#14532d', color: '#86efac',
            }}>
              Active
            </span>
          )}
          <span style={{
            fontSize: '0.72rem', fontWeight: 600, borderRadius: 4, padding: '2px 7px',
            background: row.configured ? '#14532d' : '#1a1a1a',
            color:      row.configured ? '#22c55e' : 'var(--muted)',
          }}>
            {row.configured ? 'Configured' : 'Not configured'}
          </span>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: '0.75rem' }}
            onClick={() => testService(row)}>
            Test
          </button>
          {row.canProvision && (
            <button className="btn btn-sm" style={{ padding: '2px 10px', fontSize: '0.75rem', background: '#16a34a', border: 'none', color: '#fff', borderRadius: 4 }}
              onClick={() => provisionService(provKey as 'portal' | 'token')}>
              Provision
            </button>
          )}
          {row.resource === 'blob' && (
            <button
              className="btn btn-sm"
              style={{ padding: '2px 10px', fontSize: '0.75rem', background: row.configured ? '#16a34a' : '#27272a', border: 'none', color: '#fff', borderRadius: 4, opacity: row.configured && !backupBusy ? 1 : 0.5 }}
              disabled={!row.configured || backupBusy}
              onClick={() => void runBackupNow()}
              title="Run platform Gitea dump to Azure Blob (not per-tenant policy backup)"
            >
              {backupBusy ? 'Starting…' : 'Run backup'}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 10px', fontSize: '0.75rem' }}
            onClick={() => beginEdit(row)}>
            Edit
          </button>
        </div>

        {result && (
          <div style={{ fontSize: '0.76rem', marginLeft: labelMin, color: result === 'testing' ? 'var(--muted)' : result.ok ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
            {result === 'testing' ? '…testing' : `${result.ok ? '✓' : '✗'} ${result.detail}${result.latencyMs !== undefined ? ` (${result.latencyMs}ms)` : ''}${result.schemaVersion !== undefined ? ` · schema v${result.schemaVersion}` : ''}`}
          </div>
        )}

        {showProv && provision[provKey] && (
          <div style={{ fontSize: '0.76rem', marginLeft: labelMin, color: provision[provKey].startsWith('✓') ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
            {provision[provKey]}
          </div>
        )}

        {row.resource === 'blob' && (
          <div style={{ marginTop: 8, marginLeft: labelMin }}>
            <p style={{ fontSize: '0.72rem', color: 'var(--muted)', margin: '0 0 8px' }}>
              Platform Gitea disaster-recovery dump to Azure Blob (not tenant policy backups). Gitea may be briefly unavailable during a dump.
            </p>
            {backupMsg && (
              <div style={{ fontSize: '0.76rem', marginBottom: 8, color: backupMsg.startsWith('Error') ? 'var(--danger-fg)' : 'var(--success-fg)' }}>
                {backupMsg}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#d4d4d8' }}>Backup history</span>
              <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                onClick={() => void loadBackupHistory()} disabled={historyLoading}>
                {historyLoading ? '…' : 'Refresh'}
              </button>
            </div>
            {backupHistory.length === 0 ? (
              <div style={{ fontSize: '0.74rem', color: 'var(--muted)' }}>
                {historyLoading ? 'Loading…' : 'No backup runs recorded yet.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px', fontWeight: 500 }}>Time (UTC)</th>
                      <th style={{ padding: '6px 8px', fontWeight: 500 }}>Archive</th>
                      <th style={{ padding: '6px 8px', fontWeight: 500 }}>Status</th>
                      <th style={{ padding: '6px 8px', fontWeight: 500 }}>Size</th>
                      <th style={{ padding: '6px 8px', fontWeight: 500 }}>Trigger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupHistory.map((h, i) => (
                      <tr key={`${h.ts}-${h.archiveName}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 8px', color: '#a1a1aa', whiteSpace: 'nowrap' }}>
                          {h.ts ? new Date(h.ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'}
                        </td>
                        <td style={{ padding: '6px 8px', color: '#d4d4d8', fontFamily: 'ui-monospace, monospace' }}>
                          {h.archiveName || '—'}
                          {h.status === 'failed' && h.error && (
                            <div style={{ color: 'var(--danger-fg)', marginTop: 2, fontFamily: 'inherit' }}>{h.error}</div>
                          )}
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <span style={{
                            fontSize: '0.7rem', fontWeight: 600, borderRadius: 4, padding: '2px 6px',
                            background: h.status === 'success' ? '#14532d' : h.status === 'failed' ? '#450a0a' : '#1a1a1a',
                            color: h.status === 'success' ? '#22c55e' : h.status === 'failed' ? '#f87171' : 'var(--muted)',
                          }}>
                            {h.status}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', color: '#a1a1aa' }}>{formatBytes(h.sizeBytes)}</td>
                        <td style={{ padding: '6px 8px', color: '#a1a1aa' }}>{h.trigger || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {editKey === row.key && row.resource === 'blob' && (
          <div style={{ marginTop: 10, marginLeft: labelMin, maxWidth: 520 }}>
            <p style={{ fontSize: '0.72rem', color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
              Enter fields separately. Container name is not a connection string.
              Use URI for managed identity, or connection string for account-key auth (or both).
            </p>
            <label style={{ display: 'block', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>Container name</label>
            <input
              type="text"
              placeholder="e.g. config365-admin"
              value={blobEdit.container}
              onChange={e => setBlobEdit(v => ({ ...v, container: e.target.value }))}
              style={{ ...input, marginBottom: 8 }}
            />
            <label style={{ display: 'block', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>Storage Account URI (optional)</label>
            <input
              type="text"
              placeholder="https://mystorageaccount.blob.core.windows.net/"
              value={blobEdit.uri}
              onChange={e => setBlobEdit(v => ({ ...v, uri: e.target.value }))}
              style={{ ...input, marginBottom: 8 }}
            />
            <label style={{ display: 'block', fontSize: '0.72rem', color: '#a1a1aa', marginBottom: 4 }}>Connection string (optional)</label>
            <input
              type="password"
              placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
              value={blobEdit.connectionString}
              onChange={e => setBlobEdit(v => ({ ...v, connectionString: e.target.value }))}
              style={{ ...input, marginBottom: 10 }}
            />
            <button className="btn btn-sm" onClick={() => void saveBlobStorage()} disabled={saving} style={{ marginRight: 6 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditKey(null); setSaveMsg(''); }}>Cancel</button>
            {saveMsg && <span style={{ fontSize: '0.76rem', marginLeft: 10, color: saveMsg.startsWith('Error') ? 'var(--danger-fg)' : 'var(--success-fg)' }}>{saveMsg}</span>}
          </div>
        )}

        {editKey === row.key && row.resource !== 'blob' && (
          <div style={{ marginTop: 10, marginLeft: labelMin }}>
            {(row.resource === 'keyvault' || row.resource === 'mssql-token') && (
              <p style={{ fontSize: '0.72rem', color: '#fbbf24', margin: '0 0 8px' }}>
                Saving this selects it as token storage and clears the other option (Key Vault ↔ MSSQL Token).
              </p>
            )}
            <input
              type="password"
              placeholder={`New value for ${row.label}…`}
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              style={{ ...input, maxWidth: 420, marginRight: 8 }}
            />
            <button className="btn btn-sm" onClick={saveConnStr} disabled={saving || !editVal.trim()} style={{ marginRight: 6 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setEditKey(null); setSaveMsg(''); }}>Cancel</button>
            {saveMsg && <span style={{ fontSize: '0.76rem', marginLeft: 10, color: saveMsg.startsWith('Error') ? 'var(--danger-fg)' : 'var(--success-fg)' }}>{saveMsg}</span>}
          </div>
        )}
      </div>
    );
  }

  if (!portalRow && !blobRow && tokenRows.length === 0) return null;

  const usingSqliteTokens = tokenStorageType === 'sqlite3'
    && !tokenRows.some(r => r.configured);

  return (
    <Card title="External Services">
      <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: 14 }}>
        MSSQL, token storage, and Blob Storage integrations. Configure in the setup wizard or edit below.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {portalRow && renderServiceRow(portalRow)}

        <div style={{
          border: '1px solid #1e3a5f',
          borderRadius: 8,
          padding: '12px 14px',
          background: '#0a1220',
        }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 650, color: '#e4e4e7', marginBottom: 6 }}>
            Token storage — pick one
          </div>
          <p style={{ fontSize: '0.74rem', color: '#a1a1aa', margin: '0 0 12px', lineHeight: 1.45 }}>
            Choose <strong style={{ color: '#93c5fd' }}>Azure Key Vault</strong> <em>or</em> <strong style={{ color: '#d4d4d8' }}>MSSQL Token DB</strong> — not both.
            Key Vault is recommended (managed identity, no connection string). Saving one clears the other.
            {usingSqliteTokens && (
              <> Currently using local SQLite for tokens (setup default).</>
            )}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tokenRows.map((row, idx) => renderServiceRow(row, { nested: true, hideBorder: idx === tokenRows.length - 1 }))}
          </div>
        </div>

        {blobRow && renderServiceRow(blobRow)}
      </div>
    </Card>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function PlatformStatus({ org, adminUser, baseUrl, isAio }: Props) {
  return (
    <div style={{ maxWidth: 860 }}>
      <RecentActivitySection />
      <ExternalServicesSection />
      <AzureAdSettingsSection />
      <RunnerSection isAio={isAio} />
      <IntuneWinToolSection isAio={isAio} />
      <GiteaSection  adminUser={adminUser} baseUrl={baseUrl} />
      <GiteaApiTokenSection />
      {!isAio && <TokenSection org={org} />}
    </div>
  );
}
