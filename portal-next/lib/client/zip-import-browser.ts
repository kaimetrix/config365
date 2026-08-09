'use client';

import {
  shouldSkipZipEntry,
  normalizeZipEntryName,
  finalizeImportPaths,
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
    files.push({
      path: normalizeZipEntryName(rawName),
      content: await entry.async('string'),
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
