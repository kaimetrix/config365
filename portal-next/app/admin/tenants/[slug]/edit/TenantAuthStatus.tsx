'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface ConnectionStatus {
  connected: boolean;
  expiresAt: string | null;
  updatedAt: string | null;
  error?:    string;
}

interface DeviceCodeInfo {
  user_code:        string;
  verification_uri: string;
  expires_in:       number;
  message?:         string;
}

interface Props {
  tenantSlug: string;
  mspSlug:    string;
}

// ─── Consent Step Card ────────────────────────────────────────────────────────

interface ConsentCardProps {
  consentUrl: string;
  onContinue: () => void;
  onCancel:   () => void;
}

function ConsentCard({ consentUrl, onContinue, onCancel }: ConsentCardProps) {
  return (
    <div style={{
      border: '2px solid #f59e0b',
      borderRadius: 10,
      padding: '20px 24px',
      background: 'var(--bg-raised, #fffbeb)',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Step 1 of 2 — Grant Admin Consent</span>
      </div>

      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.88rem' }}>
        <li>
          Open the link below and sign in as a <strong>Global Administrator</strong> of the target tenant:
          <div style={{ marginTop: 8 }}>
            <a
              href={consentUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                background: '#1d4ed8',
                color: '#fff',
                padding: '6px 14px',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: '0.85rem',
                textDecoration: 'none',
              }}
            >
              Grant Admin Consent ↗
            </a>
          </div>
        </li>
        <li>Review the requested permissions and click <strong>Accept</strong>.</li>
        <li>Return here and click <strong>Continue</strong> to complete sign-in.</li>
      </ol>

      <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.6 }}>
        Consent URL: <code style={{ wordBreak: 'break-all' }}>{consentUrl}</code>
      </p>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" onClick={onContinue}>
          I&apos;ve granted consent — Continue
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Reusable Device Code Card ────────────────────────────────────────────────

interface DeviceCodeCardProps {
  deviceCode:  DeviceCodeInfo;
  secondsLeft: number;
  pollMsg:     string;
  onCancel:    () => void;
}

function DeviceCodeCard({ deviceCode, secondsLeft, pollMsg, onCancel }: DeviceCodeCardProps) {
  const fmtTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div style={{
      border: '2px solid var(--accent, #6366f1)',
      borderRadius: 10,
      padding: '20px 24px',
      background: 'var(--bg-raised, #f8fafc)',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Admin sign-in required</span>
        <span style={{
          fontFamily: 'monospace', fontSize: '0.82rem',
          color: secondsLeft < 120 ? '#ef4444' : 'var(--muted)',
        }}>
          Expires in {fmtTime(secondsLeft)}
        </span>
      </div>

      <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.88rem' }}>
        <li>
          Open a browser and visit:{' '}
          <a
            href={deviceCode.verification_uri}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent, #6366f1)', fontWeight: 600 }}
          >
            {deviceCode.verification_uri}
          </a>
        </li>
        <li style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          Enter this code:&nbsp;
          <span style={{
            fontFamily: 'monospace',
            fontSize: '1.5rem',
            fontWeight: 700,
            letterSpacing: '0.15em',
            background: 'var(--bg-code, #e2e8f0)',
            padding: '4px 14px',
            borderRadius: 6,
            userSelect: 'all',
          }}>
            {deviceCode.user_code}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Copy code"
            onClick={() => navigator.clipboard.writeText(deviceCode.user_code)}
            style={{ fontSize: '0.78rem', padding: '2px 8px' }}
          >
            Copy
          </button>
        </li>
        <li>Sign in with a <strong>Global Administrator</strong> account for the tenant.</li>
      </ol>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: 'var(--muted)' }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: '#22c55e', animation: 'pulse 1.5s infinite',
          }} />
          {pollMsg || 'Waiting for sign-in…'}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TenantAuthStatus({ tenantSlug, mspSlug }: Props) {
  const [status, setStatus]         = useState<ConnectionStatus | null>(null);
  const [loading, setLoading]       = useState(true);

  // Graph / Exchange flow state
  const [busy, setBusy]             = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [pollMsg, setPollMsg]       = useState('');
  const [errorMsg, setErrorMsg]     = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [keyMissing, setKeyMissing] = useState(false);
  const [keyBusy, setKeyBusy]       = useState(false);
  const [consentUrl, setConsentUrl] = useState<string | null>(null);
  const [showConsent, setShowConsent] = useState(false);
  const pollTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  const countTimer = useRef<ReturnType<typeof setInterval> | null>(null);


  const stopPolling = useCallback(() => {
    if (pollTimer.current)  { clearInterval(pollTimer.current);  pollTimer.current  = null; }
    if (countTimer.current) { clearInterval(countTimer.current); countTimer.current = null; }
  }, []);


  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, keyRes] = await Promise.all([
        fetch(`/api/tenants/${tenantSlug}/token-status`),
        fetch(`/api/msps/${mspSlug}/internal-key`),
      ]);
      setStatus(await statusRes.json() as ConnectionStatus);
      if (keyRes.ok) {
        const keyData = await keyRes.json() as { configured?: boolean };
        setKeyMissing(!keyData.configured);
      }
    } catch {
      setStatus({ connected: false, expiresAt: null, updatedAt: null });
    } finally {
      setLoading(false);
    }
  }, [tenantSlug, mspSlug]);

  useEffect(() => {
    fetchStatus();
    return () => stopPolling();
  }, [fetchStatus, stopPolling]);

  // ── Graph/Exchange helpers ─────────────────────────────────────────────────

  function isKeyMissingResponse(_status: number, error?: string, code?: string): boolean {
    const msg = `${code ?? ''} ${error ?? ''}`.toLowerCase();
    // Do not treat every 422 as key-missing — that caused an infinite Generate Key loop.
    return msg.includes('msp_key_not_configured') || msg.includes('portal_internal_key');
  }

  async function generateKey() {
    setKeyBusy(true); setErrorMsg('');
    try {
      const res = await fetch(`/api/msps/${mspSlug}/internal-key`, { method: 'POST' });
      const data = await res.json() as { ok?: boolean; error?: string; giteaPushed?: boolean; giteaError?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed to generate key');
      setKeyMissing(false);
      if (data.giteaPushed === false) {
        setErrorMsg(
          `MSP key saved, but Gitea secret push failed${data.giteaError ? `: ${data.giteaError}` : ''}. ` +
          'Delegated auth can still proceed; fix the Gitea token if pipelines need PORTAL_INTERNAL_KEY.',
        );
      }
      await beginConnect();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Key generation failed');
    } finally {
      setKeyBusy(false);
    }
  }

  async function beginConnect() {
    setErrorMsg(''); setShowConsent(false);

    try {
      const keyRes = await fetch(`/api/msps/${mspSlug}/internal-key`);
      if (keyRes.ok) {
        const keyData = await keyRes.json() as { configured?: boolean };
        if (!keyData.configured) {
          setKeyMissing(true);
          return;
        }
      }
    } catch { /* fall through */ }

    // Fetch consent URL first — show Step 1 before starting the device code flow
    try {
      const res = await fetch(`/api/tenants/${tenantSlug}/auth-config`);
      const cfg = await res.json() as { consentUrl?: string; adminConsentUrl?: string };
      const url = cfg.consentUrl ?? cfg.adminConsentUrl;
      if (url) {
        setConsentUrl(url);
        setShowConsent(true);
        return;
      }
    } catch { /* fall through to device code directly */ }

    await startConnect();
  }

  async function startConnect() {
    setBusy(true); setErrorMsg(''); setDeviceCode(null); setPollMsg(''); setKeyMissing(false);
    setShowConsent(false);
    stopPolling();

    try {
      const res = await fetch(`/api/tenants/${tenantSlug}/connect`, { method: 'POST' });
      const data = await res.json() as DeviceCodeInfo & { error?: string; code?: string };

      if (!res.ok || data.error) {
        if (isKeyMissingResponse(res.status, data.error, data.code)) {
          setKeyMissing(true); setBusy(false); return;
        }
        setErrorMsg(data.error ?? 'Failed to start device code flow');
        setBusy(false);
        return;
      }

      setDeviceCode(data);
      setSecondsLeft(data.expires_in ?? 900);

      countTimer.current = setInterval(() => {
        setSecondsLeft(s => { if (s <= 1) { stopPolling(); return 0; } return s - 1; });
      }, 1000);

      pollTimer.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/tenants/${tenantSlug}/connect`);
          const poll = await pollRes.json() as { status: string; reason?: string; expected?: string; got?: string };
          if (poll.status === 'success') {
            stopPolling(); setDeviceCode(null); setPollMsg(''); setBusy(false);
            await fetchStatus();
          } else if (poll.status === 'expired') {
            stopPolling(); setDeviceCode(null);
            setErrorMsg('The device code expired. Click Connect again to retry.');
            setBusy(false);
          } else if (poll.status === 'tenant_mismatch') {
            stopPolling(); setDeviceCode(null);
            setErrorMsg(
              `Wrong tenant: you signed in with directory ${poll.got ?? '(unknown)'}` +
              ` but this tenant is configured for ${poll.expected ?? '(see tenant settings)'}. ` +
              `Sign in with an account from the correct Entra ID tenant.`
            );
            setBusy(false);
          } else if (poll.status === 'error') {
            stopPolling(); setDeviceCode(null);
            setErrorMsg(poll.reason
              ? `Sign-in failed: ${poll.reason}. Check the app registration configuration.`
              : 'An error occurred while checking sign-in status.');
            setBusy(false);
          }
        } catch { /* transient — keep polling */ }
      }, 5000);

    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Error starting connection');
      setBusy(false);
    }
  }

  function cancelConnect() {
    stopPolling(); setDeviceCode(null); setPollMsg(''); setBusy(false);
    setShowConsent(false); setConsentUrl(null);
  }

  async function disconnect() {
    if (!confirm('Disconnect this tenant? Pipelines will fail until reconnected.')) return;
    setBusy(true); setErrorMsg('');
    stopPolling(); setDeviceCode(null);
    try {
      const res = await fetch(`/api/tenants/${tenantSlug}/token-status`, { method: 'DELETE' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Disconnect failed');
      await fetchStatus();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Error disconnecting');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isConnected = status?.connected ?? false;
  const expiresAt   = status?.expiresAt ? new Date(status.expiresAt) : null;
  const updatedAt   = status?.updatedAt ? new Date(status.updatedAt) : null;

  return (
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Graph + Exchange Card ─────────────────────────────────────────── */}
      <div>
        <h3 style={{ marginBottom: 12, fontSize: '0.95rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.7 }}>
          Delegated Auth — Microsoft Graph &amp; Exchange
        </h3>

        {loading ? (
          <p style={{ opacity: 0.6, fontSize: '0.875rem' }}>Checking connection status…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {!deviceCode && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                  background: isConnected ? '#22c55e' : '#ef4444', flexShrink: 0,
                }} />
                <span style={{ fontWeight: 500 }}>{isConnected ? 'Connected' : 'Not connected'}</span>
              </div>
            )}

            {isConnected && !deviceCode && expiresAt && (
              <div style={{ fontSize: '0.8rem', opacity: 0.7, paddingLeft: 18 }}>
                Token expires: {expiresAt.toLocaleString()}<br />
                {updatedAt && <>Last refreshed: {updatedAt.toLocaleString()}</>}
              </div>
            )}

            {!isConnected && !deviceCode && (
              <p style={{ fontSize: '0.82rem', opacity: 0.7, paddingLeft: 18 }}>
                Pipelines cannot use delegated auth until an admin completes the sign-in below.
              </p>
            )}

            {showConsent && consentUrl && !deviceCode && (
              <ConsentCard
                consentUrl={consentUrl}
                onContinue={startConnect}
                onCancel={cancelConnect}
              />
            )}

            {deviceCode && (
              <DeviceCodeCard
                deviceCode={deviceCode}
                secondsLeft={secondsLeft}
                pollMsg={pollMsg}
                onCancel={cancelConnect}
              />
            )}

            {keyMissing && !deviceCode && (
              <div style={{
                padding: '14px 16px', borderRadius: 8,
                background: 'var(--bg-raised, #fefce8)', border: '1px solid #fbbf24',
                display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, color: '#92400e' }}>
                  MSP authentication key not configured
                </p>
                <p style={{ margin: 0, fontSize: '0.82rem', color: '#78350f' }}>
                  Each MSP needs a <code>PORTAL_INTERNAL_KEY</code> before tenants can connect.
                  Click below to generate one — it will be saved and pushed to the Gitea org automatically.
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={generateKey}
                  disabled={keyBusy}
                  style={{ alignSelf: 'flex-start', background: '#d97706', border: 'none', color: '#fff' }}
                >
                  {keyBusy ? 'Generating…' : 'Generate MSP Key & Connect'}
                </button>
              </div>
            )}

            {errorMsg && (
              <p style={{ fontSize: '0.82rem', padding: '8px 12px', borderRadius: 6, background: '#fee2e2', color: '#991b1b' }}>
                {errorMsg}
              </p>
            )}

            {!deviceCode && !keyMissing && !showConsent && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={beginConnect}
                  disabled={busy}
                  title="Grants admin consent then starts the OAuth2 device code flow"
                >
                  {busy ? 'Starting…' : isConnected ? 'Reconnect' : 'Connect'}
                </button>

                {isConnected && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={disconnect}
                    disabled={busy}
                    title="Removes all stored tokens — pipelines will fail until reconnected"
                  >
                    Disconnect
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={fetchStatus}
                  disabled={loading || busy}
                >
                  Refresh
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
