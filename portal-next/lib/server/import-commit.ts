import 'server-only';
import * as gitea from '@/lib/server/gitea';
import type { BatchFileEntry } from '@/lib/server/gitea';
import { getTenantBySlug, getMspBySlug } from '@/lib/server/tenant-store';

export interface ImportTarget {
  org: string;
  repo: string;
}

export type ResolveImportTargetResult =
  | { ok: true; target: ImportTarget }
  | { ok: false; error: string; status: number };

export async function resolveImportTarget(
  scope: string | null,
  mspSlug: string | null,
  slug: string | null,
): Promise<ResolveImportTargetResult> {
  const platformOrg = process.env.GITEA_ORG ?? 'config365';
  if (scope === 'baseline') {
    let org = platformOrg;
    if (mspSlug) {
      const msp = await getMspBySlug(mspSlug);
      org = msp?.giteaOrg ?? platformOrg;
    }
    return { ok: true, target: { org, repo: 'baseline' } };
  }
  if (slug) {
    const t = await getTenantBySlug(slug);
    if (!t) return { ok: false, error: 'Tenant not found', status: 404 };
    return { ok: true, target: { org: t.giteaOrg, repo: `tenant-${t.slug}` } };
  }
  return { ok: false, error: 'Provide slug or scope=baseline', status: 400 };
}

async function importViaSequentialPut(
  org: string,
  repo: string,
  files: BatchFileEntry[],
  message: string,
  onProgress?: (committed: number) => void,
): Promise<number> {
  let imported = 0;
  for (const file of files) {
    const existing = await gitea.getFile(org, repo, file.path);
    await gitea.putFile(
      org,
      repo,
      file.path,
      file.content,
      `${message}: ${file.path}`,
      existing.exists ? existing.sha : undefined,
      'main',
      file.encoding === 'base64',
    );
    imported++;
    onProgress?.(imported);
  }
  return imported;
}

/** Commit staged files — local git batch (AIO) with sequential HTTP fallback. */
export async function commitImportFiles(
  org: string,
  repo: string,
  files: BatchFileEntry[],
  message: string,
  onProgress?: (committed: number) => void,
): Promise<number> {
  if (files.length === 0) throw new Error('No files to import');

  try {
    await gitea.batchPutFiles(org, repo, files, message, 'main', (done) => {
      onProgress?.(done);
    });
    onProgress?.(files.length);
    return files.length;
  } catch (batchErr) {
    const batchMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
    console.warn(`[import] batch commit failed (${files.length} files): ${batchMsg}`);
    console.warn('[import] falling back to sequential putFile');
    return importViaSequentialPut(org, repo, files, message, onProgress);
  }
}
