/**
 * /api/git/admx
 *
 * GET  ?mspSlug=  → list ADMX definitions from MSP baseline repo
 * PUT             → upload .admx / .adml files for a definition
 * DELETE          → remove an entire definition (json + admx + all adml)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getMspBySlug } from '@/lib/server/tenant-store';
import { getGitTree, getFile, putFile, deleteFile } from '@/lib/server/gitea';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

const ADMX_PATH = 'baseline/intune/admx-files';

// ─── GET — list definitions ───────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const mspSlug = request.nextUrl.searchParams.get('mspSlug');
  if (!mspSlug) return json({ error: 'mspSlug required' }, 400);
  const msp = await getMspBySlug(mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const org = msp.giteaOrg;
  const repo = 'baseline';

  try {
    const tree = await getGitTree(org, repo).catch(() => []);
    const inAdmx = tree.filter(e => e.type === 'blob' && e.path.startsWith(ADMX_PATH + '/'));

    // Build sets for .admx and .adml presence
    const admxNames = new Set(
      inAdmx.filter(e => e.path.endsWith('.admx'))
             .map(e => (e.path.split('/').pop() ?? '').replace(/\.admx$/, ''))
    );
    const admlByBase = new Map<string, string[]>();
    for (const e of inAdmx) {
      if (!e.path.endsWith('.adml')) continue;
      const fname = e.path.split('/').pop() ?? '';
      const withoutExt = fname.replace(/\.adml$/i, '');
      const dot = withoutExt.indexOf('.');
      if (dot === -1) continue;
      const base = withoutExt.slice(0, dot);
      const lang = withoutExt.slice(dot + 1);
      if (!admlByBase.has(base)) admlByBase.set(base, []);
      admlByBase.get(base)!.push(lang);
    }

    const jsonFiles = inAdmx.filter(e => e.path.endsWith('.json'));

    type DefItem = { baseName: string; displayName: string; fileName: string; description: string; languageCodes: string[]; hasAdmx: boolean };

    const results = await Promise.allSettled(jsonFiles.map(async (e): Promise<DefItem> => {
      const f = await getFile(org, repo, e.path);
      const baseName = (e.path.split('/').pop() ?? '').replace(/\.json$/, '');
      let displayName = baseName, fileName = baseName + '.admx', description = '';
      let languageCodes: string[] = [];
      if (f.exists) {
        try {
          const p = JSON.parse(f.content);
          if (p.displayName) displayName = p.displayName;
          if (p.fileName)    fileName    = p.fileName;
          if (p.description) description = p.description;
          if (Array.isArray(p.languageCodes)) languageCodes = p.languageCodes;
        } catch { /* fallback */ }
      }
      const detected = admlByBase.get(baseName);
      if (detected?.length) languageCodes = Array.from(new Set([...languageCodes, ...detected])).sort();
      return { baseName, displayName, fileName, description, languageCodes, hasAdmx: admxNames.has(baseName) };
    }));

    const defs = results
      .filter((r): r is PromiseFulfilledResult<DefItem> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return json({ definitions: defs });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

// ─── PUT — upload files ───────────────────────────────────────────────────────

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: {
    mspSlug: string;
    baseName: string;
    displayName?: string;
    description?: string;
    admxBase64?: string;           // binary .admx file as base64
    admlFiles?: Array<{ fileName: string; base64: string }>; // each: {baseName}.{lang}.adml
  };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const msp = await getMspBySlug(body.mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const org  = msp.giteaOrg;
  const repo = 'baseline';
  const base = `${ADMX_PATH}/${body.baseName}`;

  try {
    const ops: Promise<unknown>[] = [];

    // Strip UTF-8 BOM from XML content — the Microsoft GroupPolicy Admin Service
    // rejects ADMX/ADML uploads that begin with a BOM (returns HTTP 500).
    function stripBom(s: string): string {
      return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    }

    // Upsert .admx if provided
    if (body.admxBase64) {
      const admxPath = `${base}.admx`;
      const existing = await getFile(org, repo, admxPath);
      const content  = stripBom(Buffer.from(body.admxBase64, 'base64').toString('utf-8'));
      ops.push(putFile(org, repo, admxPath, content, `portal: upload ${body.baseName}.admx`, existing.exists ? existing.sha : undefined));
    }

    // Upsert each .adml file
    for (const adml of body.admlFiles ?? []) {
      const admlPath = `${base}.${adml.fileName.replace(/^.*?\./, '')}`;
      const existing = await getFile(org, repo, admlPath);
      const content  = stripBom(Buffer.from(adml.base64, 'base64').toString('utf-8'));
      ops.push(putFile(org, repo, admlPath, content, `portal: upload ${adml.fileName}`, existing.exists ? existing.sha : undefined));
    }

    // Upsert metadata JSON
    const jsonPath  = `${base}.json`;
    const existJson = await getFile(org, repo, jsonPath);
    let meta: Record<string, unknown> = {};
    if (existJson.exists) { try { meta = JSON.parse(existJson.content); } catch { /* start fresh */ } }
    if (body.displayName) meta.displayName = body.displayName;
    if (body.description) meta.description = body.description;
    meta.fileName = body.baseName + '.admx';
    // Merge language codes from new adml files
    const newLangs = (body.admlFiles ?? []).map(a => {
      const parts = a.fileName.replace(/\.adml$/i, '').split('.');
      return parts.length >= 2 ? parts[parts.length - 1] : '';
    }).filter(Boolean);
    if (newLangs.length) {
      const existing = Array.isArray(meta.languageCodes) ? meta.languageCodes as string[] : [];
      meta.languageCodes = Array.from(new Set([...existing, ...newLangs])).sort();
    }
    ops.push(putFile(org, repo, jsonPath, JSON.stringify(meta, null, 2) + '\n', `portal: update ${body.baseName} ADMX metadata`, existJson.exists ? existJson.sha : undefined));

    await Promise.all(ops);
    return json({ ok: true });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}

// ─── DELETE — remove entire definition ───────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  let body: { mspSlug: string; baseName: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const msp = await getMspBySlug(body.mspSlug);
  if (!msp) return json({ error: 'MSP not found' }, 404);

  const org  = msp.giteaOrg;
  const repo = 'baseline';
  const base = `${ADMX_PATH}/${body.baseName}`;

  try {
    const tree = await getGitTree(org, repo).catch(() => []);
    const toDelete = tree.filter(e =>
      e.type === 'blob' &&
      e.path.startsWith(base + '.') &&
      (e.path.endsWith('.json') || e.path.endsWith('.admx') || e.path.endsWith('.adml'))
    );

    await Promise.all(toDelete.map(e =>
      deleteFile(org, repo, e.path, e.sha ?? '', `portal: delete ADMX definition ${body.baseName}`)
    ));

    return json({ ok: true, deleted: toDelete.length });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
