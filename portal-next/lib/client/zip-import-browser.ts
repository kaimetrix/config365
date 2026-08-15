'use client';

import {
  shouldSkipZipEntry,
  normalizeZipEntryName,
  finalizeImportPaths,
  isBinaryImportPath,
  ZIP_IMPORT_MAX_BYTES,
  type ZipImportFile,
} from '@/lib/zip-import';

export { ZIP_IMPORT_MAX_BYTES };

/** Read and unpack a ZIP in the browser before upload. */
export async function extractZipInBrowser(file: File): Promise<ZipImportFile[]> {
  if (file.size > ZIP_IMPORT_MAX_BYTES) {
    throw new Error(`ZIP must be under ${Math.round(ZIP_IMPORT_MAX_BYTES / (1024 * 1024))} MB`);
  }
  if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
    throw new Error('File must be a .zip archive');
  }

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const files: ZipImportFile[] = [];

  for (const [rawName, entry] of Object.entries(zip.files)) {
    if (entry.dir || shouldSkipZipEntry(rawName)) continue;
    const path = normalizeZipEntryName(rawName);
    const binary = isBinaryImportPath(path);
    files.push({
      path,
      content: await entry.async(binary ? 'base64' : 'string'),
      encoding: binary ? 'base64' : 'utf-8',
    });
  }

  if (files.length === 0) throw new Error('ZIP contains no importable files');
  return files;
}

/** Extract ZIP and normalize paths for MSP baseline repo layout (flattens baseline/baseline/, etc.). */
export async function extractBaselineZipInBrowser(
  file: File,
  pathPrefix = '',
): Promise<ZipImportFile[]> {
  const raw = await extractZipInBrowser(file);
  return finalizeImportPaths(raw, { scope: 'baseline', pathPrefix });
}
