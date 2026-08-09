'use client';

import { useCallback, useEffect, useState } from 'react';

type UpdateChannel = 'preview' | 'ga';

interface ChannelState {
  channel: UpdateChannel;
  repoOverride: string | null;
  effectiveRepo: string;
}

const CHANNEL_LABEL: Record<UpdateChannel, string> = {
  preview: 'Preview',
  ga: 'GA (stable)',
};

export default function UpdateChannelSettings() {
  const [saved, setSaved] = useState<ChannelState | null>(null);
  const [channel, setChannel] = useState<UpdateChannel>('preview');
  const [repoOverrideInput, setRepoOverrideInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ack, setAck] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/platform/update-channel');
      const data = await res.json() as ChannelState & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to load update channel');
      setSaved(data);
      setChannel(data.channel);
      setRepoOverrideInput(data.repoOverride ?? '');
      setShowAdvanced(!!data.repoOverride);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const channelChanged = saved != null && channel !== saved.channel;
  const repoChanged = saved != null && repoOverrideInput.trim() !== (saved.repoOverride ?? '');
  const dirty = channelChanged || repoChanged;

  async function save() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/admin/platform/update-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, repoOverride: repoOverrideInput.trim() || null }),
      });
      const data = await res.json() as ChannelState & { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setSaved(data);
      setChannel(data.channel);
      setRepoOverrideInput(data.repoOverride ?? '');
      setAck(false);
      setSuccess('Update channel saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Update channel</h2>
      </div>
      <div className="card-body">
        {error && <p style={{ color: 'var(--danger-fg)', marginBottom: 12 }}>{error}</p>}
        {success && !dirty && <p style={{ color: 'var(--success-fg)', marginBottom: 12 }}>{success}</p>}

        <p style={{ fontSize: '0.85rem', color: 'var(--muted-fg)', marginTop: 0, marginBottom: 12 }}>
          Controls where <strong>app-only</strong> updates (patch/minor, via Software update below) are checked
          and downloaded from. It does <strong>not</strong> change your running Docker image.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <label htmlFor="update-channel-select" style={{ fontSize: '0.85rem', minWidth: 90 }}>Channel</label>
          <select
            id="update-channel-select"
            value={channel}
            onChange={(e) => { setChannel(e.target.value as UpdateChannel); setAck(false); setSuccess(null); }}
            disabled={loading}
            style={{ maxWidth: 220 }}
          >
            <option value="preview">{CHANNEL_LABEL.preview}</option>
            <option value="ga">{CHANNEL_LABEL.ga}</option>
          </select>
        </div>

        <p style={{ fontSize: '0.8rem', color: 'var(--muted-fg)', margin: '0 0 12px' }}>
          Effective repo: <code>{repoOverrideInput.trim() || (channel === 'ga' ? 'potsolutions/config365' : 'potsolutions/config365-preview')}</code>
          {saved && <> · currently saved: <code>{CHANNEL_LABEL[saved.channel]}</code></>}
        </p>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowAdvanced(v => !v)}
          style={{ marginBottom: 8 }}
        >
          {showAdvanced ? 'Hide' : 'Show'} advanced (custom repo override)
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <label htmlFor="update-repo-override" style={{ fontSize: '0.85rem', minWidth: 90 }}>Repo override</label>
            <input
              id="update-repo-override"
              type="text"
              placeholder="owner/repo (blank = use channel default)"
              value={repoOverrideInput}
              onChange={(e) => { setRepoOverrideInput(e.target.value); setAck(false); setSuccess(null); }}
              disabled={loading}
              style={{ maxWidth: 320 }}
            />
          </div>
        )}

        {dirty && (
          <div
            style={{
              background: 'var(--warning-bg, rgba(234, 179, 8, 0.12))',
              border: '1px solid var(--warning-fg, #b45309)',
              borderRadius: 6,
              padding: 12,
              marginBottom: 12,
              fontSize: '0.82rem',
            }}
          >
            <strong>⚠ Switching update channels can cause version-track conflicts.</strong>
            <p style={{ margin: '6px 0 0' }}>
              This only affects future app (patch/minor) update checks — it does not change your Docker
              image. Config365 <strong>cannot detect</strong> which image you actually deployed
              (<code>config365-preview</code> vs <code>config365</code>), since GA images are sometimes
              byte-identical copies of a Preview image.
            </p>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Running the <code>config365</code> (GA) image but switching to <strong>Preview</strong> pulls
                less-tested app updates onto what&apos;s meant to be a stable deployment.</li>
              <li>Running the <code>config365-preview</code> image but switching to <strong>GA</strong> may leave
                you unable to update for a while — GA promotions lag behind Preview and skip versions.</li>
            </ul>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 2 }} />
              <span>I know which Docker image (<code>config365</code> or <code>config365-preview</code>) is deployed and want to use a different channel for app updates.</span>
            </label>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={loading || !dirty || (dirty && !ack)}
          >
            Save
          </button>
          {dirty && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (!saved) return;
                setChannel(saved.channel);
                setRepoOverrideInput(saved.repoOverride ?? '');
                setAck(false);
                setError(null);
              }}
              disabled={loading}
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
