'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Tenant } from '@/lib/server/tenant-store';
import { GroupPicker } from '@/components/GroupPicker';
import { defaultIntuneDisplayName, defaultPrinterSplitIntuneDisplayName, resolveIntuneDisplayName } from '@/lib/app-intune-display-name';
import {
  buildPrinterConnectInstallScript,
  buildPrinterDetectionScript,
  buildPrinterDriverConnectDetectionScript,
  buildPrinterDriverConnectInstallScript,
  buildPrinterDriverConnectUninstallScript,
  buildPrinterDriverDetectionScript,
  buildPrinterDriverInstallScript,
  buildPrinterDriverUninstallScript,
  buildPrinterInstallScript,
  buildPrinterUninstallScript,
  DEFAULT_DRIVER_INSTALL_SCRIPT,
} from '@/lib/printer-scripts';
import {
  type AppAssignment,
  type AssignmentIntent,
  type CustomScriptMode,
  type DriverDeployMode,
  type GroupDeployScope,
  type InstallRunAsAccount,
  type PrinterPathEntry,
  appFolderPath,
  baselineGroupPaths,
  buildGroupSidecar,
  buildStaticSecurityGroup,
  fetchAssignmentGroupNames,
  fetchBaselineGroupNames,
  tenantGroupPaths,
} from '@/lib/group-definitions';

type MainTab = 'deploy' | 'manage';
type DeployMode = 'baseline' | 'tenants';
type SaveTarget = { scope: 'baseline' } | { scope: 'tenant'; slug: string };

interface StagedAttachment { fileName: string; base64: string }

interface PrinterEntry {
  packageId: string;
  displayName: string;
  intuneDisplayName: string;
  splitDeploy?: boolean;
  driverDeployMode?: DriverDeployMode;
  printers: PrinterPathEntry[];
  customScript?: string;
  customScriptMode?: CustomScriptMode;
  customDetectionScript?: string;
  driverCustomScript?: string;
  driverCustomScriptMode?: CustomScriptMode;
  driverCustomDetectionScript?: string;
  connectCustomScript?: string;
  connectCustomScriptMode?: CustomScriptMode;
  connectCustomDetectionScript?: string;
  assignments?: AppAssignment[];
  availableForAllUsers?: boolean;
  runAsAccount?: InstallRunAsAccount;
  target: string;
  targetType: 'baseline' | 'tenant';
  path: string;
}

interface Props { mspSlug: string; tenants: Tenant[] }

const DEFAULT_CUSTOM_SCRIPT = `# Optional configuration script
# Attachments are available at $PSScriptRoot\\
# Example: pnputil /add-driver "$PSScriptRoot\\driver.inf" /install
`;

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

function Spinner({ small }: { small?: boolean }) {
  const s = small ? 10 : 12;
  return <span style={{ display: 'inline-block', width: s, height: s, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: 'currentColor', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />;
}

function safePackageId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function readFileAsBase64(file: File): Promise<StagedAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1]! : result;
      resolve({ fileName: file.name, base64 });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function PrintersClient({ mspSlug, tenants }: Props) {
  const [mainTab, setMainTab] = useState<MainTab>('deploy');
  const [manageEntries, setManageEntries] = useState<PrinterEntry[]>([]);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageEntry, setManageEntry] = useState<PrinterEntry | null>(null);

  const [packageId, setPackageId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [intuneDisplayName, setIntuneDisplayName] = useState('');
  const [printers, setPrinters] = useState<PrinterPathEntry[]>([{ path: '' }]);
  const [customScript, setCustomScript] = useState('');
  const [customScriptMode, setCustomScriptMode] = useState<CustomScriptMode>('none');
  const [customDetectionScript, setCustomDetectionScript] = useState('');
  const [showCustomDetection, setShowCustomDetection] = useState(false);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [splitDeploy, setSplitDeploy] = useState(false);
  const [driverDeployMode, setDriverDeployMode] = useState<DriverDeployMode>('package');
  const [driverCustomScript, setDriverCustomScript] = useState(DEFAULT_DRIVER_INSTALL_SCRIPT);
  const [driverCustomScriptMode, setDriverCustomScriptMode] = useState<CustomScriptMode>('only');
  const [driverCustomDetectionScript, setDriverCustomDetectionScript] = useState('');
  const [showDriverCustomDetection, setShowDriverCustomDetection] = useState(false);
  const [connectCustomScript, setConnectCustomScript] = useState('');
  const [connectCustomScriptMode, setConnectCustomScriptMode] = useState<CustomScriptMode>('none');
  const [connectCustomDetectionScript, setConnectCustomDetectionScript] = useState('');
  const [showConnectCustomDetection, setShowConnectCustomDetection] = useState(false);

  const [deployMode, setDeployMode] = useState<DeployMode>('baseline');
  const [selectedTenants, setSelectedTenants] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<AppAssignment[]>([]);
  const [availableForAllUsers, setAvailableForAllUsers] = useState(false);
  const [runAsAccount, setRunAsAccount] = useState<InstallRunAsAccount>('user');
  const [repoGroupNames, setRepoGroupNames] = useState<string[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ msg: string; type: 'success' | 'error' }>({ msg: '', type: 'success' });

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [groupModalForManage, setGroupModalForManage] = useState(false);

  const [manageAssignments, setManageAssignments] = useState<AppAssignment[]>([]);
  const [manageAvailableForAllUsers, setManageAvailableForAllUsers] = useState(false);
  const [manageRunAsAccount, setManageRunAsAccount] = useState<InstallRunAsAccount>('user');
  const [managePrinters, setManagePrinters] = useState<PrinterPathEntry[]>([]);
  const [manageCustomScript, setManageCustomScript] = useState('');
  const [manageCustomScriptMode, setManageCustomScriptMode] = useState<CustomScriptMode>('none');
  const [manageCustomDetectionScript, setManageCustomDetectionScript] = useState('');
  const [manageShowCustomDetection, setManageShowCustomDetection] = useState(false);
  const [manageSplitDeploy, setManageSplitDeploy] = useState(false);
  const [manageDriverDeployMode, setManageDriverDeployMode] = useState<DriverDeployMode>('package');
  const [manageDriverCustomScript, setManageDriverCustomScript] = useState(DEFAULT_DRIVER_INSTALL_SCRIPT);
  const [manageDriverCustomScriptMode, setManageDriverCustomScriptMode] = useState<CustomScriptMode>('only');
  const [manageDriverCustomDetectionScript, setManageDriverCustomDetectionScript] = useState('');
  const [manageShowDriverCustomDetection, setManageShowDriverCustomDetection] = useState(false);
  const [manageConnectCustomScript, setManageConnectCustomScript] = useState('');
  const [manageConnectCustomScriptMode, setManageConnectCustomScriptMode] = useState<CustomScriptMode>('none');
  const [manageConnectCustomDetectionScript, setManageConnectCustomDetectionScript] = useState('');
  const [manageShowConnectCustomDetection, setManageShowConnectCustomDetection] = useState(false);
  const [manageStagedAttachments, setManageStagedAttachments] = useState<StagedAttachment[]>([]);
  const [manageExistingAttachments, setManageExistingAttachments] = useState<string[]>([]);
  const [manageGroupNames, setManageGroupNames] = useState<string[]>([]);
  const [manageGroupsLoading, setManageGroupsLoading] = useState(false);
  const [manageSaving, setManageSaving] = useState(false);
  const [manageMsg, setManageMsg] = useState<{ msg: string; type: 'success' | 'error' }>({ msg: '', type: 'success' });
  const [removeModalOpen, setRemoveModalOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [manageBanner, setManageBanner] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const loadManage = useCallback(async () => {
    setManageLoading(true);
    setManageEntries([]);
    try {
      const entries: PrinterEntry[] = [];
      const loadFromPath = async (
        treePath: string,
        scope: 'baseline' | 'tenant',
        targetLabel: string,
        fileParams: string,
      ) => {
        const res = await fetch(`/api/git/tree?path=${encodeURIComponent(treePath)}&${fileParams}`);
        const d = await res.json();
        if (!Array.isArray(d)) return;
        for (const folder of d.filter((f: { type: string }) => f.type === 'dir')) {
          const cfgRes = await fetch(`/api/git/file?path=${encodeURIComponent(`${folder.path}/config.json`)}&${fileParams}`);
          const cfg = await cfgRes.json();
          if (!cfg.exists) continue;
          try {
            const p = JSON.parse(cfg.content);
            entries.push({
              packageId: folder.name,
              displayName: p.displayName ?? folder.name,
              intuneDisplayName: resolveIntuneDisplayName('printer', p, folder.name),
              splitDeploy: !!p.splitDeploy,
              driverDeployMode: p.driverDeployMode === 'connect' ? 'connect' : 'package',
              printers: p.printers ?? [],
              customScript: p.customScript,
              customScriptMode: p.customScriptMode ?? 'none',
              customDetectionScript: p.customDetectionScript,
              driverCustomScript: p.driverCustomScript,
              driverCustomScriptMode: p.driverCustomScriptMode ?? 'only',
              driverCustomDetectionScript: p.driverCustomDetectionScript,
              connectCustomScript: p.connectCustomScript,
              connectCustomScriptMode: p.connectCustomScriptMode ?? 'none',
              connectCustomDetectionScript: p.connectCustomDetectionScript,
              assignments: p.assignments ?? [],
              availableForAllUsers: !!p.availableForAllUsers,
              runAsAccount: p.runAsAccount === 'system' ? 'system' : 'user',
              target: targetLabel,
              targetType: scope,
              path: folder.path,
            });
          } catch { /* skip */ }
        }
      };

      await loadFromPath('baseline/apps/printer', 'baseline', 'baseline', `scope=baseline&mspSlug=${mspSlug}`);
      await Promise.all(tenants.map(t =>
        loadFromPath('apps/printer', 'tenant', t.slug, `slug=${t.slug}`),
      ));
      setManageEntries(entries.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch { /* silent */ }
    finally { setManageLoading(false); }
  }, [mspSlug, tenants]);

  useEffect(() => { if (mainTab === 'manage') void loadManage(); }, [mainTab, loadManage]);

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
    void loadGroups();
    return () => { cancelled = true; };
  }, [deployMode, selectedTenants, mspSlug]);

  useEffect(() => {
    if (!manageEntry) {
      setManageAssignments([]);
      setManageAvailableForAllUsers(false);
      setManageRunAsAccount('user');
      setManagePrinters([]);
      setManageCustomScript('');
      setManageCustomScriptMode('none');
      setManageCustomDetectionScript('');
      setManageShowCustomDetection(false);
      setManageSplitDeploy(false);
      setManageDriverDeployMode('package');
      setManageDriverCustomScript(DEFAULT_DRIVER_INSTALL_SCRIPT);
      setManageDriverCustomScriptMode('only');
      setManageDriverCustomDetectionScript('');
      setManageShowDriverCustomDetection(false);
      setManageConnectCustomScript('');
      setManageConnectCustomScriptMode('none');
      setManageConnectCustomDetectionScript('');
      setManageShowConnectCustomDetection(false);
      setManageStagedAttachments([]);
      setManageExistingAttachments([]);
      setManageMsg({ msg: '', type: 'success' });
      return;
    }
    setManageAssignments((manageEntry.assignments ?? []).map(a => ({
      groupName: a.groupName,
      intent: a.intent ?? 'required',
      isNew: false,
    })));
    setManageAvailableForAllUsers(!!manageEntry.availableForAllUsers);
    setManageRunAsAccount(manageEntry.runAsAccount ?? 'user');
    setManageSplitDeploy(!!manageEntry.splitDeploy);
    const loadedDriverMode: DriverDeployMode = manageEntry.driverDeployMode === 'connect' ? 'connect' : 'package';
    setManageDriverDeployMode(loadedDriverMode);
    setManagePrinters(manageEntry.printers.length ? manageEntry.printers : [{ path: '' }]);
    setManageCustomScript(manageEntry.customScript ?? '');
    setManageCustomScriptMode(manageEntry.customScriptMode ?? 'none');
    setManageCustomDetectionScript(manageEntry.customDetectionScript ?? '');
    setManageShowCustomDetection(!!manageEntry.customDetectionScript?.trim());
    if (loadedDriverMode === 'connect') {
      setManageDriverCustomScript(manageEntry.driverCustomScript ?? '');
      setManageDriverCustomScriptMode(manageEntry.driverCustomScriptMode ?? 'none');
    } else {
      setManageDriverCustomScript(manageEntry.driverCustomScript ?? DEFAULT_DRIVER_INSTALL_SCRIPT);
      setManageDriverCustomScriptMode(manageEntry.driverCustomScriptMode ?? 'only');
    }
    setManageDriverCustomDetectionScript(manageEntry.driverCustomDetectionScript ?? '');
    setManageShowDriverCustomDetection(!!manageEntry.driverCustomDetectionScript?.trim());
    setManageConnectCustomScript(manageEntry.connectCustomScript ?? '');
    setManageConnectCustomScriptMode(manageEntry.connectCustomScriptMode ?? 'none');
    setManageConnectCustomDetectionScript(manageEntry.connectCustomDetectionScript ?? '');
    setManageShowConnectCustomDetection(!!manageEntry.connectCustomDetectionScript?.trim());
    setManageStagedAttachments([]);
    setManageMsg({ msg: '', type: 'success' });
  }, [manageEntry?.path, manageEntry?.target]);

  useEffect(() => {
    let cancelled = false;
    async function loadManageExtras() {
      if (!manageEntry) return;
      const query = manageEntry.targetType === 'baseline'
        ? `scope=baseline&mspSlug=${mspSlug}`
        : `slug=${manageEntry.target}`;
      setManageGroupsLoading(true);
      try {
        const names = manageEntry.targetType === 'baseline'
          ? await fetchBaselineGroupNames(mspSlug)
          : await fetchAssignmentGroupNames({ scope: 'tenant', mspSlug, tenantSlugs: [manageEntry.target] });
        if (!cancelled) setManageGroupNames(names);

        const attachPath = manageEntry.splitDeploy
          ? `${manageEntry.path}/driver/attachments`
          : `${manageEntry.path}/attachments`;
        const treeRes = await fetch(`/api/git/tree?path=${encodeURIComponent(attachPath)}&${query}`);
        const tree = await treeRes.json();
        if (!cancelled && Array.isArray(tree)) {
          setManageExistingAttachments(
            tree.filter((f: { type: string; name: string }) => f.type === 'file').map((f: { name: string }) => f.name),
          );
        }
      } catch {
        if (!cancelled) {
          setManageGroupNames([]);
          setManageExistingAttachments([]);
        }
      } finally {
        if (!cancelled) setManageGroupsLoading(false);
      }
    }
    void loadManageExtras();
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

  function getSaveTargets(): SaveTarget[] {
    if (deployMode === 'baseline') return [{ scope: 'baseline' }];
    return selectedTenants.map(slug => ({ scope: 'tenant', slug }));
  }

  function entrySaveTarget(entry: PrinterEntry): SaveTarget {
    return entry.targetType === 'baseline'
      ? { scope: 'baseline' }
      : { scope: 'tenant', slug: entry.target };
  }

  async function gitPut(path: string, content: string, target: SaveTarget, message: string) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;
    const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}`).then(r => r.json());
    const body: Record<string, unknown> = {
      path, content, message, sha: ex.exists ? ex.sha : undefined, mspSlug,
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

  async function gitPutBinary(path: string, contentBase64: string, target: SaveTarget, message: string) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;
    const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}&binary=1`).then(r => r.json());
    const body: Record<string, unknown> = {
      path, content: contentBase64, encoding: 'base64', message,
      sha: ex.exists ? ex.sha : undefined, mspSlug,
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

  async function deleteGitTree(treePath: string, target: SaveTarget, message: string) {
    const query = target.scope === 'baseline'
      ? `scope=baseline&mspSlug=${mspSlug}`
      : `slug=${target.slug}`;
    const res = await fetch(`/api/git/tree?path=${encodeURIComponent(treePath)}&${query}`);
    const items = await res.json();
    if (!Array.isArray(items)) return;
    for (const item of items as { type: string; path: string; sha?: string }[]) {
      if (item.type === 'dir') {
        await deleteGitTree(item.path, target, message);
      } else if (item.type === 'file' && item.sha) {
        await gitDelete(item.path, item.sha, target, message);
      }
    }
  }

  async function cleanupPrinterPackageLayout(folder: string, split: boolean, target: SaveTarget, pkgId: string) {
    if (split) {
      for (const rel of ['install.ps1', 'detection.ps1', 'uninstall.ps1']) {
        const path = `${folder}/${rel}`;
        const query = target.scope === 'baseline'
          ? `scope=baseline&mspSlug=${mspSlug}`
          : `slug=${target.slug}`;
        const ex = await fetch(`/api/git/file?path=${encodeURIComponent(path)}&${query}`).then(r => r.json());
        if (ex.exists && ex.sha) {
          await gitDelete(path, ex.sha, target, `portal: remove single-package ${rel} ${pkgId}`);
        }
      }
      await deleteGitTree(`${folder}/attachments`, target, `portal: remove single-package attachments ${pkgId}`);
    } else {
      await deleteGitTree(`${folder}/driver`, target, `portal: remove split driver ${pkgId}`);
      await deleteGitTree(`${folder}/connect`, target, `portal: remove split connect ${pkgId}`);
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

  function applyDriverDeployMode(mode: DriverDeployMode, forManage: boolean) {
    if (forManage) {
      setManageDriverDeployMode(mode);
      if (mode === 'connect') {
        setManageDriverCustomScript('');
        setManageDriverCustomScriptMode('none');
        setManageStagedAttachments([]);
      } else {
        setManageDriverCustomScript(DEFAULT_DRIVER_INSTALL_SCRIPT);
        setManageDriverCustomScriptMode('only');
      }
    } else {
      setDriverDeployMode(mode);
      if (mode === 'connect') {
        setDriverCustomScript('');
        setDriverCustomScriptMode('none');
        setStagedAttachments([]);
      } else {
        setDriverCustomScript(DEFAULT_DRIVER_INSTALL_SCRIPT);
        setDriverCustomScriptMode('only');
      }
    }
  }

  function buildMasterConfigObject(opts: {
    pkgId: string;
    dName: string;
    split: boolean;
    driverMode: DriverDeployMode;
    printerList: PrinterPathEntry[];
    script: string;
    scriptMode: CustomScriptMode;
    detectionScript: string;
    driverScript: string;
    driverScriptMode: CustomScriptMode;
    driverDetectionScript: string;
    connectScript: string;
    connectScriptMode: CustomScriptMode;
    connectDetectionScript: string;
    configAssignments: Array<{ groupName: string; intent: AssignmentIntent }>;
    runAs: InstallRunAsAccount;
    allUsers: boolean;
    intuneName: string;
  }) {
    const validPrinters = opts.printerList.filter(p => p.path.trim()).map(p => ({
      path: p.path.trim(),
      ...(p.displayName?.trim() ? { displayName: p.displayName.trim() } : {}),
    }));
    const config: Record<string, unknown> = {
      pkgManager: 'printer',
      packageId: opts.pkgId,
      displayName: opts.dName,
      splitDeploy: opts.split,
      printers: validPrinters,
      assignments: opts.configAssignments,
    };
    if (opts.split) {
      config.driverDeployMode = opts.driverMode;
      if (opts.driverScript.trim()) config.driverCustomScript = opts.driverScript.trim();
      config.driverCustomScriptMode = opts.driverScriptMode;
      if (opts.driverDetectionScript.trim()) config.driverCustomDetectionScript = opts.driverDetectionScript.trim();
      if (opts.connectScript.trim()) config.connectCustomScript = opts.connectScript.trim();
      config.connectCustomScriptMode = opts.connectScriptMode;
      if (opts.connectDetectionScript.trim()) config.connectCustomDetectionScript = opts.connectDetectionScript.trim();
    } else {
      config.customScriptMode = opts.scriptMode;
      if (opts.script.trim()) config.customScript = opts.script.trim();
      if (opts.detectionScript.trim()) config.customDetectionScript = opts.detectionScript.trim();
      if (opts.allUsers) config.availableForAllUsers = true;
      if (opts.runAs === 'system') config.runAsAccount = 'system';
      if (opts.intuneName.trim()) config.intuneDisplayName = opts.intuneName.trim();
    }
    if (opts.split) {
      if (opts.allUsers) config.availableForAllUsers = true;
    }
    return config;
  }

  async function writeSplitPrinterPackage(
    target: SaveTarget,
    opts: {
      pkgId: string;
      dName: string;
      driverMode: DriverDeployMode;
      printerList: PrinterPathEntry[];
      driverScript: string;
      driverScriptMode: CustomScriptMode;
      driverDetectionScript: string;
      connectScript: string;
      connectScriptMode: CustomScriptMode;
      connectDetectionScript: string;
      configAssignments: Array<{ groupName: string; intent: AssignmentIntent }>;
      allUsers: boolean;
      attachments: StagedAttachment[];
      masterConfig: Record<string, unknown>;
    },
  ) {
    const scope: GroupDeployScope = target.scope === 'baseline' ? 'baseline' : 'tenant';
    const folder = appFolderPath('printer', opts.pkgId, scope);
    const validPrinters = (opts.masterConfig.printers as PrinterPathEntry[]) ?? [];
    const driverIntuneName = defaultPrinterSplitIntuneDisplayName(opts.dName, 'driver');
    const connectIntuneName = defaultPrinterSplitIntuneDisplayName(opts.dName, 'connect');
    const driverConnectMode = opts.driverMode === 'connect';

    await gitPut(`${folder}/config.json`, JSON.stringify(opts.masterConfig, null, 2) + '\n', target, `portal: save printer ${opts.pkgId}`);

    if (driverConnectMode) {
      await deleteGitTree(`${folder}/driver/attachments`, target, `portal: remove driver attachments ${opts.pkgId} (connect mode)`);
    }

    const driverConfig: Record<string, unknown> = {
      pkgManager: 'printer',
      packageId: opts.pkgId,
      printerRole: 'driver',
      driverDeployMode: opts.driverMode,
      displayName: opts.dName,
      intuneDisplayName: driverIntuneName,
      runAsAccount: 'system',
      assignments: opts.configAssignments,
      ...(opts.allUsers ? { availableForAllUsers: true } : {}),
      customScriptMode: opts.driverScriptMode,
      ...(opts.driverScript.trim() ? { customScript: opts.driverScript.trim() } : {}),
      ...(opts.driverDetectionScript.trim() ? { customDetectionScript: opts.driverDetectionScript.trim() } : {}),
    };
    if (driverConnectMode) {
      driverConfig.printers = validPrinters;
    }
    await gitPut(`${folder}/driver/config.json`, JSON.stringify(driverConfig, null, 2) + '\n', target, `portal: driver config ${opts.pkgId}`);

    if (driverConnectMode) {
      await gitPut(
        `${folder}/driver/install.ps1`,
        buildPrinterDriverConnectInstallScript({ printers: validPrinters, customScript: opts.driverScript, customScriptMode: opts.driverScriptMode }),
        target,
        `portal: driver install ${opts.pkgId}`,
      );
      await gitPut(
        `${folder}/driver/detection.ps1`,
        buildPrinterDriverConnectDetectionScript({ printers: validPrinters, customDetectionScript: opts.driverDetectionScript }),
        target,
        `portal: driver detection ${opts.pkgId}`,
      );
      await gitPut(
        `${folder}/driver/uninstall.ps1`,
        buildPrinterDriverConnectUninstallScript(validPrinters),
        target,
        `portal: driver uninstall ${opts.pkgId}`,
      );
    } else {
      await gitPut(
        `${folder}/driver/install.ps1`,
        buildPrinterDriverInstallScript({ packageId: opts.pkgId, customScript: opts.driverScript, customScriptMode: opts.driverScriptMode }),
        target,
        `portal: driver install ${opts.pkgId}`,
      );
      await gitPut(
        `${folder}/driver/detection.ps1`,
        buildPrinterDriverDetectionScript({ packageId: opts.pkgId, customDetectionScript: opts.driverDetectionScript }),
        target,
        `portal: driver detection ${opts.pkgId}`,
      );
      await gitPut(
        `${folder}/driver/uninstall.ps1`,
        buildPrinterDriverUninstallScript(opts.pkgId),
        target,
        `portal: driver uninstall ${opts.pkgId}`,
      );
      for (const file of opts.attachments) {
        await gitPutBinary(`${folder}/driver/attachments/${file.fileName}`, file.base64, target, `portal: driver attachment ${opts.pkgId}/${file.fileName}`);
      }
    }

    const connectConfig = {
      pkgManager: 'printer',
      packageId: opts.pkgId,
      printerRole: 'connect',
      displayName: opts.dName,
      intuneDisplayName: connectIntuneName,
      dependsOnIntuneDisplayName: driverIntuneName,
      runAsAccount: 'user',
      printers: validPrinters,
      assignments: opts.configAssignments,
      ...(opts.allUsers ? { availableForAllUsers: true } : {}),
      customScriptMode: opts.connectScriptMode,
      ...(opts.connectScript.trim() ? { customScript: opts.connectScript.trim() } : {}),
      ...(opts.connectDetectionScript.trim() ? { customDetectionScript: opts.connectDetectionScript.trim() } : {}),
    };
    await gitPut(`${folder}/connect/config.json`, JSON.stringify(connectConfig, null, 2) + '\n', target, `portal: connect config ${opts.pkgId}`);
    await gitPut(
      `${folder}/connect/install.ps1`,
      buildPrinterConnectInstallScript({ printers: validPrinters, customScript: opts.connectScript, customScriptMode: opts.connectScriptMode }),
      target,
      `portal: connect install ${opts.pkgId}`,
    );
    await gitPut(
      `${folder}/connect/detection.ps1`,
      buildPrinterDetectionScript({ printers: validPrinters, customDetectionScript: opts.connectDetectionScript }),
      target,
      `portal: connect detection ${opts.pkgId}`,
    );
    await gitPut(
      `${folder}/connect/uninstall.ps1`,
      buildPrinterUninstallScript(validPrinters),
      target,
      `portal: connect uninstall ${opts.pkgId}`,
    );
  }

  async function writePrinterPackage(
    target: SaveTarget,
    opts: {
      pkgId: string;
      dName: string;
      split: boolean;
      driverMode: DriverDeployMode;
      printerList: PrinterPathEntry[];
      script: string;
      scriptMode: CustomScriptMode;
      detectionScript: string;
      driverScript: string;
      driverScriptMode: CustomScriptMode;
      driverDetectionScript: string;
      connectScript: string;
      connectScriptMode: CustomScriptMode;
      connectDetectionScript: string;
      configAssignments: Array<{ groupName: string; intent: AssignmentIntent }>;
      runAs: InstallRunAsAccount;
      allUsers: boolean;
      intuneName: string;
      attachments: StagedAttachment[];
    },
  ) {
    const masterConfig = buildMasterConfigObject(opts);
    const scope: GroupDeployScope = target.scope === 'baseline' ? 'baseline' : 'tenant';
    const folder = appFolderPath('printer', opts.pkgId, scope);
    await cleanupPrinterPackageLayout(folder, opts.split, target, opts.pkgId);
    if (opts.split) {
      await writeSplitPrinterPackage(target, {
        pkgId: opts.pkgId,
        dName: opts.dName,
        driverMode: opts.driverMode,
        printerList: opts.printerList,
        driverScript: opts.driverScript,
        driverScriptMode: opts.driverScriptMode,
        driverDetectionScript: opts.driverDetectionScript,
        connectScript: opts.connectScript,
        connectScriptMode: opts.connectScriptMode,
        connectDetectionScript: opts.connectDetectionScript,
        configAssignments: opts.configAssignments,
        allUsers: opts.allUsers,
        attachments: opts.attachments,
        masterConfig,
      });
      return;
    }

    const validPrinters = (masterConfig.printers as PrinterPathEntry[]) ?? [];
    const config = JSON.stringify(masterConfig, null, 2) + '\n';

    await gitPut(`${folder}/config.json`, config, target, `portal: save printer ${opts.pkgId}`);
    await gitPut(
      `${folder}/install.ps1`,
      buildPrinterInstallScript({ printers: validPrinters, customScript: opts.script, customScriptMode: opts.scriptMode }),
      target,
      `portal: install script ${opts.pkgId}`,
    );
    await gitPut(
      `${folder}/detection.ps1`,
      buildPrinterDetectionScript({ printers: validPrinters, customDetectionScript: opts.detectionScript }),
      target,
      `portal: detection script ${opts.pkgId}`,
    );
    await gitPut(
      `${folder}/uninstall.ps1`,
      buildPrinterUninstallScript(validPrinters),
      target,
      `portal: uninstall script ${opts.pkgId}`,
    );

    for (const file of opts.attachments) {
      await gitPutBinary(
        `${folder}/attachments/${file.fileName}`,
        file.base64,
        target,
        `portal: attachment ${opts.pkgId}/${file.fileName}`,
      );
    }
  }

  function validatePrinterForm(opts: {
    split: boolean;
    driverMode: DriverDeployMode;
    pkgId: string;
    dName: string;
    printerList: PrinterPathEntry[];
    script: string;
    scriptMode: CustomScriptMode;
    detectionScript: string;
    driverScript: string;
    driverScriptMode: CustomScriptMode;
    connectScript: string;
    connectScriptMode: CustomScriptMode;
    attachmentsCount: number;
  }): string | null {
    if (!opts.pkgId.trim()) return 'Package ID is required.';
    if (!opts.dName.trim()) return 'Display name is required.';

    const validPaths = opts.printerList.filter(p => p.path.trim());

    if (opts.split) {
      if (validPaths.length === 0) return 'Add at least one printer path.';
      if (opts.driverMode === 'package') {
        if (!opts.driverScript.trim() && opts.attachmentsCount === 0) {
          return 'Driver app needs an install script or at least one attachment (INF/MSI).';
        }
      } else if (opts.driverScriptMode !== 'none' && !opts.driverScript.trim()) {
        return 'Driver custom script is required for the selected driver script mode.';
      }
      if (opts.connectScriptMode !== 'none' && !opts.connectScript.trim()) {
        return 'Connect custom script is required for the selected connect script mode.';
      }
      return null;
    }

    if (opts.scriptMode !== 'only' && validPaths.length === 0) {
      return 'Add at least one printer path, or set custom script mode to "Run only".';
    }
    if (opts.scriptMode !== 'none' && !opts.script.trim()) {
      return 'Custom script is required for the selected script mode.';
    }
    if (opts.scriptMode === 'only' && !opts.detectionScript.trim() && validPaths.length === 0) {
      return 'When using "Run only" without printer paths, provide a custom detection script.';
    }
    return null;
  }

  async function saveDeploy() {
    const pkgId = safePackageId(packageId);
    const dName = displayName.trim();
    const err = validatePrinterForm({
      pkgId, dName, printerList: printers, script: customScript,
      scriptMode: customScriptMode, detectionScript: customDetectionScript,
      split: splitDeploy,
      driverMode: driverDeployMode,
      driverScript: driverCustomScript,
      driverScriptMode: driverCustomScriptMode,
      connectScript: connectCustomScript,
      connectScriptMode: connectCustomScriptMode,
      attachmentsCount: stagedAttachments.length,
    });
    if (err) { setDeployMsg({ msg: err, type: 'error' }); return; }

    const targets = getSaveTargets();
    if (deployMode === 'tenants' && targets.length === 0) {
      setDeployMsg({ msg: 'Select at least one tenant.', type: 'error' });
      return;
    }

    setDeploying(true);
    setDeployMsg({ msg: '', type: 'success' });
    try {
      const configAssignments = assignments
        .filter(a => a.groupName.trim())
        .map(({ groupName, intent }) => ({ groupName: groupName.trim(), intent }));

      const newGroups = assignments.filter(a => a.isNew && a.groupName.trim());
      const writtenGroups = new Set<string>();
      const intuneName = splitDeploy
        ? `${defaultPrinterSplitIntuneDisplayName(dName, 'driver')} + ${defaultPrinterSplitIntuneDisplayName(dName, 'connect')}`
        : (intuneDisplayName.trim() || defaultIntuneDisplayName('printer', dName));

      for (const target of targets) {
        for (const group of newGroups) {
          const key = `${target.scope === 'baseline' ? 'b' : target.slug}:${group.groupName}`;
          if (writtenGroups.has(key)) continue;
          await saveNewGroup(group, target);
          writtenGroups.add(key);
        }

        await writePrinterPackage(target, {
          pkgId,
          dName,
          split: splitDeploy,
          driverMode: driverDeployMode,
          printerList: printers,
          script: customScript,
          scriptMode: customScriptMode,
          detectionScript: customDetectionScript,
          driverScript: driverCustomScript,
          driverScriptMode: driverCustomScriptMode,
          driverDetectionScript: driverCustomDetectionScript,
          connectScript: connectCustomScript,
          connectScriptMode: connectCustomScriptMode,
          connectDetectionScript: connectCustomDetectionScript,
          configAssignments,
          runAs: runAsAccount,
          allUsers: availableForAllUsers,
          intuneName,
          attachments: stagedAttachments,
        });
      }

      setAssignments(prev => prev.map(a => ({ ...a, isNew: false })));
      if (newGroups.length) {
        setRepoGroupNames(prev => [...new Set([...prev, ...newGroups.map(g => g.groupName)])].sort());
      }

      const targetLabel = deployMode === 'baseline'
        ? 'baseline'
        : targets.map(t => t.scope === 'tenant'
          ? (tenants.find(x => x.slug === t.slug)?.displayName ?? t.slug)
          : '',
        ).join(', ');
      setDeployMsg({ msg: `"${intuneName}" saved to ${targetLabel}. Run deploy with Apps: Printers to push to Intune.`, type: 'success' });
      setStagedAttachments([]);
      if (mainTab === 'manage') await loadManage();
    } catch (e: unknown) {
      setDeployMsg({ msg: e instanceof Error ? e.message : 'Failed', type: 'error' });
    } finally {
      setDeploying(false);
    }
  }

  async function saveManageEntry() {
    const entry = manageEntry;
    if (!entry) return;

    const err = validatePrinterForm({
      pkgId: entry.packageId,
      dName: entry.displayName,
      printerList: managePrinters,
      script: manageCustomScript,
      scriptMode: manageCustomScriptMode,
      detectionScript: manageCustomDetectionScript,
      split: manageSplitDeploy,
      driverMode: manageDriverDeployMode,
      driverScript: manageDriverCustomScript,
      driverScriptMode: manageDriverCustomScriptMode,
      connectScript: manageConnectCustomScript,
      connectScriptMode: manageConnectCustomScriptMode,
      attachmentsCount: manageDriverDeployMode === 'connect'
        ? 0
        : manageStagedAttachments.length + manageExistingAttachments.length,
    });
    if (err) { setManageMsg({ msg: err, type: 'error' }); return; }

    setManageSaving(true);
    setManageMsg({ msg: '', type: 'success' });
    try {
      const target = entrySaveTarget(entry);
      const configAssignments = manageAssignments
        .filter(a => a.groupName.trim())
        .map(({ groupName, intent }) => ({ groupName: groupName.trim(), intent }));

      const newGroups = manageAssignments.filter(a => a.isNew && a.groupName.trim());
      for (const group of newGroups) {
        await saveNewGroup(group, target);
      }

      await writePrinterPackage(target, {
        pkgId: entry.packageId,
        dName: entry.displayName,
        split: manageSplitDeploy,
        driverMode: manageDriverDeployMode,
        printerList: managePrinters,
        script: manageCustomScript,
        scriptMode: manageCustomScriptMode,
        detectionScript: manageCustomDetectionScript,
        driverScript: manageDriverCustomScript,
        driverScriptMode: manageDriverCustomScriptMode,
        driverDetectionScript: manageDriverCustomDetectionScript,
        connectScript: manageConnectCustomScript,
        connectScriptMode: manageConnectCustomScriptMode,
        connectDetectionScript: manageConnectCustomDetectionScript,
        configAssignments,
        runAs: manageRunAsAccount,
        allUsers: manageAvailableForAllUsers,
        intuneName: entry.intuneDisplayName,
        attachments: manageStagedAttachments,
      });

      setManageAssignments(prev => prev.map(a => ({ ...a, isNew: false })));
      setManageStagedAttachments([]);
      setManageMsg({ msg: 'Saved. Run deploy with Apps: Printers to update Intune.', type: 'success' });
      await loadManage();
    } catch (e: unknown) {
      setManageMsg({ msg: e instanceof Error ? e.message : 'Failed', type: 'error' });
    } finally {
      setManageSaving(false);
    }
  }

  async function collectFolderFiles(entry: PrinterEntry): Promise<{ path: string; sha: string }[]> {
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

  async function removePrinterFromGit(entry: PrinterEntry) {
    const target = entrySaveTarget(entry);
    const files = await collectFolderFiles(entry);
    if (!files.length) throw new Error('No printer package files found in Git');
    for (const file of files) {
      await gitDelete(file.path, file.sha, target, `portal: remove printer ${entry.packageId}`);
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

  async function confirmRemove() {
    const entry = manageEntry;
    if (!entry) return;
    setRemoving(true);
    try {
      await removePrinterFromGit(entry);
      setRemoveModalOpen(false);
      setManageEntry(null);
      await loadManage();
      setManageBanner({ msg: 'Printer package removed from Git. Run deploy to delete from Intune.', type: 'success' });
    } catch (e: unknown) {
      setManageBanner({ msg: e instanceof Error ? e.message : 'Remove failed', type: 'error' });
    } finally {
      setRemoving(false);
    }
  }

  function addAssignmentGroup(name: string, isNew = false, description?: string) {
    setAssignments(prev => [...prev, { groupName: name, intent: 'required', isNew, description }]);
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

  function selectableGroupsForRow(rows: AppAssignment[], rowIndex: number, groupOptions: string[]): string[] {
    const usedElsewhere = new Set(
      rows.filter((_, j) => j !== rowIndex).map(r => r.groupName.trim()).filter(Boolean),
    );
    return groupOptions.filter(g => !usedElsewhere.has(g) || rows[rowIndex]?.groupName.trim() === g);
  }

  function renderAssignmentEditor(opts: {
    rows: AppAssignment[];
    setRows: React.Dispatch<React.SetStateAction<AppAssignment[]>>;
    groupOptions: string[];
    hint: string;
    forManage?: boolean;
  }) {
    const { rows, setRows, groupOptions, hint, forManage } = opts;
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
              No groups assigned — package will deploy without Intune assignments.
            </div>
          ) : rows.map((a, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 120px 36px', gap: 10, alignItems: 'center',
              padding: '8px 12px', borderBottom: i < rows.length - 1 ? '1px solid #1a1a1d' : undefined,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <GroupPicker
                  value={a.groupName}
                  options={selectableGroupsForRow(rows, i, groupOptions)}
                  placeholder={groupOptions.length ? 'Select a group…' : 'No groups in Git'}
                  variant="select"
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
            <button type="button" onClick={() => setRows(prev => [...prev, { groupName: '', intent: 'required' }])} style={UI.addBt}>+ Add group</button>
            <button type="button" onClick={() => { setGroupModalForManage(!!forManage); setCreateModalOpen(true); }}
              style={{ ...UI.addBt, borderStyle: 'solid', color: '#93c5fd', borderColor: '#3f3f46' }}>
              + Create new group
            </button>
          </div>
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
              Available for all licensed users
            </span>
            <span style={{ display: 'block', fontSize: '0.75rem', color: '#52525b', marginTop: 2, lineHeight: 1.45 }}>
              App appears in Company Portal for licensed users on enrolled devices.
            </span>
          </span>
        </div>
      </div>
    );
  }

  function renderPrinterPaths(
    rows: PrinterPathEntry[],
    setRows: React.Dispatch<React.SetStateAction<PrinterPathEntry[]>>,
    opts?: { splitShared?: boolean },
  ) {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>{opts?.splitShared ? 'Printer paths (shared)' : 'Printer paths (UNC)'}</label>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 8 }}>
          {opts?.splitShared
            ? 'Used by the connect (user) app and by the driver app when deploy type is Connect printers.'
            : 'One or more network printer paths, e.g. \\\\printserver\\ShareName. All paths are packaged into a single IntuneWin app.'}
        </div>
        {rows.map((p, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 36px', gap: 8, marginBottom: 8 }}>
            <input
              value={p.path}
              onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, path: e.target.value } : x))}
              placeholder="\\printserver\PrinterShare"
              style={inp}
            />
            <input
              value={p.displayName ?? ''}
              onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, displayName: e.target.value } : x))}
              placeholder="Display name (optional)"
              style={inp}
            />
            <button type="button" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))} style={UI.delBt} disabled={rows.length === 1}>×</button>
          </div>
        ))}
        <button type="button" onClick={() => setRows(prev => [...prev, { path: '' }])} style={UI.addBt}>+ Add printer path</button>
      </div>
    );
  }

  function renderScriptSection(opts: {
    script: string;
    setScript: (v: string) => void;
    mode: CustomScriptMode;
    setMode: (v: CustomScriptMode) => void;
    detectionScript: string;
    setDetectionScript: (v: string) => void;
    showDetection: boolean;
    setShowDetection: (v: boolean) => void;
    scriptLabel?: string;
    detectionHint?: string;
  }) {
    return (
      <>
        <div style={{ marginBottom: 16 }}>
          <label style={UI.lbl}>Custom script mode</label>
          <select
            value={opts.mode}
            onChange={e => opts.setMode(e.target.value as CustomScriptMode)}
            style={UI.sel}
          >
            <option value="none">None — auto-add printers only</option>
            <option value="before">Run before — custom script, then add printers</option>
            <option value="after">Run after — add printers, then custom script</option>
            <option value="only">Run only — custom script replaces auto-add</option>
          </select>
        </div>
        {opts.mode !== 'none' && (
          <div style={{ marginBottom: 16 }}>
            <label style={UI.lbl}>{opts.scriptLabel ?? 'Custom PowerShell script'}</label>
            <textarea
              value={opts.script}
              onChange={e => opts.setScript(e.target.value)}
              placeholder={DEFAULT_CUSTOM_SCRIPT}
              rows={8}
              style={{ ...inp, fontFamily: 'monospace', fontSize: '0.75rem', background: '#0a0a0b', color: '#86efac', resize: 'vertical' }}
            />
          </div>
        )}
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => opts.setShowDetection(!opts.showDetection)}
            style={{ ...UI.addBt, borderStyle: 'solid', marginBottom: opts.showDetection ? 8 : 0 }}
          >
            {opts.showDetection ? 'Hide' : 'Show'} custom detection script override
          </button>
          {opts.showDetection && (
            <>
              {opts.detectionHint && (
                <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 8 }}>{opts.detectionHint}</div>
              )}
              <textarea
              value={opts.detectionScript}
              onChange={e => opts.setDetectionScript(e.target.value)}
              placeholder="# Override auto-detection — exit 0 = detected, exit 1 = not detected"
              rows={6}
              style={{ ...inp, fontFamily: 'monospace', fontSize: '0.75rem', background: '#0a0a0b', color: '#86efac', resize: 'vertical' }}
            />
            </>
          )}
        </div>
      </>
    );
  }

  function renderAttachments(opts: {
    staged: StagedAttachment[];
    setStaged: React.Dispatch<React.SetStateAction<StagedAttachment[]>>;
    existing: string[];
  }) {
    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>Attachments (drivers, INF, etc.)</label>
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginBottom: 8 }}>
          Files are bundled into the IntuneWin package. Reference them in custom scripts via $PSScriptRoot\filename
        </div>
        {(opts.existing.length > 0 || opts.staged.length > 0) && (
          <ul style={{ margin: '0 0 8px', padding: '8px 12px', background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 6, listStyle: 'none', fontSize: '0.8125rem', color: '#a1a1aa' }}>
            {opts.existing.map(name => (
              <li key={`ex-${name}`} style={{ padding: '4px 0' }}>{name} <span style={{ color: '#52525b' }}>(in Git)</span></li>
            ))}
            {opts.staged.map(f => (
              <li key={`st-${f.fileName}`} style={{ padding: '4px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{f.fileName} <span style={{ color: '#86efac' }}>(new)</span></span>
                <button type="button" onClick={() => opts.setStaged(prev => prev.filter(x => x.fileName !== f.fileName))} style={{ ...UI.delBt, width: 22, height: 22, fontSize: '0.75rem' }}>×</button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="file"
          multiple
          onChange={async e => {
            const files = e.target.files;
            if (!files?.length) return;
            const added = await Promise.all([...files].map(readFileAsBase64));
            opts.setStaged(prev => {
              const names = new Set(prev.map(p => p.fileName));
              return [...prev, ...added.filter(a => !names.has(a.fileName))];
            });
            e.target.value = '';
          }}
          style={{ fontSize: '0.8125rem', color: '#a1a1aa' }}
        />
      </div>
    );
  }

  function renderPackageModeSelector(opts: {
    split: boolean;
    setSplit: (v: boolean) => void;
    displayName: string;
    packageId: string;
    showIntuneNames?: boolean;
  }) {
    const modeBtn = (split: boolean, label: string, desc: string) => (
      <button
        key={label}
        type="button"
        onClick={() => opts.setSplit(split)}
        style={{
          ...UI.addBt,
          flex: 1,
          textAlign: 'left' as const,
          borderStyle: 'solid',
          padding: '10px 12px',
          color: opts.split === split ? (split ? '#93c5fd' : '#86efac') : '#71717a',
          borderColor: opts.split === split ? (split ? '#1e3a5f' : '#166534') : '#3f3f46',
          background: opts.split === split ? '#0d0d0f' : 'transparent',
        }}
      >
        <span style={{ display: 'block', fontWeight: 600, fontSize: '0.8125rem', marginBottom: 4 }}>{label}</span>
        <span style={{ display: 'block', fontSize: '0.6875rem', color: '#52525b', lineHeight: 1.45 }}>{desc}</span>
      </button>
    );

    return (
      <div style={{ marginBottom: 16 }}>
        <label style={UI.lbl}>Package mode</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: opts.showIntuneNames !== false && opts.split ? 8 : 0 }}>
          {modeBtn(
            false,
            'Single package',
            'One IntuneWin app — driver install, printer connect, and attachments in a single script. Run as user or system.',
          )}
          {modeBtn(
            true,
            'Split deploy',
            'Two IntuneWin apps — driver installs as system, printer connects as user. Connect app depends on driver app.',
          )}
        </div>
        {opts.showIntuneNames !== false && opts.split && (
          <div style={{ fontSize: '0.75rem', color: '#71717a', lineHeight: 1.5 }}>
            Driver: {defaultPrinterSplitIntuneDisplayName(opts.displayName || opts.packageId || '…', 'driver')}
            {' · '}
            Connect: {defaultPrinterSplitIntuneDisplayName(opts.displayName || opts.packageId || '…', 'connect')}
            <span style={{ display: 'block', marginTop: 4, color: '#52525b' }}>
              Connect (user) depends on Driver (system) — user package installs only after the system package is detected.
            </span>
          </div>
        )}
      </div>
    );
  }

  function renderDriverDeployTypeSelector(opts: {
    mode: DriverDeployMode;
    forManage?: boolean;
  }) {
    const typeBtn = (mode: DriverDeployMode, label: string, desc: string) => (
      <button
        key={mode}
        type="button"
        onClick={() => applyDriverDeployMode(mode, !!opts.forManage)}
        style={{
          ...UI.addBt,
          flex: 1,
          textAlign: 'left' as const,
          borderStyle: 'solid',
          padding: '8px 10px',
          color: opts.mode === mode ? '#93c5fd' : '#71717a',
          borderColor: opts.mode === mode ? '#1e3a5f' : '#3f3f46',
          background: opts.mode === mode ? '#0a0a0c' : 'transparent',
        }}
      >
        <span style={{ display: 'block', fontWeight: 600, fontSize: '0.75rem', marginBottom: 2 }}>{label}</span>
        <span style={{ display: 'block', fontSize: '0.6875rem', color: '#52525b', lineHeight: 1.4 }}>{desc}</span>
      </button>
    );

    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ ...UI.lbl, marginBottom: 4 }}>Driver deploy type</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {typeBtn('package', 'Driver package', 'Install driver files (INF/MSI) from attachments with optional script.')}
          {typeBtn('connect', 'Connect printers', 'Add UNC printer connections at system level with optional before/after script.')}
        </div>
      </div>
    );
  }

  const tabBtn = (tab: MainTab, label: string) => (
    <button
      key={tab}
      onClick={() => setMainTab(tab)}
      style={{
        background: mainTab === tab ? '#27272a' : 'transparent',
        border: 'none', borderRadius: 6, color: mainTab === tab ? '#fff' : '#71717a',
        cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8125rem', fontWeight: 600,
        padding: '8px 16px',
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {tabBtn('deploy', 'Deploy')}
        {tabBtn('manage', 'Manage')}
      </div>

      {mainTab === 'deploy' && (
        <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: 20, maxWidth: 720 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={UI.lbl}>Package ID</label>
              <input
                value={packageId}
                onChange={e => {
                  setPackageId(e.target.value);
                  if (!displayName) setDisplayName(e.target.value);
                  if (!intuneDisplayName) setIntuneDisplayName(defaultIntuneDisplayName('printer', e.target.value));
                }}
                placeholder="office-printers"
                style={inp}
              />
            </div>
            <div>
              <label style={UI.lbl}>Display name</label>
              <input
                value={displayName}
                onChange={e => {
                  setDisplayName(e.target.value);
                  if (!intuneDisplayName || intuneDisplayName === defaultIntuneDisplayName('printer', packageId)) {
                    setIntuneDisplayName(defaultIntuneDisplayName('printer', e.target.value));
                  }
                }}
                style={inp}
              />
            </div>
          </div>

          {!splitDeploy && (
            <div style={{ marginBottom: 16 }}>
              <label style={UI.lbl}>Intune display name</label>
              <input value={intuneDisplayName} onChange={e => setIntuneDisplayName(e.target.value)} style={inp} />
            </div>
          )}

          {renderPackageModeSelector({
            split: splitDeploy,
            setSplit: setSplitDeploy,
            displayName,
            packageId,
          })}

          {splitDeploy ? (
            <>
              {renderPrinterPaths(printers, setPrinters, { splitShared: true })}
              <div style={{ marginBottom: 20, padding: 14, background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 8 }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#93c5fd', marginBottom: 12 }}>Driver app (system)</div>
                {renderDriverDeployTypeSelector({ mode: driverDeployMode })}
                {driverDeployMode === 'package' && renderAttachments({ staged: stagedAttachments, setStaged: setStagedAttachments, existing: [] })}
                {renderScriptSection({
                  script: driverCustomScript,
                  setScript: setDriverCustomScript,
                  mode: driverCustomScriptMode,
                  setMode: setDriverCustomScriptMode,
                  detectionScript: driverCustomDetectionScript,
                  setDetectionScript: setDriverCustomDetectionScript,
                  showDetection: showDriverCustomDetection,
                  setShowDetection: setShowDriverCustomDetection,
                  scriptLabel: driverDeployMode === 'package' ? 'Driver install script' : 'Optional driver script',
                  detectionHint: driverDeployMode === 'package'
                    ? 'Default detection checks for a marker file under ProgramData\\Config365\\printers'
                    : 'Default detection checks printer connections by UNC path (PortName)',
                })}
              </div>
              <div style={{ marginBottom: 20, padding: 14, background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 8 }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#86efac', marginBottom: 12 }}>Connect app (user)</div>
                {renderScriptSection({
                  script: connectCustomScript,
                  setScript: setConnectCustomScript,
                  mode: connectCustomScriptMode,
                  setMode: setConnectCustomScriptMode,
                  detectionScript: connectCustomDetectionScript,
                  setDetectionScript: setConnectCustomDetectionScript,
                  showDetection: showConnectCustomDetection,
                  setShowDetection: setShowConnectCustomDetection,
                  scriptLabel: 'Optional connect script',
                  detectionHint: 'Default detection checks printer connections by UNC path (PortName)',
                })}
              </div>
            </>
          ) : (
            <>
              {renderPrinterPaths(printers, setPrinters)}
              {renderScriptSection({
                script: customScript,
                setScript: setCustomScript,
                mode: customScriptMode,
                setMode: setCustomScriptMode,
                detectionScript: customDetectionScript,
                setDetectionScript: setCustomDetectionScript,
                showDetection: showCustomDetection,
                setShowDetection: setShowCustomDetection,
                detectionHint: 'Default detection checks printer connections by UNC path (PortName)',
              })}
              {renderAttachments({ staged: stagedAttachments, setStaged: setStagedAttachments, existing: [] })}
              <div style={{ marginBottom: 16 }}>
                <label style={UI.lbl}>Run install as</label>
                <select value={runAsAccount} onChange={e => setRunAsAccount(e.target.value as InstallRunAsAccount)} style={{ ...UI.sel, maxWidth: 200 }}>
                  <option value="user">User (recommended for printers)</option>
                  <option value="system">System</option>
                </select>
                <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 6 }}>
                  Use script mode &quot;Run before&quot; or &quot;Run after&quot; to install drivers from attachments in the same package.
                </div>
              </div>
            </>
          )}

          <div style={{ marginBottom: 16 }}>
            <label style={UI.lbl}>Deploy to</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {(['baseline', 'tenants'] as DeployMode[]).map(m => (
                <button key={m} type="button" onClick={() => setDeployMode(m)}
                  style={{ ...UI.addBt, borderStyle: 'solid', color: deployMode === m ? '#86efac' : '#71717a', borderColor: deployMode === m ? '#166534' : '#3f3f46' }}>
                  {m === 'baseline' ? 'Baseline' : 'Tenant(s)'}
                </button>
              ))}
            </div>
            {deployMode === 'tenants' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tenants.map(t => (
                  <label key={t.slug} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: '#a1a1aa', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedTenants.includes(t.slug)}
                      onChange={e => setSelectedTenants(prev =>
                        e.target.checked ? [...prev, t.slug] : prev.filter(s => s !== t.slug),
                      )}
                    />
                    {t.displayName}
                  </label>
                ))}
              </div>
            )}
          </div>

          {renderAssignmentEditor({
            rows: assignments,
            setRows: setAssignments,
            groupOptions: availableGroups,
            hint: groupsLoading ? 'Loading groups…' : deployMode === 'tenants'
              ? (selectedTenants.length === 0
                ? 'Select tenant(s) above to load groups from each tenant repo and Entra backup.'
                : 'Groups from tenant Git (groups/) and backed-up Entra security groups for the selected tenant(s).')
              : 'Select groups from Git — create new groups below if needed.',
          })}

          {renderCompanyPortalOption(availableForAllUsers, setAvailableForAllUsers)}

          {deployMsg.msg && (
            <div style={{
              marginBottom: 12, padding: '10px 12px', borderRadius: 6, fontSize: '0.8125rem',
              background: deployMsg.type === 'error' ? '#2d1216' : '#052e16',
              color: deployMsg.type === 'error' ? '#fca5a5' : '#86efac',
              border: `1px solid ${deployMsg.type === 'error' ? '#7f1d1d' : '#166534'}`,
            }}>
              {deployMsg.msg}
            </div>
          )}

          <button
            type="button"
            onClick={() => void saveDeploy()}
            disabled={deploying}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '8px 20px', borderRadius: 6, border: 'none', fontWeight: 600,
              fontSize: '0.8125rem', cursor: deploying ? 'not-allowed' : 'pointer',
              background: deploying ? '#1a2e1a' : '#22c55e', color: deploying ? '#52525b' : '#052e16',
              fontFamily: 'inherit',
            }}
          >
            {deploying ? <><Spinner /> Saving…</> : 'Save to Git'}
          </button>
        </div>
      )}

      {mainTab === 'manage' && (
        <div style={{ display: 'grid', gridTemplateColumns: manageEntry ? '280px 1fr' : '1fr', gap: 16, alignItems: 'start' }}>
          <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #27272a', fontSize: '0.8125rem', fontWeight: 600, color: '#d4d4d8' }}>
              Printer packages {manageLoading && <Spinner small />}
            </div>
            {manageBanner && (
              <div style={{ padding: '8px 12px', fontSize: '0.75rem', background: manageBanner.type === 'error' ? '#2d1216' : '#052e16', color: manageBanner.type === 'error' ? '#fca5a5' : '#86efac' }}>
                {manageBanner.msg}
              </div>
            )}
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {manageEntries.length === 0 && !manageLoading && (
                <div style={{ padding: 16, fontSize: '0.8125rem', color: '#52525b', fontStyle: 'italic' }}>No printer packages yet.</div>
              )}
              {manageEntries.map(e => (
                <button
                  key={`${e.targetType}-${e.target}-${e.packageId}`}
                  type="button"
                  onClick={() => setManageEntry(e)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                    background: manageEntry?.path === e.path && manageEntry?.target === e.target ? '#1a1a1d' : 'transparent',
                    border: 'none', borderBottom: '1px solid #1a1a1d', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#e4e4e7' }}>{e.displayName}</div>
                  <div style={{ fontSize: '0.6875rem', color: '#52525b', marginTop: 2 }}>
                    {e.splitDeploy
                      ? `Split (2 apps) · Driver: ${e.driverDeployMode === 'connect' ? 'connect' : 'package'}`
                      : 'Single package'} · {e.targetType === 'baseline' ? 'baseline' : e.target} · {e.printers.length} printer(s)
                  </div>
                </button>
              ))}
            </div>
          </div>

          {manageEntry && (
            <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1rem', color: '#e4e4e7' }}>{manageEntry.displayName}</h3>
                  <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: 4 }}>
                    {manageEntry.splitDeploy
                      ? `${defaultPrinterSplitIntuneDisplayName(manageEntry.displayName, 'driver')} · ${defaultPrinterSplitIntuneDisplayName(manageEntry.displayName, 'connect')}`
                      : manageEntry.intuneDisplayName}
                  </div>
                </div>
                <button type="button" onClick={() => setRemoveModalOpen(true)} style={{ ...UI.delBt, width: 'auto', height: 'auto', padding: '6px 12px', fontSize: '0.75rem' }}>
                  Remove
                </button>
              </div>

              {renderPackageModeSelector({
                split: manageSplitDeploy,
                setSplit: setManageSplitDeploy,
                displayName: manageEntry.displayName,
                packageId: manageEntry.packageId,
              })}

              {manageSplitDeploy ? (
                <>
                  {renderPrinterPaths(managePrinters, setManagePrinters, { splitShared: true })}
                  <div style={{ marginBottom: 20, padding: 14, background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#93c5fd', marginBottom: 12 }}>Driver app (system)</div>
                    {renderDriverDeployTypeSelector({ mode: manageDriverDeployMode, forManage: true })}
                    {manageDriverDeployMode === 'package' && renderAttachments({
                      staged: manageStagedAttachments,
                      setStaged: setManageStagedAttachments,
                      existing: manageExistingAttachments,
                    })}
                    {renderScriptSection({
                      script: manageDriverCustomScript,
                      setScript: setManageDriverCustomScript,
                      mode: manageDriverCustomScriptMode,
                      setMode: setManageDriverCustomScriptMode,
                      detectionScript: manageDriverCustomDetectionScript,
                      setDetectionScript: setManageDriverCustomDetectionScript,
                      showDetection: manageShowDriverCustomDetection,
                      setShowDetection: setManageShowDriverCustomDetection,
                      scriptLabel: manageDriverDeployMode === 'package' ? 'Driver install script' : 'Optional driver script',
                      detectionHint: manageDriverDeployMode === 'package'
                        ? 'Default detection checks for a marker file under ProgramData\\Config365\\printers'
                        : 'Default detection checks printer connections by UNC path (PortName)',
                    })}
                  </div>
                  <div style={{ marginBottom: 20, padding: 14, background: '#0d0d0f', border: '1px solid #27272a', borderRadius: 8 }}>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#86efac', marginBottom: 12 }}>Connect app (user)</div>
                    {renderScriptSection({
                      script: manageConnectCustomScript,
                      setScript: setManageConnectCustomScript,
                      mode: manageConnectCustomScriptMode,
                      setMode: setManageConnectCustomScriptMode,
                      detectionScript: manageConnectCustomDetectionScript,
                      setDetectionScript: setManageConnectCustomDetectionScript,
                      showDetection: manageShowConnectCustomDetection,
                      setShowDetection: setManageShowConnectCustomDetection,
                      scriptLabel: 'Optional connect script',
                      detectionHint: 'Default detection checks printer connections by UNC path (PortName)',
                    })}
                  </div>
                </>
              ) : (
                <>
                  {renderPrinterPaths(managePrinters, setManagePrinters)}
                  {renderScriptSection({
                    script: manageCustomScript,
                    setScript: setManageCustomScript,
                    mode: manageCustomScriptMode,
                    setMode: setManageCustomScriptMode,
                    detectionScript: manageCustomDetectionScript,
                    setDetectionScript: setManageCustomDetectionScript,
                    showDetection: manageShowCustomDetection,
                    setShowDetection: setManageShowCustomDetection,
                  })}
                  {renderAttachments({
                    staged: manageStagedAttachments,
                    setStaged: setManageStagedAttachments,
                    existing: manageExistingAttachments,
                  })}
                  <div style={{ marginBottom: 16 }}>
                    <label style={UI.lbl}>Run install as</label>
                    <select value={manageRunAsAccount} onChange={e => setManageRunAsAccount(e.target.value as InstallRunAsAccount)} style={{ ...UI.sel, maxWidth: 200 }}>
                      <option value="user">User</option>
                      <option value="system">System</option>
                    </select>
                  </div>
                </>
              )}

              {renderAssignmentEditor({
                rows: manageAssignments,
                setRows: setManageAssignments,
                groupOptions: manageAvailableGroups,
                hint: manageGroupsLoading ? 'Loading groups…' : manageEntry.targetType === 'tenant'
                  ? 'Groups from tenant Git (groups/) and backed-up Entra security groups.'
                  : 'Select groups from Git — create new groups below if needed.',
                forManage: true,
              })}

              {renderCompanyPortalOption(manageAvailableForAllUsers, setManageAvailableForAllUsers)}

              {manageMsg.msg && (
                <div style={{
                  marginBottom: 12, padding: '10px 12px', borderRadius: 6, fontSize: '0.8125rem',
                  background: manageMsg.type === 'error' ? '#2d1216' : '#052e16',
                  color: manageMsg.type === 'error' ? '#fca5a5' : '#86efac',
                }}>
                  {manageMsg.msg}
                </div>
              )}

              <button
                type="button"
                onClick={() => void saveManageEntry()}
                disabled={manageSaving}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '8px 20px', borderRadius: 6, border: 'none', fontWeight: 600,
                  fontSize: '0.8125rem', cursor: manageSaving ? 'not-allowed' : 'pointer',
                  background: manageSaving ? '#1a2e1a' : '#22c55e', color: manageSaving ? '#52525b' : '#052e16',
                  fontFamily: 'inherit',
                }}
              >
                {manageSaving ? <><Spinner /> Saving…</> : 'Save changes'}
              </button>
            </div>
          )}
        </div>
      )}

      {createModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, padding: 24, width: 360 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '0.9375rem', color: '#e4e4e7' }}>Create new group</h3>
            <label style={UI.lbl}>Group name</label>
            <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} style={{ ...inp, marginBottom: 12 }} autoFocus />
            <label style={UI.lbl}>Description (optional)</label>
            <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)} style={{ ...inp, marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setCreateModalOpen(false); setGroupModalForManage(false); }} style={UI.addBt}>Cancel</button>
              <button type="button" onClick={confirmCreateGroup} style={{ ...UI.addBt, borderStyle: 'solid', color: '#86efac', borderColor: '#166534' }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {removeModalOpen && manageEntry && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, padding: 24, width: 400 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.9375rem', color: '#e4e4e7' }}>Remove printer package?</h3>
            <p style={{ margin: '0 0 16px', fontSize: '0.8125rem', color: '#71717a' }}>
              This removes <strong style={{ color: '#e4e4e7' }}>{manageEntry.displayName}</strong> from Git ({manageEntry.target}). Run deploy to remove from Intune.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setRemoveModalOpen(false)} style={UI.addBt}>Cancel</button>
              <button type="button" onClick={() => void confirmRemove()} disabled={removing} style={{ ...UI.delBt, width: 'auto', height: 'auto', padding: '6px 14px' }}>
                {removing ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
