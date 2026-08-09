/** Shared ZIP import path helpers — safe for browser and Node route handlers. */

export const ZIP_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

export function normalizeZipEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function shouldSkipZipEntry(entryName: string): boolean {
  const n = normalizeZipEntryName(entryName);
  if (!n) return true;
  if (n.startsWith('__MACOSX/') || n.includes('/__MACOSX/')) return true;
  if (n.endsWith('.DS_Store')) return true;
  return false;
}

export function applyImportPathPrefix(prefix: string, relPath: string): string {
  const p = prefix.replace(/\/$/, '');
  return p ? `${p}/${relPath}` : relPath;
}

/** Files that live at the baseline repo root — not under baseline/. */
const BASELINE_REPO_ROOT_FILES = new Set(['groups-config.json', 'README.md']);

function isBaselineRepoRootPath(relPath: string): boolean {
  if (BASELINE_REPO_ROOT_FILES.has(relPath)) return true;
  if (relPath.startsWith('maintenance/')) return true;
  return false;
}

/** Hoist groups-config.json from common export layouts to repo root. */
function hoistRepoRootConfig(path: string): string {
  if (path === 'baseline/groups-config.json') return 'groups-config.json';
  return path;
}

export interface ZipImportFile {
  path: string;
  content: string;
}

export function buildImportFileList(
  entries: ZipImportFile[],
  pathPrefix: string,
): ZipImportFile[] {
  return entries.map(({ path, content }) => ({
    path: applyImportPathPrefix(pathPrefix, path),
    content,
  }));
}

/** Strip one shared top-level folder when it wraps a baseline checkout (e.g. main/baseline/…). */
function stripSingleZipRoot(entries: ZipImportFile[]): ZipImportFile[] {
  if (entries.length === 0) return entries;
  const roots = new Set(entries.map((e) => e.path.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) return entries;
  const root = [...roots][0]!;
  if (root === 'baseline' || root === 'baseline-remove') return entries;

  const strip = `${root}/`;
  const inner = entries.map((e) => (e.path.startsWith(strip) ? e.path.slice(strip.length) : e.path));
  const isBaselineWrapper = inner.some(
    (p) => p.startsWith('baseline/') || p === 'baseline' || p.startsWith('baseline-remove/'),
  );
  if (!isBaselineWrapper) return entries;

  return entries.map((e) => ({
    ...e,
    path: e.path.startsWith(strip) ? e.path.slice(strip.length) : e.path,
  }));
}

/**
 * Normalize paths when importing into the MSP baseline Gitea repo.
 *
 * Handles zips exported from a full baseline checkout:
 * - baseline/baseline/exchange/… → baseline/exchange/…
 * - baseline/baseline-remove/… → baseline-remove/…
 * - exchange/… (bare) → baseline/exchange/…
 * - main/baseline/baseline/… → baseline/exchange/… (strip wrapper folder first)
 */
export function normalizeBaselineImportPaths(
  entries: ZipImportFile[],
  pathPrefix = '',
): ZipImportFile[] {
  let files = entries.map(({ path, content }) => ({
    path: normalizeZipEntryName(path),
    content,
  }));

  for (let i = 0; i < 3; i++) {
    files = stripSingleZipRoot(files);
    files = files.map(({ path, content }) => ({
      path: path
        .replace(/^baseline\/baseline\//, 'baseline/')
        .replace(/^baseline\/baseline-remove\//, 'baseline-remove/'),
      content,
    }));
  }

  files = files.map(({ path, content }) => ({
    path: hoistRepoRootConfig(
      !path.startsWith('baseline/') && !path.startsWith('baseline-remove/')
        ? isBaselineRepoRootPath(path)
          ? path
          : applyImportPathPrefix('baseline', path)
        : path,
    ),
    content,
  }));

  if (pathPrefix.trim()) {
    files = buildImportFileList(files, pathPrefix);
  }

  return files;
}

/** Finalize import paths for the given scope (baseline repo layout vs tenant paths). */
export function finalizeImportPaths(
  entries: ZipImportFile[],
  opts: { scope: string | null; pathPrefix: string },
): ZipImportFile[] {
  if (opts.scope === 'baseline' && !opts.pathPrefix.trim()) {
    return normalizeBaselineImportPaths(entries, '');
  }
  return buildImportFileList(entries, opts.pathPrefix);
}
