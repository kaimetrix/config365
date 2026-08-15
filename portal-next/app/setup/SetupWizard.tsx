'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BootstrapProgress } from '@/components/BootstrapProgress';

type Step = 'azure' | 'authenticate' | 'database' | 'azure-services' | 'complete' | 'provisioning';

interface SetupDefaults {
  azureStep:          Step;
  defaultRedirectUri: string;
  isEasyAuth?:        boolean;
}

export function SetupWizard({ defaults }: { defaults: SetupDefaults }) {
  const router = useRouter();

  const [step, setStep]   = useState<Step>(defaults.azureStep);
  const [error, setError] = useState('');
  const [busy, setBusy]   = useState(false);

  // ── Azure AD step ─────────────────────────────────────────────────────────
  const [useEasyAuth, setUseEasyAuth]   = useState(defaults.isEasyAuth ?? false);
  const [clientId, setClientId]         = useState('');
  const [tenantId, setTenantId]         = useState('');
  const [redirectUri, setRedirectUri]   = useState(defaults.defaultRedirectUri);
  const [clientSecret, setClientSecret] = useState('');

  // ── Database step ─────────────────────────────────────────────────────────
  const [portalDbType,     setPortalDbType]      = useState('sqlite3');
  const [mssqlPortalConn,  setMssqlPortalConn]  = useState('');
  const [giteeDbType,      setGiteaDbType]       = useState('sqlite3');
  const [giteaDbHost,      setGiteaDbHost]       = useState('');
  const [giteaDbName,      setGiteaDbName]       = useState('gitea');
  const [giteaDbUser,      setGiteaDbUser]       = useState('');
  const [giteaDbPassword,  setGiteaDbPassword]   = useState('');
  // Token storage — single exclusive choice: sqlite3 | mssql | keyvault
  const [tokenStorageType, setTokenStorageType]  = useState('sqlite3');
  const [tokenMssqlConn,   setTokenMssqlConn]    = useState('');
  const [kvUrl,            setKvUrl]             = useState('');
  const [dbTestResult,     setDbTestResult]      = useState<Record<string, string>>({});
  // ── Azure Services step ───────────────────────────────────────────────────
  const [blobContainer,         setBlobContainer]         = useState('');
  const [blobUri,               setBlobUri]               = useState('');
  const [blobConnStr,           setBlobConnStr]           = useState('');
  const [backupSchedule,        setBackupSchedule]        = useState('0 2 * * *');
  const [backupRetention,       setBackupRetention]       = useState('30');
  const [giteaExternalEnabled,  setGiteaExternalEnabled]  = useState(false);
  const [giteaExternalDir,      setGiteaExternalDir]      = useState('/mnt/gitea');
  const [blobBackupEnabled,     setBlobBackupEnabled]     = useState(false);
  const [azureTestResult,       setAzureTestResult]       = useState<Record<string, string>>({});

  // ── Provisioning step ─────────────────────────────────────────────────────
  const [platformDone,  setPlatformDone]  = useState(false);
  const [scriptsDone,   setScriptsDone]   = useState(false);
  const [platformError, setPlatformError] = useState(false);
  const [scriptsError,  setScriptsError]  = useState(false);

  const allDone    = platformDone && scriptsDone;
  const hasErrors  = platformError || scriptsError;
  const totalDone  = (platformDone ? 1 : 0) + (scriptsDone ? 1 : 0);

  // ── Helpers ───────────────────────────────────────────────────────────────

  // noAdvance=true: save to the API but don't navigate to the next step (used by Test buttons)
  async function submit(payload: Record<string, string>, noAdvance = false) {
    setBusy(true); setError('');
    try {
      const res  = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      if (!noAdvance) {
        const next = data.next as Step | undefined;
        if (next) setStep(next);
        else router.push('/');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally { setBusy(false); }
  }

  async function testConnection(resource: string, resultKey: string, setter: (fn: (prev: Record<string, string>) => Record<string, string>) => void) {
    setter(prev => ({ ...prev, [resultKey]: '…testing' }));
    try {
      const res  = await fetch(`/api/admin/test-connection?resource=${resource}`);
      const data = await res.json() as { ok?: boolean; detail?: string; error?: string; latencyMs?: number };
      const detail =
        (typeof data.detail === 'string' && data.detail.trim()) ||
        (typeof data.error === 'string' && data.error.trim()) ||
        (res.ok ? 'Connection test returned no detail.' : `HTTP ${res.status} — connection test failed with no detail.`);
      setter(prev => ({
        ...prev,
        [resultKey]: data.ok ? `✓ ${detail} (${data.latencyMs ?? 0}ms)` : `✗ ${detail}`,
      }));
    } catch (e: unknown) {
      setter(prev => ({ ...prev, [resultKey]: `✗ ${e instanceof Error ? e.message : 'Test failed'}` }));
    }
  }

  function azureServicesPayload(): Record<string, string> {
    return {
      step: 'azure-services-save',
      giteaExternalDir: giteaExternalEnabled ? giteaExternalDir : '',
      blobContainer:    blobBackupEnabled ? blobContainer : '',
      blobUri:          blobBackupEnabled ? blobUri : '',
      blobConnStr:      blobBackupEnabled ? blobConnStr : '',
      backupSchedule:   blobBackupEnabled ? backupSchedule : '',
      backupRetention:  blobBackupEnabled ? backupRetention : '',
    };
  }

  async function saveDatabaseStep() {
    setBusy(true); setError('');
    try {
      const payload = { step: 'database-save', mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl };
      const res  = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      const next = data.next as Step | undefined;
      if (next) setStep(next);
      else router.push('/');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'complete' }) });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      setStep('provisioning');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally { setBusy(false); }
  }

  const progressSteps: Step[] = ['azure', 'authenticate', 'database', 'azure-services', 'complete', 'provisioning'];
  const stepIdx = progressSteps.indexOf(step);

  return (
    <div style={{ margin: 0, background: '#09090b', color: '#e4e4e7', fontFamily: 'system-ui,sans-serif', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: 40, maxWidth: 560, width: '100%' }}>
        <h1 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: 4 }}>Config365 Setup</h1>
        <p style={{ color: '#71717a', fontSize: '0.85rem', marginBottom: 16 }}>Configure the platform before first use.</p>
        <div style={{
          background: 'rgba(234, 179, 8, 0.08)',
          border: '1px solid rgba(234, 179, 8, 0.35)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: '0.8rem',
          color: '#fde68a',
          lineHeight: 1.5,
          marginBottom: 28,
        }}>
          <strong style={{ color: '#facc15' }}>Isolated environment required.</strong>
          {' '}Config365 is intended to run on a private network or otherwise isolated host.
          It must not be published directly to the internet.
        </div>

        {/* Progress bar */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 28 }}>
          {progressSteps.map((s, i) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 4, background: step === s ? '#3b82f6' : (i < stepIdx ? '#22c55e' : '#27272a') }} />
          ))}
        </div>

        {error && <div style={{ background: '#450a0a', color: '#fca5a5', border: '1px solid #7f1d1d', borderRadius: 6, padding: '10px 14px', fontSize: '0.85rem', marginBottom: 16 }}>{error}</div>}

        {/* ── Step 1: Azure AD ──────────────────────────────────────────────── */}
        {step === 'azure' && (
          <form onSubmit={async e => {
            e.preventDefault();
            if (useEasyAuth) {
              setBusy(true); setError('');
              try {
                const res  = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'azure', easyAuth: 'true' }) });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? 'Request failed');
                // Bootstrap an iron-session from X-MS-CLIENT-PRINCIPAL before advancing.
                // /auth/easyauth creates the session then returns to /setup, which resumes
                // at the database step because auth_mode=easyauth is now saved.
                window.location.href = '/auth/easyauth?returnTo=/setup';
              } catch (e: unknown) {
                setError(e instanceof Error ? e.message : 'Unknown error');
                setBusy(false);
              }
            } else {
              submit({ step: 'azure', clientId, tenantId, redirectUri, clientSecret });
            }
          }}>
            <h2 style={sh2}>Step 1 — Azure AD App Registration</h2>

            {/* Easy Auth toggle */}
            <div onClick={() => setUseEasyAuth(v => !v)} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 10, cursor: 'pointer', marginBottom: 20, padding: '12px 14px', background: useEasyAuth ? '#052e16' : '#0d0d0f', border: `1px solid ${useEasyAuth ? '#166534' : '#27272a'}`, borderRadius: 8, width: '100%', boxSizing: 'border-box' }}>
              <input
                type="checkbox"
                checked={useEasyAuth}
                onChange={e => setUseEasyAuth(e.target.checked)}
                onClick={e => e.stopPropagation()}
                style={{ marginTop: 3, accentColor: '#22c55e', width: 15, height: 15 }}
              />
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: useEasyAuth ? '#86efac' : '#e4e4e7' }}>
                  Use Azure App Service Easy Auth
                </div>
                <div style={{ fontSize: '0.775rem', color: '#71717a', marginTop: 2 }}>
                  Azure handles authentication at the infrastructure level — no App Registration configuration needed here.{' '}
                  <a
                    href="https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    style={{ color: '#3b82f6', textDecoration: 'underline' }}
                  >
                    How to configure Easy Auth
                  </a>
                </div>
              </div>
            </div>

            {!useEasyAuth && (
              <>
                <Field label="Client ID *"              value={clientId}     onChange={setClientId}     placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required />
                <Field label="Tenant ID *"              value={tenantId}     onChange={setTenantId}     placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required />
                <Field label="Redirect URI (auto-detected — edit if behind a reverse proxy)" value={redirectUri} onChange={setRedirectUri} placeholder="https://portal.example.com/auth/callback" />
                <Field label="Client Secret (optional)" value={clientSecret} onChange={setClientSecret} type="password" />
              </>
            )}
            <SubmitBtn busy={busy} label="Next →" />
          </form>
        )}

        {/* ── Step 2: Sign in ──────────────────────────────────────────────── */}
        {step === 'authenticate' && (
          <div>
            <h2 style={sh2}>Step 2 — Sign in</h2>
            <p style={sp}>
              Azure AD is configured. Sign in with your Microsoft account to verify
              the credentials and continue setup.
            </p>
            <p style={{ color: '#52525b', fontSize: '0.78rem', marginBottom: 24 }}>
              You will be redirected to Microsoft login and returned here automatically.
              If you need to correct the Azure AD settings first, use the Back button.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setStep('azure')} style={btnSecondary}>← Back</button>
              <button
                onClick={() => { window.location.href = '/login/start?returnTo=/setup'; }}
                style={btnPrimary(false)}
              >
                Sign in with Microsoft →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Database (skippable) ─────────────────────────────────── */}
        {step === 'database' && (
          <div>
            <h2 style={sh2}>Step 3 — Database <SkipBadge /></h2>
            <p style={sp}>Configure where Config365 stores its operational and token data. SQLite is recommended (especially on Azure) — no extra setup needed.</p>

            <SectionLabel>Portal Operational Database</SectionLabel>
            <p style={{ color: '#52525b', fontSize: '0.78rem', marginBottom: 10 }}>
              Choose where portal operational data (tenants, MSPs, IAM) is stored. On Azure prefer SQLite; on-prem SQLite or full SQL Server are both fine. Azure SQL is not recommended.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, width: '100%' }}>
              {(['sqlite3', 'mssql'] as const).map(opt => (
                <div key={opt} onClick={() => { setPortalDbType(opt); if (opt === 'sqlite3') setMssqlPortalConn(''); }} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', alignItems: 'start', gap: 10, cursor: 'pointer', padding: '10px 12px', background: portalDbType === opt ? '#0d1f38' : '#0d0d0f', border: `1px solid ${portalDbType === opt ? '#1d4ed8' : '#27272a'}`, borderRadius: 7, width: '100%', boxSizing: 'border-box' }}>
                  <input type="radio" name="portalDbType" value={opt} checked={portalDbType === opt} onChange={() => { setPortalDbType(opt); if (opt === 'sqlite3') setMssqlPortalConn(''); }} style={{ marginTop: 3, accentColor: '#3b82f6' }} />
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: portalDbType === opt ? '#93c5fd' : '#e4e4e7', display: 'flex', alignItems: 'center', gap: 8 }}>
                      {opt === 'sqlite3' ? 'SQLite (recommended)' : 'Microsoft SQL Server'}
                      {opt === 'sqlite3' && (
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, borderRadius: 4, padding: '2px 6px', background: '#1e3a5f', color: '#93c5fd' }}>
                          Recommended on Azure
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: 2 }}>
                      {opt === 'sqlite3'
                        ? 'Stores data in a local SQLite file. Recommended on Azure; also fine on-prem.'
                        : 'Full Microsoft SQL Server (on-prem / VM). Fine for on-prem — not Azure SQL Database / elastic pools.'}
                    </div>
                    {opt === 'mssql' && portalDbType === 'mssql' && (
                        <div onClick={e => e.stopPropagation()} style={{ marginTop: 10 }}>
                          <Field label="MSSQL Connection String (portal)" value={mssqlPortalConn} onChange={setMssqlPortalConn}
                            placeholder="Server=sql.example.com,1433;Database=config365;User Id=...;Password=...;Encrypt=true" type="password" />
                          {mssqlPortalConn && (
                            <TestRow label="Test Portal DB" result={dbTestResult['portal']}
                              onTest={() => {
                                submit({ step: 'database-save', mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl }, true)
                                  .then(() => testConnection('mssql-portal', 'portal', setDbTestResult));
                              }} />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
              ))}
            </div>

            <SectionLabel>Token Storage</SectionLabel>
            <p style={{ color: '#52525b', fontSize: '0.78rem', marginBottom: 10 }}>
              Choose where M365 tenant tokens are stored. Pick <strong style={{ color: '#a1a1aa' }}>one</strong> option only — not both MSSQL and Key Vault.
              Azure Key Vault is recommended.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, width: '100%' }}>
              {(['sqlite3', 'keyvault', 'mssql'] as const).map(opt => (
                <div key={opt} onClick={() => setTokenStorageType(opt)} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', alignItems: 'start', gap: 10, cursor: 'pointer', padding: '10px 12px', background: tokenStorageType === opt ? '#0d1f38' : '#0d0d0f', border: `1px solid ${tokenStorageType === opt ? '#1d4ed8' : '#27272a'}`, borderRadius: 7, width: '100%', boxSizing: 'border-box' }}>
                  <input type="radio" name="tokenStorageType" value={opt} checked={tokenStorageType === opt} onChange={() => setTokenStorageType(opt)} style={{ marginTop: 3, accentColor: '#3b82f6' }} />
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: tokenStorageType === opt ? '#93c5fd' : '#e4e4e7', display: 'flex', alignItems: 'center', gap: 8 }}>
                      {opt === 'sqlite3' ? 'SQLite (default)' : opt === 'mssql' ? 'Microsoft SQL Server' : 'Azure Key Vault'}
                      {opt === 'keyvault' && (
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, borderRadius: 4, padding: '2px 6px', background: '#1e3a5f', color: '#93c5fd' }}>
                          Recommended
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: 2 }}>
                      {opt === 'sqlite3' && 'Tokens stored in the local SQLite file. No extra configuration needed.'}
                      {opt === 'mssql' && 'Tokens stored in full Microsoft SQL Server (on-prem / VM). Alternative to Key Vault — do not use both. Not Azure SQL.'}
                      {opt === 'keyvault' && 'Recommended. Tokens stored as Key Vault secrets via managed identity; no connection string required.'}
                    </div>
                    {opt === 'mssql' && tokenStorageType === 'mssql' && (
                      <div onClick={e => e.stopPropagation()} style={{ marginTop: 10 }}>
                        <Field label="MSSQL Connection String (token storage)" value={tokenMssqlConn} onChange={setTokenMssqlConn}
                          placeholder="Server=sql.example.com,1433;Database=tokens;User Id=...;Password=...;Encrypt=true" type="password" />
                        {tokenMssqlConn && (
                          <TestRow label="Test Token DB" result={dbTestResult['token']}
                            onTest={() => {
                              submit({ step: 'database-save', mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl }, true)
                                .then(() => testConnection('mssql-token', 'token', setDbTestResult));
                            }} />
                        )}
                      </div>
                    )}
                    {opt === 'keyvault' && tokenStorageType === 'keyvault' && (
                      <div onClick={e => e.stopPropagation()} style={{ marginTop: 10 }}>
                        <Field label="Key Vault URL" value={kvUrl} onChange={setKvUrl}
                          placeholder="https://myvault.vault.azure.net/" />
                        <p style={{ color: '#52525b', fontSize: '0.75rem', marginBottom: 8 }}>
                          Uses managed identity. Ensure the container identity has the Key Vault Secrets Officer role.
                        </p>
                        {kvUrl && (
                          <TestRow label="Test Key Vault" result={dbTestResult['keyvault']}
                            onTest={() => {
                              submit({ step: 'database-save', mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl }, true)
                                .then(() => testConnection('keyvault', 'keyvault', setDbTestResult));
                            }} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <SectionLabel>Gitea Database (optional — uses SQLite by default)</SectionLabel>
            <div style={{ background: '#1c1008', border: '1px solid #78350f', borderRadius: 6, padding: '10px 14px', fontSize: '0.8rem', color: '#fdba74', marginBottom: 12, lineHeight: 1.5 }}>
              <strong style={{ color: '#fed7aa' }}>SQLite is recommended on Azure.</strong>{' '}
              On-prem, SQLite or full Microsoft SQL Server (VM) are both fine.
              Azure SQL Database / elastic pools and Azure PostgreSQL (serverless / Flexible Server) are <strong style={{ color: '#fed7aa' }}>not recommended</strong>.
            </div>
            <p style={{ ...sp, fontSize: '0.8rem', color: '#a1a1aa', marginTop: -4, marginBottom: 10 }}>
              Gitea sees the most concurrent writes of any component (repo pushes, Actions runs). Prefer SQLite unless you run full SQL Server on-prem.
            </p>
            <div style={{ marginBottom: 14 }}>
              <label style={slabel}>Database Type</label>
              <select value={giteeDbType} onChange={e => setGiteaDbType(e.target.value)}
                style={{ background: '#0d0d0f', border: '1px solid #27272a', color: '#e4e4e7', borderRadius: 6, padding: '8px 10px', fontSize: '0.875rem', width: '100%' }}>
                <option value="sqlite3">SQLite (recommended — especially on Azure)</option>
                <option value="mssql">Microsoft SQL Server (on-prem / VM only — not Azure SQL)</option>
                <option value="postgres">PostgreSQL (not recommended on Azure)</option>
                <option value="mysql">MySQL / MariaDB (untested)</option>
              </select>
            </div>
            {giteeDbType !== 'sqlite3' && (
              <>
                <Field label="Host:Port" value={giteaDbHost} onChange={setGiteaDbHost} placeholder="sql.example.com,1433" />
                <Field label="Database Name" value={giteaDbName} onChange={setGiteaDbName} placeholder="gitea" />
                <Field label="User" value={giteaDbUser} onChange={setGiteaDbUser} placeholder="gitea_user" />
                <Field label="Password" value={giteaDbPassword} onChange={setGiteaDbPassword} type="password" />
                <TestRow label="Test Gitea DB" result={dbTestResult['gitea']}
                  onTest={() => {
                    submit({ step: 'database-save', mssqlPortalConn, giteeDbType, giteaDbHost, giteaDbName, giteaDbUser, giteaDbPassword, tokenStorageType, tokenMssqlConn, kvUrl }, true)
                      .then(() => testConnection('mssql-gitea', 'gitea', setDbTestResult));
                  }} />
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 24, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setStep('authenticate')} style={btnSecondary} disabled={busy}>← Back</button>
              <button onClick={saveDatabaseStep} disabled={busy} style={btnPrimary(busy)}>
                {busy ? 'Saving…' : 'Save & Continue →'}
              </button>
              <button onClick={() => submit({ step: 'database-skip' })} disabled={busy} style={btnSecondary}>
                Skip (use SQLite)
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Azure Services (skippable) ───────────────────────────── */}
        {step === 'azure-services' && (
          <div>
            <h2 style={sh2}>Step 4 — Azure Storage <SkipBadge /></h2>
            <p style={sp}>Configure Azure Blob Storage for Gitea backups and optionally store all Gitea data on an Azure Files share. Leave blank to skip.</p>

            <SectionLabel>Gitea File Storage (Azure Files)</SectionLabel>
            <UntestedWarning style={{ marginBottom: 10 }} />
            <div style={{ background: '#0c1a2e', border: '1px solid #1e3a5f', borderRadius: 5, padding: '8px 10px', fontSize: '0.72rem', color: '#93c5fd', marginBottom: 10, lineHeight: 1.45 }}>
              Config365 does <strong style={{ color: '#bfdbfe' }}>not</strong> create or mount the Azure Files share.
              Mount the SMB share into the container yourself (App Service, Container App, or compose), then enter that mount path here.
              Required SMB options: <code style={{ color: '#a1a1aa' }}>nobrl,mfsymlinks</code>.
            </div>
            <div onClick={() => setGiteaExternalEnabled(v => !v)} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 10, cursor: 'pointer', marginBottom: 14, padding: '12px 14px', background: giteaExternalEnabled ? '#0f1e10' : '#0d0d0f', border: `1px solid ${giteaExternalEnabled ? '#166534' : '#27272a'}`, borderRadius: 8, width: '100%', boxSizing: 'border-box' }}>
              <input
                type="checkbox"
                checked={giteaExternalEnabled}
                onChange={e => setGiteaExternalEnabled(e.target.checked)}
                onClick={e => e.stopPropagation()}
                style={{ marginTop: 3, accentColor: '#22c55e', width: 15, height: 15 }}
              />
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: giteaExternalEnabled ? '#86efac' : '#e4e4e7' }}>
                  Use Azure Files for Gitea data storage
                </div>
                <div style={{ fontSize: '0.775rem', color: '#71717a', marginTop: 2 }}>
                  Redirects Gitea config, repositories, LFS, logs, and templates to the mounted path.
                  SQLite and queue data always remain on the internal volume.
                </div>
              </div>
            </div>
            {giteaExternalEnabled && (
              <>
                <Field label="Mount path (where the Azure Files share is mounted in the container)" value={giteaExternalDir} onChange={setGiteaExternalDir} placeholder="/mnt/gitea" />
                <TestRow label="Test mount" result={azureTestResult['gitea-files']}
                  onTest={() => {
                    submit(azureServicesPayload(), true)
                      .then(() => testConnection('gitea-files-mount', 'gitea-files', setAzureTestResult));
                  }} />
              </>
            )}

            <SectionLabel>Azure Blob Storage (for Gitea backups)</SectionLabel>
            <div style={{ background: '#0c1a2e', border: '1px solid #1e3a5f', borderRadius: 5, padding: '8px 10px', fontSize: '0.72rem', color: '#93c5fd', marginBottom: 10, lineHeight: 1.45 }}>
              Create the blob container in Azure first — Config365 does not create it.
            </div>
            <div onClick={() => setBlobBackupEnabled(v => !v)} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 10, cursor: 'pointer', marginBottom: 14, padding: '12px 14px', background: blobBackupEnabled ? '#0f1e10' : '#0d0d0f', border: `1px solid ${blobBackupEnabled ? '#166534' : '#27272a'}`, borderRadius: 8, width: '100%', boxSizing: 'border-box' }}>
              <input
                type="checkbox"
                checked={blobBackupEnabled}
                onChange={e => setBlobBackupEnabled(e.target.checked)}
                onClick={e => e.stopPropagation()}
                style={{ marginTop: 3, accentColor: '#22c55e', width: 15, height: 15 }}
              />
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: blobBackupEnabled ? '#86efac' : '#e4e4e7' }}>
                  Enable Azure Blob Storage for Gitea backups
                </div>
                <div style={{ fontSize: '0.775rem', color: '#71717a', marginTop: 2 }}>
                  Uploads scheduled Gitea backups to an Azure Blob container. Provide either a Storage Account URI (managed identity) or a connection string (account key).
                </div>
              </div>
            </div>
            {blobBackupEnabled && (
              <>
                <Field label="Container Name" value={blobContainer} onChange={setBlobContainer} placeholder="gitea-backups" />
                <Field label="Storage Account URI (managed identity)" value={blobUri} onChange={setBlobUri}
                  placeholder="https://mystorageaccount.blob.core.windows.net/" />
                <Field label="Connection String (key auth)" value={blobConnStr} onChange={setBlobConnStr}
                  placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" type="password" />
                <Field label="Backup Schedule (cron)" value={backupSchedule} onChange={setBackupSchedule} placeholder="0 2 * * *" />
                <Field label="Backup Retention (days)" value={backupRetention} onChange={setBackupRetention} placeholder="30" />
                {blobContainer && (blobUri || blobConnStr) && (
                  <TestRow label="Test Blob Storage" result={azureTestResult['blob']}
                    onTest={() => {
                      submit(azureServicesPayload(), true)
                        .then(() => testConnection('blob', 'blob', setAzureTestResult));
                    }} />
                )}
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
              <button onClick={() => setStep('database')} style={btnSecondary}>← Back</button>
              <button onClick={() => submit(azureServicesPayload())}
                disabled={busy} style={btnPrimary(busy)}>
                {busy ? 'Saving…' : 'Save & Continue →'}
              </button>
              <button onClick={() => submit({ step: 'azure-services-skip' })} disabled={busy} style={btnSecondary}>
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Finalize ─────────────────────────────────────────────── */}
        {step === 'complete' && (
          <div>
            <h2 style={sh2}>Step 5 — Finalize</h2>
            <p style={{ color: '#71717a', fontSize: '0.85rem', marginBottom: 20 }}>
              All settings are configured. Click below to provision the platform and proceed to login.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setStep('azure-services')} style={btnSecondary}>← Back</button>
              <button onClick={finalize} disabled={busy} style={btnPrimary(busy)}>
                {busy ? 'Saving…' : 'Complete Setup'}
              </button>
            </div>
          </div>
        )}

        {/* ── Provisioning ─────────────────────────────────────────────────── */}
        {step === 'provisioning' && (
          <div>
            <h2 style={sh2}>Step 6 — Provisioning Platform</h2>

            {/* Progress counter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 4, background: '#27272a', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 4, background: allDone && !hasErrors ? '#22c55e' : '#3b82f6', width: `${(totalDone / 2) * 100}%`, transition: 'width 0.4s ease' }} />
              </div>
              <span style={{ fontSize: '0.75rem', color: '#71717a', whiteSpace: 'nowrap' }}>
                {totalDone} / 2 complete
              </span>
            </div>

            {/* Scope cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
              <BootstrapProgress
                scope="platform"
                title="Platform bootstrap"
                pollMs={2000}
                pendingLabel="Waiting to start…"
                onDone={(hasErr) => { setPlatformDone(true); if (hasErr) setPlatformError(true); }}
              />
              <BootstrapProgress
                scope="scripts-sync"
                title="Scripts sync"
                pollMs={2000}
                pendingLabel="Queued — starts after platform bootstrap completes"
                onDone={(hasErr) => { setScriptsDone(true); if (hasErr) setScriptsError(true); }}
              />
            </div>

            {/* Warning / status message */}
            {!allDone && (
              <div style={{ background: '#1c1400', border: '1px solid #7c4b00', borderRadius: 6, padding: '10px 14px', fontSize: '0.82rem', color: '#fbbf24', marginBottom: 16 }}>
                <strong>Provisioning is in progress.</strong> The portal may behave unexpectedly
                if you proceed before all tasks complete — Gitea repos and scripts are still being
                set up. We recommend waiting for all steps to finish.
              </div>
            )}
            {allDone && hasErrors && (
              <div style={{ background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6, padding: '10px 14px', fontSize: '0.82rem', color: '#fca5a5', marginBottom: 16 }}>
                <strong>Provisioning completed with errors.</strong> Some steps failed — check the
                details above. You can still continue; failed steps will be retried automatically
                on next login.
              </div>
            )}
            {allDone && !hasErrors && (
              <div style={{ background: '#052e16', border: '1px solid #166534', borderRadius: 6, padding: '10px 14px', fontSize: '0.82rem', color: '#86efac', marginBottom: 16 }}>
                <strong>All tasks completed successfully.</strong> The portal is ready.
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                onClick={() => router.push('/login')}
                disabled={!allDone}
                style={{
                  background: allDone ? (hasErrors ? '#d97706' : '#16a34a') : '#27272a',
                  color: '#fff', border: 'none', borderRadius: 6,
                  padding: '9px 20px', fontWeight: 600, cursor: allDone ? 'pointer' : 'not-allowed',
                  opacity: allDone ? 1 : 0.5,
                }}
              >
                {allDone ? 'Continue to Portal →' : 'Setting up platform…'}
              </button>
              {!allDone && (
                <span style={{ fontSize: '0.78rem', color: '#52525b' }}>
                  or{' '}
                  <button
                    onClick={() => router.push('/login')}
                    style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: '0.78rem', padding: 0, textDecoration: 'underline' }}
                  >
                    skip and go to portal
                  </button>
                  {' '}(not recommended while provisioning)
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────────────────────────

const sh2: React.CSSProperties = { fontSize: '0.95rem', fontWeight: 600, marginBottom: 16 };
const sp:  React.CSSProperties = { color: '#71717a', fontSize: '0.82rem', marginBottom: 16 };
const slabel: React.CSSProperties = { display: 'block', fontSize: '0.78rem', color: '#71717a', marginBottom: 4, fontWeight: 500 };
const btnPrimary   = (busy: boolean): React.CSSProperties => ({ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 });
const btnSecondary: React.CSSProperties = { background: 'none', color: '#71717a', border: '1px solid #27272a', borderRadius: 6, padding: '9px 18px', fontWeight: 500, cursor: 'pointer' };

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, type = 'text', required = false }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={slabel}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required}
        style={{ background: '#0d0d0f', border: '1px solid #27272a', color: '#e4e4e7', borderRadius: 6, padding: '8px 10px', fontSize: '0.875rem', width: '100%', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
    </div>
  );
}

function SubmitBtn({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button type="submit" disabled={busy} style={btnPrimary(busy)}>
      {busy ? 'Saving…' : label}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 20, marginBottom: 8, borderBottom: '1px solid #27272a', paddingBottom: 4 }}>{children}</div>;
}

function SkipBadge() {
  return <span style={{ fontSize: '0.65rem', fontWeight: 500, background: '#27272a', color: '#71717a', borderRadius: 4, padding: '2px 6px', marginLeft: 6, verticalAlign: 'middle' }}>optional</span>;
}

function UntestedWarning({ style }: { style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#1c1400', border: '1px solid #7c4b00', borderRadius: 5, padding: '6px 10px', fontSize: '0.72rem', color: '#fbbf24', marginTop: 6, ...style }}>
      ⚠&nbsp;Not fully tested in production — use with caution.
    </div>
  );
}


function TestRow({ label, result, onTest, primary = false }: { label: string; result?: string; onTest: () => void; primary?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <button type="button" onClick={onTest}
        style={{ background: primary ? '#16a34a' : '#27272a', color: primary ? '#fff' : '#e4e4e7', border: 'none', borderRadius: 5, padding: '5px 12px', fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        {label}
      </button>
      {result && (
        <span style={{ fontSize: '0.78rem', color: result.startsWith('✓') ? '#22c55e' : (result.startsWith('…') ? '#71717a' : '#f87171') }}>
          {result}
        </span>
      )}
    </div>
  );
}
