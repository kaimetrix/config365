/**
 * WinGet package search — uses the official microsoft/winget-pkgs repo on GitHub
 * for exact ID lookups (matches `winget install --id Publisher.Package`).
 *
 * api.winget.run is kept as a fallback for fuzzy keyword search but its index
 * has not been updated since ~2023 and misses most current packages.
 */

export interface WingetPackage {
  id: string;
  displayName: string;
  version: string;
  summary: string;
  publisher?: string;
}

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Config365/1.0',
};

/** Map PackageIdentifier → manifests/{c}/{Publisher}/{Name} */
export function packageIdToManifestPath(id: string): string | null {
  const trimmed = id.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) return null;
  return `manifests/${trimmed[0].toLowerCase()}/${trimmed.slice(0, dot)}/${trimmed.slice(dot + 1)}`;
}

function yamlField(yaml: string, key: string): string {
  const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      if (va !== vb) return va - vb;
    } else if (String(va) !== String(vb)) {
      return String(va).localeCompare(String(vb));
    }
  }
  return 0;
}

async function fetchPackageById(id: string): Promise<WingetPackage | null> {
  const manifestPath = packageIdToManifestPath(id);
  if (!manifestPath) return null;

  const listRes = await fetch(
    `https://api.github.com/repos/microsoft/winget-pkgs/contents/${manifestPath}`,
    { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000), next: { revalidate: 3600 } },
  );
  if (!listRes.ok) return null;

  const entries = await listRes.json() as Array<{ name: string; type: string }>;
  const versions = entries
    .filter(e => e.type === 'dir' && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort(compareVersions);
  if (!versions.length) return null;

  const latest = versions[versions.length - 1];
  const localePath = `${manifestPath}/${latest}/${id}.locale.en-US.yaml`;
  let localeRes = await fetch(
    `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/${localePath}`,
    { signal: AbortSignal.timeout(12_000), next: { revalidate: 3600 } },
  );

  // Some packages only ship non-en-US locale files.
  if (!localeRes.ok) {
    const filesRes = await fetch(
      `https://api.github.com/repos/microsoft/winget-pkgs/contents/${manifestPath}/${latest}`,
      { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000), next: { revalidate: 3600 } },
    );
    if (!filesRes.ok) return null;
    const files = await filesRes.json() as Array<{ name: string; download_url?: string }>;
    const localeFile = files.find(f => f.name.endsWith('.locale.en-US.yaml'))
      ?? files.find(f => /\.locale\.[^.]+\.yaml$/.test(f.name));
    if (!localeFile?.download_url) return null;
    localeRes = await fetch(localeFile.download_url, {
      signal: AbortSignal.timeout(12_000), next: { revalidate: 3600 },
    });
    if (!localeRes.ok) return null;
  }

  const yaml = await localeRes.text();
  return {
    id,
    displayName: yamlField(yaml, 'PackageName') || yamlField(yaml, 'Moniker') || id,
    publisher: yamlField(yaml, 'Publisher'),
    version: yamlField(yaml, 'PackageVersion') || latest,
    summary: yamlField(yaml, 'ShortDescription').slice(0, 200),
  };
}

async function searchWingetRun(query: string): Promise<WingetPackage[]> {
  const url = `https://api.winget.run/v2/packages?query=${encodeURIComponent(query)}&take=30`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Config365/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WinGet API returned ${res.status}`);
  const data = await res.json() as {
    Packages?: Array<{
      Id: string;
      Latest?: { Name?: string; Publisher?: string; Description?: string };
      Versions?: string[];
    }>;
  };
  return (data.Packages ?? [])
    .filter(p => p.Id)
    .map(p => ({
      id:          p.Id,
      displayName: p.Latest?.Name ?? p.Id,
      publisher:   p.Latest?.Publisher ?? '',
      version:     p.Versions?.[0] ?? '',
      summary:     (p.Latest?.Description ?? '').slice(0, 200),
    }));
}

/** Search WinGet — exact ID via winget-pkgs GitHub, keywords via legacy index fallback. */
export async function searchWinget(query: string): Promise<WingetPackage[]> {
  const q = query.trim();
  if (!q) return [];

  const seen = new Set<string>();
  const results: WingetPackage[] = [];
  const add = (pkg: WingetPackage | null | undefined) => {
    if (!pkg || seen.has(pkg.id)) return;
    seen.add(pkg.id);
    results.push(pkg);
  };

  // Exact package ID (e.g. Anthropic.Claude) — same as `winget install --id`.
  if (q.includes('.')) {
    add(await fetchPackageById(q));
  }

  // Fuzzy keyword fallback (stale index — may miss recent packages).
  try {
    for (const pkg of await searchWingetRun(q)) add(pkg);
  } catch { /* optional */ }

  return results.slice(0, 30);
}
