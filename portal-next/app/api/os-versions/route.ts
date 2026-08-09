/**
 * GET /api/os-versions
 *
 * Returns latest OS version and patch information for iOS, Android, Windows, macOS.
 * Fetches from endoflife.date API v1 and Android Security Bulletin.
 * Results are cached in-process for 6 hours.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlatformVersionInfo {
  version: string;
  releaseDate: string | null;
  supported: boolean;
  source: string;
  supportedVersions: string[];
  extendedVersions?: string[];
  patchDate?: string | null;
  windowsReleases?: WindowsRelease[];
}

export interface WindowsRelease {
  label: string;
  channel: string;
  buildNumber: string;
  eolDate: string | null;
  isEol: boolean;
}

interface EolRelease {
  name: string;
  codename: string | null;
  label: string;
  releaseDate: string;
  isEol: boolean;
  eolFrom: string | null;
  isMaintained: boolean;
  latest: { name: string; date: string; link: string } | null;
}

// ─── endoflife.date v1 ────────────────────────────────────────────────────────

const EOL_V1 = 'https://endoflife.date/api/v1';

async function fetchEolReleases(product: string): Promise<EolRelease[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
    try {
      const res = await fetch(`${EOL_V1}/products/${product}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Config365/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`endoflife.date /${product} returned ${res.status}`);
      const wrapper = await res.json() as { result?: { releases: EolRelease[] } };
      return wrapper.result?.releases ?? [];
    } catch { if (attempt === 2) throw new Error(`Failed to fetch ${product} from endoflife.date`); }
  }
  return [];
}

// ─── iOS ─────────────────────────────────────────────────────────────────────

async function fetchIosVersion(): Promise<PlatformVersionInfo> {
  const releases = await fetchEolReleases('ios');
  const grace = new Date(); grace.setDate(grace.getDate() - 90);
  const sorted = releases.filter(r => r.latest?.name).sort((a, b) => parseFloat(b.name) - parseFloat(a.name));
  const active = sorted.filter(r => !r.isEol || (r.eolFrom !== null && new Date(r.eolFrom) > grace));
  if (!active.length) throw new Error('No iOS releases found');
  return {
    version: active[0].latest!.name,
    releaseDate: active[0].latest!.date,
    supported: true,
    source: 'endoflife.date/api/v1/products/ios',
    supportedVersions: active.map(r => r.latest!.name),
    extendedVersions: sorted.map(r => r.latest!.name),
  };
}

// ─── Android ─────────────────────────────────────────────────────────────────

async function fetchAndroidPatchDate(): Promise<string | null> {
  const now = new Date();
  for (let delta = 0; delta <= 10; delta++) {
    const d = new Date(now.getFullYear(), now.getMonth() - delta, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const slug = `${yyyy}-${mm}-01`;
    const url = yyyy >= 2026
      ? `https://source.android.com/docs/security/bulletin/${yyyy}/${slug}`
      : `https://source.android.com/docs/security/bulletin/${slug}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const html = await res.text();
      if (/<td/i.test(html)) return slug;
    } catch { continue; }
  }
  return null;
}

async function fetchAndroidVersion(): Promise<PlatformVersionInfo> {
  const [relRes, patchRes] = await Promise.allSettled([fetchEolReleases('android'), fetchAndroidPatchDate()]);
  const releases = relRes.status === 'fulfilled' ? relRes.value : [];
  const patchDate = patchRes.status === 'fulfilled' ? patchRes.value : null;
  const sorted = releases.filter(r => r.name).sort((a, b) => parseFloat(b.name) - parseFloat(a.name));
  const maintained = sorted.filter(r => r.isMaintained);
  return {
    version: maintained[0]?.name ?? '—',
    releaseDate: patchDate,
    supported: true,
    source: 'endoflife.date/api/v1/products/android',
    supportedVersions: maintained.map(r => r.codename ? `${r.name} (${r.codename})` : r.name),
    extendedVersions: sorted.map(r => `${r.name}.0`),
    patchDate,
  };
}

// ─── macOS ────────────────────────────────────────────────────────────────────

async function fetchMacosVersion(): Promise<PlatformVersionInfo> {
  const releases = await fetchEolReleases('macos');
  const maintained = releases
    .filter(r => r.isMaintained && r.latest !== null)
    .sort((a, b) => parseFloat(b.name) - parseFloat(a.name));
  if (!maintained.length) throw new Error('No macOS releases found');
  return {
    version: maintained[0].latest!.name,
    releaseDate: maintained[0].latest!.date,
    supported: true,
    source: 'endoflife.date/api/v1/products/macos',
    supportedVersions: maintained.map(r => r.latest!.name),
  };
}

// ─── Windows ──────────────────────────────────────────────────────────────────

function stripWindowsEdition(label: string): string {
  return label.replace(/\s+IoT\b/g, '').replace(/\s*\([EW]\)\s*/g, '').replace(/\s*\(LTS\)\s*/g, '').trim();
}

async function fetchWindowsVersions(): Promise<PlatformVersionInfo> {
  const releases = await fetchEolReleases('windows');
  const maintained = releases
    .filter(r => r.isMaintained && r.latest?.name)
    .sort((a, b) => parseInt(b.latest!.name.split('.')[2] ?? '0', 10) - parseInt(a.latest!.name.split('.')[2] ?? '0', 10));
  const seenBuilds = new Set<string>();
  const deduped: EolRelease[] = [];
  for (const r of maintained) {
    if (!seenBuilds.has(r.latest!.name)) { seenBuilds.add(r.latest!.name); deduped.push(r); }
  }
  if (!deduped.length) throw new Error('No Windows releases found');
  const windowsReleases: WindowsRelease[] = deduped.map(r => ({
    label: `Windows ${stripWindowsEdition(r.label)}`,
    channel: r.label,
    buildNumber: `${r.latest!.name}.0`,
    eolDate: r.eolFrom,
    isEol: r.isEol,
  }));
  return {
    version: windowsReleases[0]?.label ?? '—',
    releaseDate: deduped[0]?.releaseDate ?? null,
    supported: true,
    source: 'endoflife.date/api/v1/products/windows',
    supportedVersions: windowsReleases.map(r => r.label),
    windowsReleases,
  };
}

// ─── Cache + handler ─────────────────────────────────────────────────────────

const CACHE_TTL = 6 * 60 * 60 * 1000;
const _cache: Partial<Record<string, { data: PlatformVersionInfo; at: number }>> = {};

async function getOrFetch(key: string, fetcher: () => Promise<PlatformVersionInfo>): Promise<PlatformVersionInfo> {
  const c = _cache[key];
  if (c && Date.now() - c.at < CACHE_TTL) return c.data;
  try {
    const data = await fetcher();
    _cache[key] = { data, at: Date.now() };
    return data;
  } catch (e) {
    return { version: 'unavailable', releaseDate: null, supported: false, source: String(e), supportedVersions: [] };
  }
}

export async function GET() {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const [ios, android, windows, macos] = await Promise.all([
    getOrFetch('ios',     fetchIosVersion),
    getOrFetch('android', fetchAndroidVersion),
    getOrFetch('windows', fetchWindowsVersions),
    getOrFetch('macos',   fetchMacosVersion),
  ]);

  return json({ ios, android, windows, macos });
}
