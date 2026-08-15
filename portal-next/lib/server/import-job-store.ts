import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BatchFileEntry } from '@/lib/server/gitea';
import {
  finalizeImportPaths,
  normalizeZipEntryName,
  shouldSkipZipEntry,
  isBinaryImportPath,
  type ZipImportFile,
} from '@/lib/zip-import';
import { commitImportFiles } from '@/lib/server/import-commit';

export type ImportJobPhase = 'uploading' | 'committing' | 'done' | 'error' | 'cancelled';

export interface ImportJobMeta {
  id: string;
  phase: ImportJobPhase;
  mspSlug: string | null;
  slug: string | null;
  scope: string | null;
  pathPrefix: string;
  message: string;
  org: string;
  repo: string;
  totalFiles: number;
  uploadedFiles: number;
  committedFiles: number;
  error?: string;
  createdAt: number;
}

const JOBS_ROOT = process.env.IMPORT_JOBS_DIR ?? '/data/import-jobs';
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_BATCH_FILES = 10;

function jobDir(jobId: string): string {
  return path.join(JOBS_ROOT, jobId);
}

function metaPath(jobId: string): string {
  return path.join(jobDir(jobId), 'meta.json');
}

function filesDir(jobId: string): string {
  return path.join(jobDir(jobId), 'files');
}

function stagedFilePath(jobId: string, repoPath: string): string {
  const safe = repoPath.split('/').join(path.sep);
  return path.join(filesDir(jobId), safe);
}

function readMeta(jobId: string): ImportJobMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(jobId), 'utf-8');
    return JSON.parse(raw) as ImportJobMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: ImportJobMeta): void {
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
}

function ensureJobsRoot(): void {
  fs.mkdirSync(JOBS_ROOT, { recursive: true });
}

/** Best-effort cleanup of jobs older than 1 hour. */
export function cleanupStaleImportJobs(): void {
  try {
    ensureJobsRoot();
    const now = Date.now();
    for (const name of fs.readdirSync(JOBS_ROOT)) {
      const meta = readMeta(name);
      if (meta && now - meta.createdAt > JOB_TTL_MS) {
        deleteImportJob(name);
      }
    }
  } catch {
    /* ignore */
  }
}

export function createImportJob(opts: {
  mspSlug: string | null;
  slug: string | null;
  scope: string | null;
  pathPrefix: string;
  message: string;
  org: string;
  repo: string;
  totalFiles: number;
}): ImportJobMeta {
  cleanupStaleImportJobs();
  ensureJobsRoot();

  const id = randomUUID();
  const dir = jobDir(id);
  fs.mkdirSync(filesDir(id), { recursive: true });

  const meta: ImportJobMeta = {
    id,
    phase: 'uploading',
    mspSlug: opts.mspSlug,
    slug: opts.slug,
    scope: opts.scope,
    pathPrefix: opts.pathPrefix,
    message: opts.message,
    org: opts.org,
    repo: opts.repo,
    totalFiles: opts.totalFiles,
    uploadedFiles: 0,
    committedFiles: 0,
    createdAt: Date.now(),
  };
  writeMeta(meta);
  return meta;
}

export function getImportJob(jobId: string): ImportJobMeta | null {
  return readMeta(jobId);
}

function normalizeBatchPaths(
  files: ZipImportFile[],
  scope: string | null,
  pathPrefix: string,
): BatchFileEntry[] {
  const entries = files
    .map((f) => ({
      path: normalizeZipEntryName(f.path),
      content: f.content,
      encoding: f.encoding,
    }))
    .filter(({ path: p }) => !shouldSkipZipEntry(p));

  return finalizeImportPaths(entries, { scope, pathPrefix });
}

export function stageImportBatch(
  jobId: string,
  files: ZipImportFile[],
): { meta: ImportJobMeta } | { error: string; status: number } {
  const meta = readMeta(jobId);
  if (!meta) return { error: 'Import job not found', status: 404 };
  if (meta.phase !== 'uploading') {
    return { error: `Job is not accepting uploads (phase: ${meta.phase})`, status: 409 };
  }
  if (files.length === 0 || files.length > MAX_BATCH_FILES) {
    return { error: `Each batch must contain 1–${MAX_BATCH_FILES} files`, status: 400 };
  }

  const normalized = normalizeBatchPaths(files, meta.scope, meta.pathPrefix);
  if (normalized.length === 0) {
    return { error: 'No importable files in batch', status: 400 };
  }

  if (meta.uploadedFiles + normalized.length > meta.totalFiles) {
    return {
      error: `Batch exceeds job total (${meta.uploadedFiles + normalized.length} > ${meta.totalFiles})`,
      status: 400,
    };
  }

  for (const file of normalized) {
    const dest = stagedFilePath(jobId, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file.encoding === 'base64') {
      fs.writeFileSync(dest, Buffer.from(file.content, 'base64'));
    } else {
      fs.writeFileSync(dest, file.content, 'utf-8');
    }
  }

  meta.uploadedFiles += normalized.length;
  writeMeta(meta);
  return { meta };
}

function listStagedFiles(jobId: string, dir: string, prefix = ''): BatchFileEntry[] {
  const out: BatchFileEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) {
      out.push(...listStagedFiles(jobId, full, rel.replace(/\\/g, '/')));
    } else {
      const repoPath = rel.replace(/\\/g, '/');
      if (isBinaryImportPath(repoPath)) {
        out.push({
          path: repoPath,
          content: fs.readFileSync(full).toString('base64'),
          encoding: 'base64',
        });
      } else {
        out.push({
          path: repoPath,
          content: fs.readFileSync(full, 'utf-8'),
        });
      }
    }
  }
  return out;
}

export function deleteImportJob(jobId: string): void {
  try {
    fs.rmSync(jobDir(jobId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function cancelImportJob(jobId: string): ImportJobMeta | null {
  const meta = readMeta(jobId);
  if (!meta) return null;
  if (meta.phase === 'done' || meta.phase === 'committing') return meta;
  meta.phase = 'cancelled';
  writeMeta(meta);
  deleteImportJob(jobId);
  return meta;
}

/** Start async Gitea commit; returns immediately after marking phase=committing. */
export function startImportJobCommit(jobId: string): { meta: ImportJobMeta } | { error: string; status: number } {
  const meta = readMeta(jobId);
  if (!meta) return { error: 'Import job not found', status: 404 };
  if (meta.phase !== 'uploading') {
    return { error: `Job cannot be committed (phase: ${meta.phase})`, status: 409 };
  }
  if (meta.uploadedFiles !== meta.totalFiles) {
    return {
      error: `Not all files uploaded (${meta.uploadedFiles}/${meta.totalFiles})`,
      status: 400,
    };
  }

  meta.phase = 'committing';
  meta.committedFiles = 0;
  writeMeta(meta);

  void runImportJobCommit(jobId);

  return { meta };
}

async function runImportJobCommit(jobId: string): Promise<void> {
  const meta = readMeta(jobId);
  if (!meta || meta.phase !== 'committing') return;

  try {
    const files = listStagedFiles(jobId, filesDir(jobId));
    const imported = await commitImportFiles(
      meta.org,
      meta.repo,
      files,
      meta.message,
      (committed) => {
        const m = readMeta(jobId);
        if (m && m.phase === 'committing') {
          m.committedFiles = Math.max(0, committed);
          writeMeta(m);
        }
      },
    );

    const done = readMeta(jobId);
    if (!done) return;
    done.phase = 'done';
    done.committedFiles = imported;
    writeMeta(done);
    try {
      fs.rmSync(filesDir(jobId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } catch (err) {
    const failed = readMeta(jobId);
    if (!failed) return;
    failed.phase = 'error';
    failed.error = err instanceof Error ? err.message : String(err);
    writeMeta(failed);
  }
}

export { MAX_BATCH_FILES };
