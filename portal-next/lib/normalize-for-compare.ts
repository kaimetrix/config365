/**
 * Shared normalization utilities for policy comparison.
 *
 * Field exclusion lists live in runner/scripts/compare-ignore-fields/ (canonical source
 * for PowerShell) and are mirrored into portal-next/lib/compare-ignore-fields/ for local
 * TypeScript development. The Dockerfile COPY instruction keeps the Docker build in sync
 * with the runner/scripts/ source.
 *
 * To add a new policy type: add a JSON file in both directories, import it below,
 * and add an entry to BY_PATH.
 */

import common              from './compare-ignore-fields/common.json';
import intune              from './compare-ignore-fields/intune.json';
import conditionalAccess   from './compare-ignore-fields/conditional-access.json';
import authPolicies        from './compare-ignore-fields/authentication-policies.json';
import exchange            from './compare-ignore-fields/exchange.json';
import consentPermissions  from './compare-ignore-fields/consent-permissions.json';
import enterpriseApps      from './compare-ignore-fields/enterprise-apps.json';
import informationProtection from './compare-ignore-fields/information-protection.json';

const BY_PATH: Array<[string, string[]]> = [
  ['intune/',                        intune.fields],
  ['conditional-access/',            conditionalAccess.fields],
  ['authentication-policies/',       authPolicies.fields],
  ['exchange/',                      exchange.fields],
  ['entra-id-consentpermissions/',   consentPermissions.fields],
  ['enterprise-apps/',               enterpriseApps.fields],
  ['information-protection/',        informationProtection.fields],
];

function buildIgnoreSet(filePath?: string): Set<string> {
  const typeFields = filePath
    ? (BY_PATH.find(([prefix]) => filePath.startsWith(prefix))?.[1] ?? [])
    : [];
  return new Set([...common.fields, ...typeFields]);
}

function stripIgnoredFields(val: unknown, ignore: Set<string>): unknown {
  if (Array.isArray(val)) {
    return val.map(v => stripIgnoredFields(v, ignore));
  }
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .filter(([k]) => !ignore.has(k) && !(common.odataWildcard && k.includes('@odata.')))
        .map(([k, v]) => [k, stripIgnoredFields(v, ignore)])
    );
  }
  return val;
}

/**
 * Strips all metadata/ignorable fields from a parsed JSON value based on its file path.
 * Exported for use in ViewerClient where the caller applies further monitor-config
 * filtering after this step.
 */
export function stripMetadataFields(val: unknown, filePath?: string): unknown {
  return stripEncryptedValues(stripIgnoredFields(val, buildIgnoreSet(filePath)));
}

/**
 * Multi-segment all-zero strings (e.g. "0000-00-00", "0.0.0") are sentinel
 * "not configured" values that the Graph API uses interchangeably with null.
 * Canonicalize them to null so the comparison treats them as equal.
 * Plain "0" is intentionally excluded — it may carry meaning in other contexts.
 */
const ZERO_LIKE = /^0+([-.]0+)+$/;

export function normalizeZeroLike(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(normalizeZeroLike);
  if (val !== null && typeof val === 'object')
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, normalizeZeroLike(v)])
    );
  if (typeof val === 'string' && ZERO_LIKE.test(val)) return null;
  return val;
}

/**
 * Strips keys whose value is null or an empty array, mirroring what
 * PowerShell's Normalize-Recursive does. Run after normalizeZeroLike so
 * that zero-like strings canonicalized to null are also removed.
 */
export function stripNullAndEmpty(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(stripNullAndEmpty).filter(v => v !== null);
  }
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .map(([k, v]) => [k, stripNullAndEmpty(v)])
        .filter(([, v]) => v !== null && !(Array.isArray(v) && (v as unknown[]).length === 0))
    );
  }
  return val;
}

/**
 * Normalizes field types that the Graph API returns inconsistently.
 * roleScopeTagIds may be a bare string or an array — always coerce to array
 * for consistent comparison (mirrors PowerShell's Normalize-PolicyForComparison).
 */
export function normalizeFieldTypes(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(normalizeFieldTypes);
  if (val !== null && typeof val === 'object') {
    const obj = Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, normalizeFieldTypes(v)])
    );
    if ('roleScopeTagIds' in obj && typeof obj.roleScopeTagIds === 'string') {
      obj.roleScopeTagIds = [obj.roleScopeTagIds];
    }
    return obj;
  }
  return val;
}

/**
 * Strips the `value` field from any object whose `valueState` is `"encryptedValueToken"`.
 * The MDE onboarding blob and similar enrollment tokens are tenant-specific encrypted
 * payloads that will always differ between tenants and should not trigger a conflict.
 */
export function stripEncryptedValues(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(stripEncryptedValues);
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, stripEncryptedValues(v)])
    );
    if (result['valueState'] === 'encryptedValueToken') {
      delete result['value'];
    }
    return result;
  }
  return val;
}

/**
 * PowerShell's ConvertTo-Json unwraps single-element arrays into plain objects.
 * Fields that the Graph API always returns as arrays (omaSettings, definitionValues)
 * must be re-wrapped so baseline [{ ... }] and backup { ... } compare as equal.
 */
const KNOWN_ARRAY_FIELDS = new Set(['omaSettings', 'definitionValues']);

export function normalizeKnownArrayFields(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(normalizeKnownArrayFields);
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => {
        if (KNOWN_ARRAY_FIELDS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
          return [k, [normalizeKnownArrayFields(v)]];
        }
        return [k, normalizeKnownArrayFields(v)];
      })
    );
  }
  return val;
}

export function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(sortKeysDeep).sort((a, b) => {
      const as = JSON.stringify(a) ?? '';
      const bs = JSON.stringify(b) ?? '';
      return as < bs ? -1 : as > bs ? 1 : 0;
    });
  }
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.keys(val as object).sort().map(k => [k, sortKeysDeep((val as Record<string, unknown>)[k])])
    );
  }
  return val;
}

/**
 * Full normalization pipeline: strip metadata → sort keys → serialize.
 * Used by the diff-status API route for bulk comparison.
 */
export function normalizeForCompare(rawStr: string, filePath?: string): string {
  try {
    const jsonStr  = rawStr.replace(/^\uFEFF/, ''); // strip UTF-8 BOM
    const ignore   = buildIgnoreSet(filePath);
    const parsed   = JSON.parse(jsonStr);
    const stripped = stripIgnoredFields(parsed, ignore);
    const typed    = normalizeFieldTypes(stripped);
    const arrayed  = normalizeKnownArrayFields(typed);
    const zeroed   = normalizeZeroLike(arrayed);
    const noEnc    = stripEncryptedValues(zeroed);
    const cleaned  = stripNullAndEmpty(noEnc);
    return JSON.stringify(sortKeysDeep(cleaned));
  } catch {
    return rawStr;
  }
}
