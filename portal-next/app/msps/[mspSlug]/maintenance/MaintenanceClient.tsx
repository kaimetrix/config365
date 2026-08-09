'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';
import { toGiteaWebUrl } from '@/lib/utils';
import { GroupPicker } from '@/components/GroupPicker';
import { fetchGroupNamesFromGit } from '@/lib/group-definitions';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TargetGroup  { groupId: string | null; name: string; percentage: number }
interface FilterRule   { field: string; operator: string; value: string | number | boolean }
interface FilterGroup  { operator: 'and' | 'or'; rules: FilterRule[] }
interface SplitFilters { groupOperator: 'and' | 'or'; groups: FilterGroup[] }

interface GroupSplit {
  id: string; displayName: string; sourceGroupId: string; sourceGroupName: string;
  targetGroups: TargetGroup[];
  filters?: SplitFilters;
}
interface FontRule    { id: string; displayName: string; groupId: string; groupName: string; fontName: string; fontSize: number }
interface GalRule     { id: string; displayName: string; groupId: string; groupName: string; hidden: boolean }
interface RenameRule  { id: string; displayName: string; groupId: string; groupName: string; prefix: string; excludeGroups: { groupId: string; groupName: string }[] }
interface PrimaryUser { enabled: boolean; exclusiveDays: number; targetGroups: { groupId: string; groupName: string }[]; excludeGroups: { groupId: string; groupName: string }[] }
interface EntraDeviceCleanup { enabled: boolean; inactiveDays: number; targetGroups: { groupId: string; groupName: string }[]; excludeGroups: { groupId: string; groupName: string }[] }
interface BaselineApplyCleanup { enabled: boolean; retentionDays: number }
interface Run         { id: number; status: string; display_title: string; created_at: string; html_url: string }
interface CommitEntry { sha: string; message: string; created: string; services?: string[] }

interface Props { mspSlug: string; tenants: Tenant[] }

const FILES = {
  splits:             'group-splits.json',
  fonts:              'exchange-fonts.json',
  gal:                'exchange-gal-hide.json',
  rename:             'intune-device-rename.json',
  primaryUser:        'intune-primary-user.json',
  entraDeviceCleanup: 'entra-device-cleanup.json',
  baselineApplyCleanup: 'baseline-apply-cleanup.json',
  schedule:           'maintenance-schedule.json',
} as const;

// ─── Schedule mode types ──────────────────────────────────────────────────────

type ScheduleMode = 'both' | 'auto' | 'manual';

interface ScheduleModes {
  groupSplits:         ScheduleMode;
  exchangeFonts:       ScheduleMode;
  exchangeGal:         ScheduleMode;
  intuneDeviceRename:  ScheduleMode;
  intunePrimaryUser:   ScheduleMode;
  entraDeviceCleanup:  ScheduleMode;
  baselineApplyCleanup: ScheduleMode;
}

const DEFAULT_SCHEDULE: ScheduleModes = {
  groupSplits:         'both',
  exchangeFonts:       'both',
  exchangeGal:         'both',
  intuneDeviceRename:  'both',
  intunePrimaryUser:   'both',
  entraDeviceCleanup:  'both',
  baselineApplyCleanup: 'both',
};

// ─── WhatIf result types ──────────────────────────────────────────────────────

interface WhatIfTask {
  keyword: string;
  label:   string;
  status:  'success' | 'failure' | 'skipped';
  output:  unknown;
}

interface MaintenanceWhatIfPlan {
  generatedAt: string;
  tenant:      string;
  runId:       string;
  whatIf:      boolean;
  tasks:       WhatIfTask[];
}

const FILTER_FIELDS = [
  { value: 'trustType',    label: 'Join Type',     category: 'Device' },
  { value: 'lastActivity', label: 'Last Activity', category: 'Device' },
  { value: 'osType',       label: 'OS Type',       category: 'Device' },
  { value: 'mdmManaged',   label: 'MDM Managed',   category: 'Device' },
  { value: 'lastSignIn',   label: 'Last Sign-In',  category: 'User'   },
  { value: 'hasLicense',   label: 'Has License',   category: 'User'   },
];
function filterMeta(field: string) {
  switch (field) {
    case 'trustType':    return { ops: [{ v: 'eq', l: 'is' }, { v: 'neq', l: 'is not' }], type: 'select', opts: [{ v: 'AzureAd', l: 'Azure AD Joined' }, { v: 'Workplace', l: 'Registered' }, { v: 'ServerAd', l: 'Hybrid AAD' }] };
    case 'lastActivity':
    case 'lastSignIn':   return { ops: [{ v: 'withinDays', l: 'active within' }, { v: 'notWithinDays', l: 'not active within' }], type: 'days', opts: [] };
    case 'osType':       return { ops: [{ v: 'eq', l: 'is' }, { v: 'neq', l: 'is not' }], type: 'text', opts: [], placeholder: 'Windows, iOS…' };
    case 'mdmManaged':   return { ops: [{ v: 'eq', l: 'is' }], type: 'select', opts: [{ v: 'true', l: 'Managed' }, { v: 'false', l: 'Unmanaged' }] };
    case 'hasLicense':   return { ops: [{ v: 'eq', l: 'is' }], type: 'select', opts: [{ v: 'true', l: 'Licensed' }, { v: 'false', l: 'Unlicensed' }] };
    default:             return { ops: [{ v: 'eq', l: 'equals' }], type: 'text', opts: [] };
  }
}

const S = {
  inp:   { width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit' },
  sel:   { width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none', boxSizing: 'border-box' as const, fontFamily: 'inherit', cursor: 'pointer' },
  lbl:   { display: 'block' as const, fontSize: '0.75rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 6 },
  card:  { background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' as const, marginBottom: 12 },
  sec:   { marginBottom: 28 },
  secTt: { fontSize: '0.875rem', fontWeight: 600, color: '#e4e4e7' },
  secSt: { fontSize: '0.75rem', color: '#52525b', marginTop: 2 },
  addBt: { background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', fontSize: '0.8125rem', fontWeight: 500, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 },
  delBt: { background: 'transparent', border: '1px solid transparent', borderRadius: 6, color: '#52525b', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
  row2:  { display: 'grid' as const, gridTemplateColumns: '1fr 1fr', gap: 12 },
  fg:    { marginBottom: 14 },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function MaintenanceClient({ mspSlug, tenants }: Props) {
  const [scope, setScope] = useState<string>('baseline');
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [isDirty, setIsDirty]     = useState(false);
  const [toast, setToast]         = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  const [splits, setSplits]           = useState<GroupSplit[]>([]);
  const [fonts, setFonts]             = useState<FontRule[]>([]);
  const [gal, setGal]                 = useState<GalRule[]>([]);
  const [rename, setRename]           = useState<RenameRule[]>([]);
  const [primaryUser, setPrimaryUser] = useState<PrimaryUser>({ enabled: false, exclusiveDays: 30, targetGroups: [], excludeGroups: [] });
  const [entraDeviceCleanup, setEntraDeviceCleanup] = useState<EntraDeviceCleanup>({ enabled: false, inactiveDays: 90, targetGroups: [], excludeGroups: [] });
  const [baselineApplyCleanup, setBaselineApplyCleanup] = useState<BaselineApplyCleanup>({ enabled: false, retentionDays: 30 });
  const [scheduleModes, setScheduleModes] = useState<ScheduleModes>({ ...DEFAULT_SCHEDULE });

  // per-file SHAs for updates
  const [shas, setShas]           = useState<Record<string, string | undefined>>({});

  // ── Available groups (for autocomplete pickers) ───────────────────────────
  const [baselineGroupNames, setBaselineGroupNames] = useState<string[]>([]);

  useEffect(() => {
    fetchGroupNamesFromGit('baseline/groups', `scope=baseline&mspSlug=${encodeURIComponent(mspSlug)}`)
      .then(setBaselineGroupNames)
      .catch(() => { /* group autocomplete is optional, fail silently */ });
  }, [mspSlug]);

  // Union of baseline groups + any groups already referenced in the loaded config
  const availableGroups = useMemo(() => {
    const all = new Set<string>(baselineGroupNames);
    splits.forEach(s => {
      if (s.sourceGroupName) all.add(s.sourceGroupName);
      s.targetGroups.forEach(t => { if (t.name) all.add(t.name); });
    });
    fonts.forEach(f => { if (f.groupName) all.add(f.groupName); });
    gal.forEach(g => { if (g.groupName) all.add(g.groupName); });
    rename.forEach(r => { if (r.groupName) all.add(r.groupName); r.excludeGroups?.forEach(eg => { if (eg.groupName) all.add(eg.groupName); }); });
    primaryUser.targetGroups.forEach(g => { if (g.groupName) all.add(g.groupName); });
    primaryUser.excludeGroups.forEach(g => { if (g.groupName) all.add(g.groupName); });
    entraDeviceCleanup.targetGroups.forEach(g => { if (g.groupName) all.add(g.groupName); });
    entraDeviceCleanup.excludeGroups.forEach(g => { if (g.groupName) all.add(g.groupName); });
    return [...all].sort();
  }, [baselineGroupNames, splits, fonts, gal, rename, primaryUser, entraDeviceCleanup]);

  // WhatIf viewer
  const [whatIfModal, setWhatIfModal] = useState(false);

  // history
  const [runs, setRuns]               = useState<Run[]>([]);
  const [commits, setCommits]         = useState<CommitEntry[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [histTab, setHistTab]         = useState<'commits' | 'ado'>('commits');
  const [triggering, setTriggering]   = useState(false);
  const [runResult, setRunResult]     = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ msg, type }); setTimeout(() => setToast(null), 4000);
  }
  function markDirty() { setIsDirty(true); }

  // ── resolve API params ────────────────────────────────────────────────────
  function fileParams(file: string) {
    if (scope === 'baseline') return `path=${encodeURIComponent(`maintenance/${file}`)}&scope=baseline&mspSlug=${mspSlug}`;
    return `path=${encodeURIComponent(`config/maintenance/${file}`)}&slug=${encodeURIComponent(scope)}`;
  }
  function saveBody(file: string, content: string, sha?: string) {
    if (scope === 'baseline') return { path: `maintenance/${file}`, content, message: `portal: update ${file}`, sha, scope: 'baseline', mspSlug };
    return { path: `config/maintenance/${file}`, content, message: `portal: update ${file}`, sha, slug: scope };
  }

  // ── load ─────────────────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setLoading(true); setIsDirty(false); setRunResult(null);
    try {
      const load = async (file: string) => {
        const r = await fetch(`/api/git/file?${fileParams(file)}`);
        return r.ok ? r.json() : { exists: false, content: null, sha: null };
      };
      const [sp, fo, ga, rn, pu, edc, bac, sched] = await Promise.all(Object.values(FILES).map(f => load(f)));
      const newShas: Record<string, string | undefined> = {};

      const parse = <T,>(d: { exists: boolean; content: string | null; sha?: string }, key: string, def: T): T => {
        if (d.sha) newShas[key] = d.sha;
        if (!d.exists || !d.content) return def;
        try { return JSON.parse(d.content) as T; } catch { return def; }
      };

      setSplits(parse<{ groupSplits: GroupSplit[] }>(sp, FILES.splits, { groupSplits: [] }).groupSplits ?? []);
      setFonts(parse<{ exchangeFonts: FontRule[] }>(fo, FILES.fonts, { exchangeFonts: [] }).exchangeFonts ?? []);
      setGal(parse<{ galHideRules: GalRule[] }>(ga, FILES.gal, { galHideRules: [] }).galHideRules ?? []);
      setRename(parse<{ renameRules: RenameRule[] }>(rn, FILES.rename, { renameRules: [] }).renameRules ?? []);
      const puParsed = parse<Partial<PrimaryUser>>(pu, FILES.primaryUser, {});
      setPrimaryUser({
        enabled: puParsed.enabled ?? false, exclusiveDays: puParsed.exclusiveDays ?? 30,
        targetGroups: puParsed.targetGroups ?? [], excludeGroups: puParsed.excludeGroups ?? [],
      });
      const edcParsed = parse<Partial<EntraDeviceCleanup>>(edc, FILES.entraDeviceCleanup, {});
      setEntraDeviceCleanup({
        enabled: edcParsed.enabled ?? false, inactiveDays: edcParsed.inactiveDays ?? 90,
        targetGroups: edcParsed.targetGroups ?? [], excludeGroups: edcParsed.excludeGroups ?? [],
      });
      const bacParsed = parse<Partial<BaselineApplyCleanup>>(bac, FILES.baselineApplyCleanup, {});
      setBaselineApplyCleanup({
        enabled: bacParsed.enabled ?? false, retentionDays: bacParsed.retentionDays ?? 30,
      });
      const schedParsed = parse<Partial<ScheduleModes>>(sched, FILES.schedule, {});
      setScheduleModes({
        groupSplits:         (schedParsed.groupSplits         ?? 'both') as ScheduleMode,
        exchangeFonts:       (schedParsed.exchangeFonts       ?? 'both') as ScheduleMode,
        exchangeGal:         (schedParsed.exchangeGal         ?? 'both') as ScheduleMode,
        intuneDeviceRename:  (schedParsed.intuneDeviceRename  ?? 'both') as ScheduleMode,
        intunePrimaryUser:   (schedParsed.intunePrimaryUser   ?? 'both') as ScheduleMode,
        entraDeviceCleanup:  (schedParsed.entraDeviceCleanup  ?? 'both') as ScheduleMode,
        baselineApplyCleanup: (schedParsed.baselineApplyCleanup ?? 'both') as ScheduleMode,
      });
      setShas(newShas);
    } finally { setLoading(false); }
  }, [scope, mspSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  // ── load history ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (scope === 'baseline') { setRuns([]); setCommits([]); return; }
    setRunsLoading(true);
    Promise.allSettled([
      fetch(`/api/pipelines/runs?slug=${scope}&workflow=maintenance.yml&limit=15`).then(r => r.json()),
      fetch(`/api/git/commits?slug=${scope}&limit=50`).then(r => r.json()),
    ]).then(([runsRes, commitsRes]) => {
      setRuns(runsRes.status === 'fulfilled' && Array.isArray(runsRes.value) ? runsRes.value : []);
      // API returns GitCommit[] — map to CommitEntry and filter to maintenance-only commits
      type RawCommit = { sha: string; commit: { message: string; author: { date: string } } };
      const raw: RawCommit[] = commitsRes.status === 'fulfilled' && Array.isArray(commitsRes.value) ? commitsRes.value : [];
      const MAINT_RE = /maintenance|write-back|whatif/i;
      setCommits(
        raw
          .filter(c => MAINT_RE.test(c.commit?.message ?? ''))
          .map(c => ({ sha: c.sha, message: c.commit.message, created: c.commit.author.date }))
      );
    }).finally(() => setRunsLoading(false));
  }, [scope]);

  // ── save ─────────────────────────────────────────────────────────────────
  async function saveAll() {
    setSaving(true); let errors = 0;
    const saves: [string, string | undefined, object][] = [
      [FILES.splits,             shas[FILES.splits],             { groupSplits: splits }],
      [FILES.fonts,              shas[FILES.fonts],              { exchangeFonts: fonts }],
      [FILES.gal,                shas[FILES.gal],                { galHideRules: gal }],
      [FILES.rename,             shas[FILES.rename],             { renameRules: rename }],
      [FILES.primaryUser,        shas[FILES.primaryUser],        primaryUser],
      [FILES.entraDeviceCleanup, shas[FILES.entraDeviceCleanup], entraDeviceCleanup],
      [FILES.baselineApplyCleanup, shas[FILES.baselineApplyCleanup], baselineApplyCleanup],
      [FILES.schedule,           shas[FILES.schedule],           scheduleModes],
    ];
    for (const [file, sha, data] of saves) {
      try {
        const r = await fetch('/api/git/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saveBody(file, JSON.stringify(data, null, 2), sha)) });
        if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      } catch (e: unknown) { errors++; showToast(`Failed to save ${file}: ${(e as Error).message}`, 'error'); }
    }
    setSaving(false);
    if (errors === 0) { setIsDirty(false); showToast('Configuration saved.', 'success'); await loadConfig(); }
  }

  // ── run ──────────────────────────────────────────────────────────────────
  async function triggerRun(whatIf = false, allTenants = false) {
    if (!allTenants && scope === 'baseline') return;
    const label = whatIf ? ' (WhatIf)' : '';
    const tgt   = allTenants ? 'all tenants' : (tenants.find(t => t.slug === scope)?.displayName ?? scope);
    if (!confirm(`Trigger maintenance${label} for ${tgt}?`)) return;
    setTriggering(true); setRunResult(null);
    try {
      if (allTenants) {
        const results = await Promise.allSettled(tenants.map(t =>
          fetch('/api/pipelines/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: t.slug, workflow: 'maintenance.yml', inputs: whatIf ? { what_if: 'true' } : {} }) }).then(r => { if (!r.ok) throw new Error(t.displayName); })
        ));
        const failed = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
        if (failed.length === 0) setRunResult({ msg: `Triggered${label} for all ${tenants.length} tenant(s).`, ok: true });
        else setRunResult({ msg: `Triggered with errors. Failed: ${failed.join(', ')}`, ok: false });
      } else {
        const r = await fetch('/api/pipelines/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: scope, workflow: 'maintenance.yml', inputs: whatIf ? { what_if: 'true' } : {} }) });
        if (!r.ok) throw new Error((await r.json()).error);
        setRunResult({ msg: `Maintenance${label} triggered for ${tgt}.`, ok: true });
      }
    } catch (e: unknown) { setRunResult({ msg: `Error: ${(e as Error).message}`, ok: false }); }
    finally { setTriggering(false); }
  }

  const isTenant = scope !== 'baseline';

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingBottom: 40 }}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#f4f4f5' }}>Maintenance</div>
          <div style={{ fontSize: '0.8125rem', color: '#71717a', marginTop: 2 }}>Configure nightly maintenance tasks for your tenants.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <select value={scope} onChange={e => setScope(e.target.value)} style={{ ...S.sel, width: 'auto', minWidth: 180, padding: '7px 10px' }}>
            <option value="baseline">Baseline (all tenants)</option>
            {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
          </select>
          <button onClick={saveAll} disabled={!isDirty || saving} style={{ background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, padding: '8px 16px', cursor: (!isDirty || saving) ? 'not-allowed' : 'pointer', opacity: !isDirty ? 0.4 : 1, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {loading && <div style={{ color: '#52525b', fontSize: '0.8125rem', marginBottom: 16 }}>Loading configuration…</div>}

      {/* ── Run panel ───────────────────────────────────────────────────── */}
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16, flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e4e4e7' }}>Run Maintenance Now</div>
          <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 2 }}>Trigger the maintenance pipeline on demand.</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isTenant && (
              <>
                <button onClick={() => triggerRun(false, false)} disabled={triggering} style={{ ...S.addBt, borderColor: '#22c55e33', color: '#22c55e' }}>
                  ▶ Run {tenants.find(t => t.slug === scope)?.displayName ?? scope}
                </button>
                <button onClick={() => triggerRun(true, false)} disabled={triggering} style={{ ...S.addBt }}>WhatIf</button>
                <button onClick={() => setWhatIfModal(true)} disabled={triggering} style={{ ...S.addBt, borderColor: '#a78bfa33', color: '#a78bfa', fontSize: '0.75rem' }}>View WhatIf Results</button>
              </>
            )}
            <button onClick={() => triggerRun(false, true)} disabled={triggering} style={S.addBt}>▶▶ Run all tenants</button>
            <button onClick={() => triggerRun(true, true)} disabled={triggering} style={S.addBt}>WhatIf all</button>
          </div>
          {runResult && <div style={{ fontSize: '0.8125rem', color: runResult.ok ? '#22c55e' : '#f87171' }}>{runResult.msg}</div>}
        </div>
      </div>

      {/* ── Group Split Rules ────────────────────────────────────────────── */}
      <Section title="Group Split Rules" subtitle="Divide a source group's members into child groups by percentage. Runs nightly." onAdd={() => { setSplits(p => [...p, { id: `split-${Date.now()}`, displayName: '', sourceGroupId: '', sourceGroupName: '', targetGroups: [] }]); markDirty(); }} scheduleMode={scheduleModes.groupSplits} onScheduleChange={m => { setScheduleModes(p => ({ ...p, groupSplits: m })); markDirty(); }}>
        {splits.length === 0 ? <Empty>No group split rules configured. Click <strong>Add Split</strong> to create one.</Empty> : splits.map((s, i) => (
          <SplitCard key={s.id} split={s} groups={availableGroups} onDelete={() => { setSplits(p => p.filter((_, j) => j !== i)); markDirty(); }}
            onChange={up => { setSplits(p => p.map((x, j) => j === i ? { ...x, ...up } : x)); markDirty(); }} />
        ))}
      </Section>

      {/* ── Exchange Fonts ───────────────────────────────────────────────── */}
      <Section title="Exchange Default Font Configuration" subtitle="Set Outlook default font and size per Entra group. Applied to each member's mailbox nightly." onAdd={() => { setFonts(p => [...p, { id: `font-${Date.now()}`, displayName: '', groupId: '', groupName: '', fontName: '', fontSize: 11 }]); markDirty(); }} scheduleMode={scheduleModes.exchangeFonts} onScheduleChange={m => { setScheduleModes(p => ({ ...p, exchangeFonts: m })); markDirty(); }}>
        {fonts.length === 0 ? <Empty>No font rules configured. Click <strong>Add Font Rule</strong> to create one.</Empty> : fonts.map((f, i) => (
          <RuleCard key={f.id} title={f.displayName || 'Untitled Rule'} meta={`${f.groupName || 'No group'} — ${f.fontName || 'No font'}${f.fontSize ? ` ${f.fontSize}pt` : ''}`} onDelete={() => { setFonts(p => p.filter((_, j) => j !== i)); markDirty(); }}>
            <div style={S.row2}>
              <Field label="Rule Name"><input style={S.inp} value={f.displayName} placeholder="e.g. Marketing default font" onChange={e => { setFonts(p => p.map((x, j) => j === i ? { ...x, displayName: e.target.value } : x)); markDirty(); }} /></Field>
              <Field label="Target Group"><GroupPicker value={f.groupName} options={availableGroups} onChange={name => { setFonts(p => p.map((x, j) => j === i ? { ...x, groupName: name, groupId: '' } : x)); markDirty(); }} /></Field>
            </div>
            <div style={S.row2}>
              <Field label="Font Name"><input style={S.inp} value={f.fontName} placeholder="e.g. Aeroport Light" onChange={e => { setFonts(p => p.map((x, j) => j === i ? { ...x, fontName: e.target.value } : x)); markDirty(); }} /></Field>
              <Field label="Font Size (pt)"><input style={S.inp} type="number" min={6} max={72} value={f.fontSize} onChange={e => { setFonts(p => p.map((x, j) => j === i ? { ...x, fontSize: parseInt(e.target.value) || 11 } : x)); markDirty(); }} /></Field>
            </div>
          </RuleCard>
        ))}
      </Section>

      {/* ── GAL Visibility ──────────────────────────────────────────────── */}
      <Section title="Exchange GAL Visibility" subtitle="Hide or show all mailbox members of an Entra group in the Exchange Global Address List." onAdd={() => { setGal(p => [...p, { id: `gal-${Date.now()}`, displayName: '', groupId: '', groupName: '', hidden: true }]); markDirty(); }} scheduleMode={scheduleModes.exchangeGal} onScheduleChange={m => { setScheduleModes(p => ({ ...p, exchangeGal: m })); markDirty(); }}>
        {gal.length === 0 ? <Empty>No GAL rules configured. Click <strong>Add GAL Rule</strong> to create one.</Empty> : gal.map((g, i) => (
          <RuleCard key={g.id} title={g.displayName || 'Untitled Rule'} meta={`${g.groupName || 'No group'} — ${g.hidden ? 'Hidden from GAL' : 'Visible in GAL'}`} onDelete={() => { setGal(p => p.filter((_, j) => j !== i)); markDirty(); }}>
            <div style={S.row2}>
              <Field label="Rule Name"><input style={S.inp} value={g.displayName} placeholder="e.g. Hide Service Accounts from GAL" onChange={e => { setGal(p => p.map((x, j) => j === i ? { ...x, displayName: e.target.value } : x)); markDirty(); }} /></Field>
              <Field label="Target Group"><GroupPicker value={g.groupName} options={availableGroups} onChange={name => { setGal(p => p.map((x, j) => j === i ? { ...x, groupName: name, groupId: '' } : x)); markDirty(); }} /></Field>
            </div>
            <Field label="GAL Visibility">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => { setGal(p => p.map((x, j) => j === i ? { ...x, hidden: true } : x)); markDirty(); }} style={{ background: g.hidden ? 'rgba(248,113,113,0.15)' : 'transparent', border: '1px solid #3f3f46', borderRadius: '6px 0 0 6px', color: g.hidden ? '#f87171' : '#71717a', padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8125rem' }}>Hidden</button>
                <button onClick={() => { setGal(p => p.map((x, j) => j === i ? { ...x, hidden: false } : x)); markDirty(); }} style={{ background: !g.hidden ? 'rgba(34,197,94,0.12)' : 'transparent', border: '1px solid #3f3f46', borderLeft: 'none', borderRadius: '0 6px 6px 0', color: !g.hidden ? '#22c55e' : '#71717a', padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8125rem' }}>Visible</button>
              </div>
              <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#52525b' }}>Members of this group will be <strong style={{ color: g.hidden ? '#f87171' : '#22c55e' }}>{g.hidden ? 'hidden from' : 'visible in'}</strong> the Exchange Global Address List.</div>
            </Field>
          </RuleCard>
        ))}
      </Section>

      {/* ── Intune Device Rename ─────────────────────────────────────────── */}
      <Section title="Intune Device Auto-Rename" subtitle={<>Rename enrolled devices to <code style={{ fontSize: '0.8em', background: '#27272a', padding: '1px 5px', borderRadius: 4 }}>{'{PREFIX}-{USER5}{RAND2}'}</code> based on Entra group membership.</>} onAdd={() => { setRename(p => [...p, { id: `rename-${Date.now()}`, displayName: '', groupId: '', groupName: '', prefix: '', excludeGroups: [] }]); markDirty(); }} scheduleMode={scheduleModes.intuneDeviceRename} onScheduleChange={m => { setScheduleModes(p => ({ ...p, intuneDeviceRename: m })); markDirty(); }}>
        {rename.length === 0 ? <Empty>No rename rules configured. Click <strong>Add Rename Rule</strong> to create one.</Empty> : rename.map((r, i) => {
          const pfx = (r.prefix || '???').toUpperCase();
          return (
            <RuleCard key={r.id} title={r.displayName || 'Untitled Rule'} meta={`${r.groupName || 'No group'} — format: ${pfx}-USER54F`} onDelete={() => { setRename(p => p.filter((_, j) => j !== i)); markDirty(); }}>
              <div style={S.row2}>
                <Field label="Rule Name"><input style={S.inp} value={r.displayName} placeholder="e.g. Rename SON devices" onChange={e => { setRename(p => p.map((x, j) => j === i ? { ...x, displayName: e.target.value } : x)); markDirty(); }} /></Field>
                <Field label="Target Group"><GroupPicker value={r.groupName} options={availableGroups} onChange={name => { setRename(p => p.map((x, j) => j === i ? { ...x, groupName: name, groupId: '' } : x)); markDirty(); }} /></Field>
              </div>
              <div style={S.row2}>
                <Field label="Prefix (1–3 alphanumeric chars)">
                  <input style={{ ...S.inp, textTransform: 'uppercase', maxWidth: 120 }} value={r.prefix} maxLength={3} placeholder="e.g. SON" onChange={e => { const v = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3); setRename(p => p.map((x, j) => j === i ? { ...x, prefix: v } : x)); markDirty(); }} />
                </Field>
                <Field label="Resulting format">
                  <div style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: '#a1a1aa', padding: '8px 12px', background: '#18181b', border: '1px solid #27272a', borderRadius: 6 }}>{pfx}-USER54F</div>
                </Field>
              </div>
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #27272a' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={S.lbl}>Exclusion Groups</span>
                  <button onClick={() => { setRename(p => p.map((x, j) => j === i ? { ...x, excludeGroups: [...(x.excludeGroups ?? []), { groupId: '', groupName: '' }] } : x)); markDirty(); }} style={{ ...S.addBt, fontSize: '0.75rem', padding: '3px 8px' }}>+ Add Exclusion Group</button>
                </div>
                {(r.excludeGroups ?? []).length === 0
                  ? <div style={{ fontSize: '0.75rem', color: '#3f3f46', fontStyle: 'italic' }}>No exclusion groups configured.</div>
                  : (r.excludeGroups ?? []).map((eg, ei) => (
                    <div key={ei} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                      <GroupPicker value={eg.groupName} options={availableGroups} style={{ ...S.inp, flex: 1 }} onChange={name => { setRename(p => p.map((x, j) => j === i ? { ...x, excludeGroups: x.excludeGroups.map((eg2, ej) => ej === ei ? { ...eg2, groupName: name, groupId: '' } : eg2) } : x)); markDirty(); }} />
                      <button onClick={() => { setRename(p => p.map((x, j) => j === i ? { ...x, excludeGroups: x.excludeGroups.filter((_, ej) => ej !== ei) } : x)); markDirty(); }} style={S.delBt} title="Remove">×</button>
                    </div>
                  ))}
              </div>
            </RuleCard>
          );
        })}
      </Section>

      {/* ── Intune Primary User ──────────────────────────────────────────── */}
      <div style={S.sec}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={S.secTt}>Intune Primary User Auto-Assignment</div>
              <ScheduleModeSelect value={scheduleModes.intunePrimaryUser} onChange={m => { setScheduleModes(p => ({ ...p, intunePrimaryUser: m })); markDirty(); }} />
            </div>
            <div style={S.secSt}>Assign a device's primary user in Intune when only one user has logged on during the configured lookback window.</div>
          </div>
        </div>
        <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Enabled</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={primaryUser.enabled} style={{ width: 15, height: 15, accentColor: '#6366f1', cursor: 'pointer' }} onChange={e => { setPrimaryUser(p => ({ ...p, enabled: e.target.checked })); markDirty(); }} />
              <span style={{ fontSize: '0.8125rem', color: '#d4d4d8' }}>{primaryUser.enabled ? 'Active — will run nightly' : 'Inactive — no changes will be made'}</span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Exclusive days</label>
            <input type="number" min={1} max={365} value={primaryUser.exclusiveDays} style={{ width: 70, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '5px 8px', outline: 'none' }} onChange={e => { const v = parseInt(e.target.value) || 30; setPrimaryUser(p => ({ ...p, exclusiveDays: v })); markDirty(); }} />
            <span style={{ fontSize: '0.8125rem', color: '#71717a' }}>Assign primary user only when one unique user has logged on in the past <strong>{primaryUser.exclusiveDays}</strong> day{primaryUser.exclusiveDays === 1 ? '' : 's'}.</span>
          </div>
          <GroupListField label="Target groups" hint="Leave empty to evaluate all managed devices" groups={primaryUser.targetGroups} onChange={v => { setPrimaryUser(p => ({ ...p, targetGroups: v })); markDirty(); }} addLabel="+ Add Group" availableGroups={availableGroups} />
          <GroupListField label="Exclusion groups" hint="Devices in these groups will not have their primary user changed" groups={primaryUser.excludeGroups} onChange={v => { setPrimaryUser(p => ({ ...p, excludeGroups: v })); markDirty(); }} addLabel="+ Add Exclusion Group" availableGroups={availableGroups} />
        </div>
      </div>

      {/* ── Entra ID Inactive Device Cleanup ─────────────────────────────── */}
      <div style={S.sec}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={S.secTt}>Entra ID Inactive Device Cleanup</div>
              <ScheduleModeSelect value={scheduleModes.entraDeviceCleanup} onChange={m => { setScheduleModes(p => ({ ...p, entraDeviceCleanup: m })); markDirty(); }} />
            </div>
            <div style={S.secSt}>Delete stale Entra ID device registrations that have not signed in within the configured window. Intune managed device records are not affected.</div>
          </div>
        </div>
        <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Enabled</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={entraDeviceCleanup.enabled} style={{ width: 15, height: 15, accentColor: '#6366f1', cursor: 'pointer' }} onChange={e => { setEntraDeviceCleanup(p => ({ ...p, enabled: e.target.checked })); markDirty(); }} />
              <span style={{ fontSize: '0.8125rem', color: '#d4d4d8' }}>{entraDeviceCleanup.enabled ? 'Active — will run nightly' : 'Inactive — no changes will be made'}</span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Inactive days</label>
            <input type="number" min={1} max={3650} value={entraDeviceCleanup.inactiveDays} style={{ width: 70, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '5px 8px', outline: 'none' }} onChange={e => { const v = parseInt(e.target.value) || 90; setEntraDeviceCleanup(p => ({ ...p, inactiveDays: v })); markDirty(); }} />
            <span style={{ fontSize: '0.8125rem', color: '#71717a' }}>Delete devices that have not signed in for more than <strong>{entraDeviceCleanup.inactiveDays}</strong> day{entraDeviceCleanup.inactiveDays === 1 ? '' : 's'}.</span>
          </div>
          <GroupListField label="Target groups" hint="Leave empty to evaluate all Entra ID devices" groups={entraDeviceCleanup.targetGroups} onChange={v => { setEntraDeviceCleanup(p => ({ ...p, targetGroups: v })); markDirty(); }} addLabel="+ Add Group" availableGroups={availableGroups} />
          <GroupListField label="Exclusion groups" hint="Devices in these groups will not be deleted" groups={entraDeviceCleanup.excludeGroups} onChange={v => { setEntraDeviceCleanup(p => ({ ...p, excludeGroups: v })); markDirty(); }} addLabel="+ Add Exclusion Group" availableGroups={availableGroups} />
        </div>
      </div>

      {/* ── Baseline Apply Scope Cleanup ─────────────────────────────────── */}
      <div style={S.sec}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={S.secTt}>Baseline Apply Scope Cleanup</div>
              <ScheduleModeSelect value={scheduleModes.baselineApplyCleanup} onChange={m => { setScheduleModes(p => ({ ...p, baselineApplyCleanup: m })); markDirty(); }} />
            </div>
            <div style={S.secSt}>Remove stale deploy apply-scope files (<code style={{ fontSize: '0.75rem', color: '#71717a' }}>.baseline-apply-*</code>) from the tenant repository.</div>
          </div>
        </div>
        <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Enabled</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={baselineApplyCleanup.enabled} style={{ width: 15, height: 15, accentColor: '#6366f1', cursor: 'pointer' }} onChange={e => { setBaselineApplyCleanup(p => ({ ...p, enabled: e.target.checked })); markDirty(); }} />
              <span style={{ fontSize: '0.8125rem', color: '#d4d4d8' }}>{baselineApplyCleanup.enabled ? 'Active — will run nightly' : 'Inactive — no changes will be made'}</span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: '0.8125rem', color: '#a1a1aa', minWidth: 110 }}>Retention days</label>
            <input type="number" min={1} max={3650} value={baselineApplyCleanup.retentionDays} style={{ width: 70, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '5px 8px', outline: 'none' }} onChange={e => { const v = parseInt(e.target.value) || 30; setBaselineApplyCleanup(p => ({ ...p, retentionDays: v })); markDirty(); }} />
            <span style={{ fontSize: '0.8125rem', color: '#71717a' }}>Delete scope files older than <strong>{baselineApplyCleanup.retentionDays}</strong> day{baselineApplyCleanup.retentionDays === 1 ? '' : 's'}.</span>
          </div>
        </div>
      </div>

      {/* ── History (tenant only) ────────────────────────────────────────── */}
      {isTenant && (
        <div style={S.sec}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div><div style={S.secTt}>Run History</div><div style={S.secSt}>Past maintenance pipeline runs and write-backs.</div></div>
            <button onClick={() => {}} style={{ ...S.addBt, fontSize: '0.75rem' }}>↻ Refresh</button>
          </div>
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #27272a', marginBottom: 0 }}>
            {(['commits', 'ado'] as const).map(t => (
              <button key={t} onClick={() => setHistTab(t)} style={{ background: 'transparent', border: 'none', borderBottom: histTab === t ? '2px solid #22c55e' : '2px solid transparent', color: histTab === t ? '#e4e4e7' : '#71717a', fontSize: '0.8125rem', fontWeight: 500, padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: -1 }}>
                {t === 'commits' ? 'Change Log' : 'Pipeline Runs'}
              </button>
            ))}
          </div>
          <div style={{ background: '#111113', border: '1px solid #27272a', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
            {runsLoading && <div style={{ padding: '32px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.875rem' }}>Loading…</div>}
            {histTab === 'commits' && !runsLoading && (
              commits.length === 0
                ? <div style={{ padding: '32px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.875rem' }}>No maintenance write-backs found.</div>
                : commits.map(c => (
                  <div key={c.sha} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, padding: '10px 16px', borderBottom: '1px solid #1a1a1d', fontSize: '0.8125rem' }}>
                    <span style={{ color: '#a1a1aa', whiteSpace: 'nowrap' }}>{c.created ? new Date(c.created).toLocaleString() : '—'}</span>
                    <span style={{ color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message?.replace(/ \[skip ci\].*/i, '').replace(/^portal: /i, '')}</span>
                  </div>
                ))
            )}
                {histTab === 'ado' && !runsLoading && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 100px 1fr auto', gap: 12, padding: '8px 16px', fontSize: '0.6875rem', fontWeight: 600, color: '#3f3f46', textTransform: 'uppercase', letterSpacing: '0.07em', background: '#0d0d0f', borderBottom: '1px solid #27272a' }}>
                  <span>Date</span><span>Status</span><span>Run</span><span></span>
                </div>
                {runs.length === 0
                  ? <div style={{ padding: '32px 24px', textAlign: 'center', color: '#52525b', fontSize: '0.875rem' }}>No pipeline runs found.</div>
                  : runs.map(r => {
                    const isWhatIf = r.display_title?.toLowerCase().includes('whatif') ?? false;
                    return (
                      <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '160px 100px 1fr auto', gap: 12, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid #1a1a1d', fontSize: '0.8125rem' }}>
                        <span style={{ color: '#a1a1aa', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</span>
                        <StatusBadge status={r.status} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.display_title?.slice(0, 80) ?? '—'}</span>
                          {isWhatIf && (
                            <span style={{ flexShrink: 0, fontSize: '0.68rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>WhatIf</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          {isWhatIf && (
                            <button onClick={() => setWhatIfModal(true)} style={{ fontSize: '0.72rem', color: '#a78bfa', textDecoration: 'none', background: 'none', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 5, padding: '3px 8px', whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit' }}>View WhatIf →</button>
                          )}
                          <a href={toGiteaWebUrl(r.html_url)} target="_blank" rel="noreferrer" style={{ fontSize: '0.72rem', color: '#52525b', textDecoration: 'none', border: '1px solid #27272a', borderRadius: 5, padding: '3px 8px', whiteSpace: 'nowrap' }}>Logs</a>
                        </div>
                      </div>
                    );
                  })}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── WhatIf Results Modal ────────────────────────────────────────── */}
      {whatIfModal && isTenant && (
        <MaintenanceWhatIfModal
          slug={scope}
          onClose={() => setWhatIfModal(false)}
        />
      )}

      {/* ── Toast ───────────────────────────────────────────────────────── */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000 }}>
          <div style={{ padding: '10px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500, maxWidth: 360, background: toast.type === 'success' ? '#14532d' : toast.type === 'error' ? '#450a0a' : '#1c1c1f', color: toast.type === 'success' ? '#86efac' : toast.type === 'error' ? '#fca5a5' : '#a1a1aa', border: `1px solid ${toast.type === 'success' ? '#166534' : toast.type === 'error' ? '#7f1d1d' : '#3f3f46'}` }}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScheduleModeSelect({ value, onChange }: { value: ScheduleMode; onChange: (m: ScheduleMode) => void }) {
  const color = value === 'auto' ? '#60a5fa' : value === 'manual' ? '#a78bfa' : '#52525b';
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as ScheduleMode)}
      onClick={e => e.stopPropagation()}
      style={{ background: '#18181b', border: `1px solid ${color}44`, borderRadius: 5, color, fontSize: '0.7rem', fontWeight: 600, padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit', outline: 'none' }}
    >
      <option value="both">Auto + Manual</option>
      <option value="auto">Auto only</option>
      <option value="manual">Manual only</option>
    </select>
  );
}

function Section({ title, subtitle, onAdd, scheduleMode, onScheduleChange, children }: { title: string; subtitle: React.ReactNode; onAdd: () => void; scheduleMode?: ScheduleMode; onScheduleChange?: (m: ScheduleMode) => void; children: React.ReactNode }) {
  return (
    <div style={S.sec}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={S.secTt}>{title}</div>
            {scheduleMode !== undefined && onScheduleChange && <ScheduleModeSelect value={scheduleMode} onChange={onScheduleChange} />}
          </div>
          <div style={S.secSt}>{subtitle}</div>
        </div>
        <button onClick={onAdd} style={{ ...S.addBt, flexShrink: 0 }}>+ Add</button>
      </div>
      {children}
    </div>
  );
}

function RuleCard({ title, meta, onDelete, children }: { title: string; meta: string; onDelete: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: open ? '1px solid #27272a' : 'none', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <button onClick={() => setOpen(v => !v)} style={{ background: 'transparent', border: 'none', color: '#52525b', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: open ? 'none' : 'rotate(-90deg)', fontSize: '0.9rem' }}>▾</span>
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            <div style={{ fontSize: '0.75rem', color: '#52525b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</div>
          </div>
        </div>
        <button onClick={onDelete} style={{ ...S.delBt, flexShrink: 0 }} title="Delete">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="2 4 14 4"/><path d="M5 4V2h6v2"/><rect x="3" y="4" width="10" height="10" rx="1"/><line x1="6" y1="7" x2="6" y2="11"/><line x1="10" y1="7" x2="10" y2="11"/></svg>
        </button>
      </div>
      {open && <div style={{ padding: '16px' }}>{children}</div>}
    </div>
  );
}

// ─── Split card ───────────────────────────────────────────────────────────────

function SplitCard({ split, onDelete, onChange, groups }: { split: GroupSplit; onDelete: () => void; onChange: (up: Partial<GroupSplit>) => void; groups: string[] }) {
  const totalPct = (split.targetGroups ?? []).reduce((s, t) => s + (Number(t.percentage) || 0), 0);
  const isOver   = totalPct > 100;

  return (
    <RuleCard
      title={split.displayName || 'Untitled Split'}
      meta={split.sourceGroupName || 'No source group'}
      onDelete={onDelete}
    >
      <div style={S.row2}>
        <Field label="Split Name"><input style={S.inp} value={split.displayName} placeholder="e.g. Update Ring Split" onChange={e => onChange({ displayName: e.target.value })} /></Field>
        <Field label="Source Group"><GroupPicker value={split.sourceGroupName} options={groups} onChange={name => onChange({ sourceGroupName: name, sourceGroupId: '' })} /></Field>
      </div>
      <Field label="Child Groups">
        <div style={{ background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 32px', gap: 10, padding: '8px 12px', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #27272a' }}>
            <span>Group Name</span><span>Percentage</span><span></span>
          </div>
          {(split.targetGroups ?? []).map((tg, ti) => (
            <div key={ti} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 32px', gap: 10, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #1a1a1d' }}>
              <GroupPicker value={tg.name} options={groups} placeholder="Child group name" style={{ ...S.inp, background: 'transparent', border: '1px solid #3f3f46' }} onChange={name => { const tgs = split.targetGroups.map((x, j) => j === ti ? { ...x, name } : x); onChange({ targetGroups: tgs }); }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="number" min={0} max={100} style={{ ...S.inp, width: 60, background: '#18181b' }} value={tg.percentage} onChange={e => { const tgs = split.targetGroups.map((x, j) => j === ti ? { ...x, percentage: parseFloat(e.target.value) || 0 } : x); onChange({ targetGroups: tgs }); }} />
                <span style={{ color: '#71717a', fontSize: '0.8125rem' }}>%</span>
              </div>
              <button onClick={() => { onChange({ targetGroups: split.targetGroups.filter((_, j) => j !== ti) }); }} style={{ ...S.delBt, color: '#52525b' }} title="Remove">×</button>
            </div>
          ))}
          <div style={{ padding: '8px 12px', borderTop: '1px solid #27272a' }}>
            <button onClick={() => onChange({ targetGroups: [...(split.targetGroups ?? []), { groupId: null, name: '', percentage: 0 }] })} style={{ ...S.addBt, border: 'none', color: '#52525b', padding: 0, fontSize: '0.8125rem' }}>+ Add child group</button>
          </div>
        </div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: '#27272a', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: isOver ? '#ef4444' : '#22c55e', borderRadius: 999, width: `${Math.min(totalPct, 100)}%`, transition: 'width 0.2s' }} />
          </div>
          <span style={{ fontSize: '0.75rem', color: isOver ? '#ef4444' : '#71717a', whiteSpace: 'nowrap' }}>{totalPct}% / 100%</span>
        </div>
      </Field>
      {/* Filter rules */}
      <FilterSection split={split} onChange={onChange} />
    </RuleCard>
  );
}

function FilterSection({ split, onChange }: { split: GroupSplit; onChange: (up: Partial<GroupSplit>) => void }) {
  const filters = split.filters ?? { groupOperator: 'and', groups: [] };

  function updateFilters(f: SplitFilters) { onChange({ filters: f }); }
  function addGroup() { updateFilters({ ...filters, groups: [...filters.groups, { operator: 'and', rules: [{ field: 'trustType', operator: 'eq', value: 'AzureAd' }] }] }); }
  function delGroup(gi: number) { updateFilters({ ...filters, groups: filters.groups.filter((_, j) => j !== gi) }); }
  function addRule(gi: number) { updateFilters({ ...filters, groups: filters.groups.map((g, j) => j === gi ? { ...g, rules: [...g.rules, { field: 'trustType', operator: 'eq', value: 'AzureAd' }] } : g) }); }
  function delRule(gi: number, ri: number) { updateFilters({ ...filters, groups: filters.groups.map((g, j) => j === gi ? { ...g, rules: g.rules.filter((_, k) => k !== ri) } : g) }); }
  function setRuleOp(gi: number, op: 'and' | 'or') { updateFilters({ ...filters, groups: filters.groups.map((g, j) => j === gi ? { ...g, operator: op } : g) }); }
  function setGroupOp(op: 'and' | 'or') { updateFilters({ ...filters, groupOperator: op }); }
  function setRuleField(gi: number, ri: number, field: string) {
    const meta = filterMeta(field);
    const defVal = meta.type === 'days' ? 30 : meta.opts[0]?.v ?? '';
    updateFilters({ ...filters, groups: filters.groups.map((g, j) => j === gi ? { ...g, rules: g.rules.map((r, k) => k === ri ? { field, operator: meta.ops[0].v, value: defVal } : r) } : g) });
  }
  function setRulePart(gi: number, ri: number, part: 'operator' | 'value', val: string | number) {
    updateFilters({ ...filters, groups: filters.groups.map((g, j) => j === gi ? { ...g, rules: g.rules.map((r, k) => k === ri ? { ...r, [part]: val } : r) } : g) });
  }

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid #27272a', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ ...S.lbl, margin: 0 }}>Member Filters</span>
        <button onClick={addGroup} style={{ ...S.addBt, fontSize: '0.75rem', padding: '3px 8px', color: '#a78bfa', borderColor: 'rgba(167,139,250,0.3)' }}>+ Add filter group</button>
      </div>
      {filters.groups.length === 0
        ? <div style={{ fontSize: '0.8rem', color: '#52525b' }}>No filters — all source group members will be included.</div>
        : filters.groups.map((g, gi) => (
          <div key={gi}>
            {gi > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <div style={{ flex: 1, height: 1, background: '#27272a' }} />
                <div style={{ display: 'flex', border: '1px solid #3f3f46', borderRadius: 5, overflow: 'hidden' }}>
                  {(['and', 'or'] as const).map(op => (
                    <button key={op} onClick={() => setGroupOp(op)} style={{ background: filters.groupOperator === op ? 'rgba(167,139,250,0.15)' : 'transparent', border: 'none', color: filters.groupOperator === op ? '#a78bfa' : '#71717a', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>{op.toUpperCase()}</button>
                  ))}
                </div>
                <div style={{ flex: 1, height: 1, background: '#27272a' }} />
              </div>
            )}
            <div style={{ background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid #1a1a1d' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.75rem', color: '#52525b' }}>
                  <span>Match</span>
                  <div style={{ display: 'flex', border: '1px solid #3f3f46', borderRadius: 5, overflow: 'hidden' }}>
                    {(['and', 'or'] as const).map(op => (
                      <button key={op} onClick={() => setRuleOp(gi, op)} style={{ background: g.operator === op ? 'rgba(167,139,250,0.15)' : 'transparent', border: 'none', color: g.operator === op ? '#a78bfa' : '#71717a', fontSize: '0.7rem', fontWeight: 700, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>{op === 'and' ? 'ALL' : 'ANY'}</button>
                    ))}
                  </div>
                  <span>of the following rules</span>
                </div>
                <button onClick={() => delGroup(gi)} style={{ ...S.delBt, color: '#52525b' }} title="Delete filter group">×</button>
              </div>
              {g.rules.length === 0 && <div style={{ padding: '10px 12px', fontSize: '0.8rem', color: '#52525b' }}>No rules yet.</div>}
              {g.rules.map((rule, ri) => {
                const meta = filterMeta(rule.field);
                return (
                  <div key={ri} style={{ display: 'grid', gridTemplateColumns: '150px 130px 1fr 28px', gap: 6, padding: '6px 10px', alignItems: 'center', borderBottom: '1px solid #111113' }}>
                    <select value={rule.field} onChange={e => setRuleField(gi, ri, e.target.value)} style={{ ...S.sel, fontSize: '0.8rem', padding: '5px 7px' }}>
                      {FILTER_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label} ({f.category})</option>)}
                    </select>
                    <select value={rule.operator} onChange={e => setRulePart(gi, ri, 'operator', e.target.value)} style={{ ...S.sel, fontSize: '0.8rem', padding: '5px 7px' }}>
                      {meta.ops.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </select>
                    {meta.type === 'select' ? (
                      <select value={String(rule.value)} onChange={e => setRulePart(gi, ri, 'value', e.target.value)} style={{ ...S.sel, fontSize: '0.8rem', padding: '5px 7px' }}>
                        {meta.opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                      </select>
                    ) : meta.type === 'days' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="number" min={1} style={{ ...S.inp, width: 64, fontSize: '0.8rem', padding: '5px 7px' }} value={Number(rule.value) || 30} onChange={e => setRulePart(gi, ri, 'value', parseInt(e.target.value) || 30)} />
                        <span style={{ fontSize: '0.8rem', color: '#71717a' }}>days</span>
                      </div>
                    ) : (
                      <input style={{ ...S.inp, fontSize: '0.8rem', padding: '5px 7px' }} value={String(rule.value ?? '')} placeholder={(meta as { placeholder?: string }).placeholder} onChange={e => setRulePart(gi, ri, 'value', e.target.value)} />
                    )}
                    <button onClick={() => delRule(gi, ri)} style={{ ...S.delBt, color: '#52525b' }} title="Remove rule">×</button>
                  </div>
                );
              })}
              <div style={{ padding: '6px 10px', borderTop: '1px solid #27272a' }}>
                <button onClick={() => addRule(gi)} style={{ ...S.addBt, border: 'none', color: '#52525b', padding: 0, fontSize: '0.8rem' }}>+ Add rule</button>
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

function GroupListField({ label, hint, groups, onChange, addLabel, availableGroups }: { label: string; hint: string; groups: { groupId: string; groupName: string }[]; onChange: (v: { groupId: string; groupName: string }[]) => void; addLabel: string; availableGroups?: string[] }) {
  return (
    <div>
      <div style={{ fontSize: '0.8125rem', color: '#a1a1aa', marginBottom: 8 }}>{label} <span style={{ color: '#52525b', fontWeight: 400 }}>({hint})</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {groups.length === 0
          ? <div style={{ fontSize: '0.8125rem', color: '#52525b', fontStyle: 'italic' }}>No groups configured.</div>
          : groups.map((g, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GroupPicker value={g.groupName} options={availableGroups ?? []} placeholder="Group name" style={{ ...S.inp, flex: 1 }} onChange={name => onChange(groups.map((x, j) => j === i ? { ...x, groupName: name, groupId: '' } : x))} />
              <button onClick={() => onChange(groups.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', padding: 4, borderRadius: 4, fontSize: '1rem', lineHeight: 1 }}>✕</button>
            </div>
          ))}
      </div>
      <button onClick={() => onChange([...groups, { groupId: '', groupName: '' }])} style={{ ...S.addBt, marginTop: 8, border: '1px dashed #3f3f46', color: '#71717a', fontSize: '0.75rem', padding: '5px 12px' }}>{addLabel}</button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={S.fg}><label style={S.lbl}>{label}</label>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '48px 24px', textAlign: 'center', background: '#111113', border: '1px solid #27272a', borderRadius: 8, color: '#52525b', fontSize: '0.875rem' }}>{children}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    success: ['rgba(34,197,94,0.1)', '#22c55e'], failure: ['rgba(239,68,68,0.1)', '#f87171'],
    running: ['rgba(59,130,246,0.1)', '#60a5fa'], waiting: ['rgba(234,179,8,0.1)', '#eab308'],
    cancelled: ['rgba(113,113,122,0.12)', '#71717a'],
  };
  const [bg, color] = map[status] ?? ['rgba(63,63,70,0.2)', '#52525b'];
  return <span style={{ display: 'inline-block', fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: bg, color, border: `1px solid ${color}33` }}>{status}</span>;
}

// ─── MaintenanceWhatIfModal ───────────────────────────────────────────────────

function MaintenanceWhatIfModal({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [plan,    setPlan]    = useState<MaintenanceWhatIfPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');
  const [open,    setOpen]    = useState<Set<string>>(new Set());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    fetch(`/api/git/file?path=${encodeURIComponent('config/maintenance/whatif-latest.json')}&slug=${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then((d: { exists?: boolean; content?: string }) => {
        if (!d.exists || !d.content) { setErr('No WhatIf results yet — run maintenance in WhatIf mode first.'); return; }
        try { setPlan(JSON.parse(d.content) as MaintenanceWhatIfPlan); }
        catch { setErr('Could not parse WhatIf results.'); }
      })
      .catch(() => setErr('Failed to load WhatIf results.'))
      .finally(() => setLoading(false));
  }, [slug]);

  function toggleTask(kw: string) {
    setOpen(prev => { const next = new Set(prev); next.has(kw) ? next.delete(kw) : next.add(kw); return next; });
  }

  const taskStatusColor: Record<string, string> = { success: '#22c55e', failure: '#f87171', skipped: '#71717a' };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.7)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>Maintenance WhatIf Results</span>
            {plan && <span style={{ fontSize: '0.75rem', color: '#52525b', marginLeft: 10 }}>{new Date(plan.generatedAt).toLocaleString()}</span>}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: '1.25rem', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#52525b' }}>
              <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid #27272a', borderTopColor: '#a78bfa', borderRadius: '50%', animation: 'mwi-spin 0.7s linear infinite', marginRight: 8, verticalAlign: 'middle' }} />
              Loading WhatIf results…
            </div>
          )}
          {err && <div style={{ textAlign: 'center', padding: '40px 0', color: '#71717a', fontSize: '0.85rem' }}>{err}</div>}

          {plan && (
            <>
              {/* Summary */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 20, padding: 14, background: '#0c0c0e', border: '1px solid #1e1e21', borderRadius: 8, flexWrap: 'wrap' }}>
                {plan.tasks.map(t => (
                  <div key={t.keyword} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: taskStatusColor[t.status] ?? '#52525b', display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.78rem', color: '#a1a1aa' }}>{t.label}</span>
                    <span style={{ fontSize: '0.68rem', color: taskStatusColor[t.status] ?? '#52525b', fontWeight: 600 }}>{t.status}</span>
                  </div>
                ))}
              </div>

              {/* Per-task results */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {plan.tasks.map(task => (
                  <div key={task.keyword} style={{ background: '#0c0c0e', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
                    <button
                      onClick={() => toggleTask(task.keyword)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
                    >
                      <span style={{ fontSize: '0.8rem', transform: open.has(task.keyword) ? 'none' : 'rotate(-90deg)', display: 'inline-block', transition: 'transform 0.15s', color: '#52525b' }}>▾</span>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e4e4e7', flex: 1 }}>{task.label}</span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: `${taskStatusColor[task.status] ?? '#52525b'}22`, color: taskStatusColor[task.status] ?? '#52525b', border: `1px solid ${taskStatusColor[task.status] ?? '#52525b'}44` }}>
                        {task.status}
                      </span>
                    </button>
                    {open.has(task.keyword) && (
                      <div style={{ borderTop: '1px solid #1a1a1d', padding: '12px 14px' }}>
                        {task.output === null || task.output === undefined ? (
                          <div style={{ fontSize: '0.8rem', color: '#52525b', fontStyle: 'italic' }}>No output available.</div>
                        ) : (
                          <pre style={{ margin: 0, padding: '10px 12px', background: '#09090b', border: '1px solid #1a1a1d', borderRadius: 6, fontSize: '0.75rem', color: '#a1a1aa', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace' }}>
                            {JSON.stringify(task.output, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginTop: 12 }}>
                Run ID: {plan.runId} · Tenant: {plan.tenant}
              </div>
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes mwi-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
