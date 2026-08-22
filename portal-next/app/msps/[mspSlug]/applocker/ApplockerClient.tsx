'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';
import {
  COLLECTION_LABELS,
  COLLECTION_TYPES,
  SID_EVERYONE,
  WELL_KNOWN_SIDS,
  defaultRules,
  flattenTenantOverlayRows,
  mergeOverlay,
  newRuleId,
  parseRuleCollectionXml,
  ruleKind,
  serializeRuleCollectionXml,
  sidLabel,
  type AppLockerOverlay,
  type AppLockerRule,
  type CollectionType,
  type EnforcementMode,
  type RuleCondition,
  type ApplockerBackupImportStatus,
  type ApplockerCollectionDto,
  type RuleXmlName,
} from '@/lib/applocker';
import { APPLOCKER_FILE_ACCEPT, readAppLockerUpload, validateAppLockerUpload } from '@/lib/applocker-upload';

type Target = { scope: 'baseline' } | { scope: 'tenant'; slug: string };
type RuleKind = 'publisher' | 'path' | 'hash';

const inp: React.CSSProperties = {
  width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6,
  color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none',
  boxSizing: 'border-box', fontFamily: 'inherit',
};
const UI = {
  lbl: { display: 'block' as const, fontSize: '0.75rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 6 },
  sel: { ...inp, cursor: 'pointer' },
  btn: { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#e4e4e7', fontSize: '0.8125rem', padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  primary: { background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', borderRadius: 6, color: '#22c55e', fontSize: '0.8125rem', padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 },
};

function Spinner({ small }: { small?: boolean }) {
  const s = small ? 10 : 12;
  return <span style={{ display: 'inline-block', width: s, height: s, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: 'currentColor', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />;
}

function emptyRule(kind: RuleKind, collection: CollectionType): AppLockerRule {
  const xmlName: RuleXmlName = kind === 'path' ? 'FilePathRule' : kind === 'hash' ? 'FileHashRule' : 'FilePublisherRule';
  const conditions: RuleCondition[] = kind === 'path'
    ? [{ kind: 'path', path: '%PROGRAMFILES%\\*' }]
    : kind === 'hash'
      ? [{ kind: 'hash', hashes: [{ type: 'SHA256', data: '', sourceFileName: '', sourceFileLength: '0' }] }]
      : [{ kind: 'publisher', publisherName: '*', productName: '*', binaryName: '*', lowSection: '*', highSection: '*' }];
  return {
    id: newRuleId(),
    xmlName,
    name: collection === 'Appx' ? 'Packaged app rule' : 'New rule',
    description: '',
    userOrGroupSid: SID_EVERYONE,
    action: 'Allow',
    conditions,
    exceptions: [],
  };
}

interface Props { mspSlug: string; tenants: Tenant[] }

export default function ApplockerClient({ mspSlug, tenants }: Props) {
  const [target, setTarget] = useState<Target>({ scope: 'baseline' });
  const [collections, setCollections] = useState<ApplockerCollectionDto[]>([]);
  const [type, setType] = useState<CollectionType>('Exe');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [draft, setDraft] = useState<AppLockerRule | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [importXml, setImportXml] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [backupImport, setBackupImport] = useState<ApplockerBackupImportStatus | null>(null);
  const [selectedBackupPaths, setSelectedBackupPaths] = useState<string[]>([]);
  const [showTenantRules, setShowTenantRules] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{ rule: AppLockerRule; tenantOwned: boolean } | null>(null);

  const current = collections.find(c => c.type === type);
  const tenantView = useMemo(
    () => flattenTenantOverlayRows(current?.rules ?? [], current?.tenantOverlays ?? []),
    [current],
  );
  const visibleTenantRows = showTenantRules ? tenantView.rows : [];

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    setBackupImport(null);
    try {
      const qs = new URLSearchParams({ mspSlug });
      if (target.scope === 'tenant') qs.set('slug', target.slug);
      const res = await fetch(`/api/git/applocker?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load AppLocker policies');
      setCollections(data.collections ?? []);
      const nextBackup = target.scope === 'tenant' ? data.backupImport ?? null : null;
      setBackupImport(nextBackup);
      setSelectedBackupPaths((nextBackup?.policies ?? []).map((p: { path: string }) => p.path));
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : 'Load failed', kind: 'err' });
    } finally {
      setLoading(false);
    }
  }, [mspSlug, target]);

  useEffect(() => { load(); }, [load]);

  const visibleTypes = useMemo(() => {
    const existing = collections.filter(c => c.exists).map(c => c.type);
    if (existing.length === 0) return COLLECTION_TYPES.filter(t => t !== 'Dll');
    return COLLECTION_TYPES.filter(t => existing.includes(t) || t !== 'Dll' || existing.includes('Dll'));
  }, [collections]);

  const effective = useMemo(() => {
    if (!current) return null;
    if (target.scope === 'baseline') {
      return { enforcementMode: current.enforcementMode, rules: current.rules };
    }
    return mergeOverlay(
      { type: current.type, enforcementMode: current.enforcementMode, rules: current.rules },
      {
        excludeRuleIds: current.overlay.excludeRuleIds,
        rules: current.overlay.rules,
        enforcementMode: current.overlay.enforcementMode,
      },
    );
  }, [current, target.scope]);

  function patchCurrent(updater: (col: ApplockerCollectionDto) => ApplockerCollectionDto) {
    setCollections(cols => cols.map(c => c.type === type ? updater(c) : c));
  }

  async function saveBaseline(
    next: { enforcementMode: EnforcementMode; rules: AppLockerRule[] },
    opts?: { keepView?: boolean },
  ) {
    if (!current) return;
    const previous = collections;
    if (opts?.keepView) {
      patchCurrent(c => ({ ...c, enforcementMode: next.enforcementMode, rules: next.rules }));
    }
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/git/applocker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mspSlug,
          collection: type,
          enforcementMode: next.enforcementMode,
          rules: next.rules,
          sha: current.sha,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setMsg({ text: 'Baseline rules saved.', kind: 'ok' });
      setDraft(null); setEditingId(null);
      if (!opts?.keepView) await load();
    } catch (e: unknown) {
      if (opts?.keepView) setCollections(previous);
      setMsg({ text: e instanceof Error ? e.message : 'Save failed', kind: 'err' });
    } finally { setSaving(false); }
  }

  async function saveOverlay(overlay: AppLockerOverlay, opts?: { keepView?: boolean }) {
    if (target.scope !== 'tenant' || !current) return;
    const previous = collections;
    if (opts?.keepView) {
      patchCurrent(c => ({
        ...c,
        overlay: {
          ...c.overlay,
          excludeRuleIds: overlay.excludeRuleIds,
          rules: overlay.rules,
          enforcementMode: overlay.enforcementMode,
          exists: true,
        },
      }));
    }
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/git/applocker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mspSlug,
          slug: target.slug,
          collection: type,
          overlay,
          overlaySha: current.overlay.sha,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setMsg({ text: 'Tenant overlay saved.', kind: 'ok' });
      setDraft(null); setEditingId(null);
      if (!opts?.keepView) await load();
    } catch (e: unknown) {
      if (opts?.keepView) setCollections(previous);
      setMsg({ text: e instanceof Error ? e.message : 'Save failed', kind: 'err' });
    } finally { setSaving(false); }
  }

  function enforcementLabel(mode: EnforcementMode): string {
    if (mode === 'Enabled') return 'Enforce';
    if (mode === 'AuditOnly') return 'Audit only';
    return 'Not configured';
  }

  async function importFromTenantBackup() {
    if (target.scope !== 'tenant') return;
    const policies = (backupImport?.policies ?? []).filter(p => selectedBackupPaths.includes(p.path));
    if (policies.length === 0) {
      setMsg({ text: 'Select at least one backup policy to import.', kind: 'err' });
      return;
    }
    const names = policies.map(p => p.displayName).join(', ');
    const confirmMsg = backupImport?.imported
      ? `Replace tenant customizations for the selected policies (${names}) from the latest backup? Run a tenant backup first if you just changed AppLocker in Intune.`
      : `Import the selected backup policies (${names})? Rules that match the baseline stay inherited. Tenant-only rules and differences become customizations.`;
    if (!window.confirm(confirmMsg)) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/git/applocker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug, slug: target.slug, paths: policies.map(p => p.path) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      const written = Array.isArray(data.imported) ? data.imported as CollectionType[] : [];
      await load();
      setMsg({
        text: written.length
          ? `Imported ${written.map(t => COLLECTION_LABELS[t]).join(', ')} from tenant backup.`
          : 'Tenant backup matches the baseline — nothing extra to import.',
        kind: 'ok',
      });
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : 'Import failed', kind: 'err' });
    } finally { setSaving(false); }
  }

  async function createCollection() {
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/git/applocker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug, collection: type, create: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      setMsg({ text: `${COLLECTION_LABELS[type]} collection created in baseline.`, kind: 'ok' });
      await load();
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : 'Create failed', kind: 'err' });
    } finally { setSaving(false); }
  }

  function startNew(kind: RuleKind) {
    const rule = emptyRule(kind, type);
    setDraft(rule);
    setEditingId(rule.id);
  }

  function startEdit(rule: AppLockerRule) {
    setDraft({
      ...rule,
      conditions: rule.conditions.map(c => ({ ...c })),
      exceptions: rule.exceptions.map(c => ({ ...c })),
    });
    setEditingId(rule.id);
  }

  function commitDraftToBaseline() {
    if (!draft || !current || !effective) return;
    const exists = current.rules.some(r => r.id === draft.id);
    const rules = exists ? current.rules.map(r => r.id === draft.id ? draft : r) : [...current.rules, draft];
    void saveBaseline({ enforcementMode: effective.enforcementMode, rules });
  }

  function commitDraftToTenant() {
    if (!draft || !current) return;
    const fromBaseline = current.rules.some(r => r.id === draft.id);
    const excludeIds = new Set(current.overlay.excludeRuleIds);
    if (fromBaseline) excludeIds.add(draft.id);
    const overlay: AppLockerOverlay = {
      excludeRuleIds: [...excludeIds],
      rules: current.overlay.rules.some(r => r.id === draft.id)
        ? current.overlay.rules.map(r => r.id === draft.id ? draft : r)
        : [...current.overlay.rules, draft],
      enforcementMode: current.overlay.enforcementMode,
    };
    void saveOverlay(overlay);
  }

  function commitDraft() {
    if (target.scope === 'baseline') commitDraftToBaseline();
    else commitDraftToTenant();
  }

  function requestDelete(rule: AppLockerRule, tenantOwned: boolean) {
    setPendingDelete({ rule, tenantOwned });
  }

  function deleteRule(rule: AppLockerRule, tenantOwned: boolean) {
    if (!current || !effective) return;
    if (draft?.id === rule.id) {
      setDraft(null);
      setEditingId(null);
    }
    if (target.scope === 'baseline') {
      void saveBaseline(
        { enforcementMode: effective.enforcementMode, rules: current.rules.filter(r => r.id !== rule.id) },
        { keepView: true },
      );
      return;
    }
    if (tenantOwned) {
      void saveOverlay({
        excludeRuleIds: current.overlay.excludeRuleIds.filter(id => id !== rule.id),
        rules: current.overlay.rules.filter(r => r.id !== rule.id),
        enforcementMode: current.overlay.enforcementMode,
      }, { keepView: true });
    }
  }

  async function copyRuleToBaseline(rule: AppLockerRule, tenantSlug?: string) {
    const slug = target.scope === 'tenant' ? target.slug : tenantSlug;
    if (!slug || !current || !effective) return;
    const overlay = target.scope === 'tenant'
      ? current.overlay
      : current.tenantOverlays?.find(t => t.slug === slug);
    if (!overlay) return;
    setSaving(true); setMsg(null);
    try {
      const exists = current.rules.some(r => r.id === rule.id);
      const rules = exists ? current.rules.map(r => r.id === rule.id ? rule : r) : [...current.rules, rule];
      const baselineRes = await fetch('/api/git/applocker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mspSlug,
          collection: type,
          enforcementMode: effective.enforcementMode,
          rules,
          sha: current.sha,
        }),
      });
      const baselineData = await baselineRes.json();
      if (!baselineRes.ok) throw new Error(baselineData.error || 'Copy to baseline failed');
      const overlayRes = await fetch('/api/git/applocker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mspSlug,
          slug,
          collection: type,
          overlay: {
            excludeRuleIds: overlay.excludeRuleIds.filter(id => id !== rule.id),
            rules: overlay.rules.filter(r => r.id !== rule.id),
            enforcementMode: overlay.enforcementMode,
          },
          overlaySha: target.scope === 'tenant' ? current.overlay.sha : undefined,
        }),
      });
      const overlayData = await overlayRes.json();
      if (!overlayRes.ok) throw new Error(overlayData.error || 'Removed tenant copy, but overlay cleanup failed');
      setMsg({ text: 'Copied to baseline for all tenants.', kind: 'ok' });
      setDraft(null); setEditingId(null);
      await load();
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : 'Copy to baseline failed', kind: 'err' });
    } finally { setSaving(false); }
  }

  function toggleExclude(ruleId: string) {
    if (target.scope !== 'tenant' || !current) return;
    const set = new Set(current.overlay.excludeRuleIds);
    if (set.has(ruleId)) set.delete(ruleId); else set.add(ruleId);
    void saveOverlay({
      excludeRuleIds: [...set],
      rules: current.overlay.rules,
      enforcementMode: current.overlay.enforcementMode,
    });
  }

  function applyDefaults() {
    if (!current || !effective) return;
    const rules = [...effective.rules, ...defaultRules(type)];
    if (target.scope === 'baseline') {
      void saveBaseline({ enforcementMode: effective.enforcementMode, rules });
    } else {
      void saveOverlay({
        excludeRuleIds: current.overlay.excludeRuleIds,
        rules: [...current.overlay.rules, ...defaultRules(type)],
        enforcementMode: current.overlay.enforcementMode,
      });
    }
  }

  function exportXml() {
    if (!effective) return;
    const xml = serializeRuleCollectionXml({ type, enforcementMode: effective.enforcementMode, rules: effective.rules });
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `applocker-${type.toLowerCase()}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyImport() {
    if (!current || !effective) return;
    try {
      const imported = parseRuleCollectionXml(importXml, type);
      if (target.scope === 'baseline') {
        void saveBaseline({ enforcementMode: imported.enforcementMode, rules: imported.rules });
      } else {
        void saveOverlay({
          excludeRuleIds: current.overlay.excludeRuleIds,
          rules: [...current.overlay.rules, ...imported.rules.map(r => ({ ...r, id: newRuleId() }))],
          enforcementMode: current.overlay.enforcementMode,
        });
      }
      setImportOpen(false);
      setImportXml('');
    } catch (e: unknown) {
      setMsg({ text: e instanceof Error ? e.message : 'Invalid XML', kind: 'err' });
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !draft) return;
    const verr = validateAppLockerUpload(file);
    if (verr) { setMsg({ text: verr, kind: 'err' }); return; }
    setFileBusy(true); setMsg(null);
    try {
      const upload = await readAppLockerUpload(file);
      const res = await fetch('/api/git/applocker/file-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mspSlug, ...upload }),
      });
      const info = await res.json();
      if (!res.ok) throw new Error(info.error || 'Could not read file');
      const kind = ruleKind(draft);
      if (kind === 'publisher') {
        setDraft({
          ...draft,
          name: draft.name === 'New rule' || draft.name === 'Packaged app rule'
            ? `${info.signed ? 'Signed' : 'File'} ${info.fileName}`
            : draft.name,
          conditions: [{
            kind: 'publisher',
            publisherName: info.publisherName || '*',
            productName: info.productName || '*',
            binaryName: info.binaryName || '*',
            lowSection: info.fileVersion && info.fileVersion !== '*' ? info.fileVersion : '*',
            highSection: '*',
          }],
        });
        if (!info.signed) setMsg({ text: 'File is not signed — publisher fields may be incomplete. Use a hash rule instead.', kind: 'err' });
      } else if (kind === 'hash') {
        setDraft({
          ...draft,
          name: draft.name === 'New rule' ? info.fileName : draft.name,
          conditions: [{
            kind: 'hash',
            hashes: [{
              type: 'SHA256',
              data: info.hash,
              sourceFileName: info.fileName,
              sourceFileLength: String(info.fileLength),
            }],
          }],
        });
      }
    } catch (err: unknown) {
      setMsg({ text: err instanceof Error ? err.message : 'File parse failed', kind: 'err' });
    } finally { setFileBusy(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ minWidth: 240, flex: 1 }}>
          <label style={UI.lbl}>Target</label>
          <select
            value={target.scope === 'baseline' ? 'baseline' : target.slug}
            onChange={e => {
              const v = e.target.value;
              setDraft(null); setEditingId(null); setPendingDelete(null);
              setTarget(v === 'baseline' ? { scope: 'baseline' } : { scope: 'tenant', slug: v });
            }}
            style={UI.sel}
          >
            <option value="baseline">Baseline (all tenants)</option>
            {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
          </select>
        </div>
        {effective && current?.exists && (
          <div style={{ minWidth: 220 }}>
            <label style={UI.lbl}>Enforcement</label>
            <select
              value={effective.enforcementMode}
              disabled={target.scope === 'tenant'}
              onChange={e => {
                if (target.scope === 'baseline') {
                  void saveBaseline({ enforcementMode: e.target.value as EnforcementMode, rules: current.rules });
                }
              }}
              style={UI.sel}
            >
              <option value="NotConfigured">Not configured</option>
              <option value="AuditOnly">Audit only</option>
              <option value="Enabled">Enforce</option>
            </select>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {visibleTypes.map(t => (
          <button key={t} type="button" onClick={() => { setType(t); setDraft(null); setEditingId(null); }}
            style={{
              ...UI.btn,
              color: type === t ? '#22c55e' : '#a1a1aa',
              borderColor: type === t ? '#22c55e' : '#3f3f46',
              background: type === t ? 'rgba(34,197,94,0.12)' : '#18181b',
            }}>
            {COLLECTION_LABELS[t]}
            {collections.find(c => c.type === t)?.exists ? '' : ' · missing'}
          </button>
        ))}
        {!visibleTypes.includes('Dll') && (
          <button type="button" onClick={() => setType('Dll')} style={UI.btn}>+ DLL</button>
        )}
      </div>

      {msg && (
        <div style={{ marginBottom: 12, fontSize: '0.8125rem', color: msg.kind === 'ok' ? '#22c55e' : '#f87171' }}>{msg.text}</div>
      )}

      {loading && <div style={{ color: '#71717a', display: 'flex', alignItems: 'center', gap: 8 }}><Spinner /> Loading…</div>}

      {!loading && current && !current.exists && (
        <div style={{ padding: 16, border: '1px dashed #3f3f46', borderRadius: 8, color: '#a1a1aa' }}>
          <div style={{ marginBottom: 10 }}>No {COLLECTION_LABELS[type]} policy in the baseline repo yet.</div>
          {target.scope === 'baseline' && (
            <button type="button" style={UI.primary} onClick={createCollection} disabled={saving}>
              {saving ? <Spinner small /> : null} Create collection
            </button>
          )}
        </div>
      )}

      {!loading && current?.exists && effective && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button type="button" style={UI.primary} onClick={() => startNew('publisher')}>New publisher rule</button>
            {type !== 'Appx' && <button type="button" style={UI.btn} onClick={() => startNew('path')}>New path rule</button>}
            {type !== 'Appx' && <button type="button" style={UI.btn} onClick={() => startNew('hash')}>New hash rule</button>}
            <button type="button" style={UI.btn} onClick={applyDefaults} disabled={saving}>Create default rules</button>
            <button type="button" style={UI.btn} onClick={() => setImportOpen(o => !o)}>Import XML</button>
            {target.scope === 'tenant' && (
              <button
                type="button"
                style={backupOpen ? { ...UI.primary } : UI.btn}
                onClick={() => { setBackupOpen(o => !o); setImportOpen(false); }}
              >
                Import from backup
              </button>
            )}
            <button type="button" style={UI.btn} onClick={exportXml}>Export XML</button>
          </div>
          {target.scope === 'tenant' && (
            <div style={{ fontSize: '0.75rem', color: '#a1a1aa', marginBottom: 10 }}>
              Tenant-only rules are listed first. Copy one to the shared baseline, or edit a baseline rule to customize it for this tenant.
            </div>
          )}
          {target.scope === 'baseline' && tenantView.rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                role="switch"
                aria-checked={showTenantRules}
                onClick={() => setShowTenantRules(v => !v)}
                style={{
                  ...UI.btn,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  color: showTenantRules ? '#22c55e' : '#a1a1aa',
                  borderColor: showTenantRules ? '#22c55e' : '#3f3f46',
                  background: showTenantRules ? 'rgba(34,197,94,0.12)' : '#18181b',
                }}
              >
                <span aria-hidden style={{
                  width: 28, height: 16, borderRadius: 99, flexShrink: 0,
                  background: showTenantRules ? '#22c55e' : '#3f3f46',
                  position: 'relative', display: 'inline-block',
                }}>
                  <span style={{
                    position: 'absolute', top: 2, width: 12, height: 12, borderRadius: '50%',
                    background: '#fafafa',
                    left: showTenantRules ? 14 : 2,
                    transition: 'left 0.15s ease',
                  }} />
                </span>
                Tenant-specific rules
                <span style={{
                  fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.02em',
                  padding: '1px 6px', borderRadius: 99,
                  color: showTenantRules ? '#22c55e' : '#a1a1aa',
                  background: showTenantRules ? 'rgba(34,197,94,0.18)' : '#27272a',
                }}>
                  {tenantView.rows.length}
                </span>
              </button>
              {showTenantRules && (
                <span style={{ fontSize: '0.75rem', color: '#71717a', whiteSpace: 'nowrap' }}>
                  Listed first. Switch to a tenant to change them.
                </span>
              )}
            </div>
          )}

          {importOpen && (
            <div style={{ marginBottom: 14 }}>
              <label style={UI.lbl}>Paste AppLocker XML</label>
              <textarea value={importXml} onChange={e => setImportXml(e.target.value)} rows={8} style={{ ...inp, fontFamily: 'ui-monospace, monospace' }} />
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button type="button" style={UI.primary} onClick={applyImport}>Import</button>
                <button type="button" style={UI.btn} onClick={() => setImportOpen(false)}>Cancel</button>
              </div>
            </div>
          )}

          {backupOpen && target.scope === 'tenant' && (
            <div style={{
              marginBottom: 14, padding: '12px 14px', border: '1px solid #3f3f46', borderRadius: 8,
              background: '#18181b',
            }}>
              <div style={{ fontSize: '0.8125rem', color: '#d4d4d8', lineHeight: 1.45, marginBottom: 10 }}>
                Choose backed-up AppLocker policies to import as tenant customizations.
                Matching baseline rules stay inherited.
                {backupImport?.importedAt
                  ? ` Last imported ${new Date(backupImport.importedAt).toLocaleString()}.`
                  : ''}
              </div>
              {(backupImport?.policies ?? []).length === 0 ? (
                <div style={{ fontSize: '0.8125rem', color: '#a1a1aa' }}>
                  No AppLocker policies found in this tenant backup. Run a tenant backup after AppLocker exists in Intune, then try again.
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                    {(backupImport?.policies ?? []).map(p => {
                      const checked = selectedBackupPaths.includes(p.path);
                      return (
                        <label key={p.path} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                          padding: '8px 10px', border: '1px solid #3f3f46', borderRadius: 6, background: checked ? 'rgba(34,197,94,0.08)' : '#09090b',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedBackupPaths(prev =>
                              prev.includes(p.path) ? prev.filter(x => x !== p.path) : [...prev, p.path])}
                            style={{ marginTop: 3 }}
                          />
                          <span>
                            <span style={{ display: 'block', color: '#e4e4e7', fontSize: '0.8125rem', fontWeight: 600 }}>{p.displayName}</span>
                            <span style={{ color: '#71717a', fontSize: '0.75rem' }}>
                              {COLLECTION_LABELS[p.type]} · {p.ruleCount} rule{p.ruleCount === 1 ? '' : 's'} · {enforcementLabel(p.enforcementMode)}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                      type="button"
                      style={UI.btn}
                      onClick={() => setSelectedBackupPaths((backupImport?.policies ?? []).map(p => p.path))}
                    >
                      Select all
                    </button>
                    <button type="button" style={UI.btn} onClick={() => setSelectedBackupPaths([])}>Select none</button>
                    <button
                      type="button"
                      style={UI.primary}
                      onClick={() => void importFromTenantBackup()}
                      disabled={saving || selectedBackupPaths.length === 0}
                    >
                      {saving ? <Spinner small /> : null} {backupImport?.imported ? 'Update selected' : 'Import selected'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: draft ? 'minmax(280px, 1fr) minmax(320px, 1fr)' : '1fr', gap: 16 }}>
            {target.scope === 'baseline' ? (
              <RuleTable
                title={null}
                empty="No rules in this collection."
                rules={[...visibleTenantRows.map(r => r.rule), ...current.rules]}
                rowKey={(rule, i) => i < visibleTenantRows.length ? visibleTenantRows[i].key : `baseline:${rule.id}`}
                editingId={editingId}
                showSource
                saving={saving}
                rowMeta={(rule, i) => {
                  if (i < visibleTenantRows.length) {
                    const row = visibleTenantRows[i];
                    return {
                      source: 'tenant',
                      excluded: false,
                      tenantOwned: true,
                      customized: row.customized,
                      tenantLabel: row.displayName,
                      slug: row.slug,
                      canEdit: false,
                      canDelete: false,
                    };
                  }
                  const excludedBy = tenantView.excludedBy[rule.id] ?? [];
                  return {
                    source: 'baseline',
                    excluded: excludedBy.length > 0,
                    tenantOwned: false,
                    excludedBy,
                    canDelete: true,
                  };
                }}
                onEdit={startEdit}
                onDelete={rule => requestDelete(rule, false)}
                onCopyToBaseline={copyRuleToBaseline}
                onOpenTenant={slug => {
                  setDraft(null); setEditingId(null);
                  setTarget({ scope: 'tenant', slug });
                }}
              />
            ) : (
              <RuleTable
                title={null}
                empty="No rules in this collection."
                rules={[
                  ...current.overlay.rules,
                  ...current.rules.filter(r => !current.overlay.rules.some(o => o.id === r.id)),
                ]}
                editingId={editingId}
                showSource
                saving={saving}
                rowMeta={rule => {
                  const tenantOwned = current.overlay.rules.some(o => o.id === rule.id);
                  return {
                    source: tenantOwned ? 'tenant' : 'baseline',
                    excluded: current.overlay.excludeRuleIds.includes(rule.id),
                    tenantOwned,
                    customized: tenantOwned && current.rules.some(b => b.id === rule.id),
                  };
                }}
                onExclude={toggleExclude}
                onEdit={startEdit}
                onDelete={rule => requestDelete(rule, true)}
                onCopyToBaseline={copyRuleToBaseline}
              />
            )}

            {draft && (
              <RuleEditor
                draft={draft}
                collection={type}
                fileBusy={fileBusy}
                fileRef={fileRef}
                saving={saving}
                tenantMode={target.scope === 'tenant'}
                baselineOrigin={!!current.rules.some(r => r.id === draft.id)}
                onChange={setDraft}
                onBrowse={() => fileRef.current?.click()}
                onSave={commitDraft}
                onSaveBaseline={target.scope === 'tenant' ? commitDraftToBaseline : undefined}
                onCancel={() => { setDraft(null); setEditingId(null); }}
              />
            )}
          </div>
          <input ref={fileRef} type="file" accept={APPLOCKER_FILE_ACCEPT} hidden onChange={onFilePicked} />
        </>
      )}

      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="applocker-delete-title"
          onClick={e => { if (e.target === e.currentTarget && !saving) setPendingDelete(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 500,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{
            background: '#111113', border: '1px solid #27272a', borderRadius: 8,
            width: 'min(440px, calc(100vw - 48px))', padding: 18,
          }}>
            <div id="applocker-delete-title" style={{ fontSize: '0.9375rem', fontWeight: 700, color: '#e4e4e7', marginBottom: 8 }}>
              Delete rule?
            </div>
            <div style={{ fontSize: '0.8125rem', color: '#a1a1aa', lineHeight: 1.45, marginBottom: 16 }}>
              {target.scope === 'baseline'
                ? `Remove “${pendingDelete.rule.name}” from the shared ${COLLECTION_LABELS[type]} baseline. This applies to all tenants that inherit this collection.`
                : `Remove “${pendingDelete.rule.name}” from this tenant’s ${COLLECTION_LABELS[type]} overlay. Baseline rules are unchanged.`}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" style={UI.btn} disabled={saving} onClick={() => setPendingDelete(null)}>Cancel</button>
              <button
                type="button"
                disabled={saving}
                style={{ ...UI.btn, color: '#f87171', borderColor: 'rgba(239,68,68,0.45)', background: 'rgba(239,68,68,0.12)' }}
                onClick={() => {
                  const next = pendingDelete;
                  setPendingDelete(null);
                  deleteRule(next.rule, next.tenantOwned);
                }}
              >
                {saving ? <Spinner small /> : null} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type RuleRowMeta = {
  source: 'baseline' | 'tenant';
  excluded: boolean;
  tenantOwned: boolean;
  customized?: boolean;
  tenantLabel?: string;
  excludedBy?: string[];
  slug?: string;
  canEdit?: boolean;
  canDelete?: boolean;
};

function sourceBadgeLabel(meta: RuleRowMeta): string {
  if (meta.source === 'tenant') {
    if (meta.customized) {
      return meta.tenantLabel ? `Modified from baseline · ${meta.tenantLabel}` : 'Modified from baseline';
    }
    return meta.tenantLabel || 'Tenant only';
  }
  if (meta.excluded) {
    if (meta.excludedBy?.length) return `Baseline · excluded by ${meta.excludedBy.join(', ')}`;
    return 'Baseline · excluded';
  }
  return 'Baseline';
}

function RuleTable({
  title,
  hint,
  empty,
  rules,
  rowKey,
  editingId,
  showSource,
  saving,
  rowMeta,
  onEdit,
  onDelete,
  onExclude,
  onCopyToBaseline,
  onOpenTenant,
}: {
  title: string | null;
  hint?: string;
  empty: string;
  rules: AppLockerRule[];
  rowKey?: (rule: AppLockerRule, index: number) => string;
  editingId: string | null;
  showSource: boolean;
  saving?: boolean;
  rowMeta: (rule: AppLockerRule, index: number) => RuleRowMeta;
  onEdit?: (rule: AppLockerRule) => void;
  onDelete?: (rule: AppLockerRule) => void;
  onExclude?: (ruleId: string) => void;
  onCopyToBaseline?: (rule: AppLockerRule, tenantSlug?: string) => void;
  onOpenTenant?: (slug: string) => void;
}) {
  return (
    <div style={{ border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
      {title && (
        <div style={{ padding: '10px 12px 8px', background: '#18181b', borderBottom: '1px solid #27272a' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#e4e4e7', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>
          {hint && <div style={{ fontSize: '0.75rem', color: '#71717a', marginTop: 4 }}>{hint}</div>}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
        <thead>
          <tr style={{ background: '#111113', color: '#71717a', textAlign: 'left' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Name</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Type</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Action</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>User</th>
            {showSource && <th style={{ padding: '8px 10px', fontWeight: 600 }}>Source</th>}
            <th style={{ padding: '8px 10px' }} />
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 && (
            <tr><td colSpan={showSource ? 6 : 5} style={{ padding: 16, color: '#52525b' }}>{empty}</td></tr>
          )}
          {rules.map((rule, index) => {
            const meta = rowMeta(rule, index);
            return (
              <tr key={rowKey?.(rule, index) ?? rule.id} style={{
                borderTop: '1px solid #27272a',
                background: editingId === rule.id ? 'rgba(34,197,94,0.06)' : undefined,
                opacity: meta.excluded ? 0.5 : 1,
              }}>
                <td style={{ padding: '8px 10px', color: '#e4e4e7' }}>{rule.name}</td>
                <td style={{ padding: '8px 10px', color: '#a1a1aa' }}>{ruleKind(rule)}</td>
                <td style={{ padding: '8px 10px', color: rule.action === 'Deny' ? '#f87171' : '#22c55e' }}>{rule.action}</td>
                <td style={{ padding: '8px 10px', color: '#a1a1aa' }}>{sidLabel(rule.userOrGroupSid)}</td>
                {showSource && (
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{
                      display: 'inline-block',
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      padding: '2px 7px',
                      borderRadius: 4,
                      color: meta.source === 'tenant' ? '#38bdf8' : '#a1a1aa',
                      background: meta.source === 'tenant' ? 'rgba(56,189,248,0.12)' : '#27272a',
                      border: `1px solid ${meta.source === 'tenant' ? 'rgba(56,189,248,0.35)' : '#3f3f46'}`,
                    }}>
                      {sourceBadgeLabel(meta)}
                    </span>
                  </td>
                )}
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  {onCopyToBaseline && meta.tenantOwned && (
                    <button type="button" style={{ ...UI.btn, padding: '3px 8px', fontSize: '0.75rem', marginRight: 4 }}
                      onClick={() => onCopyToBaseline(rule, meta.slug)} disabled={saving}>
                      Copy to baseline
                    </button>
                  )}
                  {onOpenTenant && meta.slug && (
                    <button type="button" style={{ ...UI.btn, padding: '3px 8px', fontSize: '0.75rem', marginRight: 4 }}
                      onClick={() => onOpenTenant(meta.slug!)}>
                      Open tenant
                    </button>
                  )}
                  {onExclude && !meta.tenantOwned && (
                    <button type="button" style={{ ...UI.btn, padding: '3px 8px', fontSize: '0.75rem', marginRight: 4 }}
                      onClick={() => onExclude(rule.id)}>
                      {meta.excluded ? 'Include' : 'Exclude'}
                    </button>
                  )}
                  {onEdit && meta.canEdit !== false && (
                    <button type="button" style={{ ...UI.btn, padding: '3px 8px', fontSize: '0.75rem', marginRight: 4 }}
                      onClick={() => onEdit(rule)}>Edit</button>
                  )}
                  {onDelete && (meta.canDelete ?? meta.tenantOwned) && (
                    <button type="button" style={{ ...UI.btn, padding: '3px 8px', fontSize: '0.75rem', color: '#f87171', borderColor: 'rgba(239,68,68,0.35)' }}
                      onClick={() => onDelete(rule)}>Delete</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RuleEditor({
  draft, collection, fileBusy, fileRef, saving, tenantMode, baselineOrigin, onChange, onBrowse, onSave, onSaveBaseline, onCancel,
}: {
  draft: AppLockerRule;
  collection: CollectionType;
  fileBusy: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  saving: boolean;
  tenantMode: boolean;
  baselineOrigin: boolean;
  onChange: (r: AppLockerRule) => void;
  onBrowse: () => void;
  onSave: () => void;
  onSaveBaseline?: () => void;
  onCancel: () => void;
}) {
  const kind = ruleKind(draft);
  const cond = draft.conditions[0];
  void fileRef;

  function setCond(next: RuleCondition) {
    onChange({ ...draft, conditions: [next] });
  }

  return (
    <div style={{ border: '1px solid #27272a', borderRadius: 8, padding: 14, background: '#111113' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
        {kind} rule
      </div>
      <label style={UI.lbl}>Name</label>
      <input style={{ ...inp, marginBottom: 10 }} value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} />
      <label style={UI.lbl}>Description</label>
      <input style={{ ...inp, marginBottom: 10 }} value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={UI.lbl}>Action</label>
          <select style={UI.sel} value={draft.action} onChange={e => onChange({ ...draft, action: e.target.value as 'Allow' | 'Deny' })}>
            <option value="Allow">Allow</option>
            <option value="Deny">Deny</option>
          </select>
        </div>
        <div>
          <label style={UI.lbl}>User or group SID</label>
          <select
            style={UI.sel}
            value={WELL_KNOWN_SIDS.some(s => s.sid === draft.userOrGroupSid) ? draft.userOrGroupSid : 'custom'}
            onChange={e => {
              if (e.target.value === 'custom') onChange({ ...draft, userOrGroupSid: draft.userOrGroupSid.startsWith('S-') ? draft.userOrGroupSid : 'S-1-' });
              else onChange({ ...draft, userOrGroupSid: e.target.value });
            }}
          >
            {WELL_KNOWN_SIDS.map(s => <option key={s.sid} value={s.sid}>{s.label}</option>)}
            <option value="custom">Custom SID</option>
          </select>
          {!WELL_KNOWN_SIDS.some(s => s.sid === draft.userOrGroupSid) && (
            <input style={{ ...inp, marginTop: 6 }} value={draft.userOrGroupSid}
              onChange={e => onChange({ ...draft, userOrGroupSid: e.target.value })} />
          )}
        </div>
      </div>

      {(kind === 'publisher' || kind === 'hash') && collection !== 'Appx' && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" style={UI.btn} onClick={onBrowse} disabled={fileBusy}>
            {fileBusy ? <Spinner small /> : null} Browse file…
          </button>
          <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 4 }}>
            {kind === 'publisher' ? 'Copy publisher / product / file from a signed EXE, DLL, or MSI.' : 'Compute the AppLocker SHA256 hash from the file.'}
          </div>
        </div>
      )}
      {kind === 'publisher' && collection === 'Appx' && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" style={UI.btn} onClick={onBrowse} disabled={fileBusy}>
            {fileBusy ? <Spinner small /> : null} Browse package…
          </button>
        </div>
      )}

      {cond?.kind === 'publisher' && (
        <>
          <label style={UI.lbl}>Publisher</label>
          <input style={{ ...inp, marginBottom: 8 }} value={cond.publisherName} onChange={e => setCond({ ...cond, publisherName: e.target.value })} />
          <label style={UI.lbl}>Product</label>
          <input style={{ ...inp, marginBottom: 8 }} value={cond.productName} onChange={e => setCond({ ...cond, productName: e.target.value })} />
          <label style={UI.lbl}>File name</label>
          <input style={{ ...inp, marginBottom: 8 }} value={cond.binaryName} onChange={e => setCond({ ...cond, binaryName: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={UI.lbl}>Min version</label>
              <input style={inp} value={cond.lowSection} onChange={e => setCond({ ...cond, lowSection: e.target.value })} />
            </div>
            <div>
              <label style={UI.lbl}>Max version</label>
              <input style={inp} value={cond.highSection} onChange={e => setCond({ ...cond, highSection: e.target.value })} />
            </div>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 10 }}>
            Use * to widen the slider (publisher only, any product, any file, any version).
          </div>
        </>
      )}
      {cond?.kind === 'path' && (
        <>
          <label style={UI.lbl}>Path</label>
          <input style={{ ...inp, marginBottom: 8 }} value={cond.path} onChange={e => setCond({ ...cond, path: e.target.value })} />
          <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 10 }}>%WINDIR%, %PROGRAMFILES%, %OSDRIVE%, and * wildcards are supported.</div>
        </>
      )}
      {cond?.kind === 'hash' && (
        <>
          <label style={UI.lbl}>SHA256</label>
          <input style={{ ...inp, marginBottom: 8, fontFamily: 'ui-monospace, monospace' }} value={cond.hashes[0]?.data ?? ''}
            onChange={e => setCond({ kind: 'hash', hashes: [{ ...(cond.hashes[0] ?? { type: 'SHA256', sourceFileName: '', sourceFileLength: '0', data: '' }), data: e.target.value }] })} />
          <label style={UI.lbl}>Source file</label>
          <input style={{ ...inp, marginBottom: 8 }} value={cond.hashes[0]?.sourceFileName ?? ''}
            onChange={e => setCond({ kind: 'hash', hashes: [{ ...(cond.hashes[0] ?? { type: 'SHA256', data: '', sourceFileLength: '0', sourceFileName: '' }), sourceFileName: e.target.value }] })} />
        </>
      )}

      {(kind === 'publisher' || kind === 'path') && (
        <ExceptionsEditor exceptions={draft.exceptions} onChange={exceptions => onChange({ ...draft, exceptions })} />
      )}

      {tenantMode && (
        <div style={{ fontSize: '0.75rem', color: '#a1a1aa', marginTop: 10 }}>
          {baselineOrigin
            ? 'Save for this tenant to override the inherited rule. Save to baseline to change it for every tenant.'
            : 'This rule is saved only for the selected tenant.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" style={UI.primary} onClick={onSave} disabled={saving}>
          {saving ? <Spinner small /> : null} {tenantMode ? 'Save for this tenant' : 'Save rule'}
        </button>
        {tenantMode && baselineOrigin && onSaveBaseline && (
          <button type="button" style={UI.btn} onClick={onSaveBaseline} disabled={saving}>Save to baseline</button>
        )}
        <button type="button" style={UI.btn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ExceptionsEditor({ exceptions, onChange }: { exceptions: RuleCondition[]; onChange: (e: RuleCondition[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" style={{ ...UI.btn, fontSize: '0.75rem' }} onClick={() => setOpen(o => !o)}>
        Exceptions ({exceptions.length})
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {exceptions.map((ex, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select style={{ ...UI.sel, width: 110 }} value={ex.kind}
                onChange={e => {
                  const k = e.target.value as RuleKind;
                  const next = [...exceptions];
                  next[i] = k === 'path'
                    ? { kind: 'path', path: '*' }
                    : k === 'hash'
                      ? { kind: 'hash', hashes: [{ type: 'SHA256', data: '', sourceFileName: '', sourceFileLength: '0' }] }
                      : { kind: 'publisher', publisherName: '*', productName: '*', binaryName: '*', lowSection: '*', highSection: '*' };
                  onChange(next);
                }}>
                <option value="path">Path</option>
                <option value="publisher">Publisher</option>
                <option value="hash">Hash</option>
              </select>
              {ex.kind === 'path' && (
                <input style={inp} value={ex.path} onChange={e => {
                  const next = [...exceptions]; next[i] = { kind: 'path', path: e.target.value }; onChange(next);
                }} />
              )}
              {ex.kind === 'publisher' && (
                <input style={inp} value={ex.publisherName} placeholder="Publisher"
                  onChange={e => { const next = [...exceptions]; next[i] = { ...ex, publisherName: e.target.value }; onChange(next); }} />
              )}
              {ex.kind === 'hash' && (
                <input style={inp} value={ex.hashes[0]?.data ?? ''} placeholder="SHA256"
                  onChange={e => {
                    const next = [...exceptions];
                    next[i] = { kind: 'hash', hashes: [{ type: 'SHA256', data: e.target.value, sourceFileName: '', sourceFileLength: '0' }] };
                    onChange(next);
                  }} />
              )}
              <button type="button" style={{ ...UI.btn, color: '#f87171' }} onClick={() => onChange(exceptions.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" style={{ ...UI.btn, fontSize: '0.75rem' }}
            onClick={() => onChange([...exceptions, { kind: 'path', path: '%OSDRIVE%\\Temp\\*' }])}>
            Add exception
          </button>
        </div>
      )}
    </div>
  );
}
