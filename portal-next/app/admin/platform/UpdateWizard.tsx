'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UpdateCheck {
  installedAppVersion: string;
  installedPlatformVersion: number;
  installedSchemaVersion: number;
  latestVersion: string | null;
  updateAvailable: boolean;
  blocked: boolean;
  blockReason?: string;
  requiredPlatformVersion?: number;
  pendingMigrations?: Array<{ version: number; description: string }>;
  releaseNotes?: string;
}

interface UpdateSession {
  step: string;
  targetVersion: string;
  releaseNotes?: string;
  log: string[];
  prNumber?: number;
  prUrl?: string;
  scriptChanges?: Array<{ path: string; status: string }>;
  error?: string;
  migrationsApplied?: number;
  schemaVersion?: number;
}

export default function UpdateWizard() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [session, setSession] = useState<UpdateSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const pollingRef = useRef(false);

  const pollAfterRestart = useCallback(async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const sessionRes = await fetch('/api/admin/platform/update/session');
        if (!sessionRes.ok) continue;
        const sessionData = await sessionRes.json() as { session?: UpdateSession | null };
        if (sessionData.session) setSession(sessionData.session);
        const resumeRes = await fetch('/api/admin/platform/update/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'resume' }),
        });
        if (resumeRes.ok) {
          const data = await resumeRes.json() as { session?: UpdateSession };
          setSession(data.session ?? null);
          if (data.session?.step === 'complete') {
            setWizardOpen(false);
          }
          return;
        }
      } catch {
        /* portal still restarting */
      }
    }
    setError('Portal did not come back after restart — reload this page or check container logs.');
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [checkRes, sessionRes] = await Promise.all([
        fetch('/api/admin/platform/update'),
        fetch('/api/admin/platform/update/session'),
      ]);
      const checkData = await checkRes.json() as UpdateCheck & { ok?: boolean; error?: string };
      const sessionData = await sessionRes.json() as { session?: UpdateSession | null };
      if (!checkRes.ok) throw new Error(checkData.error ?? 'Check failed');
      setCheck(checkData);
      setSession(sessionData.session ?? null);
      if (sessionData.session && !['complete', 'cancelled', 'idle'].includes(sessionData.session.step)) {
        setWizardOpen(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (session?.step === 'restarting' && wizardOpen && !pollingRef.current) {
      pollingRef.current = true;
      pollAfterRestart().finally(() => { pollingRef.current = false; });
    }
  }, [session?.step, wizardOpen, pollAfterRestart]);

  async function startUpdate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/platform/update/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; session?: UpdateSession; blocked?: boolean };
      if (!res.ok) throw new Error(data.error ?? 'Start failed');
      setSession(data.session ?? null);
      setWizardOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function continueUpdate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/platform/update/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'continue' }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; session?: UpdateSession; restarting?: boolean };
      if (!res.ok) throw new Error(data.error ?? 'Update failed');
      setSession(data.session ?? null);
      if (data.restarting) {
        pollAfterRestart();
        return;
      }
      if (data.session?.step === 'complete') {
        setWizardOpen(false);
        await refresh();
      }
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function approveScripts() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/platform/update/approve', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Approve failed');
      setWizardOpen(false);
      setSession(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function cancelUpdate() {
    await fetch('/api/admin/platform/update/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    setWizardOpen(false);
    setSession(null);
    await refresh();
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Software update</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
          Check for updates
        </button>
      </div>
      <div className="card-body">
        {error && (
          <p style={{ color: 'var(--danger-fg)', marginBottom: 12 }}>{error}</p>
        )}
        {check && (
          <div style={{ marginBottom: 16, fontSize: '0.875rem' }}>
            <div>Installed: app <code>{check.installedAppVersion}</code> · platform v{check.installedPlatformVersion} · schema v{check.installedSchemaVersion}</div>
            {check.updateAvailable && check.latestVersion && (
              <div style={{ marginTop: 8 }}>
                Available: <strong>v{check.latestVersion}</strong>
                {check.blocked && (
                  <span style={{ color: 'var(--danger-fg)', marginLeft: 8 }}>
                    — Docker update required (platform v{check.requiredPlatformVersion})
                  </span>
                )}
              </div>
            )}
            {!check.updateAvailable && <div style={{ marginTop: 8, color: 'var(--success-fg)' }}>Up to date</div>}
          </div>
        )}

        {!wizardOpen && check?.updateAvailable && !check.blocked && (
          <button type="button" className="btn btn-primary" onClick={startUpdate} disabled={loading}>
            Start update
          </button>
        )}

        {wizardOpen && session && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
            <h3 style={{ fontSize: '0.95rem', margin: '0 0 12px' }}>
              Update to v{session.targetVersion}
              <span style={{ fontWeight: 400, color: 'var(--muted-fg)', marginLeft: 8 }}>
                step: {session.step}
              </span>
            </h3>

            {session.step === 'step1' && (
              <>
                {session.releaseNotes && (
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem', maxHeight: 200, overflow: 'auto', background: 'var(--surface-2)', padding: 12, borderRadius: 6 }}>
                    {session.releaseNotes.slice(0, 4000)}
                  </pre>
                )}
                {check?.pendingMigrations && check.pendingMigrations.length > 0 && (
                  <p style={{ fontSize: '0.85rem' }}>
                    Pending migrations after update: {check.pendingMigrations.map(m => `v${m.version}`).join(', ')}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn btn-primary" onClick={continueUpdate} disabled={loading}>
                    Continue
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={cancelUpdate} disabled={loading}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {(session.step === 'step2a' || session.step === 'step2b' || session.step === 'step3' || session.step === 'restarting') && (
              <p style={{ fontSize: '0.85rem' }}>
                {session.step === 'restarting'
                  ? 'Portal is restarting — preparing scripts update…'
                  : (loading ? 'Update in progress…' : 'Processing…')}
              </p>
            )}

            {session.step === 'step4' && (
              <>
                <p style={{ fontSize: '0.85rem' }}>
                  {session.scriptChanges?.length ?? 0} script file(s) in PR
                  {session.prNumber ? ` #${session.prNumber}` : ''}.
                  {session.migrationsApplied != null && session.migrationsApplied > 0 && (
                    <> Schema migrations applied: {session.migrationsApplied}.</>
                  )}
                </p>
                {session.scriptChanges && session.scriptChanges.length > 0 && (
                  <ul style={{ fontSize: '0.8rem', maxHeight: 160, overflow: 'auto', margin: '8px 0' }}>
                    {session.scriptChanges.slice(0, 50).map(c => (
                      <li key={c.path}><code>{c.path}</code> ({c.status})</li>
                    ))}
                  </ul>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary" onClick={approveScripts} disabled={loading}>
                    Approve scripts
                  </button>
                  {session.prUrl && (
                    <a href={session.prUrl} target="_blank" rel="noopener" className="btn btn-ghost">
                      Open in Gitea ↗
                    </a>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={cancelUpdate} disabled={loading}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {session.step === 'failed' && (
              <>
                <p style={{ color: 'var(--danger-fg)' }}>{session.error ?? 'Update failed'}</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn btn-primary" onClick={continueUpdate} disabled={loading}>
                    Retry
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={cancelUpdate} disabled={loading}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {session.log.length > 0 && (
              <pre style={{ fontSize: '0.72rem', marginTop: 12, maxHeight: 120, overflow: 'auto', opacity: 0.85 }}>
                {session.log.slice(-20).join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
