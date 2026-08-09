'use client';

import { readJsonApiResponse } from '@/lib/client/upload-json';
import { finalizeImportPaths, type ZipImportFile } from '@/lib/zip-import';

export const IMPORT_BATCH_SIZE = 10;
const UPLOAD_PROGRESS_WEIGHT = 0.8;
const POLL_MS = 1500;

export type ImportPhase = 'reading' | 'uploading' | 'committing' | 'done';

export interface ImportProgress {
  phase: ImportPhase;
  /** 0–100 */
  percent: number;
  uploaded: number;
  total: number;
  committed: number;
}

export interface RunBaselineImportOpts {
  files: ZipImportFile[];
  mspSlug: string;
  scope: string;
  pathPrefix: string;
  message: string;
  signal?: AbortSignal;
  onProgress: (p: ImportProgress) => void;
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Upload cancelled');
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  assertNotAborted(signal);
  const res = await fetch(url, { ...init, signal });
  return readJsonApiResponse<T & { error?: string }>(res) as Promise<T>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Upload cancelled'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Upload cancelled'));
      },
      { once: true },
    );
  });
}

/**
 * Staged baseline import: create job → upload batches of 10 → commit → poll.
 */
export async function runBaselineImport(opts: RunBaselineImportOpts): Promise<{ imported: number }> {
  const { mspSlug, scope, pathPrefix, message, signal, onProgress } = opts;
  const files = finalizeImportPaths(opts.files, { scope, pathPrefix });
  const total = files.length;

  if (total === 0) throw new Error('ZIP contains no importable files');

  onProgress({ phase: 'uploading', percent: 0, uploaded: 0, total, committed: 0 });

  const { jobId } = await fetchJson<{ jobId: string }>(
    '/api/git/import-jobs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mspSlug, scope, path: pathPrefix, message, totalFiles: total }),
    },
    signal,
  );

  let uploaded = 0;
  const batches = chunk(files, IMPORT_BATCH_SIZE);

  try {
    for (const batch of batches) {
      assertNotAborted(signal);
      const result = await fetchJson<{ uploaded: number; total: number }>(
        `/api/git/import-jobs/${jobId}/files`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: batch }),
        },
        signal,
      );
      uploaded = result.uploaded;
      const percent = Math.round((uploaded / total) * UPLOAD_PROGRESS_WEIGHT * 100);
      onProgress({ phase: 'uploading', percent, uploaded, total, committed: 0 });
    }

    onProgress({
      phase: 'committing',
      percent: Math.round(UPLOAD_PROGRESS_WEIGHT * 100),
      uploaded: total,
      total,
      committed: 0,
    });

    await fetchJson<{ phase: string }>(
      `/api/git/import-jobs/${jobId}/commit`,
      { method: 'POST' },
      signal,
    );

    for (;;) {
      assertNotAborted(signal);
      const status = await fetchJson<{
        phase: string;
        uploaded: number;
        total: number;
        committed: number;
        error: string | null;
      }>(`/api/git/import-jobs/${jobId}`, { method: 'GET' }, signal);

      if (status.phase === 'error') {
        throw new Error(status.error ?? 'Import commit failed');
      }

      if (status.phase === 'done') {
        onProgress({
          phase: 'done',
          percent: 100,
          uploaded: status.uploaded,
          total: status.total,
          committed: status.committed,
        });
        return { imported: status.committed };
      }

      const committed = Math.max(0, status.committed);
      const commitFraction = status.total > 0 ? committed / status.total : 0;
      const percent = Math.round(
        (UPLOAD_PROGRESS_WEIGHT + (1 - UPLOAD_PROGRESS_WEIGHT) * commitFraction) * 100,
      );
      onProgress({
        phase: 'committing',
        percent,
        uploaded: status.uploaded,
        total: status.total,
        committed,
      });

      await sleep(POLL_MS, signal);
    }
  } catch (err) {
    if (signal?.aborted) {
      try {
        await fetch(`/api/git/import-jobs/${jobId}`, { method: 'DELETE', signal });
      } catch {
        /* ignore cleanup errors */
      }
    }
    throw err;
  }
}
