/** Pure helpers for OS threshold comparison (no I/O). */

export function isDottedNumericVersion(value: string): boolean {
  return /^\d+(\.\d+)*$/.test(value.trim());
}

/**
 * Intune Windows osMinimumVersion is `10.0.{build}[.{ubr}]`.
 * MDE often stores only the build (`22631` or `22631.4037`) in osBuild,
 * and leaves osVersion empty or as a marketing label (`22H2`).
 */
export function normalizeOsVersion(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // Intune/MDE macOS strings look like "26.6.1 (25G76)" or "Version 15.3.1 (24D70)".
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const dotted = s.match(/(\d+(?:\.\d+)+)/)?.[1];
  if (dotted) s = dotted;
  else if (!isDottedNumericVersion(s)) return '';
  const first = parseInt(s.split('.')[0] ?? '0', 10) || 0;
  if (first >= 10000) return `10.0.${s}`;
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
