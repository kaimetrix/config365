import { NextRequest, NextResponse } from 'next/server';
import { getSession, isPlatformAdmin } from '@/lib/server/session';
import type { BatchFileEntry } from '@/lib/server/gitea';
import { commitImportFiles, resolveImportTarget } from '@/lib/server/import-commit';
import {
  finalizeImportPaths,
  normalizeZipEntryName,
  shouldSkipZipEntry,
  ZIP_IMPORT_MAX_BYTES,
} from '@/lib/zip-import';
import AdmZip from 'adm-zip';

export const runtime = 'nodejs';
export const maxDuration = 300;

const FAST_PATH_MAX_FILES = 10;
const FAST_PATH_MAX_BYTES = 512 * 1024;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function filesFromZipBuffer(buf: Buffer, pathPrefix: string, scope: string | null): BatchFileEntry[] {
  const zip = new AdmZip(buf);
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && !shouldSkipZipEntry(e.entryName))
    .map((entry) => ({
      path: normalizeZipEntryName(entry.entryName),
      content: entry.getData().toString('utf-8'),
    }));

  return finalizeImportPaths(entries, { scope, pathPrefix });
}

interface JsonImportBody {
  mspSlug?: string | null;
  slug?: string | null;
  scope?: string | null;
  path?: string | null;
  message?: string | null;
  files?: Array<{ path?: string; content?: string }>;
}

function parseJsonImportFiles(
  body: JsonImportBody,
  pathPrefix: string,
  scope: string | null,
): BatchFileEntry[] | NextResponse {
  const raw = body.files;
  if (!Array.isArray(raw) || raw.length === 0) {
    return json({ error: 'files array is required' }, 400);
  }

  const entries: BatchFileEntry[] = [];
  let totalBytes = 0;

  for (const item of raw) {
    if (!item?.path || typeof item.content !== 'string') {
      return json({ error: 'Each file entry requires path and content' }, 400);
    }
    const rel = normalizeZipEntryName(item.path);
    if (shouldSkipZipEntry(rel)) continue;
    totalBytes += Buffer.byteLength(item.content, 'utf-8');
    if (totalBytes > ZIP_IMPORT_MAX_BYTES) {
      return json({ error: `Import payload exceeds ${Math.round(ZIP_IMPORT_MAX_BYTES / (1024 * 1024))} MB` }, 413);
    }
    entries.push({ path: rel, content: item.content });
  }

  if (entries.length === 0) return json({ error: 'No importable files in payload' }, 400);
  return finalizeImportPaths(entries, { scope, pathPrefix });
}

function tooLargeForFastPath(files: BatchFileEntry[]): boolean {
  if (files.length > FAST_PATH_MAX_FILES) return true;
  let bytes = 0;
  for (const f of files) {
    bytes += Buffer.byteLength(f.content, 'utf-8');
    if (bytes > FAST_PATH_MAX_BYTES) return true;
  }
  return false;
}

/**
 * POST /api/git/import-zip
 *
 * Fast path only: ≤10 files and ≤512 KB total. Larger imports use /api/git/import-jobs.
 * Legacy: multipart/form-data with a ZIP file (same size limits).
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);
  if (!isPlatformAdmin(session.user)) return json({ error: 'Forbidden' }, 403);

  try {
    const contentType = request.headers.get('content-type') ?? '';
    let slug: string | null = null;
    let mspSlug: string | null = null;
    let scope: string | null = null;
    let pathPrefix = '';
    let message = 'import: zip upload';
    let files: BatchFileEntry[];

    if (contentType.includes('application/json')) {
      const body = (await request.json()) as JsonImportBody;
      slug = body.slug ?? null;
      mspSlug = body.mspSlug ?? null;
      scope = body.scope ?? null;
      pathPrefix = body.path ?? '';
      message = body.message ?? message;

      const parsed = parseJsonImportFiles(body, pathPrefix, scope);
      if (parsed instanceof NextResponse) return parsed;
      files = parsed;
    } else {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      slug = formData.get('slug') as string | null;
      mspSlug = formData.get('mspSlug') as string | null;
      scope = formData.get('scope') as string | null;
      pathPrefix = (formData.get('path') as string | null) ?? '';
      message = (formData.get('message') as string | null) ?? message;

      if (!file) return json({ error: 'file is required' }, 400);
      if (file.size > ZIP_IMPORT_MAX_BYTES) {
        return json({ error: `ZIP must be under ${Math.round(ZIP_IMPORT_MAX_BYTES / (1024 * 1024))} MB` }, 413);
      }

      files = filesFromZipBuffer(Buffer.from(await file.arrayBuffer()), pathPrefix, scope);
      if (files.length === 0) return json({ error: 'ZIP contains no importable files' }, 400);
    }

    if (tooLargeForFastPath(files)) {
      return json(
        {
          error: `Import too large for sync path (${files.length} files). Use the baseline import job flow.`,
          useImportJobs: true,
        },
        413,
      );
    }

    const resolved = await resolveImportTarget(scope, mspSlug, slug);
    if (!resolved.ok) return json({ error: resolved.error }, resolved.status);

    const imported = await commitImportFiles(resolved.target.org, resolved.target.repo, files, message);
    return json({ ok: true, imported });
  } catch (err: unknown) {
    return json({ error: (err as Error).message }, 500);
  }
}
