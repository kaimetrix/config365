/** Shared JSON normalization for timeline diff — strips volatile metadata fields. */
export const TIMELINE_IGNORE_FIELDS = new Set([
  'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 'deletedDateTime',
  'creationSource', 'id', 'sourceId', 'version', '@odata.context',
]);

export function normalizeJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeJson);
  if (v !== null && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      if (!TIMELINE_IGNORE_FIELDS.has(k) && !k.includes('@odata.')) {
        acc[k] = normalizeJson((v as Record<string, unknown>)[k]);
      }
      return acc;
    }, {});
  }
  return v;
}

export function normalizedJsonText(raw: string | null): string {
  if (!raw) return '';
  try {
    return JSON.stringify(normalizeJson(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}

/** True when before/after differ after stripping volatile JSON metadata fields. */
export function contentDiffers(before: string | null, after: string | null): boolean {
  if (!before && !after) return false;
  if (!before || !after) return true;
  return normalizedJsonText(before) !== normalizedJsonText(after);
}
