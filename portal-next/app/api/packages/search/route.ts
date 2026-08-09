/**
 * GET /api/packages/search?q=&manager=chocolatey|winget
 *
 * Proxies package search to avoid browser CORS issues with Chocolatey's OData API.
 * WinGet uses the official winget-pkgs GitHub repo for exact ID lookup.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { searchWinget } from '@/lib/winget-search';

export const runtime = 'nodejs';
function json(data: unknown, status = 200) { return NextResponse.json(data, { status }); }

interface Package {
  id: string;
  displayName: string;
  version: string;
  summary: string;
  publisher?: string;
  downloads?: number;
}

async function searchChocolatey(query: string): Promise<Package[]> {
  const url =
    `https://community.chocolatey.org/api/v2/Search()` +
    `?searchTerm='${encodeURIComponent(query)}'` +
    `&targetFramework=''` +
    `&includePrerelease=false` +
    `&$filter=IsLatestVersion` +
    `&$top=30`;

  const res = await fetch(url, {
    headers: { Accept: 'application/atom+xml,application/xml', 'User-Agent': 'Config365/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Chocolatey API returned ${res.status}`);
  const xml = await res.text();

  // Parse OData Atom XML
  const entries: Package[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const id      = entry.match(/<d:Id[^>]*>(.*?)<\/d:Id>/)?.[1] ?? '';
    const version = entry.match(/<d:Version[^>]*>(.*?)<\/d:Version>/)?.[1] ?? '';
    const title   = entry.match(/<title[^>]*>(.*?)<\/title>/)?.[1] ?? id;
    const summary = entry.match(/<d:Summary[^>]*>(.*?)<\/d:Summary>/)?.[1] ?? '';
    const dl      = parseInt(entry.match(/<d:DownloadCount[^>]*>(.*?)<\/d:DownloadCount>/)?.[1] ?? '0', 10);
    if (id) entries.push({ id, displayName: title || id, version, summary: summary.slice(0, 200), downloads: dl });
  }
  return entries;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.user) return json({ error: 'Unauthenticated' }, 401);

  const q       = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const manager = request.nextUrl.searchParams.get('manager') ?? 'chocolatey';

  if (!q) return json({ packages: [] });

  try {
    const packages = manager === 'winget' ? await searchWinget(q) : await searchChocolatey(q);
    return json({ packages });
  } catch (err: unknown) {
    return json({ error: (err as Error).message, packages: [] }, 200);
  }
}
