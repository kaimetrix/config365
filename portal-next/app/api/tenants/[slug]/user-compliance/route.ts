/**
 * GET /api/tenants/[slug]/user-compliance?days=X
 *
 * Reads sign-in backup files whose UTC day overlaps the requested time window,
 * filters entries by firstSignIn/lastSignIn (not file date alone), and merges rows
 * per user + device + client across the window.
 *
 * No live Graph calls — all data comes from the nightly backup pipeline.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/server/session';
import { getFile, getGitTree } from '@/lib/server/gitea';
import { requireTenantAccess } from '@/lib/server/authz';
import { parseNamedLocationBackup, type NamedLocationRecord } from '@/lib/named-location-match';

export const runtime = 'nodejs';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

/** UTC calendar dates whose 24h span may contain sign-ins in [windowStart, now]. */
function utcDatesOverlappingWindow(windowStart: Date, windowEnd: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(
    windowStart.getUTCFullYear(),
    windowStart.getUTCMonth(),
    windowStart.getUTCDate(),
  ));
  const endDay = new Date(Date.UTC(
    windowEnd.getUTCFullYear(),
    windowEnd.getUTCMonth(),
    windowEnd.getUTCDate(),
  ));
  while (cursor <= endDay) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function parseSignInTime(value: string | undefined | null): Date | null {
  if (!value?.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when the entry's sign-in span overlaps [windowStart, windowEnd]. */
function entryOverlapsWindow(
  entry: SignInEntry,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  const first = parseSignInTime(entry.firstSignIn);
  const last = parseSignInTime(entry.lastSignIn) ?? first;
  if (!first && !last) return false;
  const spanStart = first ?? last!;
  const spanEnd = last ?? first!;
  return spanEnd >= windowStart && spanStart <= windowEnd;
}

interface DailySignInSlice {
  date: string;
  signInCount: number;
  firstSignIn: string;
  lastSignIn: string;
  appsAccessed: string[];
  ipAddresses: string[];
  locations: Array<{ city: string; countryOrRegion: string; signInCount: number }>;
}

interface SignInEntry {
  userId: string;
  userPrincipalName: string;
  userDisplayName: string;
  deviceId: string;
  deviceName: string;
  operatingSystem: string;
  isCompliant: boolean | null;
  isManaged: boolean;
  trustType: string;
  clientAppUsed: string;
  browser: string;
  appsAccessed: string[];
  ipAddresses: string[];
  locations: Array<{ city: string; countryOrRegion: string; signInCount: number }>;
  signInCount: number;
  firstSignIn: string;
  lastSignIn: string;
  dailyBreakdown?: DailySignInSlice[];
  intuneLastSync?: string;
  entraDeviceActivity?: string;
}

/** Raw row from a day file before window merge. */
interface RawSignInEntry extends SignInEntry {
  backupDate: string;
}

interface DayFile {
  date: string;
  exportedAt: string;
  totalSignIns: number;
  uniqueEntries: number;
  entries: SignInEntry[];
  error?: string;
}

async function loadNamedLocations(org: string, repo: string): Promise<NamedLocationRecord[]> {
  const tree = await getGitTree(org, repo).catch(() => []);
  const paths = tree
    .filter(e =>
      e.type === 'blob'
      && e.path.startsWith('backups/conditional-access/named-locations/')
      && e.path.endsWith('.json')
      && !e.path.endsWith('.assignment.json')
      && !e.path.endsWith('.config.json'),
    )
    .map(e => e.path);

  const parsed = await Promise.all(
    paths.map(async (path) => {
      const file = await getFile(org, repo, path).catch(() => ({ exists: false as const, content: '' }));
      if (!file.exists) return null;
      try {
        return parseNamedLocationBackup(JSON.parse(file.content) as Record<string, unknown>);
      } catch {
        return null;
      }
    }),
  );

  return parsed.filter((loc): loc is NamedLocationRecord => loc !== null && loc.ipRanges.length > 0);
}

const EMPTY_DEVICE_ID = '00000000-0000-0000-0000-000000000000';

function isValidDeviceId(id: string | undefined | null): id is string {
  return !!id && id !== EMPTY_DEVICE_ID;
}

interface ManagedDeviceRecord {
  azureADDeviceId?: string;
  deviceName?: string;
  lastSyncDateTime?: string;
}

interface EntraDeviceRegistryRecord {
  deviceId?: string;
  displayName?: string;
  approximateLastSignInDateTime?: string;
}

interface DeviceRegistryFile {
  exportedAt?: string;
  devices?: EntraDeviceRegistryRecord[];
}

/** deviceId → hostname from the Intune backup file already in the tenant repo (not live Graph). */
async function loadDeviceNameMap(org: string, repo: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = await getFile(org, repo, 'backups/intune/managed-devices.json').catch(() => null);
  if (!file?.exists) return map;
  try {
    const devices = JSON.parse(file.content) as ManagedDeviceRecord[];
    for (const d of devices) {
      const id = d.azureADDeviceId?.trim();
      const name = d.deviceName?.trim();
      if (isValidDeviceId(id) && name) map.set(id.toLowerCase(), name);
    }
  } catch { /* ignore */ }
  return map;
}

/** deviceId → Intune lastSyncDateTime from repo backup (read-only reference). */
async function loadIntuneLastSyncMap(org: string, repo: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = await getFile(org, repo, 'backups/intune/managed-devices.json').catch(() => null);
  if (!file?.exists) return map;
  try {
    const devices = JSON.parse(file.content) as ManagedDeviceRecord[];
    for (const d of devices) {
      const id = d.azureADDeviceId?.trim();
      const sync = d.lastSyncDateTime?.trim();
      if (isValidDeviceId(id) && sync) map.set(id.toLowerCase(), sync);
    }
  } catch { /* ignore */ }
  return map;
}

/** deviceId → Entra approximateLastSignInDateTime from sign-in backup device registry. */
async function loadEntraDeviceActivityMap(org: string, repo: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = await getFile(org, repo, 'backups/signin-logs/device-registry.json').catch(() => null);
  if (!file?.exists) return map;
  try {
    const data = JSON.parse(file.content) as DeviceRegistryFile;
    for (const d of data.devices ?? []) {
      const id = d.deviceId?.trim();
      const activity = d.approximateLastSignInDateTime?.trim();
      if (isValidDeviceId(id) && activity) map.set(id.toLowerCase(), activity);
    }
  } catch { /* ignore */ }
  return map;
}

function toDailySlice(raw: RawSignInEntry): DailySignInSlice {
  return {
    date: raw.backupDate,
    signInCount: raw.signInCount ?? 0,
    firstSignIn: raw.firstSignIn,
    lastSignIn: raw.lastSignIn,
    appsAccessed: [...(raw.appsAccessed ?? [])],
    ipAddresses: [...(raw.ipAddresses ?? [])],
    locations: [...(raw.locations ?? [])],
  };
}

function mergeDailySlices(a: DailySignInSlice[], b: DailySignInSlice[]): DailySignInSlice[] {
  const map = new Map<string, DailySignInSlice>();
  for (const slice of [...a, ...b]) {
    const existing = map.get(slice.date);
    if (!existing) {
      map.set(slice.date, { ...slice, appsAccessed: [...slice.appsAccessed], ipAddresses: [...slice.ipAddresses], locations: [...slice.locations] });
      continue;
    }
    existing.signInCount += slice.signInCount;
    if (slice.firstSignIn && (!existing.firstSignIn || slice.firstSignIn < existing.firstSignIn)) {
      existing.firstSignIn = slice.firstSignIn;
    }
    if (slice.lastSignIn && slice.lastSignIn > existing.lastSignIn) {
      existing.lastSignIn = slice.lastSignIn;
    }
    for (const app of slice.appsAccessed) {
      if (app && !existing.appsAccessed.includes(app)) existing.appsAccessed.push(app);
    }
    for (const ip of slice.ipAddresses) {
      if (ip && !existing.ipAddresses.includes(ip)) existing.ipAddresses.push(ip);
    }
    existing.locations = mergeLocationLists(existing.locations, slice.locations);
  }
  return Array.from(map.values()).sort((x, y) => x.date.localeCompare(y.date));
}

function resolveDeviceName(
  deviceId: string,
  rawName: string,
  registry: Map<string, string>,
): string {
  if (isValidDeviceId(deviceId)) {
    const canonical = registry.get(deviceId.toLowerCase());
    if (canonical) return canonical;
  }
  return rawName;
}

function mergeLocationLists(
  a: SignInEntry['locations'],
  b: SignInEntry['locations'],
): SignInEntry['locations'] {
  const map = new Map<string, { city: string; countryOrRegion: string; signInCount: number }>();
  for (const loc of [...a, ...b]) {
    const key = `${loc.city}|${loc.countryOrRegion}`;
    const existing = map.get(key);
    if (existing) existing.signInCount += loc.signInCount ?? 0;
    else map.set(key, { ...loc });
  }
  return Array.from(map.values()).sort((x, y) => y.signInCount - x.signInCount);
}

/**
 * Merge duplicate backup rows for the same user + device + client across the
 * requested time window (one compliance row per machine, latest lastSignIn wins).
 */
function mergeSignInEntries(
  entries: RawSignInEntry[],
  deviceNames: Map<string, string>,
  intuneLastSync: Map<string, string>,
  entraDeviceActivity: Map<string, string>,
): SignInEntry[] {
  const merged = new Map<string, SignInEntry>();

  for (const raw of entries) {
    const deviceId = isValidDeviceId(raw.deviceId) ? raw.deviceId : '';
    const deviceName = resolveDeviceName(deviceId, raw.deviceName, deviceNames);
    const key = `${raw.userId}|${deviceId || deviceName}|${raw.clientAppUsed}`;
    const existing = merged.get(key);
    const daySlice = toDailySlice(raw);

    if (!existing) {
      const idKey = deviceId.toLowerCase();
      merged.set(key, {
        ...raw,
        deviceId,
        deviceName,
        dailyBreakdown: [daySlice],
        intuneLastSync: idKey ? intuneLastSync.get(idKey) : undefined,
        entraDeviceActivity: idKey ? entraDeviceActivity.get(idKey) : undefined,
      });
      continue;
    }

    existing.signInCount += raw.signInCount ?? 0;
    if (raw.firstSignIn && (!existing.firstSignIn || raw.firstSignIn < existing.firstSignIn)) {
      existing.firstSignIn = raw.firstSignIn;
    }
    if (raw.lastSignIn && raw.lastSignIn > existing.lastSignIn) {
      existing.lastSignIn = raw.lastSignIn;
    }
    for (const app of raw.appsAccessed ?? []) {
      if (app && !existing.appsAccessed.includes(app)) existing.appsAccessed.push(app);
    }
    for (const ip of raw.ipAddresses ?? []) {
      if (ip && !existing.ipAddresses.includes(ip)) existing.ipAddresses.push(ip);
    }
    existing.locations = mergeLocationLists(existing.locations, raw.locations ?? []);
    existing.dailyBreakdown = mergeDailySlices(existing.dailyBreakdown ?? [], [daySlice]);
    if (raw.isCompliant === false) existing.isCompliant = false;
    else if (raw.isCompliant === true && existing.isCompliant === null) existing.isCompliant = true;
    if (deviceName) existing.deviceName = deviceName;
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.deviceName.localeCompare(b.deviceName) || a.clientAppUsed.localeCompare(b.clientAppUsed),
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getSession();
  if (!session?.user) return json({ error: 'Unauthenticated' }, 401);

  const { slug } = await params;
  const days = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10), 1), 90);

  const tenantOrResponse = await requireTenantAccess(session.user, slug);
  if (tenantOrResponse instanceof NextResponse) return tenantOrResponse;
  const tenant = tenantOrResponse;

  const org  = tenant.giteaOrg;
  const repo = `tenant-${tenant.slug}`;

  const namedLocationsPromise = loadNamedLocations(org, repo);
  const deviceNamesPromise = loadDeviceNameMap(org, repo);
  const intuneLastSyncPromise = loadIntuneLastSyncMap(org, repo);
  const entraActivityPromise = loadEntraDeviceActivityMap(org, repo);

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const dates = utcDatesOverlappingWindow(windowStart, windowEnd);

  // Fetch all daily files in parallel — missing files are silently skipped
  const fileResults = await Promise.allSettled(
    dates.map(async (date) => {
      const result = await getFile(org, repo, `backups/signin-logs/${date}.json`);
      if (!result.exists) return null;
      try {
        return JSON.parse(result.content) as DayFile;
      } catch {
        return null;
      }
    }),
  );

  const availableDates: string[] = [];
  const allEntries: RawSignInEntry[] = [];

  for (let i = 0; i < fileResults.length; i++) {
    const r = fileResults[i];
    const backupDate = dates[i];
    if (r.status === 'fulfilled' && r.value?.entries) {
      availableDates.push(r.value.date);
      for (const entry of r.value.entries) {
        if (entryOverlapsWindow(entry, windowStart, windowEnd)) {
          allEntries.push({ ...entry, backupDate: r.value.date || backupDate });
        }
      }
    }
  }

  // Check for licence error marker
  const errorResult = await getFile(org, repo, 'backups/signin-logs/error.json').catch(() => null);
  const licenceError = errorResult?.exists
    ? (JSON.parse(errorResult.content) as { error: string; detail: string })
    : null;

  if (allEntries.length === 0 && licenceError) {
    return json({ error: licenceError.error, detail: licenceError.detail, days, availableDates: [] }, 402);
  }

  const [deviceNames, intuneLastSync, entraDeviceActivity] = await Promise.all([
    deviceNamesPromise,
    intuneLastSyncPromise,
    entraActivityPromise,
  ]);

  const userMap = new Map<string, {
    userId: string;
    userPrincipalName: string;
    userDisplayName: string;
    entries: RawSignInEntry[];
  }>();

  for (const entry of allEntries) {
    if (!userMap.has(entry.userId)) {
      userMap.set(entry.userId, {
        userId: entry.userId,
        userPrincipalName: entry.userPrincipalName,
        userDisplayName: entry.userDisplayName,
        entries: [],
      });
    }
    userMap.get(entry.userId)!.entries.push(entry);
  }

  // Build per-user summary with compliance classifications
  const LEGACY_APP_TYPES = new Set(['Exchange ActiveSync', 'IMAP', 'MAPI', 'SMTP', 'POP', 'other clients']);

  const users = Array.from(userMap.values()).map((u) => {
    const entries = mergeSignInEntries(u.entries, deviceNames, intuneLastSync, entraDeviceActivity);

    // Graph API returns full strings: "Azure AD joined", "Azure AD registered", "ServerAD", or ""
    const isEntraJoined  = (t: string) => t.toLowerCase().includes('joined') || t === 'ServerAD';
    const isByod         = (t: string) => t.toLowerCase().includes('registered');
    const isUnregistered = (t: string) => !t;

    const isFullyCompliant = entries.every(
      (e) => e.isCompliant === true && isEntraJoined(e.trustType),
    );
    const hasNonCompliantDevice = entries.some((e) => e.isCompliant === false && e.isManaged === true);
    const hasUnmanagedByod     = entries.some((e) => e.isManaged === false && isByod(e.trustType));
    const hasPersonalDevice    = entries.some((e) => isUnregistered(e.trustType));
    const hasLegacyAuth        = entries.some((e) => LEGACY_APP_TYPES.has(e.clientAppUsed));

    const lastSeen = entries.reduce((acc, e) => (e.lastSignIn > acc ? e.lastSignIn : acc), '');
    const totalSignIns = entries.reduce((sum, e) => sum + (e.signInCount ?? 0), 0);
    return {
      userId:             u.userId,
      userPrincipalName:  u.userPrincipalName,
      userDisplayName:    u.userDisplayName,
      isFullyCompliant,
      hasNonCompliantDevice,
      hasUnmanagedByod,
      hasPersonalDevice,
      hasLegacyAuth,
      lastSeen,
      totalSignIns,
      entries,
    };
  });

  // Sort: issues first, then alphabetically by UPN
  users.sort((a, b) => {
    const aIssue = !a.isFullyCompliant;
    const bIssue = !b.isFullyCompliant;
    if (aIssue !== bIssue) return aIssue ? -1 : 1;
    return a.userPrincipalName.localeCompare(b.userPrincipalName);
  });

  return json({
    days,
    windowStartUtc: windowStart.toISOString(),
    windowEndUtc: windowEnd.toISOString(),
    availableDates,
    licenceWarning: licenceError?.detail ?? null,
    userCount: users.length,
    users,
    namedLocations: await namedLocationsPromise,
  });
}
