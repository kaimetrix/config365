import { existsSync, readFileSync, statSync } from 'fs';

export const INTUNEWIN_CLI_DEST =
  process.env.INTUNEWIN_CLI_DEST ?? '/usr/local/share/config365/tools/intunewin';

export const INTUNEWIN_CLI_VERSION_JSON =
  process.env.INTUNEWIN_CLI_VERSION_JSON ?? '/usr/local/share/config365/tools-fallback/intunewin.version.json';

const VERSION_JSON_CANDIDATES = [
  INTUNEWIN_CLI_VERSION_JSON,
  '/usr/local/share/config365/tools-fallback/intunewin.version.json',
];

export interface IntuneWinPackagerInfo {
  path: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
  version: string | null;
  sourceUrl: string | null;
}

export interface IntuneWinPackagerStatus {
  nativeCli: IntuneWinPackagerInfo;
}

function fileInfo(path: string): { sizeBytes: number; modifiedAt: string } | null {
  try {
    const st = statSync(path);
    return { sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

function readJsonField(candidates: string[], field: string): string | null {
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const json = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      const val = json[field];
      if (typeof val === 'string' && val) return val;
    } catch { /* try next */ }
  }
  return null;
}

function packagerInfo(path: string | null): IntuneWinPackagerInfo {
  const version = readJsonField(VERSION_JSON_CANDIDATES, 'version');
  const sourceUrl = readJsonField(VERSION_JSON_CANDIDATES, 'sourceUrl');
  const info = path ? fileInfo(path) : null;
  return {
    path,
    sizeBytes: info?.sizeBytes ?? null,
    modifiedAt: info?.modifiedAt ?? null,
    version,
    sourceUrl,
  };
}

export function getIntuneWinPackagerStatus(): IntuneWinPackagerStatus {
  const path = existsSync(INTUNEWIN_CLI_DEST) ? INTUNEWIN_CLI_DEST : null;
  return { nativeCli: packagerInfo(path) };
}
