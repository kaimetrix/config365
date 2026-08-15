/**
 * Shared monitor-sidecar helpers (file + folder .monitor.json).
 * Used by the policy viewer, baseline editor, and WhatIf Full files pane.
 */

export type MonitorConfig = { include?: string[]; exclude?: string[] } | null;

export function getSidecarPath(filePath: string): string {
  return filePath.replace(/\.json$/i, '.monitor.json');
}

export function getFolderSidecarPath(filePath: string): string {
  const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';
  return dir ? `${dir}/_default.monitor.json` : '_default.monitor.json';
}

export function parseMonitorConfig(raw: string | undefined | null): MonitorConfig {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { include?: unknown; exclude?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    const include = Array.isArray(parsed.include) ? parsed.include.filter((x): x is string => typeof x === 'string') : [];
    const exclude = Array.isArray(parsed.exclude) ? parsed.exclude.filter((x): x is string => typeof x === 'string') : [];
    return finalizeMonitorConfig(include, exclude);
  } catch {
    return null;
  }
}

function pathCoveredBy(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => path === p || path.startsWith(`${p}.`));
}

function finalizeMonitorConfig(include: string[], exclude: string[]): MonitorConfig {
  const exc = [...new Set(exclude)];
  const inc = [...new Set(include)].filter(p => !pathCoveredBy(p, exc));
  if (!inc.length && !exc.length) return null;
  const r: { include?: string[]; exclude?: string[] } = {};
  if (inc.length) r.include = inc;
  if (exc.length) r.exclude = exc;
  return r;
}

/**
 * Returns true if the dot-notation path is excluded by the monitor config.
 * - exclude list: ignored if path matches or is a descendant
 * - include list: ignored if path is NOT the target, not under it, not an ancestor of it
 */
export function isPathIgnored(path: string | null, config: MonitorConfig): boolean {
  if (!path || !config) return false;
  if (config.exclude?.length) {
    if (config.exclude.some(e => path === e || path.startsWith(`${e}.`))) return true;
  }
  if (config.include?.length) {
    return !config.include.some(
      e => path === e || path.startsWith(`${e}.`) || e.startsWith(`${path}.`)
    );
  }
  return false;
}

export function isPathIncluded(path: string | null, config: MonitorConfig): boolean {
  if (!path || !config?.include?.length) return false;
  return config.include.some(
    e => path === e || path.startsWith(`${e}.`) || e.startsWith(`${path}.`)
  );
}

/**
 * File-level rules win on conflicts (prefix-aware):
 * folder include AllowedSenders.Sender is dropped when file excludes AllowedSenders.
 * After merge, exclude wins over include for the same path / descendants.
 */
export function mergeMonitorConfigs(fileConfig: MonitorConfig, folderConfig: MonitorConfig): MonitorConfig {
  if (!fileConfig && !folderConfig) return null;
  if (!fileConfig) return finalizeMonitorConfig(folderConfig?.include ?? [], folderConfig?.exclude ?? []);
  if (!folderConfig) return finalizeMonitorConfig(fileConfig.include ?? [], fileConfig.exclude ?? []);
  const fInc = fileConfig.include ?? [];
  const fExc = fileConfig.exclude ?? [];
  const dInc = folderConfig.include ?? [];
  const dExc = folderConfig.exclude ?? [];
  const inc = [...fInc, ...dInc.filter(p => !pathCoveredBy(p, fExc))];
  const exc = [...fExc, ...dExc.filter(p => !pathCoveredBy(p, fInc))];
  return finalizeMonitorConfig(inc, exc);
}

export function applyFieldFilter(
  obj: unknown,
  filter: { include?: string[]; exclude?: string[] },
): unknown {
  if (!filter.include?.length && !filter.exclude?.length) return obj;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => applyFieldFilter(item, filter));

  const record = obj as Record<string, unknown>;

  function getByPath(o: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let cur: unknown = o;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  function setByPath(o: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let cur = o;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in cur) || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
        cur[parts[i]] = {};
      }
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }

  function deleteByPath(o: Record<string, unknown>, path: string): void {
    const parts = path.split('.');
    const stack: { obj: Record<string, unknown>; key: string }[] = [];
    let cur: unknown = o;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
      const rec = cur as Record<string, unknown>;
      stack.push({ obj: rec, key: parts[i] });
      cur = rec[parts[i]];
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const child = stack[i].obj[stack[i].key];
      if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child as object).length === 0) {
        delete stack[i].obj[stack[i].key];
      } else {
        break;
      }
    }
  }

  let result: Record<string, unknown>;
  if (filter.include?.length) {
    result = {};
    for (const path of filter.include) {
      const val = getByPath(record, path);
      if (val !== undefined) setByPath(result, path, val);
    }
  } else {
    result = { ...record };
  }

  if (filter.exclude?.length) {
    for (const path of filter.exclude) deleteByPath(result, path);
  }

  return result;
}
