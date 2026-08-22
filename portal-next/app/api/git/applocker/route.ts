/**
 * /api/git/applocker
 *
 * GET  ?mspSlug=&slug?  → baseline AppLocker collections + tenant overlay(s)
 * PUT                   → save baseline RuleCollection or tenant overlay / create collection
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { requireMspAccess, requireTenantAccess } from '@/lib/server/authz';
import { listTenants } from '@/lib/server/tenant-store';
import { getGitTree, getTree, getFile, putFile } from '@/lib/server/gitea';
import {
  applyCollectionToDeviceConfig,
  BASELINE_DEVICE_CONFIG_DIR,
  TENANT_BACKUP_DEVICE_CONFIG_DIR,
  TENANT_IMPORT_MARKER_PATH,
  baselineFileNameFor,
  buildEmptyDeviceConfig,
  COLLECTION_TYPES,
  detectCollectionFromPolicy,
  emptyCollection,
  emptyOverlay,
  extractOmaSetting,
  isAppLockerFileName,
  overlayFromTenantBackup,
  overlayHasChanges,
  overlayPath,
  parseOverlayJson,
  parseRuleCollectionXml,
  type AppLockerOverlay,
  type ApplockerBackupImportStatus,
  type ApplockerBackupPolicy,
  type ApplockerTenantOverlayDto,
  type CollectionType,
  type EnforcementMode,
  type AppLockerRule,
  type ApplockerCollectionDto,
  type RuleCollection,
} from '@/lib/applocker';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

async function loadBaselineCollections(org: string): Promise<ApplockerCollectionDto[]> {
  const tree = await getGitTree(org, 'baseline').catch(() => []);
  const candidates = tree.filter(e => {
    if (e.type !== 'blob') return false;
    if (!e.path.startsWith(BASELINE_DEVICE_CONFIG_DIR + '/')) return false;
    if (!e.path.endsWith('.json')) return false;
    if (e.path.endsWith('.assignment.json') || e.path.endsWith('.monitor.json') || e.path.endsWith('.config.json')) return false;
    const fileName = e.path.split('/').pop() ?? '';
    return isAppLockerFileName(fileName);
  });

  const byType = new Map<CollectionType, ApplockerCollectionDto>();

  await Promise.all(candidates.map(async (e) => {
    const fileName = e.path.split('/').pop() ?? '';
    const f = await getFile(org, 'baseline', e.path);
    if (!f.exists) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(f.content); } catch { return; }
    const oma = extractOmaSetting(parsed);
    const type = detectCollectionFromPolicy(fileName, oma?.omaUri, oma?.value);
    if (!type || byType.has(type)) return;
    const col = oma?.value
      ? parseRuleCollectionXml(oma.value, type)
      : emptyCollection(type);
    byType.set(type, {
      type,
      path: e.path,
      sha: f.sha,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : fileName,
      omaUri: oma?.omaUri ?? '',
      enforcementMode: col.enforcementMode,
      rules: col.rules,
      exists: true,
      overlay: emptyOverlayDto(type),
      tenantOverlays: [],
    });
  }));

  return COLLECTION_TYPES.map(type => byType.get(type) ?? {
    type,
    path: `${BASELINE_DEVICE_CONFIG_DIR}/${baselineFileNameFor(type)}`,
    sha: null,
    displayName: `Baseline - Applocker ${type === 'Appx' ? 'appx' : type.toLowerCase()}`,
    omaUri: '',
    enforcementMode: 'NotConfigured' as EnforcementMode,
    rules: [],
    exists: false,
    overlay: emptyOverlayDto(type),
    tenantOverlays: [],
  });
}

function emptyOverlayDto(type: CollectionType): ApplockerCollectionDto['overlay'] {
  return {
    path: overlayPath(type),
    sha: null,
    exists: false,
    excludeRuleIds: [],
    rules: [],
  };
}

async function attachOverlays(
  org: string,
  tenantSlug: string,
  collections: ApplockerCollectionDto[],
): Promise<void> {
  await Promise.all(collections.map(async (c) => {
    const path = overlayPath(c.type);
    const f = await getFile(org, `tenant-${tenantSlug}`, path);
    if (!f.exists) return;
    const overlay = parseOverlayJson(safeJson(f.content));
    c.overlay = {
      path,
      sha: f.sha,
      exists: true,
      excludeRuleIds: overlay.excludeRuleIds,
      rules: overlay.rules,
      enforcementMode: overlay.enforcementMode,
    };
  }));
}

async function attachAllTenantOverlays(
  collections: ApplockerCollectionDto[],
  tenants: { slug: string; displayName: string; giteaOrg: string; isActive: number }[],
): Promise<void> {
  const active = tenants.filter(t => t.isActive);
  await Promise.all(active.map(async (tenant) => {
    await Promise.all(collections.map(async (c) => {
      try {
        const path = overlayPath(c.type);
        const f = await getFile(tenant.giteaOrg, `tenant-${tenant.slug}`, path);
        if (!f.exists) return;
        const overlay = parseOverlayJson(safeJson(f.content));
        if (!overlayHasChanges(overlay)) return;
        const entry: ApplockerTenantOverlayDto = {
          slug: tenant.slug,
          displayName: tenant.displayName,
          excludeRuleIds: overlay.excludeRuleIds,
          rules: overlay.rules,
          enforcementMode: overlay.enforcementMode,
        };
        (c.tenantOverlays ??= []).push(entry);
      } catch {
        // Missing tenant repo or overlay file — skip that tenant/collection.
      }
    }));
  }));

  for (const c of collections) {
    c.tenantOverlays = (c.tenantOverlays ?? []).sort((a, b) =>
      a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));
  }
}

function safeJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return null; }
}

interface BackupPolicyFile {
  type: CollectionType;
  path: string;
  displayName: string;
  collection: RuleCollection;
}

async function loadAppLockerBackupPolicies(
  org: string,
  repo: string,
  dir: string,
): Promise<BackupPolicyFile[]> {
  const dirs = [...new Set([dir, 'intune/device-configurations'])];
  const listed: { path: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    const tree = await getTree(org, repo, d).catch(() => []);
    for (const e of tree) {
      if (e.type !== 'file' || seen.has(e.path)) continue;
      if (!e.name.endsWith('.json')) continue;
      if (e.name.endsWith('.assignment.json') || e.name.endsWith('.monitor.json') || e.name.endsWith('.config.json')) continue;
      seen.add(e.path);
      listed.push({ path: e.path, name: e.name });
    }
  }
  const named = listed.filter(e => isAppLockerFileName(e.name));
  const candidates = named.length > 0 ? named : listed;

  const files = await Promise.all(candidates.map(async (e): Promise<BackupPolicyFile | null> => {
    const fileName = e.path.split('/').pop() ?? '';
    const f = await getFile(org, repo, e.path);
    if (!f.exists) return null;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(f.content); } catch { return null; }
    const oma = extractOmaSetting(parsed);
    const type = detectCollectionFromPolicy(fileName, oma?.omaUri, oma?.value);
    if (!type || !oma?.value) return null;
    try {
      return {
        type,
        path: e.path,
        displayName: typeof parsed.displayName === 'string' ? parsed.displayName : fileName,
        collection: parseRuleCollectionXml(oma.value, type),
      };
    } catch {
      return null;
    }
  }));

  return files.filter((f): f is BackupPolicyFile => !!f)
    .sort((a, b) => COLLECTION_TYPES.indexOf(a.type) - COLLECTION_TYPES.indexOf(b.type)
      || a.displayName.localeCompare(b.displayName));
}

function backupPolicyDtos(files: BackupPolicyFile[]): ApplockerBackupPolicy[] {
  return files.map(f => ({
    type: f.type,
    path: f.path,
    displayName: f.displayName,
    enforcementMode: f.collection.enforcementMode,
    ruleCount: f.collection.rules.length,
  }));
}

async function readImportStatus(org: string, tenantSlug: string, files: BackupPolicyFile[]): Promise<ApplockerBackupImportStatus> {
  const marker = await getFile(org, `tenant-${tenantSlug}`, TENANT_IMPORT_MARKER_PATH);
  let importedAt: string | undefined;
  if (marker.exists) {
    const parsed = safeJson(marker.content) as { importedAt?: string } | null;
    importedAt = typeof parsed?.importedAt === 'string' ? parsed.importedAt : undefined;
  }
  const types = [...new Set(files.map(f => f.type))];
  return {
    available: files.length > 0,
    imported: marker.exists,
    importedAt,
    types,
    policies: backupPolicyDtos(files),
  };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug = request.nextUrl.searchParams.get('mspSlug');
  const slug = request.nextUrl.searchParams.get('slug');
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);

  const mspGuard = await requireMspAccess(session.user, mspSlug);
  if (mspGuard instanceof NextResponse) return mspGuard;

  try {
    const collections = await loadBaselineCollections(mspGuard.giteaOrg);
    let backupImport: ApplockerBackupImportStatus | null = null;
    if (slug) {
      const tGuard = await requireTenantAccess(session.user, slug);
      if (tGuard instanceof NextResponse) return tGuard;
      await attachOverlays(tGuard.giteaOrg, slug, collections);
      const backups = await loadAppLockerBackupPolicies(tGuard.giteaOrg, `tenant-${slug}`, TENANT_BACKUP_DEVICE_CONFIG_DIR);
      backupImport = await readImportStatus(tGuard.giteaOrg, slug, backups);
    } else {
      const tenants = await listTenants(mspGuard.id);
      await attachAllTenantOverlays(collections, tenants);
    }
    return json({ collections, backupImport });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: {
    mspSlug: string;
    slug?: string;
    collection: CollectionType;
    create?: boolean;
    enforcementMode?: EnforcementMode;
    rules?: AppLockerRule[];
    sha?: string | null;
    overlay?: AppLockerOverlay;
    overlaySha?: string | null;
  };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.mspSlug || !body.collection) return json({ error: 'mspSlug and collection required' }, 400);
  if (!COLLECTION_TYPES.includes(body.collection)) return json({ error: 'Invalid collection' }, 400);

  const mspGuard = await requireMspAccess(session.user, body.mspSlug);
  if (mspGuard instanceof NextResponse) return mspGuard;

  try {
    if (body.slug) {
      const tGuard = await requireTenantAccess(session.user, body.slug);
      if (tGuard instanceof NextResponse) return tGuard;
      const path = overlayPath(body.collection);
      const overlay = parseOverlayJson(body.overlay ?? emptyOverlay());
      const content = JSON.stringify(overlay, null, 2) + '\n';
      const existing = await getFile(tGuard.giteaOrg, `tenant-${body.slug}`, path);
      await putFile(
        tGuard.giteaOrg,
        `tenant-${body.slug}`,
        path,
        content,
        `portal: update AppLocker ${body.collection} overlay`,
        existing.exists ? existing.sha : undefined,
      );
      return json({ ok: true, path });
    }

    const org = mspGuard.giteaOrg;
    const collections = await loadBaselineCollections(org);
    const current = collections.find(c => c.type === body.collection);
    const path = current?.path ?? `${BASELINE_DEVICE_CONFIG_DIR}/${baselineFileNameFor(body.collection)}`;

    if (body.create && !current?.exists) {
      const created = buildEmptyDeviceConfig(body.collection);
      await putFile(org, 'baseline', path, JSON.stringify(created, null, 2) + '\n',
        `portal: create AppLocker ${body.collection} collection`);
      return json({ ok: true, path });
    }

    const existing = await getFile(org, 'baseline', path);
    let parsed: Record<string, unknown>;
    if (existing.exists) {
      try { parsed = JSON.parse(existing.content); } catch { parsed = buildEmptyDeviceConfig(body.collection); }
    } else {
      parsed = buildEmptyDeviceConfig(body.collection);
    }

    const oma = extractOmaSetting(parsed);
    const baselineCol = oma?.value
      ? parseRuleCollectionXml(oma.value, body.collection)
      : emptyCollection(body.collection);

    const nextCol: RuleCollection = {
      type: body.collection,
      enforcementMode: body.enforcementMode ?? baselineCol.enforcementMode,
      rules: Array.isArray(body.rules) ? body.rules : baselineCol.rules,
    };
    const updated = applyCollectionToDeviceConfig(parsed, nextCol);
    await putFile(
      org,
      'baseline',
      path,
      JSON.stringify(updated, null, 2) + '\n',
      `portal: update AppLocker ${body.collection} rules`,
      existing.exists ? existing.sha : undefined,
    );
    return json({ ok: true, path });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

/** Import (or re-import) tenant AppLocker backups into overlays. */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { mspSlug?: string; slug?: string; types?: CollectionType[]; paths?: string[] };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body.mspSlug || !body.slug) return json({ error: 'mspSlug and slug required' }, 400);

  const mspGuard = await requireMspAccess(session.user, body.mspSlug);
  if (mspGuard instanceof NextResponse) return mspGuard;
  const tGuard = await requireTenantAccess(session.user, body.slug);
  if (tGuard instanceof NextResponse) return tGuard;

  try {
    const org = tGuard.giteaOrg;
    const repo = `tenant-${body.slug}`;
    const marker = await getFile(org, repo, TENANT_IMPORT_MARKER_PATH);

    const backups = await loadAppLockerBackupPolicies(org, repo, TENANT_BACKUP_DEVICE_CONFIG_DIR);
    if (backups.length === 0) return json({ error: 'No AppLocker policy found in this tenant backup.' }, 404);

    const selected = backups.filter(f => {
      if (Array.isArray(body.paths) && body.paths.length > 0) return body.paths.includes(f.path);
      if (Array.isArray(body.types) && body.types.length > 0) return body.types.includes(f.type);
      return true;
    });
    if (selected.length === 0) return json({ error: 'Select at least one AppLocker policy to import.' }, 400);

    const baselineByType = new Map<CollectionType, RuleCollection>();
    const baselineDtos = await loadBaselineCollections(mspGuard.giteaOrg);
    for (const c of baselineDtos) {
      baselineByType.set(c.type, { type: c.type, enforcementMode: c.enforcementMode, rules: c.rules });
    }

    const byType = new Map<CollectionType, RuleCollection>();
    for (const file of selected) {
      const prev = byType.get(file.type);
      if (!prev) {
        byType.set(file.type, file.collection);
        continue;
      }
      const seen = new Set(prev.rules.map(r => r.id.toLowerCase()));
      byType.set(file.type, {
        type: file.type,
        enforcementMode: file.collection.enforcementMode,
        rules: [...prev.rules, ...file.collection.rules.filter(r => !seen.has(r.id.toLowerCase()))],
      });
    }

    const imported: CollectionType[] = [];
    for (const type of COLLECTION_TYPES) {
      const tenantCol = byType.get(type);
      if (!tenantCol) continue;
      const baselineCol = baselineByType.get(type) ?? emptyCollection(type);
      const overlay = overlayFromTenantBackup(baselineCol, tenantCol);
      const path = overlayPath(type);
      const existing = await getFile(org, repo, path);
      if (!overlayHasChanges(overlay) && !existing.exists) continue;
      await putFile(
        org,
        repo,
        path,
        JSON.stringify(overlay, null, 2) + '\n',
        `portal: import AppLocker ${type} overlay from tenant backup`,
        existing.exists ? existing.sha : undefined,
      );
      imported.push(type);
    }

    const importedAt = new Date().toISOString();
    await putFile(
      org,
      repo,
      TENANT_IMPORT_MARKER_PATH,
      JSON.stringify({ importedAt, types: imported, written: imported }, null, 2) + '\n',
      'portal: record AppLocker tenant backup import',
      marker.exists ? marker.sha : undefined,
    );

    return json({ ok: true, imported, types: imported, importedAt });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
