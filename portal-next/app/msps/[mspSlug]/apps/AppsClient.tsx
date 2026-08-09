'use client';
import { Fragment, useState, useEffect, useMemo } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';
import { GroupPicker } from '@/components/GroupPicker';
import { buildChocolateyInstallScript, buildWingetInstallScript, buildWingetUninstallScript } from '@/lib/app-install-scripts';
import { APP_ICON_ACCEPT, readAppIconUpload, type AppIconUpload } from '@/lib/app-icon';
import { defaultIntuneDisplayName, resolveIntuneDisplayName } from '@/lib/app-intune-display-name';
import {
  type AppAssignment,
  type AssignmentIntent,
  type InstallRunAsAccount,
  type GroupDeployScope,
  appFolderPath,
  baselineGroupPaths,
  buildGroupSidecar,
  buildStaticSecurityGroup,
  fetchAssignmentGroupNames,
  fetchBaselineGroupNames,
  fetchGroupNamesFromGit,
  tenantGroupPaths,
} from '@/lib/group-definitions';

type PkgManager = 'chocolatey' | 'winget' | 'custom';
type MainTab = 'deploy' | 'manage';
type GroupBy = 'app' | 'target';
type DeployMode = 'baseline' | 'tenants';

interface Package {
  id: string; displayName: string; version: string; summary: string; publisher?: string; downloads?: number;
}

interface AppEntry {
  pkgManager: PkgManager;
  packageId: string;
  displayName: string;
  intuneDisplayName: string;
  version: string;
  installArgs?: string;
  uninstallArgs?: string;
  assignments?: AppAssignment[];
  availableForAllUsers?: boolean;
  runAsAccount?: InstallRunAsAccount;
  iconFile?: string;
  target: string;
  targetType: 'baseline' | 'tenant';
  path: string;
}

type SaveTarget = { scope: 'baseline' } | { scope: 'tenant'; slug: string };

function applyAppConfigFields(
  base: Record<string, unknown>,
  opts: {
    pkgManager: PkgManager;
    packageId: string;
    displayName: string;
    version: string;
    intuneDisplayName: string;
    installArgs: string;
    uninstallArgs: string;
    assignments: Array<{ groupName: string; intent: AssignmentIntent }>;
    availableForAllUsers: boolean;
    runAsAccount: InstallRunAsAccount;
    iconFile?: string;
  },
): Record<string, unknown> {
  const config = { ...base };
  const ver = opts.version.trim();
  const defaultIntuneName = defaultIntuneDisplayName(opts.pkgManager, opts.displayName);
  const intuneName = opts.intuneDisplayName.trim() || defaultIntuneName;

  config.pkgManager = opts.pkgManager;
  config.packageId = opts.packageId;
  config.displayName = opts.displayName;
  config.assignments = opts.assignments;
  if (opts.availableForAllUsers) config.availableForAllUsers = true;
  else delete config.availableForAllUsers;

  if (opts.runAsAccount === 'user') config.runAsAccount = 'user';
  else delete config.runAsAccount;

  if (ver) config.version = ver;
  else delete config.version;

  if (intuneName !== defaultIntuneName) config.intuneDisplayName = intuneName;
  else delete config.intuneDisplayName;

  const inst = opts.installArgs.trim();
  if (inst) config.installArgs = inst;
  else delete config.installArgs;

  const uninst = opts.uninstallArgs.trim();
  if (uninst) config.uninstallArgs = uninst;
  else delete config.uninstallArgs;

  if (opts.iconFile) config.iconFile = opts.iconFile;
  else delete config.iconFile;

  return config;
}

function Spinner({ small }: { small?: boolean }) {
  const s = small ? 10 : 12;
  return <span style={{ display: 'inline-block', width: s, height: s, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: 'currentColor', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />;
}

const CUSTOM_DETECT = `# Detection script — exit 0 = detected, exit 1 = not detected
$appPath = "C:\\Program Files\\MyApp\\myapp.exe"
if (Test-Path $appPath) { Write-Output "Detected"; exit 0 }
Write-Output "Not detected"
exit 1`;

const CUSTOM_INSTALL = `# Install script
$ErrorActionPreference = 'Stop'
$installerPath = "C:\\Temp\\MyAppSetup.exe"
if (-not (Test-Path $installerPath)) { throw "Installer not found: $installerPath" }
$process = Start-Process $installerPath -ArgumentList '/silent' -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) {
    throw "Installer failed with exit code $($process.ExitCode)."
}`;

const inp: React.CSSProperties = {
  width: '100%', background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6,
  color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none',
  boxSizing: 'border-box', fontFamily: 'inherit',
};

const UI = {
  lbl: { display: 'block' as const, fontSize: '0.75rem', fontWeight: 600, color: '#71717a', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 6 },
  sel: { ...inp, cursor: 'pointer' },
  addBt: { background: 'transparent', border: '1px dashed #3f3f46', borderRadius: 6, color: '#71717a', fontSize: '0.75rem', padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' },
  delBt: {
    background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 4,
    color: '#f87171', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 700,
    width: 28, height: 28, padding: 0, lineHeight: 1, flexShrink: 0,
  },
};

interface Props { mspSlug: string; tenants: Tenant[] }

export default function AppsClient({ mspSlug, tenants }: Props) {
  const [mainTab, setMainTab]       = useState<MainTab>('deploy');
  const [pkgMgr, setPkgMgr]         = useState<PkgManager>('chocolatey');
  const [searchQ, setSearchQ]       = useState('');
  const [searching, setSearching]   = useState(false);
  const [results, setResults]       = useState<Package[]>([]);
  const [searchErr, setSearchErr]   = useState('');
  const [selected, setSelected]     = useState<Package | null>(null);
  const [manageEntries, setManage]  = useState<AppEntry[]>([]);
  const [manageLoading, setMLoading]= useState(false);
  const [manageEntry, setMEntry]    = useState<AppEntry | null>(null);
  const [groupBy, setGroupBy]       = useState<GroupBy>('app');
  const [manageFilter, setMFilter]  = useState<PkgManager | 'all'>('all');

  const [version, setVersion]             = useState('');
  const [installArgs, setInstallArgs]     = useState('');
  const [uninstallArgs, setUninstallArgs] = useState('');
  const [deployMode, setDeployMode]       = useState<DeployMode>('baseline');
  const [selectedTenants, setSelectedTenants] = useState<string[]>([]);
  const [assignments, setAssignments]     = useState<AppAssignment[]>([]);
  const [availableForAllUsers, setAvailableForAllUsers] = useState(false);
  const [runAsAccount, setRunAsAccount] = useState<InstallRunAsAccount>('system');
  const [repoGroupNames, setRepoGroupNames] = useState<string[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [deploying, setDeploying]         = useState(false);
  const [deployMsg, setDeployMsg]         = useState<{ msg: string; type: 'success' | 'error' }>({ msg: '', type: 'success' });

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newGroupName, setNewGroupName]       = useState('');
  const [newGroupDesc, setNewGroupDesc]       = useState('');
  const [customName, setCustomName]       = useState('');
  const [customDisplay, setCustomDisplay] = useState('');
  const [customVersion, setCustomVer]       = useState('');
  const [customDetect, setCustomDetect]   = useState(CUSTOM_DETECT);
  const [customInstall, setCustomInstall] = useState(CUSTOM_INSTALL);
  const [customUninstall, setCustomUninstall] = useState('');
  const [intuneDisplayName, setIntuneDisplayName] = useState('');
  const [iconUpload, setIconUpload] = useState<AppIconUpload | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);

  const [manageAssignments, setManageAssignments] = useState<AppAssignment[]>([]);
  const [manageAvailableForAllUsers, setManageAvailableForAllUsers] = useState(false);
  const [manageRunAsAccount, setManageRunAsAccount] = useState<InstallRunAsAccount>('system');
  const [manageVersion, setManageVersion] = useState('');
  const [manageInstallArgs, setManageInstallArgs] = useState('');
  const [manageUninstallArgs, setManageUninstallArgs] = useState('');
  const [manageIntuneDisplayName, setManageIntuneDisplayName] = useState('');
  const [manageGroupNames, setManageGroupNames] = useState<string[]>([]);
  const [manageGroupsLoading, setManageGroupsLoading] = useState(false);
  const [manageSaving, setManageSaving] = useState(false);
  const [manageMsg, setManageMsg] = useState<{ msg: string; type: 'success' | 'error' }>({ msg: '', type: 'success' });
  const [groupModalForManage, setGroupModalForManage] = useState(false);
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [removeScope, setRemoveScope] = useState<'this' | 'all'>('this');
  const [removing, setRemoving] = useState(false);
  const [manageBanner, setManageBanner] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [manageIconUpload, setManageIconUpload] = useState<AppIconUpload | null>(null);
  const [manageIconPreview, setManageIconPreview] = useState<string | null>(null);
  const [manageIconClear, setManageIconClear] = useState(false);

  useEffect(() => { if (mainTab === 'manage') loadManage(); }, [mainTab, mspSlug]);

  useEffect(() => {
    let cancelled = false;
    async function loadGroups() {
      setGroupsLoading(true);
      try {
        const names = await fetchAssignmentGroupNames({
          scope: deployMode === 'baseline' ? 'baseline' : 'tenant',
          mspSlug,
          tenantSlugs: deployMode === 'tenants' ? selectedTenants : undefined,
        });
        if (!cancelled) setRepoGroupNames(names);
      } catch {
        if (!cancelled) setRepoGroupNames([]);
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    }
    loadGroups();
    return () => { cancelled = true; };
  }, [deployMode, selectedTenants, mspSlug]);

  useEffect(() => {
    if (!manageEntry) {
      setManageAssignments([]);
      setManageAvailableForAllUsers(false);
      setManageRunAsAccount('system');
      setManageVersion('');
      setManageInstallArgs('');
      setManageUninstallArgs('');
      setManageIntuneDisplayName('');
      setManageGroupNames([]);
      setManageIconUpload(null);
      setManageIconPreview(null);
      setManageIconClear(false);
      setManageMsg({ msg: '', type: 'success' });
      return;
    }
    setManageVersion(manageEntry.version ?? '');
    setManageInstallArgs(manageEntry.installArgs ?? '');
    setManageUninstallArgs(manageEntry.uninstallArgs ?? '');
    setManageIntuneDisplayName(manageEntry.intuneDisplayName ?? '');
    setManageAssignments((manageEntry.assignments ?? []).map(a => ({
      groupName: a.groupName,
      intent: a.intent ?? 'required',
      isNew: false,
    })));
    setManageAvailableForAllUsers(!!manageEntry.availableForAllUsers);
    setManageRunAsAccount(manageEntry.runAsAccount ?? 'system');
    setManageIconUpload(null);
    setManageIconClear(false);
    setManageMsg({ msg: '', type: 'success' });
  }, [manageEntry?.path, manageEntry?.target]);

  useEffect(() => {
    let cancelled = false;
    async function loadManageIcon() {
      if (!manageEntry) {
        setManageIconPreview(null);
        return;
      }
      const query = manageEntry.targetType === 'baseline'
        ? `scope=baseline&mspSlug=${mspSlug}`
        : `slug=${manageEntry.target}`;
      const names = manageEntry.iconFile
        ? [manageEntry.iconFile]
        : ['icon.png', 'icon.jpg'];
      for (const name of names) {
        const res = await fetch(
          `/api/git/file?path=${encodeURIComponent(`${manageEntry.path}/${name}`)}&${query}&binary=1`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.exists && data.contentBase64) {
          const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
          setManageIconPreview(`data:${mime};base64,${data.contentBase64}`);
          return;
        }
      }
      if (!cancelled) setManageIconPreview(null);
    }
    void loadManageIcon();
    return () => { cancelled = true; };
  }, [manageEntry?.path, manageEntry?.target, manageEntry?.iconFile, mspSlug]);

  useEffect(() => {
    let cancelled = false;
    async function loadManageGroups() {
      if (!manageEntry) return;
      setManageGroupsLoading(true);
      try {
        const names = manageEntry.targetType === 'baseline'
          ? await fetchBaselineGroupNames(mspSlug)
          : await fetchAssignmentGroupNames({ scope: 'tenant', mspSlug, tenantSlugs: [manageEntry.target] });
      } catch {
        if (!cancelled) setManageGroupNames([]);
      } finally {
        if (!cancelled) setManageGroupsLoading(false);
      }
    }
    loadManageGroups();
    return () => { cancelled = true; };
  }, [manageEntry?.path, manageEntry?.target, manageEntry?.targetType, mspSlug]);

  const availableGroups = useMemo(() => {
    const all = new Set<string>(repoGroupNames);
    assignments.forEach(a => { if (a.groupName) all.add(a.groupName); });
    return [...all].sort();
  }, [repoGroupNames, assignments]);

  const manageAvailableGroups = useMemo(() => {
    const all = new Set<string>(manageGroupNames);
    manageAssignments.forEach(a => { if (a.groupName) all.add(a.groupName); });
    return [...all].sort();
  }, [manageGroupNames, manageAssignments]);

  function entrySaveTarget(entry: AppEntry): SaveTarget {
    return entry.targetType === 'baseline'
      ? { scope: 'baseline' }
      : { scope: 'tenant', slug: entry.target };
  }

  async function runSearch() {
    if (!searchQ.trim() || searching) return;
    setSearching(true); setSearchErr(''); setResults([]);
    try {
      const res = await fetch(`/api/packages/search?q=${encodeURIComponent(searchQ)}&manager=${pkgMgr}`);
      const d   = await res.json();
      if (d.error && !d.packages?.length) { setSearchErr(d.error); return; }
      setResults(d.packages ?? []);
      if (!d.packages?.length) setSearchErr(`No packages found for "${searchQ}"`);
    } catch (e: unknown) { setSearchErr(e instanceof Error ? e.message : 'Search failed'); }
    finally { setSearching(false); }
  }

  async function loadAppsFromPath(
    mgr: PkgManager,
    treePath: string,
    scope: 'baseline' | 'tenant',
    targetLabel: string,
    fileParams: string,
  ): Promise<AppEntry[]> {
    const entries: AppEntry[] = [];
    const res = await fetch(`/api/git/tree?path=${encodeURIComponent(treePath)}&${fileParams}`);
    const d = await res.json();
    if (!Array.isArray(d)) return entries;
    for (const folder of d.filter((f: { type: string }) => f.type === 'dir')) {
      const cfgRes = await fetch(`/api/git/file?path=${encodeURIComponent(folder.path + '/config.json')}&${fileParams}`);
      const cfg = await cfgRes.json();
      if (!cfg.exists) continue;
      try {
        const p = JSON.parse(cfg.content);
        entries.push({
          pkgManager: mgr,
          packageId: folder.name,
          displayName: p.displayName ?? folder.name,
          intuneDisplayName: resolveIntuneDisplayName(mgr, p, folder.name),
          version: p.version ?? '',
          installArgs: p.installArgs,
          uninstallArgs: p.uninstallArgs,
          assignments: p.assignments ?? [],
          availableForAllUsers: !!p.availableForAllUsers,
          runAsAccount: p.runAsAccount === 'user' ? 'user' : 'system',
          iconFile: typeof p.iconFile === 'string' ? p.iconFile : undefined,
          target: targetLabel,
          targetType: scope,
          path: folder.path,
        });
      } catch { /* skip */ }
    }
    return entries;
  }

  async function loadManage() {
    setMLoading(true); setManage([]);
    try {
      const managers: PkgManager[] = ['chocolatey', 'winget', 'custom'];
      const entries: AppEntry[] = [];
      await Promise.all(managers.map(async mgr => {
        const baselinePath = `baseline/apps/${mgr}`;
        entries.push(...await loadAppsFromPath(mgr, baselinePath, 'baseline', 'baseline', `scope=baseline&mspSlug=${mspSlug}`));
        await Promise.all(tenants.map(async t => {
          const tenantPath = `apps/${mgr}`;
          entries.push(...await loadAppsFromPath(mgr, tenantPath, 'tenant', t.slug, `slug=${t.slug}`));
        }));
      }));
      setManage(entries.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch { /* silent */ }
    finally { setMLoading(false); }
  }

  function getSaveTargets(): SaveTarget[] {
    if (deployMode === 'baseline') return [{ scope: 'baseline' }];
    return selectedTenants.map(slug => ({ scope: 'tenant', slug }));
  }

  async function gitPutBinary(
    path: string,
    contentBase64: string,
    target: SaveTarget,
    message: string,
  ) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;
    const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}&binary=1`).then(r => r.json());
    const body: Record<string, unknown> = {
      path, content: contentBase64, encoding: 'base64', message,
      sha: ex.exists ? ex.sha : undefined,
      mspSlug,
    };
    if (target.scope === 'baseline') body.scope = 'baseline';
    else body.slug = target.slug;
    const res = await fetch('/api/git/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Failed to save ${path}`);
    }
  }

  async function syncAppIconToGit(
    folder: string,
    target: SaveTarget,
    packageId: string,
    opts: { upload: AppIconUpload | null; remove: boolean; previousIconFile?: string },
  ) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;

    const deleteIfExists = async (fileName: string) => {
      const path = `${folder}/${fileName}`;
      const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}`).then(r => r.json());
      if (ex.exists && ex.sha) {
        await gitDelete(path, ex.sha, target, `portal: remove icon ${packageId}`);
      }
    };

    if (opts.remove && opts.previousIconFile) {
      await deleteIfExists(opts.previousIconFile);
      return;
    }

    if (opts.upload) {
      if (opts.previousIconFile && opts.previousIconFile !== opts.upload.fileName) {
        await deleteIfExists(opts.previousIconFile);
      }
      await gitPutBinary(
        `${folder}/${opts.upload.fileName}`,
        opts.upload.contentBase64,
        target,
        `portal: icon ${packageId}`,
      );
    }
  }

  async function gitPut(
    path: string,
    content: string,
    target: SaveTarget,
    message: string,
  ) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;
    const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}`).then(r => r.json());
    const body: Record<string, unknown> = {
      path, content, message,
      sha: ex.exists ? ex.sha : undefined,
      mspSlug,
    };
    if (target.scope === 'baseline') body.scope = 'baseline';
    else body.slug = target.slug;
    const res = await fetch('/api/git/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Failed to save ${path}`);
    }
  }

  async function gitDelete(path: string, sha: string, target: SaveTarget, message: string) {
    const body: Record<string, unknown> = { path, sha, message, mspSlug };
    if (target.scope === 'baseline') body.scope = 'baseline';
    else body.slug = target.slug;
    const res = await fetch('/api/git/file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? `Failed to delete ${path}`);
    }
  }

  async function collectAppFolderFiles(entry: AppEntry): Promise<{ path: string; sha: string }[]> {
    const query = entry.targetType === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${entry.target}`;
    const files: { path: string; sha: string }[] = [];

    async function walk(dirPath: string) {
      const res = await fetch(`/api/git/tree?path=${encodeURIComponent(dirPath)}&${query}`);
      const items = await res.json();
      if (!Array.isArray(items)) return;
      for (const item of items as { type: string; path: string; sha?: string }[]) {
        if (item.type === 'file' && item.sha) files.push({ path: item.path, sha: item.sha });
        else if (item.type === 'dir') await walk(item.path);
      }
    }
    await walk(entry.path);
    return files;
  }

  async function removeAppFromGit(entry: AppEntry) {
    const target = entrySaveTarget(entry);
    const files = await collectAppFolderFiles(entry);
    if (!files.length) throw new Error('No app files found in Git');

    for (const file of files) {
      await gitDelete(file.path, file.sha, target, `portal: remove app ${entry.packageId}`);
    }

    if (entry.targetType === 'tenant') {
      const manifestPath = `pending-removes/intune/mobile-apps/${entry.packageId}.json`;
      const manifest = JSON.stringify({
        '@odata.type': '#microsoft.graph.win32LobApp',
        displayName: entry.intuneDisplayName,
        reason: 'Removed via Config365 portal',
      }, null, 2) + '\n';
      await gitPut(manifestPath, manifest, target, `portal: queue Intune removal ${entry.packageId}`);
    }
  }

  async function confirmRemoveApp() {
    const entry = manageEntry;
    if (!entry) return;
    setRemoving(true);
    try {
      const targets = removeScope === 'all'
        ? manageEntries.filter(e => e.packageId === entry.packageId && e.pkgManager === entry.pkgManager)
        : [entry];

      const errors: string[] = [];
      for (const t of targets) {
        try {
          await removeAppFromGit(t);
        } catch (e: unknown) {
          errors.push(`${t.target}: ${e instanceof Error ? e.message : 'failed'}`);
        }
      }

      if (errors.length === targets.length) {
        throw new Error(errors.join('; '));
      }

      setRemoveModalOpen(false);
      setMEntry(null);
      await loadManage();
      const ok = targets.length - errors.length;
      setManageBanner({
        msg: errors.length
          ? `Removed from ${ok} target(s). Failed: ${errors.join('; ')}`
          : `App removed from ${ok} target(s). Run deploy to delete from Intune.`,
        type: errors.length ? 'error' : 'success',
      });
    } catch (e: unknown) {
      setManageBanner({ msg: e instanceof Error ? e.message : 'Remove failed', type: 'error' });
    } finally {
      setRemoving(false);
    }
  }

  async function saveNewGroup(group: AppAssignment, target: SaveTarget) {
    const scope: GroupDeployScope = target.scope === 'baseline' ? 'baseline' : 'tenant';
    const paths = scope === 'baseline' ? baselineGroupPaths(group.groupName) : tenantGroupPaths(group.groupName);
    const mainJson = JSON.stringify(buildStaticSecurityGroup(group.groupName, group.description), null, 2) + '\n';
    const sidecarJson = JSON.stringify(buildGroupSidecar(scope), null, 2) + '\n';
    await gitPut(paths.main, mainJson, target, `portal: add group ${group.groupName}`);
    await gitPut(paths.sidecar, sidecarJson, target, `portal: add group sidecar ${group.groupName}`);
  }

  async function deployApp() {
    if (!selected && pkgMgr !== 'custom') return;
    const targets = getSaveTargets();
    if (deployMode === 'tenants' && targets.length === 0) {
      setDeployMsg({ msg: 'Select at least one tenant.', type: 'error' });
      return;
    }

    setDeploying(true); setDeployMsg({ msg: '', type: 'success' });
    try {
      const pkgId = pkgMgr === 'custom' ? customName : selected!.id;
      const dName = pkgMgr === 'custom' ? customDisplay : selected!.displayName;
      const ver   = (pkgMgr === 'custom' ? customVersion : version).trim();

      const configAssignments = assignments
        .filter(a => a.groupName.trim())
        .map(({ groupName, intent }) => ({ groupName: groupName.trim(), intent }));

      const configObj = applyAppConfigFields({}, {
        pkgManager: pkgMgr,
        packageId: pkgId,
        displayName: dName,
        version: ver,
        intuneDisplayName,
        installArgs,
        uninstallArgs,
        assignments: configAssignments,
        availableForAllUsers,
        runAsAccount,
        iconFile: iconUpload?.fileName,
      });
      const intuneName = (intuneDisplayName.trim() || defaultIntuneDisplayName(pkgMgr, dName));
      const config = JSON.stringify(configObj, null, 2) + '\n';

      const newGroups = assignments.filter(a => a.isNew && a.groupName.trim());
      const writtenGroups = new Set<string>();

      for (const target of targets) {
        const scope: GroupDeployScope = target.scope === 'baseline' ? 'baseline' : 'tenant';
        for (const group of newGroups) {
          const key = `${target.scope === 'baseline' ? 'b' : target.slug}:${group.groupName}`;
          if (writtenGroups.has(key)) continue;
          await saveNewGroup(group, target);
          writtenGroups.add(key);
        }

        const folder = appFolderPath(pkgMgr, pkgId, scope);
        await gitPut(`${folder}/config.json`, config, target, `portal: save app ${pkgId}`);
        if (iconUpload) {
          await syncAppIconToGit(folder, target, pkgId, { upload: iconUpload, remove: false });
        }

        if (pkgMgr === 'winget') {
          await gitPut(`${folder}/install.ps1`, buildWingetInstallScript(pkgId, { version: ver, extraArgs: installArgs, runAsAccount }), target, `portal: install script ${pkgId}`);
          await gitPut(`${folder}/uninstall.ps1`, buildWingetUninstallScript(pkgId, runAsAccount), target, `portal: uninstall script ${pkgId}`);
        } else if (pkgMgr === 'chocolatey') {
          await gitPut(`${folder}/install.ps1`, buildChocolateyInstallScript(pkgId, { version: ver, extraArgs: installArgs }), target, `portal: install script ${pkgId}`);
        } else {
          if (customDetect) await gitPut(`${folder}/detection.ps1`, customDetect, target, `portal: detection ${pkgId}`);
          if (customInstall) await gitPut(`${folder}/install.ps1`, customInstall, target, `portal: install ${pkgId}`);
          if (customUninstall) await gitPut(`${folder}/uninstall.ps1`, customUninstall, target, `portal: uninstall ${pkgId}`);
        }
      }

      setAssignments(prev => prev.map(a => ({ ...a, isNew: false })));
      if (newGroups.length) {
        setRepoGroupNames(prev => [...new Set([...prev, ...newGroups.map(g => g.groupName)])].sort());
      }

      const targetLabel = deployMode === 'baseline'
        ? 'baseline'
        : targets.map(t => t.scope === 'tenant' ? tenants.find(x => x.slug === t.slug)?.displayName ?? t.slug : '').join(', ');
      setDeployMsg({ msg: `"${intuneName}" saved to ${targetLabel}.`, type: 'success' });
      setIconUpload(null);
      setIconPreview(null);
      if (mainTab === 'manage') loadManage();
    } catch (e: unknown) {
      setDeployMsg({ msg: e instanceof Error ? e.message : 'Failed', type: 'error' });
    } finally {
      setDeploying(false);
    }
  }

  function selectPkg(pkg: Package) {
    setSelected(pkg);
    setIconUpload(null);
    setIconPreview(null);
    setVersion('');
    setInstallArgs('');
    setUninstallArgs('');
    setIntuneDisplayName(defaultIntuneDisplayName(pkgMgr, pkg.displayName));
    setAssignments([]);
    setDeployMsg({ msg: '', type: 'success' });
  }

  function confirmCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    if (groupModalForManage) {
      if (!manageAssignments.some(a => a.groupName === name)) {
        setManageAssignments(prev => [...prev, { groupName: name, intent: 'required', isNew: true, description: newGroupDesc.trim() || undefined }]);
      }
    } else {
      addAssignmentGroup(name, true, newGroupDesc.trim() || undefined);
    }
    setNewGroupName('');
    setNewGroupDesc('');
    setCreateModalOpen(false);
    setGroupModalForManage(false);
  }

  async function saveManageEntry() {
    const entry = manageEntry;
    if (!entry) return;
    setManageSaving(true);
    setManageMsg({ msg: '', type: 'success' });
    try {
      const target = entrySaveTarget(entry);
      const query = target.scope === 'baseline'
        ? `scope=baseline&mspSlug=${mspSlug}`
        : `slug=${target.slug}`;
      const cfgPath = `${entry.path}/config.json`;
      const cfgRes = await fetch(`/api/git/file?path=${encodeURIComponent(cfgPath)}&${query}`);
      const cfgFile = await cfgRes.json();
      if (!cfgFile.exists) throw new Error('config.json not found');

      const configAssignments = manageAssignments
        .filter(a => a.groupName.trim())
        .map(({ groupName, intent }) => ({ groupName: groupName.trim(), intent }));

      const existing = JSON.parse(cfgFile.content) as Record<string, unknown>;
      const displayName = (existing.displayName as string | undefined) ?? entry.displayName;
      const ver = manageVersion.trim();
      const instArgs = manageInstallArgs.trim();
      const previousIconFile = typeof existing.iconFile === 'string'
        ? existing.iconFile
        : entry.iconFile;
      const nextIconFile = manageIconClear
        ? undefined
        : (manageIconUpload?.fileName ?? previousIconFile);
      const updated = applyAppConfigFields(existing, {
        pkgManager: entry.pkgManager,
        packageId: entry.packageId,
        displayName,
        version: ver,
        intuneDisplayName: manageIntuneDisplayName,
        installArgs: instArgs,
        uninstallArgs: manageUninstallArgs,
        assignments: configAssignments,
        availableForAllUsers: manageAvailableForAllUsers,
        runAsAccount: manageRunAsAccount,
        iconFile: nextIconFile,
      });
      const config = JSON.stringify(updated, null, 2) + '\n';
      const resolvedIntuneName = resolveIntuneDisplayName(entry.pkgManager, updated, entry.packageId);

      const newGroups = manageAssignments.filter(a => a.isNew && a.groupName.trim());
      for (const group of newGroups) {
        await saveNewGroup(group, target);
      }

      await gitPut(cfgPath, config, target, `portal: update app ${entry.packageId}`);
      await syncAppIconToGit(entry.path, target, entry.packageId, {
        upload: manageIconUpload,
        remove: manageIconClear,
        previousIconFile,
      });

      if (entry.pkgManager === 'winget') {
        await gitPut(
          `${entry.path}/install.ps1`,
          buildWingetInstallScript(entry.packageId, { version: ver, extraArgs: instArgs, runAsAccount: manageRunAsAccount }),
          target,
          `portal: install script ${entry.packageId}`,
        );
        await gitPut(
          `${entry.path}/uninstall.ps1`,
          buildWingetUninstallScript(entry.packageId, manageRunAsAccount),
          target,
          `portal: uninstall script ${entry.packageId}`,
        );
      } else if (entry.pkgManager === 'chocolatey') {
        await gitPut(
          `${entry.path}/install.ps1`,
          buildChocolateyInstallScript(entry.packageId, { version: ver, extraArgs: instArgs }),
          target,
          `portal: install script ${entry.packageId}`,
        );
      }

      setManageAssignments(prev => prev.map(a => ({ ...a, isNew: false })));
      if (newGroups.length) {
        setManageGroupNames(prev => [...new Set([...prev, ...newGroups.map(g => g.groupName)])].sort());
      }

      setManageMsg({ msg: 'Changes saved. Run deploy to apply updates in Intune.', type: 'success' });
      setManageIconUpload(null);
      setManageIconClear(false);
      setMEntry(prev => (prev && prev.path === entry.path && prev.target === entry.target)
        ? {
          ...prev,
          iconFile: nextIconFile,
          version: ver,
          installArgs: instArgs || undefined,
          uninstallArgs: manageUninstallArgs.trim() || undefined,
          intuneDisplayName: resolvedIntuneName,
          availableForAllUsers: manageAvailableForAllUsers,
          runAsAccount: manageRunAsAccount,
        }
        : prev);
      await loadManage();
      setMEntry(prev => prev ? {
        ...prev,
        version: ver,
        installArgs: instArgs || undefined,
        uninstallArgs: manageUninstallArgs.trim() || undefined,
        intuneDisplayName: resolvedIntuneName,
        assignments: configAssignments,
        availableForAllUsers: manageAvailableForAllUsers,
        runAsAccount: manageRunAsAccount,
      } : null);
    } catch (e: unknown) {
      setManageMsg({ msg: e instanceof Error ? e.message : 'Failed to save', type: 'error' });
    } finally {
      setManageSaving(false);
    }
  }

  function addAssignmentGroup(groupName: string, isNew = false, description?: string) {
    const name = groupName.trim();
    if (!name || assignments.some(a => a.groupName === name)) return;
    setAssignments(prev => [...prev, { groupName: name, intent: 'required', isNew, description }]);
  }

  function renderDeployTarget() {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>Deploy target</label>
        <select
          value={deployMode}
          onChange={e => {
            const mode = e.target.value as DeployMode;
            setDeployMode(mode);
            if (mode === 'baseline') setSelectedTenants([]);
          }}
          style={UI.sel}
        >
          <option value="baseline">Baseline (all tenants)</option>
          <option value="tenants">Specific tenants</option>
        </select>
        {deployMode === 'tenants' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 6 }}>Select one or more tenants</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tenants.map(t => {
                const checked = selectedTenants.includes(t.slug);
                return (
                  <button key={t.slug} type="button"
                    onClick={() => setSelectedTenants(prev => checked ? prev.filter(s => s !== t.slug) : [...prev, t.slug])}
                    style={{
                      background: checked ? 'rgba(34,197,94,0.12)' : '#18181b',
                      border: `1px solid ${checked ? '#22c55e' : '#3f3f46'}`,
                      borderRadius: 6, color: checked ? '#22c55e' : '#a1a1aa',
                      fontSize: '0.8125rem', padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit',
                    }}>
                    {t.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderInstallContextOption(value: InstallRunAsAccount, onChange: (v: InstallRunAsAccount) => void) {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>Install context</label>
        <select value={value} onChange={e => onChange(e.target.value as InstallRunAsAccount)} style={UI.sel}>
          <option value="system">System (all users) — machine-wide install</option>
          <option value="user">User — per-user install for logged-on user</option>
        </select>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 6 }}>
          {value === 'system'
            ? 'Runs as SYSTEM in Intune. WinGet uses --scope machine.'
            : 'Runs as the logged-on user in Intune. WinGet uses --scope user.'}
        </div>
      </div>
    );
  }

  function renderCompanyPortalOption(checked: boolean, onChange: (value: boolean) => void) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={UI.lbl}>Company Portal</div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onChange(!checked)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!checked); } }}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
            padding: '10px 12px', background: '#0d0d0f', border: `1px solid ${checked ? '#3f6212' : '#27272a'}`,
            borderRadius: 6,
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={e => onChange(e.target.checked)}
            onClick={e => e.stopPropagation()}
            style={{
              marginTop: 2, flexShrink: 0, width: 'auto', padding: 0,
              border: 'none', background: 'transparent', accentColor: '#22c55e',
            }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '0.8125rem', color: '#d4d4d8', fontWeight: 600 }}>
              Available for enrolled devices
            </span>
            <span style={{ display: 'block', fontSize: '0.75rem', color: '#52525b', marginTop: 2, lineHeight: 1.45 }}>
              Included · All users — app appears in Company Portal for licensed users on enrolled devices.
            </span>
          </span>
        </div>
      </div>
    );
  }

  function renderAssignmentEditor(opts: {
    rows: AppAssignment[];
    setRows: React.Dispatch<React.SetStateAction<AppAssignment[]>>;
    groupOptions: string[];
    loading: boolean;
    hint: string;
    forManage?: boolean;
  }) {
    const { rows, setRows, groupOptions, loading, hint, forManage } = opts;
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>Assignment groups</label>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 8 }}>{hint}</div>

        <div style={{ background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
          {rows.length > 0 && (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 120px 36px', gap: 10,
              padding: '8px 12px', fontSize: '0.6875rem', fontWeight: 600, color: '#52525b',
              textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid #27272a',
            }}>
              <span>Group name</span><span>Intent</span><span />
            </div>
          )}
          {rows.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: '0.8125rem', color: '#52525b', fontStyle: 'italic' }}>
              No groups assigned — app will deploy without Intune assignments.
            </div>
          ) : rows.map((a, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 120px 36px', gap: 10, alignItems: 'center',
              padding: '8px 12px', borderBottom: i < rows.length - 1 ? '1px solid #1a1a1d' : undefined,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <GroupPicker
                  value={a.groupName}
                  options={groupOptions}
                  placeholder="Type to search groups…"
                  style={{ ...inp, flex: 1, background: 'transparent', border: '1px solid #3f3f46' }}
                  onChange={name => setRows(prev => prev.map((x, j) => j === i ? { ...x, groupName: name } : x))}
                />
                {a.isNew && (
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '2px 5px', borderRadius: 3, background: '#422006', color: '#fdba74', border: '1px solid #9a3412', whiteSpace: 'nowrap' }}>NEW</span>
                )}
              </div>
              <select
                value={a.intent}
                onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, intent: e.target.value as AssignmentIntent } : x))}
                style={{ ...inp, padding: '6px 8px', cursor: 'pointer' }}
              >
                <option value="required">Required</option>
                <option value="available">Available</option>
                <option value="exclude">Exclude</option>
              </select>
              <button type="button" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))} style={UI.delBt} title="Remove assignment">×</button>
            </div>
          ))}
          <div style={{ padding: '8px 12px', borderTop: rows.length ? '1px solid #27272a' : undefined, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setRows(prev => [...prev, { groupName: '', intent: 'required' }])} style={UI.addBt}>
              + Add group
            </button>
            <button type="button" onClick={() => { setGroupModalForManage(!!forManage); setCreateModalOpen(true); }}
              style={{ ...UI.addBt, borderStyle: 'solid', color: '#93c5fd', borderColor: '#3f3f46' }}>
              + Create new group
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderAssignmentGroups() {
    const groupsHint = groupsLoading
      ? 'Loading groups…'
      : deployMode === 'tenants'
        ? (selectedTenants.length === 0
          ? 'Select tenant(s) above to load groups from each tenant repo and Entra backup.'
          : 'Groups from tenant Git (groups/) and backed-up Entra security groups for the selected tenant(s).')
        : 'Select groups from Git — create new groups below if needed.';

    return renderAssignmentEditor({
      rows: assignments,
      setRows: setAssignments,
      groupOptions: availableGroups,
      loading: groupsLoading,
      hint: groupsHint,
    });
  }

  const filtered = manageEntries.filter(e => manageFilter === 'all' || e.pkgManager === manageFilter);

  const S = {
    panel: { display: 'flex', flexDirection: 'column' as const, background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden', minHeight: 0 } as React.CSSProperties,
    pHead: { padding: '14px 16px', borderBottom: '1px solid #27272a', fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
    pBody: { flex: 1, overflowY: 'auto' as const, padding: 16 } as React.CSSProperties,
  };

  function PkgToggle() {
    const btn = (mgr: PkgManager, label: string, activeColor: string, activeBg: string) => (
      <button key={mgr} onClick={() => {
          setPkgMgr(mgr); setSelected(null); setResults([]); setSearchErr('');
          setIntuneDisplayName('');
        }}
        style={{ background: pkgMgr === mgr ? activeBg : 'transparent', border: 'none', borderRadius: 4, color: pkgMgr === mgr ? activeColor : '#71717a', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', fontWeight: 600, padding: '4px 10px', transition: 'all 0.1s', whiteSpace: 'nowrap' }}>
        {label}
      </button>
    );
    return (
      <div style={{ display: 'flex', gap: 2, background: '#18181b', border: '1px solid #27272a', borderRadius: 6, padding: 2 }}>
        {btn('chocolatey', 'Chocolatey', '#d8b4fe', '#3b0764')}
        {btn('winget', 'WinGet', '#93c5fd', '#0c2044')}
        {btn('custom', 'Custom', '#86efac', '#052e16')}
      </div>
    );
  }

  function AppCard({ pkg }: { pkg: Package }) {
    const isSelected = selected?.id === pkg.id;
    return (
      <div onClick={() => selectPkg(pkg)} style={{ padding: 12, border: `1px solid ${isSelected ? '#22c55e' : '#27272a'}`, borderRadius: 6, marginBottom: 8, cursor: 'pointer', background: isSelected ? 'rgba(34,197,94,0.06)' : '#18181b', transition: 'border-color 0.12s, background 0.12s' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{pkgMgr === 'winget' ? '🪟' : '🍫'}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#f4f4f5', marginBottom: 2 }}>{pkg.displayName}</div>
            <div style={{ fontSize: '0.6875rem', color: '#71717a', fontFamily: 'monospace', marginBottom: 4 }}>{pkg.id}</div>
          </div>
        </div>
        {pkg.summary && <div style={{ fontSize: '0.75rem', color: '#a1a1aa', marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{pkg.summary}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <span style={{ fontSize: '0.625rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#27272a', color: '#a1a1aa' }}>v{pkg.version}</span>
          {pkg.publisher && <span style={{ fontSize: '0.625rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#1e293b', color: '#94a3b8', border: '1px solid #334155' }}>{pkg.publisher}</span>}
        </div>
      </div>
    );
  }

  function renderAppIconField(opts: {
    preview: string | null;
    onPick: (upload: AppIconUpload, previewUrl: string) => void;
    onClear: () => void;
    cleared: boolean;
    onError?: (msg: string) => void;
    error?: string;
  }) {
    const showPreview = opts.preview && !opts.cleared;
    return (
      <div className="form-group" style={{ margin: 0 }}>
        <label>Intune app icon <span style={{ color: '#71717a', fontWeight: 400 }}>(optional)</span></label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 8, border: '1px solid #27272a',
            background: '#18181b', overflow: 'hidden', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: '0.65rem',
          }}>
            {showPreview
              ? <img src={opts.preview!} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              : '—'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <input
              type="file"
              accept={APP_ICON_ACCEPT}
              style={{ ...inp, padding: '5px 8px', width: '100%' }}
              onChange={ev => {
                const file = ev.target.files?.[0];
                ev.target.value = '';
                if (!file) return;
                void readAppIconUpload(file).then(upload => {
                  opts.onPick(upload, `data:${file.type};base64,${upload.contentBase64}`);
                }).catch((e: unknown) => {
                  opts.onError?.(e instanceof Error ? e.message : 'Invalid icon');
                });
              }}
            />
            {showPreview && (
              <button type="button" onClick={opts.onClear}
                style={{ alignSelf: 'flex-start', background: 'transparent', border: '1px solid #3f3f46', borderRadius: 4, color: '#a1a1aa', fontSize: '0.72rem', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>
                Remove icon
              </button>
            )}
          </div>
        </div>
        <div className="form-hint">PNG or JPEG, max 512 KB. Shown in Intune and Company Portal after deploy.</div>
        {opts.error && <div style={{ fontSize: '0.75rem', color: '#f87171', marginTop: 4 }}>{opts.error}</div>}
      </div>
    );
  }

  function renderDeployFooter() {
    return (
      <div style={{ marginTop: 8 }}>
        {renderDeployTarget()}
        {renderInstallContextOption(runAsAccount, setRunAsAccount)}
        {renderAssignmentGroups()}
        {renderCompanyPortalOption(availableForAllUsers, setAvailableForAllUsers)}

        {deployMsg.msg && <div style={{ fontSize: '0.82rem', color: deployMsg.type === 'success' ? '#22c55e' : '#f87171', marginBottom: 10 }}>{deployMsg.msg}</div>}
        <button onClick={deployApp} disabled={deploying || (pkgMgr === 'custom' && (!customName || !customDisplay))}
          style={{ width: '100%', background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 700, padding: '10px 20px', cursor: deploying ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: deploying ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {deploying ? <><Spinner /> Saving…</> : '▶ Save App Config'}
        </button>
      </div>
    );
  }

  function ConfigPanel() {
    if (pkgMgr === 'custom') {
      return (
        <div style={S.pBody}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>App Name (slug) <span style={{ color: '#f87171' }}>*</span></label>
                <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="e.g. MyApp" />
                <div className="form-hint">Letters, digits, hyphens only</div>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Display Name <span style={{ color: '#f87171' }}>*</span></label>
                <input value={customDisplay} onChange={e => setCustomDisplay(e.target.value)} placeholder="e.g. My Custom App" />
              </div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Intune display name</label>
              <input
                value={intuneDisplayName}
                onChange={e => setIntuneDisplayName(e.target.value)}
                placeholder={defaultIntuneDisplayName('custom', customDisplay.trim() || customName.trim() || 'My App')}
              />
              <div className="form-hint">Name shown in Microsoft Intune. Defaults to Custom - display name.</div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Version <span style={{ color: '#71717a', fontWeight: 400 }}>(optional)</span></label>
              <input value={customVersion} onChange={e => setCustomVer(e.target.value)} placeholder="e.g. 1.0.0" />
            </div>
            {renderAppIconField({
              preview: iconPreview,
              cleared: false,
              onPick: (upload, previewUrl) => { setIconUpload(upload); setIconPreview(previewUrl); },
              onClear: () => { setIconUpload(null); setIconPreview(null); },
              onError: msg => setDeployMsg({ msg, type: 'error' }),
            })}
            <div className="form-group" style={{ margin: 0 }}>
              <label>Detection Script <span style={{ color: '#f87171' }}>*</span></label>
              <textarea value={customDetect} onChange={e => setCustomDetect(e.target.value)} rows={6} style={{ fontFamily: 'monospace', fontSize: '0.75rem', background: '#0a0a0b', color: '#86efac' }} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Install Script <span style={{ color: '#f87171' }}>*</span></label>
              <textarea value={customInstall} onChange={e => setCustomInstall(e.target.value)} rows={6} style={{ fontFamily: 'monospace', fontSize: '0.75rem', background: '#0a0a0b', color: '#86efac' }} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Uninstall Script <span style={{ color: '#71717a', fontWeight: 400 }}>(optional)</span></label>
              <textarea value={customUninstall} onChange={e => setCustomUninstall(e.target.value)} rows={4} style={{ fontFamily: 'monospace', fontSize: '0.75rem', background: '#0a0a0b', color: '#86efac' }} />
            </div>
            {renderDeployFooter()}
          </div>
        </div>
      );
    }

    if (!selected) {
      return (
        <div style={S.pBody}>
          <div style={{ textAlign: 'center', padding: '40px 16px', color: '#52525b', fontSize: '0.8125rem' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>←</div>
            Select a package from the search results to configure and deploy it.
          </div>
        </div>
      );
    }

    return (
      <div style={S.pBody}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingBottom: 14, borderBottom: '1px solid #27272a', marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, background: '#18181b', border: '1px solid #27272a', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '1.2rem' }}>{pkgMgr === 'winget' ? '🪟' : '🍫'}</div>
          <div>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#f4f4f5', margin: '0 0 2px' }}>{selected.displayName}</h2>
            <div style={{ fontSize: '0.75rem', color: '#71717a', fontFamily: 'monospace', marginBottom: 4 }}>{selected.id}</div>
            <div style={{ fontSize: '0.75rem', color: '#52525b' }}>v{selected.version}</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Version</label>
            <input value={version} onChange={e => setVersion(e.target.value)} placeholder={selected.version} />
            <div className="form-hint">Leave blank to use latest</div>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Intune display name</label>
            <input
              value={intuneDisplayName}
              onChange={e => setIntuneDisplayName(e.target.value)}
              placeholder={defaultIntuneDisplayName(pkgMgr, selected.displayName)}
            />
            <div className="form-hint">Name shown in Microsoft Intune. Defaults to {pkgMgr === 'winget' ? 'WinGet' : 'Chocolatey'} - package name.</div>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Install Arguments</label>
            <input value={installArgs} onChange={e => setInstallArgs(e.target.value)} placeholder="e.g. /quiet /norestart" />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Uninstall Arguments</label>
            <input value={uninstallArgs} onChange={e => setUninstallArgs(e.target.value)} placeholder="Optional" />
          </div>
          {renderAppIconField({
            preview: iconPreview,
            cleared: false,
            onPick: (upload, previewUrl) => { setIconUpload(upload); setIconPreview(previewUrl); },
            onClear: () => { setIconUpload(null); setIconPreview(null); },
            onError: msg => setDeployMsg({ msg, type: 'error' }),
          })}
          {selected.summary && (
            <div style={{ fontSize: '0.8rem', color: '#71717a', padding: '8px 10px', background: '#18181b', borderRadius: 6, lineHeight: 1.5 }}>{selected.summary}</div>
          )}
          {renderDeployFooter()}
        </div>
      </div>
    );
  }

  function ManageList() {
    if (manageLoading) return <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '32px 16px', color: '#52525b', fontSize: '0.875rem' }}><Spinner /> Loading…</div>;
    if (!filtered.length) return <div style={{ textAlign: 'center', padding: '32px 16px', color: '#52525b', fontSize: '0.8125rem' }}>No app configurations found.</div>;

    let groups: { label: string; entries: AppEntry[] }[];
    if (groupBy === 'app') {
      const map = new Map<string, AppEntry[]>();
      for (const e of filtered) {
        if (!map.has(e.packageId)) map.set(e.packageId, []);
        map.get(e.packageId)!.push(e);
      }
      groups = Array.from(map.entries()).map(([, v]) => ({ label: v[0].displayName, entries: v }));
    } else {
      const map = new Map<string, AppEntry[]>();
      for (const e of filtered) {
        if (!map.has(e.target)) map.set(e.target, []);
        map.get(e.target)!.push(e);
      }
      groups = Array.from(map.entries()).map(([k, v]) => ({
        label: k === 'baseline' ? '📦 Baseline' : tenants.find(t => t.slug === k)?.displayName ?? k,
        entries: v,
      }));
    }

    const mgBadge = (mgr: PkgManager) => ({
      chocolatey: { bg: '#3b0764', color: '#d8b4fe', border: '#6b21a8' },
      winget:     { bg: '#0c2044', color: '#93c5fd', border: '#1e40af' },
      custom:     { bg: '#052e16', color: '#86efac', border: '#166534' },
    }[mgr]);

    return (
      <div>
        {groups.map(g => (
          <div key={g.label} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '4px 0 6px', borderBottom: '1px solid #1e1e21', marginBottom: 6 }}>{g.label}</div>
            {g.entries.map(e => {
              const b = mgBadge(e.pkgManager);
              const isActive = manageEntry?.path === e.path && manageEntry?.target === e.target;
              return (
                <div key={e.path + e.target} onClick={() => setMEntry(isActive ? null : e)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: isActive ? 'rgba(34,197,94,0.08)' : 'transparent', fontSize: '0.8125rem' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.displayName}</div>
                    <div style={{ fontSize: '0.6875rem', color: '#52525b', fontFamily: 'monospace' }}>{e.packageId}</div>
                  </div>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: b.bg, color: b.color, border: `1px solid ${b.border}`, textTransform: 'uppercase' }}>{e.pkgManager === 'chocolatey' ? 'choco' : e.pkgManager}</span>
                  {e.availableForAllUsers && (
                    <span title="Available for enrolled devices — All users" style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: '#172554', color: '#93c5fd', border: '1px solid #1e3a8a' }}>Portal</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  function ManageDetail() {
    const e = manageEntry;
    if (!e) return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#52525b', fontSize: '0.8125rem', textAlign: 'center', padding: 32 }}>
        <div><div style={{ fontSize: '1.5rem', marginBottom: 8 }}>←</div>Select an app to view details.</div>
      </div>
    );
    const targetLabel = e.targetType === 'baseline'
      ? 'Baseline (all tenants)'
      : tenants.find(t => t.slug === e.target)?.displayName ?? e.target;
    return (
      <div style={{ ...S.pBody, display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#f4f4f5', marginBottom: 4 }}>{e.displayName}</div>
          <div style={{ fontSize: '0.75rem', color: '#71717a', fontFamily: 'monospace' }}>{e.packageId}</div>
          <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 4 }}>Target: {targetLabel}</div>
        </div>
        <div className="form-group">
          <label>Intune display name</label>
          <input
            value={manageIntuneDisplayName}
            onChange={ev => setManageIntuneDisplayName(ev.target.value)}
            placeholder={defaultIntuneDisplayName(e.pkgManager, e.displayName)}
          />
        </div>
        <div className="form-group">
          <label>Version</label>
          <input
            value={manageVersion}
            onChange={ev => setManageVersion(ev.target.value)}
            placeholder="Leave blank for latest"
          />
        </div>
        <div className="form-group">
          <label>Install Arguments</label>
          <input value={manageInstallArgs} onChange={ev => setManageInstallArgs(ev.target.value)} placeholder="Optional" />
        </div>
        <div className="form-group">
          <label>Uninstall Arguments</label>
          <input value={manageUninstallArgs} onChange={ev => setManageUninstallArgs(ev.target.value)} placeholder="Optional" />
        </div>
        {renderAppIconField({
          preview: manageIconPreview,
          cleared: manageIconClear,
          onPick: (upload, previewUrl) => {
            setManageIconUpload(upload);
            setManageIconPreview(previewUrl);
            setManageIconClear(false);
          },
          onClear: () => {
            setManageIconUpload(null);
            setManageIconPreview(null);
            setManageIconClear(true);
          },
          onError: msg => setManageMsg({ msg, type: 'error' }),
        })}
        {renderAssignmentEditor({
          rows: manageAssignments,
          setRows: setManageAssignments,
          groupOptions: manageAvailableGroups,
          loading: manageGroupsLoading,
          hint: manageGroupsLoading
            ? 'Loading groups…'
            : 'Edit version, arguments, or assignments below. Save to update Git config.',
          forManage: true,
        })}
        {renderInstallContextOption(manageRunAsAccount, setManageRunAsAccount)}
        {renderCompanyPortalOption(manageAvailableForAllUsers, setManageAvailableForAllUsers)}
        {manageMsg.msg && (
          <div style={{ fontSize: '0.82rem', color: manageMsg.type === 'success' ? '#22c55e' : '#f87171', marginBottom: 10 }}>
            {manageMsg.msg}
          </div>
        )}
        <button type="button" onClick={saveManageEntry} disabled={manageSaving}
          style={{ width: '100%', background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 700, padding: '10px 20px', cursor: manageSaving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: manageSaving ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
          {manageSaving ? <><Spinner /> Saving…</> : 'Save changes'}
        </button>
        <button type="button" onClick={() => { setRemoveScope('this'); setRemoveModalOpen(true); }} disabled={manageSaving || removing}
          style={{ width: '100%', background: 'transparent', color: '#f87171', border: '1px solid #7f1d1d', borderRadius: 6, fontSize: '0.875rem', fontWeight: 600, padding: '10px 20px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 }}>
          Remove app
        </button>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 8 }}>
          Removing assignments only updates group targeting. Use <strong style={{ color: '#71717a' }}>Remove app</strong> to delete the app config from Git and queue Intune deletion on deploy.
        </div>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #27272a' }}>
          <div>Path: <code style={{ fontSize: '0.72rem', color: '#71717a' }}>{e.path}</code></div>
        </div>
      </div>
    );
  }

  const radioInp: React.CSSProperties = {
    marginTop: 3, width: 'auto', flexShrink: 0, padding: 0,
    border: 'none', background: 'transparent', accentColor: '#22c55e',
  };
  const radioLbl: React.CSSProperties = {
    display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
    fontSize: '0.8125rem', color: '#a1a1aa', marginBottom: 0, fontWeight: 400,
  };

  function RemoveAppModal() {
    if (!removeModalOpen || !manageEntry) return null;
    const siblings = manageEntries.filter(
      x => x.packageId === manageEntry.packageId && x.pkgManager === manageEntry.pkgManager,
    );
    const targetLabel = manageEntry.targetType === 'baseline'
      ? 'baseline'
      : tenants.find(t => t.slug === manageEntry.target)?.displayName ?? manageEntry.target;
    const hasTenantTarget = removeScope === 'this'
      ? manageEntry.targetType === 'tenant'
      : siblings.some(s => s.targetType === 'tenant');

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }} onClick={() => !removing && setRemoveModalOpen(false)}>
        <div style={{
          background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10,
          padding: 24, width: '100%', maxWidth: 480,
        }} onClick={ev => ev.stopPropagation()}>
          <h3 style={{ margin: '0 0 8px', fontSize: '1rem', color: '#f4f4f5' }}>Remove app</h3>
          <p style={{ margin: '0 0 16px', fontSize: '0.8125rem', color: '#71717a' }}>
            Delete <strong style={{ color: '#d4d4d8' }}>{manageEntry.displayName}</strong> ({manageEntry.packageId}) from Git.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            <label style={radioLbl}>
              <input type="radio" name="remove-scope" checked={removeScope === 'this'} onChange={() => setRemoveScope('this')} style={radioInp} />
              <span>
                <strong style={{ color: '#e4e4e7' }}>This target only</strong><br />
                <span style={{ color: '#71717a' }}>{targetLabel}</span>
              </span>
            </label>
            {siblings.length > 1 && (
              <label style={radioLbl}>
                <input type="radio" name="remove-scope" checked={removeScope === 'all'} onChange={() => setRemoveScope('all')} style={radioInp} />
                <span>
                  <strong style={{ color: '#e4e4e7' }}>All deployed targets</strong><br />
                  <span style={{ color: '#71717a' }}>{siblings.length} targets: {siblings.map(s => s.target).join(', ')}</span>
                </span>
              </label>
            )}
          </div>
          {hasTenantTarget && (
            <p style={{ margin: '0 0 16px', fontSize: '0.8125rem', color: '#71717a', padding: '8px 10px', background: '#0d0d0f', borderRadius: 6, border: '1px solid #27272a' }}>
              Tenant targets will queue an Intune removal manifest. The app is deleted from Intune when the deploy pipeline runs.
            </p>
          )}
          {manageEntry.targetType === 'baseline' && removeScope === 'this' && (
            <p style={{ margin: '0 0 16px', fontSize: '0.8125rem', color: '#fcd34d', padding: '8px 10px', background: '#1c1008', borderRadius: 6, border: '1px solid #92400e' }}>
              Baseline removal stops central management but does not automatically remove the app from tenant Intune environments.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setRemoveModalOpen(false)} disabled={removing}
              style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
            <button type="button" onClick={confirmRemoveApp} disabled={removing}
              style={{ background: '#dc2626', border: 'none', borderRadius: 6, color: '#fff', fontWeight: 600, padding: '8px 16px', cursor: removing ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: removing ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 8 }}>
              {removing ? <><Spinner small /> Removing…</> : 'Remove app'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function CreateGroupModal() {
    if (!createModalOpen) return null;
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }} onClick={() => { setCreateModalOpen(false); setGroupModalForManage(false); }}>
        <div style={{
          background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10,
          padding: 24, width: '100%', maxWidth: 420,
        }} onClick={ev => ev.stopPropagation()}>
          <h3 style={{ margin: '0 0 4px', fontSize: '1rem', color: '#f4f4f5' }}>Create security group</h3>
          <p style={{ margin: '0 0 16px', fontSize: '0.8125rem', color: '#71717a' }}>
            {groupModalForManage
              ? (manageEntry?.targetType === 'baseline'
                ? 'Group will be added to baseline and deployed to all tenants.'
                : 'Group will be created in this tenant repo (deployIfNotExists).')
              : (deployMode === 'baseline'
                ? 'Group will be added to baseline and deployed to all tenants.'
                : 'Group will be created once per selected tenant (deployIfNotExists).')}
          </p>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Display name <span style={{ color: '#f87171' }}>*</span></label>
            <input value={newGroupName} onChange={ev => setNewGroupName(ev.target.value)} placeholder="e.g. Claude - Pilot" autoFocus />
          </div>
          <div className="form-group" style={{ marginBottom: 20 }}>
            <label>Description <span style={{ color: '#71717a', fontWeight: 400 }}>(optional)</span></label>
            <input value={newGroupDesc} onChange={ev => setNewGroupDesc(ev.target.value)} placeholder="Optional description" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setCreateModalOpen(false)}
              style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, color: '#a1a1aa', padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit' }}>
              Cancel
            </button>
            <button type="button" onClick={confirmCreateGroup} disabled={!newGroupName.trim()}
              style={{ background: '#22c55e', border: 'none', borderRadius: 6, color: '#000', fontWeight: 600, padding: '8px 16px', cursor: 'pointer', fontFamily: 'inherit', opacity: newGroupName.trim() ? 1 : 0.5 }}>
              Add group
            </button>
          </div>
        </div>
      </div>
    );
  }

  const height = 'calc(100vh - 52px - 200px)';

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      {CreateGroupModal()}
      {RemoveAppModal()}

      {mainTab === 'manage' && manageBanner && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 6, fontSize: '0.8125rem',
          color: manageBanner.type === 'success' ? '#22c55e' : '#f87171',
          background: manageBanner.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${manageBanner.type === 'success' ? '#166534' : '#7f1d1d'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>{manageBanner.msg}</span>
          <button type="button" onClick={() => setManageBanner(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '1rem', padding: 0 }}>
            ×
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
        {(['deploy', 'manage'] as MainTab[]).map(t => (
          <button key={t} onClick={() => setMainTab(t)}
            style={{ fontSize: '0.8125rem', fontWeight: 600, padding: '7px 18px', borderRadius: 6, border: '1px solid', borderColor: mainTab === t ? '#22c55e' : '#3f3f46', color: mainTab === t ? '#22c55e' : '#71717a', background: mainTab === t ? 'rgba(34,197,94,0.12)' : 'transparent', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s' }}>
            {t === 'deploy' ? 'Deploy' : 'Manage Apps'}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {PkgToggle()}
      </div>

      {mainTab === 'deploy' && (
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, height }}>
          <div style={S.panel}>
            <div style={S.pHead}>
              {pkgMgr === 'custom' ? '🔧 Custom App Config' : pkgMgr === 'winget' ? '🪟 WinGet Search' : '🍫 Chocolatey Search'}
            </div>
            {pkgMgr === 'custom' ? (
              <div style={S.pBody}>
                <div style={{ color: '#71717a', fontSize: '0.8rem', marginBottom: 12 }}>Fill in the details on the right panel to create a custom Win32 app configuration.</div>
              </div>
            ) : (
              <div style={S.pBody}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input value={searchQ} onChange={ev => setSearchQ(ev.target.value)} onKeyDown={ev => { if (ev.key === 'Enter') runSearch(); }}
                    placeholder="Search packages…" style={{ flex: 1, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 6, color: '#d4d4d8', fontSize: '0.8125rem', padding: '7px 10px', outline: 'none', fontFamily: 'inherit' }} />
                  <button onClick={runSearch} disabled={searching}
                    style={{ background: '#22c55e', color: '#000', border: 'none', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 600, padding: '7px 14px', cursor: searching ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, opacity: searching ? 0.7 : 1 }}>
                    {searching ? <><Spinner small /> Searching…</> : 'Search'}
                  </button>
                </div>
                {searchErr && <div style={{ textAlign: 'center', padding: '20px 8px', color: '#f87171', fontSize: '0.8125rem' }}>{searchErr}</div>}
                {!searchErr && !results.length && !searching && (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: '#52525b', fontSize: '0.8125rem' }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>📦</div>
                    {pkgMgr === 'winget' ? 'Search WinGet packages to deploy.' : 'Search the Chocolatey community to find packages to deploy.'}
                  </div>
                )}
                {results.map(pkg => (
                  <Fragment key={pkg.id}>{AppCard({ pkg })}</Fragment>
                ))}
              </div>
            )}
          </div>

          <div style={S.panel}>
            <div style={S.pHead}>⚙ Configuration</div>
            {ConfigPanel()}
          </div>
        </div>
      )}

      {mainTab === 'manage' && (
        <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 20, height }}>
          <div style={S.panel}>
            <div style={{ ...S.pHead, flexWrap: 'wrap', gap: 6 }}>
              <span>Deployed Apps</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['app', 'target'] as GroupBy[]).map(g => (
                  <button key={g} onClick={() => setGroupBy(g)}
                    style={{ fontSize: '0.6875rem', fontWeight: 500, padding: '3px 8px', borderRadius: 4, border: '1px solid', borderColor: groupBy === g ? '#22c55e' : '#3f3f46', color: groupBy === g ? '#22c55e' : '#71717a', background: groupBy === g ? 'rgba(34,197,94,0.12)' : 'transparent', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s' }}>
                    {g === 'app' ? 'By App' : 'By Target'}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 2, background: '#18181b', border: '1px solid #27272a', borderRadius: 6, padding: 2 }}>
                {(['all', 'chocolatey', 'winget', 'custom'] as const).map(f => {
                  const labels = { all: 'All', chocolatey: 'Choco', winget: 'WinGet', custom: 'Custom' };
                  return (
                    <button key={f} onClick={() => setMFilter(f)}
                      style={{ background: manageFilter === f ? '#27272a' : 'transparent', border: 'none', borderRadius: 4, color: manageFilter === f ? '#e4e4e7' : '#71717a', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.6875rem', fontWeight: 500, padding: '3px 8px', transition: 'all 0.1s' }}>
                      {labels[f]}
                    </button>
                  );
                })}
              </div>
              <button onClick={loadManage} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #3f3f46', borderRadius: 4, color: '#71717a', fontSize: '0.6875rem', padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>↺</button>
            </div>
            <div style={{ ...S.pBody, padding: '8px 0' }}>
              {ManageList()}
            </div>
          </div>

          <div style={S.panel}>
            <div style={S.pHead}>App Details</div>
            {ManageDetail()}
          </div>
        </div>
      )}
    </div>
  );
}
