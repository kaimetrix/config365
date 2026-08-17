/** Pure helpers for OS threshold comparison (no I/O). */

export function isDottedNumericVersion(value: string): boolean {
  return /^\d+(\.\d+)*$/.test(value.trim());
}

/** MDE Android osBuild is often the security-patch date (`20260705`), not a Windows NT build. */
const ANDROID_PATCH_DATE = /^(?:10\.0\.)?(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

export function androidPatchFromBuild(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  const m = String(raw).trim().match(ANDROID_PATCH_DATE);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Intune Windows osMinimumVersion is `10.0.{build}[.{ubr}]`.
 * MDE often stores only the build (`22631` or `22631.4037`) in osBuild,
 * and leaves osVersion empty or as a marketing label (`22H2`).
 *
 * Android MDE uses osBuild as YYYYMMDD (and older backups prefixed that as
 * `10.0.20260705`). Those are patch dates, not OS versions.
 */
export function normalizeOsVersion(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';

  const release = s.match(/Release\s+(\d+(?:\.\d+)*)/i);
  if (release?.[1]) return release[1];

  if (ANDROID_PATCH_DATE.test(s)) return '';

  // Intune/MDE macOS strings look like "26.6.1 (25G76)" or "Version 15.3.1 (24D70)".
  // Extract a dotted version from inside parens before stripping them so
  // "Android (Release 16.0 Build 20260705)" still yields 16.0.
  const dottedInParens = s.match(/\((?:Release\s+)?(\d+(?:\.\d+)+)/i)?.[1];
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const dotted = dottedInParens || s.match(/(\d+(?:\.\d+)+)/)?.[1];
  if (dotted) {
    if (ANDROID_PATCH_DATE.test(dotted)) return '';
    s = dotted;
  } else if (!isDottedNumericVersion(s)) {
    return '';
  }
  const first = parseInt(s.split('.')[0] ?? '0', 10) || 0;
  if (first >= 10000) {
    if (ANDROID_PATCH_DATE.test(String(first))) return '';
    return `10.0.${s}`;
  }
  return s;
}

export function resolveDeviceOsVersion(device: {
  osVersion?: string | number | null;
  osBuild?: string | number | null;
}): string {
  return normalizeOsVersion(device.osVersion) || normalizeOsVersion(device.osBuild);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export function deviceBelowThreshold(
  device: { osVersion?: string | number | null; osBuild?: string | number | null },
  threshold: string,
): boolean {
  if (!threshold) return false;
  const version = resolveDeviceOsVersion(device);
  if (!version) return false;
  return compareVersions(version, normalizeOsVersion(threshold) || threshold) < 0;
}
