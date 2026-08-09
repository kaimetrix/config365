'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { notifyDashboardBurstRefresh } from '@/lib/dashboard-refresh';

// ─── Deploy option definitions (mirrors staticapp) ────────────────────────────

const OPERATION_CONTROLS = [
  { keyword: 'allowCreate', label: 'Allow CREATE', desc: "Create resources that don't exist yet" },
  { keyword: 'allowUpdate', label: 'Allow UPDATE', desc: 'Modify existing resources with changes' },
  { keyword: 'allowDelete', label: 'Allow DELETE', desc: 'Remove resources listed in baseline-remove/' },
];

const BASELINE_MODULES: { keyword: string; label: string }[] = [
  { keyword: 'deployCustomAttributes',         label: 'Custom Attributes' },
  { keyword: 'deployGroups',                   label: 'Groups' },
  { keyword: 'deployEntraIdDeviceSettings',    label: 'Entra ID Settings' },
  { keyword: 'deployDefenderConnector',        label: 'Defender Connector' },
  { keyword: 'deployConditionalAccess',        label: 'Conditional Access' },
  { keyword: 'deployTeams',                    label: 'Teams' },
  { keyword: 'deploySharePoint',               label: 'SharePoint' },
  { keyword: 'deployExchange',                 label: 'Exchange Online' },
  { keyword: 'deployIntune',                   label: 'Intune' },
  { keyword: 'deployEnterpriseApps',           label: 'Enterprise Apps' },
  { keyword: 'deployAuthenticationPolicies',   label: 'Authentication Policies' },
  { keyword: 'deployEntraIdConsentpermissions',label: 'Consent Permissions' },
  { keyword: 'deploySharePointSettings',       label: 'SharePoint Settings' },
  { keyword: 'deployInformationProtection',    label: 'Information Protection' },
  { keyword: 'deployAppsChocolatey',           label: 'Apps: Chocolatey' },
  { keyword: 'deployAppsWinget',               label: 'Apps: WinGet' },
  { keyword: 'deployAppsCustom',               label: 'Apps: Custom' },
  { keyword: 'deployAppsPrinter',              label: 'Apps: Printers' },
];

/** All keywords enabled — used for the quick-deploy (no modal) button. */
const ALL_OPTIONS = [
  ...OPERATION_CONTROLS.map(c => c.keyword),
  ...BASELINE_MODULES.map(m => m.keyword),
].join(',');

// ─── Shared trigger helper ─────────────────────────────────────────────────────

async function triggerDeploy(slug: string, deployOptions: string): Promise<void> {
  const res = await fetch('/api/pipelines/trigger', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      slug,
      workflow: 'deploy.yml',
      inputs:   { deploy_options: deployOptions },
    }),
  });
  if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed');
}

// ─── Maintenance option definitions ──────────────────────────────────────────

const MAINTENANCE_TASKS: { keyword: string; label: string }[] = [
  { keyword: 'groupSplits',        label: 'Group Split Rebalancing' },
  { keyword: 'exchangeFonts',      label: 'Exchange Default Font' },
  { keyword: 'exchangeGal',        label: 'Exchange GAL Visibility' },
  { keyword: 'intuneDeviceRename', label: 'Intune Device Auto-Rename' },
  { keyword: 'intunePrimaryUser',  label: 'Intune Primary User Assignment' },
  { keyword: 'entraDeviceCleanup', label: 'Entra ID Device Cleanup' },
  { keyword: 'baselineApplyCleanup', label: 'Baseline Apply Scope Cleanup' },
];

const ALL_MAINT_TASKS = MAINTENANCE_TASKS.map(t => t.keyword).join(',');

// ─── Maintenance Options Modal ────────────────────────────────────────────────

function MaintenanceOptionsModal({
  slug,
  tenantName,
  onClose,
  onDone,
}: {
  slug: string;
  tenantName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const allKws = MAINTENANCE_TASKS.map(t => t.keyword);
  const [taskKws, setTaskKws] = useState<Set<string>>(new Set(allKws));
  const [whatIf,  setWhatIf]  = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState('');

  function toggle(kw: string): void {
    setTaskKws(prev => {
      const next = new Set(prev);
      next.has(kw) ? next.delete(kw) : next.add(kw);
      return next;
    });
  }

  async function run() {
    const tasks = [...taskKws].join(',');
    if (!tasks) { setErr('Select at least one task.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/pipelines/trigger', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          slug,
          workflow: 'maintenance.yml',
          inputs:   { maintenance_tasks: tasks, what_if: String(whatIf) },
        }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed');
      onClose();
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  }

  const chk = (checked: boolean) => ({
    width: 14, height: 14, accentColor: '#60a5fa', cursor: 'pointer' as const,
    opacity: checked ? 1 : 0.5,
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 420, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #27272a' }}>
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>Run maintenance — {tenantName}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', overflowY: 'auto', flex: 1 }}>
          {/* Tasks */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: '0.68rem', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
              Tasks
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setTaskKws(new Set(allKws))} style={{ fontSize: '0.7rem', color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                Select all
              </button>
              <button onClick={() => setTaskKws(new Set())} style={{ fontSize: '0.7rem', color: '#71717a', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                Deselect all
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {MAINTENANCE_TASKS.map(task => (
              <label key={task.keyword} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={taskKws.has(task.keyword)}
                  onChange={() => toggle(task.keyword)}
                  style={chk(taskKws.has(task.keyword))}
                />
                <span style={{ fontSize: '0.8rem', color: '#d4d4d8' }}>{task.label}</span>
              </label>
            ))}
          </div>

          {/* WhatIf toggle */}
          <div style={{ borderTop: '1px solid #27272a', paddingTop: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={whatIf}
                onChange={e => setWhatIf(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: '#a78bfa', cursor: 'pointer' }}
              />
              <span>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e4e4e7' }}>WhatIf (preview only)</span>
                <span style={{ fontSize: '0.75rem', color: '#71717a', marginLeft: 6 }}>Show changes without applying them</span>
              </span>
            </label>
            {whatIf && (
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#1a1200', border: '1px solid #78350f', borderRadius: 6, fontSize: '0.75rem', color: '#fbbf24' }}>
                Results will be saved and viewable in maintenance history.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #27272a' }}>
          {err && <span style={{ color: '#fca5a5', fontSize: '0.78rem', marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={{ padding: '7px 16px', fontSize: '0.8rem', background: '#18181b', border: '1px solid #27272a', color: '#a1a1aa', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancel
          </button>
          <button
            onClick={run}
            disabled={busy}
            style={{ padding: '7px 18px', fontSize: '0.8rem', fontWeight: 600, background: busy ? '#15803d' : '#16a34a', border: 'none', color: '#fff', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.7 : 1 }}
          >
            {busy ? 'Running…' : whatIf ? 'Run WhatIf' : 'Run Maintenance'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Deploy Options Modal ─────────────────────────────────────────────────────

function DeployOptionsModal({
  slug,
  tenantName,
  onClose,
  onDone,
}: {
  slug: string;
  tenantName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const allOpKws  = OPERATION_CONTROLS.map(c => c.keyword);
  const allModKws = BASELINE_MODULES.map(m => m.keyword);

  const [opKws,  setOpKws]  = useState<Set<string>>(new Set(allOpKws));
  const [modKws, setModKws] = useState<Set<string>>(new Set(allModKws));
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState('');

  function toggle(set: Set<string>, kw: string): Set<string> {
    const next = new Set(set);
    next.has(kw) ? next.delete(kw) : next.add(kw);
    return next;
  }

  async function deploy() {
    const opts = [...opKws, ...modKws].join(',');
    if (!opts) { setErr('Select at least one option.'); return; }
    setBusy(true); setErr('');
    try {
      await triggerDeploy(slug, opts);
      onClose();
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed');
      setBusy(false);
    }
  }

  const chk = (checked: boolean) => ({
    width: 14, height: 14, accentColor: '#60a5fa', cursor: 'pointer' as const,
    opacity: checked ? 1 : 0.5,
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #27272a' }}>
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>Deploy with options — {tenantName}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px', overflowY: 'auto', flex: 1 }}>
          {/* Operation controls */}
          <div style={{ fontSize: '0.68rem', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 10 }}>
            Operation Controls
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {OPERATION_CONTROLS.map(ctrl => (
              <label key={ctrl.keyword} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={opKws.has(ctrl.keyword)}
                  onChange={() => setOpKws(prev => toggle(prev, ctrl.keyword))}
                  style={chk(opKws.has(ctrl.keyword))}
                />
                <span>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e4e4e7' }}>{ctrl.label}</span>
                  <span style={{ fontSize: '0.75rem', color: '#71717a', marginLeft: 6 }}>{ctrl.desc}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Baseline modules */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: '0.68rem', color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
              Baseline Modules
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setModKws(new Set(allModKws))} style={{ fontSize: '0.7rem', color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                Select all
              </button>
              <button onClick={() => setModKws(new Set())} style={{ fontSize: '0.7rem', color: '#71717a', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
                Deselect all
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {BASELINE_MODULES.map(mod => (
              <label key={mod.keyword} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={modKws.has(mod.keyword)}
                  onChange={() => setModKws(prev => toggle(prev, mod.keyword))}
                  style={chk(modKws.has(mod.keyword))}
                />
                <span style={{ fontSize: '0.8rem', color: '#d4d4d8' }}>{mod.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #27272a' }}>
          {err && <span style={{ color: '#fca5a5', fontSize: '0.78rem', marginRight: 'auto' }}>{err}</span>}
          <button onClick={onClose} style={{ padding: '7px 16px', fontSize: '0.8rem', background: '#18181b', border: '1px solid #27272a', color: '#a1a1aa', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
            Cancel
          </button>
          <button
            onClick={deploy}
            disabled={busy}
            style={{ padding: '7px 18px', fontSize: '0.8rem', fontWeight: 600, background: busy ? '#1d4ed8' : '#2563eb', border: 'none', color: '#fff', borderRadius: 6, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.7 : 1 }}
          >
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Auth Modal ────────────────────────────────────────────────────────────────

interface AuthStatus {
  connected:  boolean;
  expiresAt:  string | null;
  updatedAt:  string | null;
}

interface DeviceCodeInfo {
  user_code:        string;
  verification_uri: string;
  expires_in:       number;
}

function TenantAuthModal({ slug, mspSlug, tenantName, onClose }: { slug: string; mspSlug: string; tenantName: string; onClose: () => void }) {
  const [status, setStatus]         = useState<AuthStatus | null>(null);
  const [loading, setLoading]       = useState(true);
  const [busy, setBusy]             = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);
  const [errorMsg, setErrorMsg]     = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [keyMissing, setKeyMissing] = useState(false);
  const [keyBusy, setKeyBusy]       = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [consentUrl, setConsentUrl]   = useState<string | null>(null);
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
        fetch(`/api/tenants/${slug}/token-status`),
        fetch(`/api/msps/${mspSlug}/internal-key`),
      ]);
      setStatus(await statusRes.json() as AuthStatus);
      if (keyRes.ok) {
        const keyData = await keyRes.json() as { configured?: boolean };
        setKeyMissing(!keyData.configured);
      }
    } catch {
      setStatus({ connected: false, expiresAt: null, updatedAt: null });
    } finally {
      setLoading(false);
    }
  }, [slug, mspSlug]);

  useEffect(() => {
    fetchStatus();
    return () => stopPolling();
  }, [fetchStatus, stopPolling]);

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
      await startConnect();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Key generation failed');
    } finally {
      setKeyBusy(false);
    }
  }

  function isKeyMissingResponse(_status: number, error?: string, code?: string): boolean {
    const msg = `${code ?? ''} ${error ?? ''}`.toLowerCase();
    // Do not treat every 422 as key-missing — that caused an infinite Generate Key loop.
    return msg.includes('msp_key_not_configured') || msg.includes('portal_internal_key');
  }

  async function beginConnect() {
    setErrorMsg('');
    // Prefer generating the MSP key before showing consent — otherwise Connect
    // looks like a no-op when consent UI appears and key is still missing.
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

    try {
      const res = await fetch(`/api/tenants/${slug}/auth-config`);
      const cfg = await res.json() as { adminConsentUrl?: string };
      if (cfg.adminConsentUrl) {
        setConsentUrl(cfg.adminConsentUrl);
        setShowConsent(true);
        return;
      }
    } catch { /* fall through */ }
    await startConnect();
  }

  async function startConnect() {
    setBusy(true); setErrorMsg(''); setDeviceCode(null); setKeyMissing(false);
    setShowConsent(false);
    stopPolling();
    try {
      const res = await fetch(`/api/tenants/${slug}/connect`, { method: 'POST' });
      const data = await res.json() as DeviceCodeInfo & { error?: string; code?: string };
      if (!res.ok || data.error) {
        if (isKeyMissingResponse(res.status, data.error, data.code)) {
          setKeyMissing(true); setBusy(false); return;
        }
        setErrorMsg(data.error ?? 'Failed to start device code flow'); setBusy(false); return;
      }

      setDeviceCode(data);
      setSecondsLeft(data.expires_in ?? 900);

      countTimer.current = setInterval(() => {
        setSecondsLeft(s => { if (s <= 1) { stopPolling(); return 0; } return s - 1; });
      }, 1000);

      pollTimer.current = setInterval(async () => {
        try {
          const poll = await (await fetch(`/api/tenants/${slug}/connect`)).json() as { status: string; reason?: string; expected?: string; got?: string };
          if (poll.status === 'success') {
            stopPolling(); setDeviceCode(null); setBusy(false); await fetchStatus();
          } else if (poll.status === 'expired') {
            stopPolling(); setDeviceCode(null); setBusy(false);
            setErrorMsg('The device code expired. Click Connect again to retry.');
          } else if (poll.status === 'tenant_mismatch') {
            stopPolling(); setDeviceCode(null); setBusy(false);
            setErrorMsg(
              `Wrong tenant: you signed in with directory ${poll.got ?? '(unknown)'}` +
              ` but this tenant is configured for ${poll.expected ?? '(see tenant settings)'}. ` +
              `Sign in with an account from the correct Entra ID tenant.`
            );
          } else if (poll.status === 'error') {
            stopPolling(); setDeviceCode(null); setBusy(false);
            setErrorMsg(poll.reason
              ? `Sign-in failed: ${poll.reason}. Check the app registration configuration.`
              : 'An error occurred. Please try again.');
          }
        } catch { /* transient — keep polling */ }
      }, 5000);
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Error');
      setBusy(false);
    }
  }

  function cancelConnect() { stopPolling(); setDeviceCode(null); setBusy(false); setShowConsent(false); setConsentUrl(null); }

  async function disconnect() {
    if (!confirm(`Disconnect ${tenantName}? Pipelines will fail until reconnected.`)) return;
    setBusy(true); setErrorMsg(''); stopPolling(); setDeviceCode(null);
    try {
      const res = await fetch(`/api/tenants/${slug}/token-status`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed');
      await fetchStatus();
    } catch (e: unknown) { setErrorMsg(e instanceof Error ? e.message : 'Error disconnecting'); }
    finally { setBusy(false); }
  }

  const connected = status?.connected;
  const expiresAt = status?.expiresAt ? new Date(status.expiresAt) : null;
  const updatedAt = status?.updatedAt ? new Date(status.updatedAt) : null;
  const fmtTime   = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const s = {
    overlay:  { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
    box:      { background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.6)' },
    header:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #27272a' },
    body:     { padding: '18px 18px 20px' },
    btnRow:   { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' as const },
    btn:      { padding: '6px 14px', fontSize: '0.8rem', fontWeight: 600, background: '#2563eb', border: 'none', color: '#fff', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' } as React.CSSProperties,
    btnDanger:{ padding: '6px 14px', fontSize: '0.8rem', background: 'transparent', border: '1px solid #7f1d1d', color: '#f87171', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' } as React.CSSProperties,
    btnGhost: { padding: '6px 14px', fontSize: '0.8rem', background: 'transparent', border: '1px solid #27272a', color: '#71717a', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' } as React.CSSProperties,
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.box}>
        <div style={s.header}>
          <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#e4e4e7' }}>
            Delegated Auth — {tenantName}
          </span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: '1.1rem', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit' }}>×</button>
        </div>

        <div style={s.body}>
          {loading ? (
            <p style={{ color: '#52525b', fontSize: '0.85rem' }}>Checking connection…</p>
          ) : (
            <>
              {/* Status dot */}
              {!deviceCode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: connected ? '#22c55e' : '#ef4444', flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.875rem', color: connected ? '#86efac' : '#fca5a5' }}>
                    {connected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
              )}

              {!deviceCode && connected && expiresAt && (
                <div style={{ fontSize: '0.78rem', color: '#52525b', paddingLeft: 18, lineHeight: 1.6, marginBottom: 6 }}>
                  Token expires: {expiresAt.toLocaleString()}<br />
                  {updatedAt && <>Last refreshed: {updatedAt.toLocaleString()}</>}
                </div>
              )}

              {!deviceCode && !connected && (
                <p style={{ fontSize: '0.8rem', color: '#52525b', paddingLeft: 18, lineHeight: 1.5, marginBottom: 6 }}>
                  Pipelines cannot use delegated auth until an admin completes the sign-in below.
                </p>
              )}

              {/* Step 1 — Admin consent */}
              {showConsent && consentUrl && !deviceCode && (
                <div style={{ border: '1px solid #1d4ed8', borderRadius: 8, padding: '14px 16px', background: '#0a0f1e', marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.8rem', color: '#93c5fd', marginBottom: 8 }}>
                    Step 1 of 2 — Grant admin consent
                  </div>
                  <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: '#a1a1aa', lineHeight: 1.5 }}>
                    Open the link below and click <strong style={{ color: '#e4e4e7' }}>Accept</strong> to grant this
                    application the latest permissions in <strong style={{ color: '#e4e4e7' }}>{tenantName}</strong>.
                    This ensures Exchange and other services have the correct delegated access.
                  </p>
                  <a href={consentUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-block', padding: '6px 14px', fontSize: '0.78rem', fontWeight: 600, background: '#1d4ed8', color: '#fff', borderRadius: 5, textDecoration: 'none', marginBottom: 12 }}>
                    Open consent page ↗
                  </a>
                  <div style={{ fontSize: '0.72rem', color: '#52525b', marginBottom: 10, wordBreak: 'break-all' }}>
                    {consentUrl}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={startConnect}
                      style={{ ...s.btn, background: '#16a34a' }}>
                      I&apos;ve granted consent — Continue to sign-in
                    </button>
                    <button type="button" onClick={cancelConnect} style={s.btnGhost}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Device code card */}
              {deviceCode && (
                <div style={{ border: '1px solid #3730a3', borderRadius: 8, padding: '14px 16px', background: '#0d0d1a', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#c7d2fe' }}>Admin sign-in required</span>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: secondsLeft < 120 ? '#f87171' : '#52525b' }}>
                      {fmtTime(secondsLeft)}
                    </span>
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem', color: '#a1a1aa', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <li>
                      Visit:{' '}
                      <a href={deviceCode.verification_uri} target="_blank" rel="noopener noreferrer"
                        style={{ color: '#818cf8', fontWeight: 600 }}>
                        {deviceCode.verification_uri}
                      </a>
                    </li>
                    <li>
                      <span>Enter code:&nbsp;</span>
                      <span style={{ fontFamily: 'monospace', fontSize: '1.25rem', fontWeight: 700, letterSpacing: '0.15em', color: '#fff', background: '#1e1e2e', padding: '2px 10px', borderRadius: 5, userSelect: 'all' }}>
                        {deviceCode.user_code}
                      </span>
                      <button type="button" onClick={() => navigator.clipboard.writeText(deviceCode.user_code)}
                        style={{ marginLeft: 8, fontSize: '0.72rem', color: '#818cf8', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                        Copy
                      </button>
                    </li>
                    <li style={{ color: '#71717a' }}>Sign in as a <strong style={{ color: '#a1a1aa' }}>Global Administrator</strong></li>
                  </ol>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block', animation: 'pulse 1.5s infinite' }} />
                    <span style={{ fontSize: '0.75rem', color: '#52525b' }}>Waiting for sign-in…</span>
                    <button type="button" onClick={cancelConnect}
                      style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#71717a', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Key not configured */}
              {keyMissing && !deviceCode && (
                <div style={{ padding: '12px 14px', borderRadius: 7, background: '#1a1200', border: '1px solid #78350f', marginBottom: 10 }}>
                  <p style={{ margin: '0 0 8px', fontSize: '0.8rem', fontWeight: 600, color: '#fbbf24' }}>
                    MSP authentication key not configured
                  </p>
                  <p style={{ margin: '0 0 10px', fontSize: '0.76rem', color: '#92400e', lineHeight: 1.5 }}>
                    This MSP needs a <code style={{ color: '#fcd34d' }}>PORTAL_INTERNAL_KEY</code> before tenants can connect.
                    Click below to generate one automatically.
                  </p>
                  <button
                    type="button"
                    onClick={generateKey}
                    disabled={keyBusy}
                    style={{ padding: '6px 14px', fontSize: '0.78rem', fontWeight: 600, background: '#d97706', border: 'none', color: '#fff', borderRadius: 5, cursor: keyBusy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: keyBusy ? 0.7 : 1 }}
                  >
                    {keyBusy ? 'Generating…' : 'Generate MSP Key & Connect'}
                  </button>
                </div>
              )}

              {errorMsg && (
                <p style={{ fontSize: '0.78rem', color: '#f87171', padding: '6px 10px', background: '#1c0a0a', borderRadius: 5, border: '1px solid #7f1d1d', marginBottom: 8 }}>
                  {errorMsg}
                </p>
              )}

              {!deviceCode && !keyMissing && !showConsent && (
                <div style={s.btnRow}>
                  <button style={{ ...s.btn, opacity: busy ? 0.65 : 1, cursor: busy ? 'not-allowed' : 'pointer' }} onClick={beginConnect} disabled={busy}>
                    {busy ? 'Starting…' : connected ? 'Reconnect' : 'Connect'}
                  </button>
                  {connected && (
                    <button style={{ ...s.btnDanger, opacity: busy ? 0.65 : 1, cursor: busy ? 'not-allowed' : 'pointer' }} onClick={disconnect} disabled={busy}>
                      Disconnect
                    </button>
                  )}
                  <button style={s.btnGhost} onClick={fetchStatus} disabled={loading || busy}>Refresh</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }`}</style>
    </div>
  );
}

// ─── TenantActions ─────────────────────────────────────────────────────────────

function ActionButtonLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <>
      {busy && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="spinner" style={{ width: 10, height: 10 }} />
        </span>
      )}
      <span style={{ visibility: busy ? 'hidden' : 'visible' }}>{children}</span>
    </>
  );
}

function refreshDashboard(router: ReturnType<typeof useRouter>) {
  notifyDashboardBurstRefresh();
  router.refresh();
}

interface Props {
  slug: string;
  mspSlug: string;
  isDeployRunning: boolean;
  isBackupRunning: boolean;
  isMaintenanceRunning: boolean;
  tenantName?: string;
}

export default function TenantActions({ slug, mspSlug, isDeployRunning, isBackupRunning, isMaintenanceRunning, tenantName }: Props) {
  const router = useRouter();
  const [busy, setBusy]                   = useState<string | null>(null);
  const [error, setError]                 = useState('');
  const [showModal, setShowModal]         = useState(false);
  const [showMaintModal, setShowMaintModal] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  async function trigger(workflow: string, inputs?: Record<string, string>) {
    if (busy) return;
    setBusy(workflow); setError('');
    try {
      const res = await fetch('/api/pipelines/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, workflow, inputs }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Failed');
      refreshDashboard(router);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(null);
    }
  }

  function quickDeploy() {
    trigger('deploy.yml', { deploy_options: ALL_OPTIONS });
  }

  const btnStyle = { fontSize: '0.72rem', padding: '3px 9px' };
  const isDeployBusy = busy === 'deploy.yml';

  return (
    <>
      {showModal && (
        <DeployOptionsModal
          slug={slug}
          tenantName={tenantName ?? slug}
          onClose={() => setShowModal(false)}
          onDone={() => { setShowModal(false); refreshDashboard(router); }}
        />
      )}
      {showMaintModal && (
        <MaintenanceOptionsModal
          slug={slug}
          tenantName={tenantName ?? slug}
          onClose={() => setShowMaintModal(false)}
          onDone={() => { setShowMaintModal(false); refreshDashboard(router); }}
        />
      )}
      {showAuthModal && (
        <TenantAuthModal
          slug={slug}
          mspSlug={mspSlug}
          tenantName={tenantName ?? slug}
          onClose={() => setShowAuthModal(false)}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {error && (
          <div style={{ color: 'var(--danger-fg)', fontSize: '0.7rem', maxWidth: 200, textAlign: 'right' }} title={error}>
            ⚠ {error.slice(0, 60)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <a href={`/msps/${mspSlug}/viewer?tenant=${slug}`} className="btn btn-ghost btn-sm" style={btnStyle}>
            View
          </a>
          <a href={`/msps/${mspSlug}/tenants/${slug}/edit`} className="btn btn-ghost btn-sm" style={btnStyle} title="Edit tenant settings and manage auth">
            Edit
          </a>
          <button
            className="btn btn-ghost btn-sm"
            style={btnStyle}
            onClick={() => setShowAuthModal(true)}
            title="Manage delegated auth connection for this tenant"
          >
            🔑 Auth
          </button>

          {/* Deploy split button */}
          <div style={{ display: 'flex', gap: 0 }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ ...btnStyle, position: 'relative', borderRadius: '4px 0 0 4px', borderRight: 'none' }}
              onClick={quickDeploy}
              disabled={!!busy || isDeployRunning}
              title={isDeployRunning ? 'Deploy already running' : 'Deploy with all options'}
            >
              <ActionButtonLabel busy={isDeployBusy}>▶ Deploy</ActionButtonLabel>
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ ...btnStyle, borderRadius: '0 4px 4px 0', padding: '3px 6px', fontSize: '0.65rem', borderLeft: '1px solid #27272a' }}
              onClick={() => setShowModal(true)}
              disabled={!!busy || isDeployRunning}
              title="Deploy with options…"
            >
              ▾
            </button>
          </div>

          <button
            className="btn btn-ghost btn-sm"
            style={{ ...btnStyle, position: 'relative' }}
            onClick={() => trigger('backup.yml')}
            disabled={!!busy || isBackupRunning}
            title={isBackupRunning ? 'Backup already running' : 'Trigger backup'}
          >
            <ActionButtonLabel busy={busy === 'backup.yml'}>↑ Backup</ActionButtonLabel>
          </button>
          {/* Maintenance split button */}
          <div style={{ display: 'flex', gap: 0 }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ ...btnStyle, position: 'relative', borderRadius: '4px 0 0 4px', borderRight: 'none' }}
              onClick={() => trigger('maintenance.yml', { maintenance_tasks: ALL_MAINT_TASKS })}
              disabled={!!busy || isMaintenanceRunning}
              title={isMaintenanceRunning ? 'Maintenance already running' : 'Run all maintenance tasks'}
            >
              <ActionButtonLabel busy={busy === 'maintenance.yml'}>⚙ Maint</ActionButtonLabel>
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ ...btnStyle, borderRadius: '0 4px 4px 0', padding: '3px 6px', fontSize: '0.65rem', borderLeft: '1px solid #27272a' }}
              onClick={() => setShowMaintModal(true)}
              disabled={!!busy || isMaintenanceRunning}
              title="Run maintenance with options…"
            >
              ▾
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
