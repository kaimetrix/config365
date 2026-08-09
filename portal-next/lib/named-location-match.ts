/**
 * Match sign-in IP addresses against Entra Conditional Access named locations
 * from tenant backup (ipNamedLocation CIDR ranges).
 */

export interface NamedLocationRecord {
  displayName: string;
  odataType: string;
  ipRanges: string[];
  countriesAndRegions: string[];
}

function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return (((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3]) >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const trimmed = cidr.trim();
  if (!trimmed.includes('/')) {
    return ip.trim() === trimmed;
  }

  const [range, bitsStr] = trimmed.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;

  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

export function matchIpToNamedLocations(
  ip: string,
  locations: NamedLocationRecord[],
): string[] {
  if (!ip || !ip.includes('.')) return [];

  const matches: string[] = [];
  for (const loc of locations) {
    if (!loc.odataType.includes('ipNamedLocation') && loc.ipRanges.length === 0) continue;
    for (const cidr of loc.ipRanges) {
      if (cidr && ipInCidr(ip, cidr)) {
        matches.push(loc.displayName);
        break;
      }
    }
  }
  return matches;
}

export function parseNamedLocationBackup(raw: Record<string, unknown>): NamedLocationRecord | null {
  const displayName = typeof raw.displayName === 'string' ? raw.displayName : '';
  if (!displayName) return null;

  const odataType = typeof raw['@odata.type'] === 'string' ? raw['@odata.type'] : '';
  const ipRanges: string[] = [];
  if (Array.isArray(raw.ipRanges)) {
    for (const range of raw.ipRanges) {
      if (range && typeof range === 'object' && typeof (range as { cidrAddress?: string }).cidrAddress === 'string') {
        ipRanges.push((range as { cidrAddress: string }).cidrAddress);
      }
    }
  }

  const countriesAndRegions = Array.isArray(raw.countriesAndRegions)
    ? raw.countriesAndRegions.filter((c): c is string => typeof c === 'string')
    : [];

  return { displayName, odataType, ipRanges, countriesAndRegions };
}
