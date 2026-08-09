'use client';
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { matchIpToNamedLocations, type NamedLocationRecord } from '@/lib/named-location-match';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Location { city: string; countryOrRegion: string; signInCount: number }

interface DailySignInSlice {
  date: string;
  signInCount: number;
  firstSignIn: string;
  lastSignIn: string;
  appsAccessed: string[];
  ipAddresses: string[];
  locations: Location[];
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
  locations: Location[];
  signInCount: number;
  firstSignIn: string;
  lastSignIn: string;
  dailyBreakdown?: DailySignInSlice[];
  intuneLastSync?: string;
  entraDeviceActivity?: string;
}

interface UserSummary {
  userId: string;
  userPrincipalName: string;
  userDisplayName: string;
  isFullyCompliant: boolean;
  hasNonCompliantDevice: boolean;
  hasUnmanagedByod: boolean;
  hasPersonalDevice: boolean;
  hasLegacyAuth: boolean;
  lastSeen: string;
  totalSignIns: number;
  entries: SignInEntry[];
}

interface ComplianceData {
  days: number;
  availableDates: string[];
  licenceWarning: string | null;
  userCount: number;
  users: UserSummary[];
  namedLocations?: NamedLocationRecord[];
}

interface SecurityGroup { id: string; displayName: string }

interface LastRunAction {
  mode: 'add' | 'remove';
  groupId: string;
  groupDisplayName: string;
  requestedAt: string;
  requestedBy: string;
  totalRequested: number;
  added: number;
  removed: number;
  alreadyMember: number;
  notMember: number;
  failed: number;
  whatIf: boolean;
}

interface LastRunResult {
  completedAt: string;
  whatIf: boolean;
  actions: LastRunAction[];
}

interface ComplianceCriteria {
  requireEntraJoined:   boolean;
  requireCompliant:     boolean;
  excludeLegacyAuth:    boolean;
  excludeMobile:        boolean; // skip iOS/Android sign-ins
  includeManagedMobile: boolean; // when excludeMobile=true, still count Intune-managed mobile
  excludedApps:         string[];
}

interface Props {
  mspSlug: string;
  tenants: { slug: string; displayName: string }[];
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

const C = {
  bg:      '#09090b',
  surface: '#111113',
  border:  '#27272a',
  muted:   '#52525b',
  dim:     '#71717a',
  body:    '#a1a1aa',
  text:    '#e4e4e7',
  white:   '#f4f4f5',
  green:   '#22c55e',
  greenBg: 'rgba(34,197,94,0.12)',
  red:     '#f87171',
  redBg:   'rgba(248,113,113,0.12)',
  yellow:  '#fbbf24',
  yellowBg:'rgba(251,191,36,0.12)',
  orange:  '#fb923c',
  orangeBg:'rgba(251,146,60,0.12)',
  blue:    '#60a5fa',
  blueBg:  'rgba(96,165,250,0.12)',
  purple:  '#a78bfa',
  purpleBg:'rgba(167,139,250,0.12)',
} as const;

const LEGACY_APP_TYPES = new Set(['Exchange ActiveSync', 'IMAP', 'MAPI', 'SMTP', 'POP', 'other clients']);

// ─── Compliance helpers ───────────────────────────────────────────────────────

function isEntraJoined(t: string) {
  const lower = t.toLowerCase();
  return lower.includes('joined') || lower === 'serverad';
}

const MOBILE_OS = ['ios', 'android'];
function isMobileEntry(e: SignInEntry) {
  const os = e.operatingSystem.toLowerCase();
  return MOBILE_OS.some(m => os.includes(m));
}

function computeIsFullyCompliant(user: UserSummary, crit: ComplianceCriteria): boolean {
  if (user.entries.length === 0) return false;
  const excluded = new Set(crit.excludedApps);
  for (const e of user.entries) {
    // Skip entries where every accessed app is excluded
    if (excluded.size > 0 && e.appsAccessed.length > 0 && e.appsAccessed.every(a => excluded.has(a))) continue;
    // Skip mobile entries (optionally keep Intune-managed mobile)
    if (crit.excludeMobile && isMobileEntry(e)) {
      if (!crit.includeManagedMobile || !e.isManaged) continue;
    }
    if (crit.requireEntraJoined && !isEntraJoined(e.trustType)) return false;
    if (crit.requireCompliant   && e.isCompliant !== true)       return false;
    if (crit.excludeLegacyAuth  && LEGACY_APP_TYPES.has(e.clientAppUsed)) return false;
  }
  return true;
}

// Returns only the entries that are relevant under the current criteria —
// mirrors the skip logic in computeIsFullyCompliant so that the column
// state icons reflect the same view as the compliance calculation.
function getFilteredEntries(entries: SignInEntry[], crit: ComplianceCriteria): SignInEntry[] {
  const excluded = new Set(crit.excludedApps);
  return entries.filter(e => {
    if (excluded.size > 0 && e.appsAccessed.length > 0 && e.appsAccessed.every(a => excluded.has(a))) return false;
    if (crit.excludeMobile && isMobileEntry(e)) {
      if (!crit.includeManagedMobile || !e.isManaged) return false;
    }
    return true;
  });
}

// Per-user column state helpers
function getJoinState(entries: SignInEntry[]): 'good' | 'warn' | 'bad' {
  if (entries.length === 0) return 'bad';
  const hasJoined    = entries.some(e => isEntraJoined(e.trustType));
  const hasNotJoined = entries.some(e => !isEntraJoined(e.trustType));
  if (hasJoined && !hasNotJoined) return 'good';  // all Entra joined
  if (!hasJoined)                  return 'bad';   // none joined at all
  return 'warn';                                   // mixed — some joined, some not
}
function getComplState(entries: SignInEntry[]): 'good' | 'bad' | 'na' {
  if (entries.length === 0) return 'na';
  const hasCompliant    = entries.some(e => e.isCompliant === true);
  const hasNonCompliant = entries.some(e => e.isCompliant === false);
  if (hasCompliant && !hasNonCompliant) return 'good';  // all (explicitly) compliant
  if (hasNonCompliant && !hasCompliant) return 'bad';   // all non-compliant, none compliant
  if (hasCompliant && hasNonCompliant)  return 'na';    // mixed — some good, some bad
  return 'na';                                          // all null (unregistered, unknown)
}

type ComputedUser = UserSummary & { isFullyCompliantComputed: boolean };

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function buildSelectedUsersClipboardText(users: ComputedUser[]): string {
  return users.map(u => u.userPrincipalName).join('\n');
}

function buildSelectedUsersCsv(users: ComputedUser[]): string {
  const headers = [
    'UserPrincipalName',
    'DisplayName',
    'UserId',
    'FullyCompliant',
    'NonCompliantDevice',
    'BYOD',
    'PersonalDevice',
    'LegacyAuth',
    'LastSeen',
    'TotalSignIns',
  ];
  const rows = users.map(u => [
    u.userPrincipalName,
    u.userDisplayName,
    u.userId,
    u.isFullyCompliantComputed ? 'Yes' : 'No',
    u.hasNonCompliantDevice ? 'Yes' : 'No',
    u.hasUnmanagedByod ? 'Yes' : 'No',
    u.hasPersonalDevice ? 'Yes' : 'No',
    u.hasLegacyAuth ? 'Yes' : 'No',
    u.lastSeen ? new Date(u.lastSeen).toISOString() : '',
    String(u.totalSignIns),
  ].map(v => csvEscape(String(v ?? ''))).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: '0.6875rem', fontWeight: 600,
      padding: '2px 7px', borderRadius: 4, color, background: bg,
      whiteSpace: 'nowrap', letterSpacing: '0.01em',
    }}>{label}</span>
  );
}

// Status icon used in the per-column compliance table cells
function StatusIcon({ state, title }: { state: 'good' | 'warn' | 'bad' | 'na'; title?: string }) {
  const cfg: Record<string, { symbol: string; color: string }> = {
    good: { symbol: '✓', color: C.green  },
    warn: { symbol: '—', color: C.yellow },  // mixed / partial
    bad:  { symbol: '✗', color: C.red    },
    na:   { symbol: '—', color: C.muted  },  // unknown / no data
  };
  const { symbol, color } = cfg[state];
  return (
    <div title={title} style={{ textAlign: 'center', color, fontWeight: 700, fontSize: '0.9375rem', lineHeight: 1 }}>
      {symbol}
    </div>
  );
}

function TrustBadge({ trustType }: { trustType: string }) {
  const t = trustType.toLowerCase();
  if (t.includes('joined') && !t.includes('server'))
    return <Badge label="Entra Joined"  color={C.green}  bg={C.greenBg} />;
  if (t === 'serverad' || t.includes('hybrid'))
    return <Badge label="Hybrid Joined" color={C.blue}   bg={C.blueBg} />;
  if (t.includes('registered'))
    return <Badge label="Registered"    color={C.yellow} bg={C.yellowBg} />;
  return <Badge label="Unregistered"    color={C.red}    bg={C.redBg} />;
}

function CompliantBadge({ isCompliant, isManaged }: { isCompliant: boolean | null; isManaged: boolean }) {
  if (!isManaged && isCompliant === null) return <Badge label="—" color={C.dim} bg={C.border} />;
  if (isCompliant === true)  return <Badge label="✓ Compliant"     color={C.green} bg={C.greenBg} />;
  if (isCompliant === false) return <Badge label="✗ Non-Compliant" color={C.red}   bg={C.redBg} />;
  return <Badge label="Unknown" color={C.dim} bg={C.border} />;
}

function ClientBadge({ clientAppUsed, browser }: { clientAppUsed: string; browser: string }) {
  if (clientAppUsed === 'Browser') {
    const name = browser ? `Browser (${browser.split(' ')[0]})` : 'Browser';
    return <Badge label={name} color={C.blue} bg={C.blueBg} />;
  }
  if (clientAppUsed === 'mobile clients' || clientAppUsed === 'Mobile Apps and Desktop clients')
    return <Badge label="App (modern)" color={C.purple} bg={C.purpleBg} />;
  if (LEGACY_APP_TYPES.has(clientAppUsed))
    return <Badge label={clientAppUsed} color={C.orange} bg={C.orangeBg} />;
  return <Badge label={clientAppUsed || 'Unknown'} color={C.dim} bg={C.border} />;
}

function StatCard({ label, value, color, bg, active, onClick }: {
  label: string; value: number; color: string; bg: string;
  active?: boolean; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: active ? bg : C.surface,
        border: `1px solid ${active ? color : C.border}`,
        borderRadius: 8, padding: '14px 18px', minWidth: 120, flex: '1 1 auto',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color, display: 'inline-block', lineHeight: 1.4 }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: active ? color : C.dim, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Btn({
  children, onClick, disabled, variant = 'default', style: extra,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    padding: '7px 16px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    transition: 'background 0.12s, border-color 0.12s', opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap', ...extra,
  };
  if (variant === 'primary') return <button type="button" onClick={onClick} disabled={disabled} style={{ ...base, background: C.green, color: '#000', border: 'none' }}>{children}</button>;
  if (variant === 'danger')  return <button type="button" onClick={onClick} disabled={disabled} style={{ ...base, background: C.redBg, color: C.red, border: `1px solid rgba(248,113,113,0.3)` }}>{children}</button>;
  if (variant === 'ghost')   return <button type="button" onClick={onClick} disabled={disabled} style={{ ...base, background: 'transparent', color: C.dim, border: 'none', padding: '7px 10px' }}>{children}</button>;
  return <button type="button" onClick={onClick} disabled={disabled} style={{ ...base, background: '#18181b', color: C.text, border: `1px solid ${C.border}` }}>{children}</button>;
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 32, height: 18, borderRadius: 9,
          background: value ? C.green : C.muted,
          position: 'relative', transition: 'background 0.2s', flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute', top: 2, left: value ? 16 : 2,
          width: 14, height: 14, borderRadius: '50%', background: '#fff',
          transition: 'left 0.2s',
        }} />
      </div>
      <span style={{ fontSize: '0.8125rem', color: C.body }}>{label}</span>
    </label>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
      border: `2px solid ${checked ? C.green : C.muted}`,
      background: checked ? C.green : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'border-color 0.1s, background 0.1s',
    }}>
      {checked && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="#000" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
    </div>
  );
}

// Expanded device/app breakdown for a single user
function IpNamedLocationCell({
  ips,
  namedLocations,
}: {
  ips: string[];
  namedLocations: NamedLocationRecord[];
}) {
  if (ips.length === 0) return <>—</>;

  const hasIpLocations = namedLocations.some(l => l.ipRanges.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {ips.map(ip => {
        const matches = matchIpToNamedLocations(ip, namedLocations);
        return (
          <div key={ip}>
            <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: C.text }}>{ip}</div>
            {matches.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                {matches.map(name => (
                  <Badge key={name} label={name} color={C.green} bg={C.greenBg} />
                ))}
              </div>
            ) : hasIpLocations ? (
              <div style={{ fontSize: '0.65rem', color: C.muted, marginTop: 2 }}>Not in named location</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function deviceEntryKey(e: SignInEntry): string {
  return `${e.deviceId || e.deviceName}|${e.clientAppUsed}`;
}

function formatShortDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function DeviceReferenceDates({ entry }: { entry: SignInEntry }) {
  const lines: Array<{ label: string; value: string; title: string }> = [];
  if (entry.lastSignIn) {
    lines.push({
      label: 'Sign-in',
      value: formatShortDate(entry.lastSignIn),
      title: `Last interactive sign-in from backup (${entry.firstSignIn} → ${entry.lastSignIn})`,
    });
  }
  if (entry.entraDeviceActivity) {
    lines.push({
      label: 'Entra activity',
      value: formatShortDate(entry.entraDeviceActivity),
      title: `Entra device approximateLastSignInDateTime (${entry.entraDeviceActivity}) — may lag behind sign-in logs`,
    });
  }
  if (entry.intuneLastSync) {
    lines.push({
      label: 'Intune sync',
      value: formatShortDate(entry.intuneLastSync),
      title: `Intune lastSyncDateTime (${entry.intuneLastSync})`,
    });
  }
  if (lines.length === 0) return null;
  return (
    <div style={{ marginTop: 4, fontSize: '0.65rem', color: C.muted, lineHeight: 1.5 }}>
      {lines.map(l => (
        <div key={l.label} title={l.title}>
          <span style={{ color: C.dim }}>{l.label}:</span>{' '}
          <span style={{ color: C.body }}>{l.value}</span>
        </div>
      ))}
    </div>
  );
}

function DeviceDailyBreakdown({
  slices,
  namedLocations,
}: {
  slices: DailySignInSlice[];
  namedLocations: NamedLocationRecord[];
}) {
  return (
    <div style={{ padding: '8px 10px 10px 28px', background: 'rgba(0,0,0,0.2)' }}>
      <div style={{ fontSize: '0.65rem', color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Daily sign-in detail
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
        <thead>
          <tr style={{ color: C.muted, textAlign: 'left' }}>
            {['Date', 'Count', 'Time span', 'Apps', 'IP / Location', 'Locations'].map(h => (
              <th key={h} style={{ padding: '4px 8px', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slices.map(s => (
            <tr key={s.date} style={{ borderTop: `1px solid ${C.border}`, color: C.body }}>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', color: C.text }}>{s.date}</td>
              <td style={{ padding: '5px 8px' }}>{s.signInCount}</td>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }} title={`${s.firstSignIn} → ${s.lastSignIn}`}>
                {new Date(s.firstSignIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {' – '}
                {new Date(s.lastSignIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </td>
              <td style={{ padding: '5px 8px' }}>{s.appsAccessed.join(', ') || '—'}</td>
              <td style={{ padding: '5px 8px', maxWidth: 160 }}>
                <IpNamedLocationCell ips={s.ipAddresses} namedLocations={namedLocations} />
              </td>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                {s.locations.length > 0
                  ? s.locations.map(l => `${l.city ? l.city + ', ' : ''}${l.countryOrRegion} (${l.signInCount})`).join(' · ')
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserEntries({
  entries,
  namedLocations,
}: {
  entries: SignInEntry[];
  namedLocations: NamedLocationRecord[];
}) {
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());

  const toggleDevice = (key: string) => {
    setExpandedDevices(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div style={{ padding: '0 12px 12px 52px' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
          <thead>
            <tr style={{ color: C.muted, textAlign: 'left', borderBottom: `1px solid ${C.border}` }}>
              <th style={{ width: 28, padding: '6px 4px' }} />
              {['Device', 'OS', 'Join Type', 'Compliant', 'Client', 'Apps', 'IP / Named Location', 'Locations', 'Sign-ins'].map(h => (
                <th key={h} style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const rowKey = deviceEntryKey(e);
              const slices = e.dailyBreakdown ?? [];
              const canExpand = slices.length > 1 || e.signInCount > 1;
              const isExpanded = expandedDevices.has(rowKey);
              return (
                <Fragment key={rowKey || i}>
                  <tr
                    style={{ borderBottom: isExpanded ? 'none' : `1px solid ${C.border}`, color: C.body, cursor: canExpand ? 'pointer' : 'default' }}
                    onClick={canExpand ? () => toggleDevice(rowKey) : undefined}
                  >
                    <td style={{ padding: '7px 4px', textAlign: 'center', color: canExpand ? C.blue : C.muted, verticalAlign: 'top' }}>
                      {canExpand && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                          <path d="M4 2.5L8 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </td>
                    <td
                      style={{ padding: '7px 10px', color: C.text, whiteSpace: 'nowrap', verticalAlign: 'top' }}
                      title={e.deviceId ? `Device ID: ${e.deviceId}` : undefined}
                    >
                      {e.deviceName || <span style={{ color: C.muted }}>Unknown</span>}
                    </td>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{e.operatingSystem || '—'}</td>
                    <td style={{ padding: '7px 10px' }}><TrustBadge trustType={e.trustType} /></td>
                    <td style={{ padding: '7px 10px' }}><CompliantBadge isCompliant={e.isCompliant} isManaged={e.isManaged} /></td>
                    <td style={{ padding: '7px 10px' }}><ClientBadge clientAppUsed={e.clientAppUsed} browser={e.browser} /></td>
                    <td style={{ padding: '7px 10px', maxWidth: 180 }} title="Interactive sign-ins tied to this device in backup">
                      <span title={e.appsAccessed.join(', ')} style={{ color: C.body }}>
                        {e.appsAccessed.length > 0
                          ? e.appsAccessed.slice(0, 2).join(', ') + (e.appsAccessed.length > 2 ? ` +${e.appsAccessed.length - 2}` : '')
                          : '—'}
                      </span>
                    </td>
                    <td style={{ padding: '7px 10px', maxWidth: 200, verticalAlign: 'top' }}>
                      <IpNamedLocationCell ips={e.ipAddresses} namedLocations={namedLocations} />
                    </td>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                      {e.locations.length > 0
                        ? e.locations.map(l => `${l.city ? l.city + ', ' : ''}${l.countryOrRegion} (${l.signInCount})`).join(' · ')
                        : '—'}
                    </td>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', color: C.dim, verticalAlign: 'top' }}>
                      <div>
                        {e.signInCount}
                        {e.lastSignIn && (
                          <span title={`${e.firstSignIn} → ${e.lastSignIn}`} style={{ marginLeft: 4, cursor: 'help', borderBottom: `1px dashed ${C.muted}` }}>
                            {formatShortDate(e.lastSignIn)}
                          </span>
                        )}
                      </div>
                      <DeviceReferenceDates entry={e} />
                    </td>
                  </tr>
                  {isExpanded && slices.length > 0 && (
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td colSpan={10} style={{ padding: 0 }}>
                        <DeviceDailyBreakdown slices={slices} namedLocations={namedLocations} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const DEFAULT_CRITERIA: ComplianceCriteria = {
  requireEntraJoined:   true,
  requireCompliant:     true,
  excludeLegacyAuth:    false,
  excludeMobile:        false,
  includeManagedMobile: false,
  excludedApps:         [],
};


export default function UserComplianceClient({ tenants }: Props) {
  const [tenantSlug,    setTenantSlug]    = useState(tenants[0]?.slug ?? '');
  const [days,          setDays]          = useState(30);
  const [loading,       setLoading]       = useState(false);
  const [data,          setData]          = useState<ComplianceData | null>(null);
  const [error,         setError]         = useState<string | null>(null);
  const [filter,        setFilter]        = useState<'all' | 'compliant' | 'issues'>('all');
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [criteria,      setCriteria]      = useState<ComplianceCriteria>(DEFAULT_CRITERIA);
  const [showApps,      setShowApps]      = useState(false);

  const [groups,        setGroups]        = useState<SecurityGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg,     setActionMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [exportMsg,     setExportMsg]     = useState<string | null>(null);
  const [lastRun,       setLastRun]       = useState<LastRunResult | null>(null);

  // Group membership filter — multiple conditions with AND / OR logic
  interface GroupFilterRow { id: string; groupKey: string; mode: 'member' | 'not-member' }
  const [groupFilters,     setGroupFilters]     = useState<GroupFilterRow[]>([]);
  const [groupFilterLogic, setGroupFilterLogic] = useState<'and' | 'or'>('and');
  // Cache: groupKey → Set<userId>  (null = still loading, undefined = not fetched)
  const [memberCache,      setMemberCache]      = useState<Record<string, Set<string> | null>>({});

  // ── Fetch compliance data ─────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    if (!tenantSlug) return;
    setLoading(true); setError(null); setData(null); setSelectedUsers(new Set());
    try {
      const res = await fetch(`/api/tenants/${tenantSlug}/user-compliance?days=${days}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: string; error?: string };
        setError(res.status === 402
          ? `Entra P1/P2 licence required: ${body.detail ?? 'AuditLog.Read.All not available'}`
          : (body.error ?? `HTTP ${res.status}`));
        return;
      }
      setData(await res.json() as ComplianceData);
    } catch (e) { setError(String(e)); }
    finally     { setLoading(false); }
  }, [tenantSlug, days]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // ── Fetch last run result ─────────────────────────────────────────────────

  const fetchLastRun = useCallback(async () => {
    if (!tenantSlug) return;
    try {
      const res  = await fetch(`/api/git/file?slug=${tenantSlug}&path=config/group-action-last-run.json`);
      if (!res.ok) return;
      const body = await res.json() as { exists: boolean; content: string };
      if (body.exists) setLastRun(JSON.parse(body.content) as LastRunResult);
    } catch { /* not yet written */ }
  }, [tenantSlug]);

  useEffect(() => { void fetchLastRun(); }, [fetchLastRun]);

  // ── Fetch security groups (lazy — needed for action panel or group filter) ─

  const [groupsNeeded, setGroupsNeeded] = useState(false);

  useEffect(() => {
    if ((!groupsNeeded && selectedUsers.size === 0) || !tenantSlug || groups.length > 0) return;
    setGroupsLoading(true);
    fetch(`/api/tenants/${tenantSlug}/security-groups`)
      .then(r => r.json() as Promise<{ groups: SecurityGroup[] }>)
      .then(body => {
        setGroups(body.groups ?? []);
        // Do not auto-pick the first group — require an explicit choice before add/remove.
        setSelectedGroup(prev => {
          if (!prev) return '';
          const stillThere = (body.groups ?? []).some(g => (g.id || g.displayName) === prev);
          return stillThere ? prev : '';
        });
      })
      .catch(() => { /* silent */ })
      .finally(() => setGroupsLoading(false));
  }, [groupsNeeded, selectedUsers.size, tenantSlug, groups.length]);

  // ── Fetch membership for any group in the filter list not yet cached ─────

  useEffect(() => {
    if (!tenantSlug) return;
    const uncached = groupFilters
      .map(f => f.groupKey)
      .filter(k => k && memberCache[k] === undefined);
    if (uncached.length === 0) return;

    // Mark as loading (null) immediately to prevent duplicate fetches
    setMemberCache(prev => {
      const next = { ...prev };
      for (const k of uncached) next[k] = null;
      return next;
    });

    for (const key of uncached) {
      const group    = groups.find(g => (g.id || g.displayName) === key);
      const groupName = group?.displayName ?? key;
      fetch(`/api/tenants/${tenantSlug}/group-membership?groupName=${encodeURIComponent(groupName)}`)
        .then(r => r.json() as Promise<{ memberIds: string[] }>)
        .then(body => setMemberCache(prev => ({ ...prev, [key]: new Set(body.memberIds ?? []) })))
        .catch(()  => setMemberCache(prev => ({ ...prev, [key]: new Set() })));
    }
  }, [groupFilters, tenantSlug, groups, memberCache]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const users = data?.users ?? [];
  const namedLocations = data?.namedLocations ?? [];

  // All unique app names from the data — used to populate the "excluded apps" chips
  const uniqueAppNames = useMemo(() => {
    const names = new Set<string>();
    for (const u of users) for (const e of u.entries) for (const a of e.appsAccessed) if (a) names.add(a);
    return Array.from(names).sort();
  }, [users]);

  const computedUsers = useMemo(() =>
    users.map(u => ({ ...u, isFullyCompliantComputed: computeIsFullyCompliant(u, criteria) })),
  [users, criteria]);

  const counts = {
    compliant:    computedUsers.filter(u => u.isFullyCompliantComputed).length,
    nonCompliant: computedUsers.filter(u => u.hasNonCompliantDevice).length,
    byod:         computedUsers.filter(u => u.hasUnmanagedByod).length,
    personal:     computedUsers.filter(u => u.hasPersonalDevice).length,
    legacy:       computedUsers.filter(u => u.hasLegacyAuth).length,
  };

  const activeGroupFilters = groupFilters.filter(f => f.groupKey);

  const filteredUsers = computedUsers.filter(u => {
    if (filter === 'compliant') { if (!u.isFullyCompliantComputed) return false; }
    if (filter === 'issues')    { if (u.isFullyCompliantComputed)  return false; }

    if (activeGroupFilters.length > 0) {
      const results = activeGroupFilters.map(f => {
        const members  = memberCache[f.groupKey];
        if (!members) return true; // still loading — don't hide the user yet
        const isMember = members.has(u.userId);
        return f.mode === 'member' ? isMember : !isMember;
      });
      const pass = groupFilterLogic === 'and' ? results.every(Boolean) : results.some(Boolean);
      if (!pass) return false;
    }

    return true;
  });

  // ── Selection helpers ─────────────────────────────────────────────────────

  function toggleUser(userId: string) {
    setSelectedUsers(prev => { const n = new Set(prev); n.has(userId) ? n.delete(userId) : n.add(userId); return n; });
  }
  function selectAllCompliant() { setSelectedUsers(new Set(computedUsers.filter(u => u.isFullyCompliantComputed).map(u => u.userId))); }
  function clearSelection()     { setSelectedUsers(new Set()); }
  function toggleExpand(userId: string) {
    setExpandedUsers(prev => { const n = new Set(prev); n.has(userId) ? n.delete(userId) : n.add(userId); return n; });
  }

  const selectedUserRecords = useMemo(
    () => computedUsers.filter(u => selectedUsers.has(u.userId)),
    [computedUsers, selectedUsers],
  );

  async function copySelectedUsers() {
    if (selectedUserRecords.length === 0) return;
    const text = buildSelectedUsersClipboardText(selectedUserRecords);
    try {
      await navigator.clipboard.writeText(text);
      setExportMsg(`Copied ${selectedUserRecords.length} UPN${selectedUserRecords.length !== 1 ? 's' : ''} to clipboard`);
    } catch {
      setExportMsg('Failed to copy to clipboard');
    }
    setTimeout(() => setExportMsg(null), 3000);
  }

  function exportSelectedUsersCsv() {
    if (selectedUserRecords.length === 0) return;
    const csv = buildSelectedUsersCsv(selectedUserRecords);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`user-compliance-${tenantSlug}-${date}.csv`, csv);
    setExportMsg(`Exported ${selectedUserRecords.length} user${selectedUserRecords.length !== 1 ? 's' : ''} to CSV`);
    setTimeout(() => setExportMsg(null), 3000);
  }

  // ── Group action (add or remove) ──────────────────────────────────────────

  async function handleGroupAction(mode: 'add' | 'remove') {
    if (!selectedGroup || selectedUsers.size === 0) return;
    const group = groups.find(g => (g.id || g.displayName) === selectedGroup);
    if (!group) return;

    const verb = mode === 'add' ? 'ADD' : 'REMOVE';
    const prep = mode === 'add' ? 'to' : 'from';
    const ok = window.confirm(
      `${verb} ${selectedUsers.size} user(s) ${prep} "${group.displayName}"?\n\nThis queues a deploy pipeline WhatIf that still requires approval before applying.`,
    );
    if (!ok) return;

    setActionLoading(true); setActionMsg(null);
    try {
      const pendingFolder  = mode === 'add' ? 'pending-group-adds' : 'pending-group-removes';
      // Use id as filename when available; otherwise sanitise the display name
      const fileKey = group.id || group.displayName.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const path = `${pendingFolder}/${fileKey}.json`;
      const newUsers = Array.from(selectedUsers).map(uid => {
        const u = computedUsers.find(cu => cu.userId === uid);
        return { id: uid, upn: u?.userPrincipalName ?? uid, displayName: u?.userDisplayName ?? '' };
      });

      // Merge into an existing pending file when present (second batch for same group).
      let existingSha: string | undefined;
      const mergedById = new Map<string, { id: string; upn: string; displayName: string }>();
      const existingRes = await fetch(`/api/git/file?slug=${encodeURIComponent(tenantSlug)}&path=${encodeURIComponent(path)}`);
      if (existingRes.ok) {
        const existing = await existingRes.json() as { exists?: boolean; content?: string; sha?: string };
        if (existing.exists && existing.content) {
          existingSha = existing.sha || undefined;
          try {
            const parsed = JSON.parse(existing.content) as {
              users?: Array<{ id?: string; upn?: string; displayName?: string }>;
              userIds?: string[];
            };
            const prior = parsed.users?.length
              ? parsed.users
              : (parsed.userIds ?? []).map(id => ({ id, upn: id, displayName: '' }));
            for (const u of prior) {
              if (u?.id) mergedById.set(u.id, { id: u.id, upn: u.upn ?? u.id, displayName: u.displayName ?? '' });
            }
          } catch { /* treat as empty if corrupt */ }
        }
      }

      const newlyQueued = newUsers.filter(u => !mergedById.has(u.id)).length;
      for (const u of newUsers) mergedById.set(u.id, u);

      const requestPayload = {
        requestedAt:      new Date().toISOString(),
        requestedBy:      'portal',
        groupId:          group.id,
        groupDisplayName: group.displayName,
        users: Array.from(mergedById.values()),
      };
      const totalPending = requestPayload.users.length;
      const writeRes = await fetch('/api/git/file', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: tenantSlug, path,
          content: JSON.stringify(requestPayload, null, 2),
          sha: existingSha,
          message: `portal: queue group ${mode} — ${group.displayName} (${newlyQueued} new, ${totalPending} total)`,
        }),
      });
      if (!writeRes.ok) {
        const errBody = await writeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error || 'Failed to write request file');
      }

      // Trigger deploy pipeline — group membership steps always run when pending files exist;
      // the pipeline goes through the Plan (WhatIf) → Approval gate → Apply flow.
      const triggerRes = await fetch('/api/pipelines/trigger', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: tenantSlug, workflow: 'deploy.yml',
          inputs: { deploy_options: '' },
        }),
      });
      if (!triggerRes.ok) throw new Error('Failed to trigger deployment pipeline');

      const verb = mode === 'add' ? 'adding' : 'removing';
      const prep = mode === 'add' ? 'to' : 'from';
      setActionMsg({
        type: 'ok',
        text: `Queued: ${verb} ${newlyQueued} user(s) ${prep} "${group.displayName}" (${totalPending} total pending). The deploy pipeline will show a WhatIf preview and require approval before applying.`,
      });
      setSelectedUsers(new Set());
    } catch (e) { setActionMsg({ type: 'err', text: String(e) }); }
    finally     { setActionLoading(false); }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const DAY_OPTIONS = [7, 14, 30, 60, 90];

  return (
    <div style={{ padding: '16px 28px 40px', color: C.text, fontSize: '0.8125rem' }}>

      {/* ── Controls bar ──────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        {tenants.length > 1 && (
          <select value={tenantSlug} onChange={e => { setTenantSlug(e.target.value); setGroups([]); setSelectedGroup(''); }}
            style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem', fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}>
            {tenants.map(t => <option key={t.slug} value={t.slug}>{t.displayName}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {DAY_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '5px 12px', borderRadius: 6, fontSize: '0.8125rem', fontWeight: 500,
              border: `1px solid ${days === d ? C.green : C.border}`,
              background: days === d ? C.greenBg : '#18181b',
              color: days === d ? C.green : C.body, cursor: 'pointer', fontFamily: 'inherit',
            }}>{d}d</button>
          ))}
        </div>
        <Btn onClick={fetchData} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Btn>
        {data?.availableDates && data.availableDates.length > 0 && (
          <span style={{ color: C.muted, fontSize: '0.75rem' }}>
            {data.availableDates[data.availableDates.length - 1]} → {data.availableDates[0]} ({data.availableDates.length} days)
          </span>
        )}
      </div>

      {/* ── Error / licence warning ────────────────────────────────────── */}
      {error && <div style={{ background: C.redBg, border: `1px solid ${C.red}`, borderRadius: 8, padding: '12px 16px', color: C.red, marginBottom: 16 }}>{error}</div>}
      {data?.licenceWarning && <div style={{ background: C.yellowBg, border: `1px solid ${C.yellow}`, borderRadius: 8, padding: '12px 16px', color: C.yellow, marginBottom: 16 }}>⚠ {data.licenceWarning}</div>}

      {/* ── Compliance Criteria — always-visible chip toolbar ─────────── */}
      {data && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>

          {/* Row 1: label + toggle chips + reset */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: C.dim, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', marginRight: 4 }}>
              Compliance criteria
            </span>

            {/* Criteria chips */}
            {([
              { key: 'requireEntraJoined',   label: 'Entra Joined',   color: C.green,  bg: C.greenBg  },
              { key: 'requireCompliant',      label: 'All Compliant',  color: C.green,  bg: C.greenBg  },
              { key: 'excludeLegacyAuth',     label: 'No Legacy Auth', color: C.purple, bg: C.purpleBg },
              { key: 'excludeMobile',         label: 'No Mobile',      color: C.blue,   bg: C.blueBg   },
            ] as { key: keyof ComplianceCriteria; label: string; color: string; bg: string }[]).map(({ key, label, color, bg }) => {
              const active = !!criteria[key];
              return (
                <button key={key}
                  onClick={() => {
                    if (key === 'excludeMobile') {
                      setCriteria(c => ({ ...c, excludeMobile: !c.excludeMobile, includeManagedMobile: !c.excludeMobile ? c.includeManagedMobile : false }));
                    } else {
                      setCriteria(c => ({ ...c, [key]: !c[key] }));
                    }
                  }}
                  title={
                    key === 'requireEntraJoined' ? 'Require all sign-ins from Entra joined devices' :
                    key === 'requireCompliant'    ? 'Require all sign-ins to be compliant' :
                    key === 'excludeLegacyAuth'   ? 'Exclude SMTP / IMAP / EAS sign-ins' :
                                                   'Exclude iOS / Android sign-ins'
                  }
                  style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
                    border: `1px solid ${active ? color : C.border}`,
                    background: active ? bg : 'transparent',
                    color: active ? color : C.muted,
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.12s',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  <span style={{ fontSize: '0.65rem' }}>{active ? '●' : '○'}</span>
                  {label}
                </button>
              );
            })}

            {/* Managed mobile sub-option — only when No Mobile is active */}
            {criteria.excludeMobile && (
              <button
                onClick={() => setCriteria(c => ({ ...c, includeManagedMobile: !c.includeManagedMobile }))}
                title="When enabled, Intune-managed mobile devices are still evaluated"
                style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
                  border: `1px solid ${criteria.includeManagedMobile ? C.blue : C.border}`,
                  background: criteria.includeManagedMobile ? C.blueBg : 'transparent',
                  color: criteria.includeManagedMobile ? C.blue : C.muted,
                  cursor: 'pointer', fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <span style={{ fontSize: '0.65rem' }}>{criteria.includeManagedMobile ? '●' : '○'}</span>
                Keep managed mobile
              </button>
            )}

            <div style={{ flex: 1 }} />

            {/* Excluded apps toggle */}
            {uniqueAppNames.length > 0 && (
              <button onClick={() => setShowApps(v => !v)} style={{
                padding: '4px 12px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
                border: `1px solid ${criteria.excludedApps.length > 0 ? C.blue : C.border}`,
                background: criteria.excludedApps.length > 0 ? C.blueBg : 'transparent',
                color: criteria.excludedApps.length > 0 ? C.blue : C.muted,
                cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                Excluded apps
                {criteria.excludedApps.length > 0
                  ? <span style={{ background: C.blue, color: '#000', borderRadius: 10, padding: '0 5px', fontSize: '0.6rem', fontWeight: 700 }}>{criteria.excludedApps.length}</span>
                  : <span style={{ fontSize: '0.7rem', color: C.muted }}>{showApps ? '▲' : '▼'}</span>
                }
              </button>
            )}

            <button onClick={() => setCriteria(DEFAULT_CRITERIA)} style={{
              padding: '4px 10px', background: 'transparent', border: 'none',
              color: C.muted, cursor: 'pointer', fontSize: '0.7rem', fontFamily: 'inherit',
            }}>
              Reset
            </button>
          </div>

          {/* Row 2: excluded apps list (expandable) */}
          {showApps && uniqueAppNames.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: '0.7rem', color: C.dim, marginBottom: 8 }}>
                Sign-ins where ALL accessed apps are excluded are skipped during compliance evaluation.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {uniqueAppNames.map(app => {
                  const active = criteria.excludedApps.includes(app);
                  return (
                    <button key={app}
                      onClick={() => setCriteria(c => ({
                        ...c,
                        excludedApps: active ? c.excludedApps.filter(a => a !== app) : [...c.excludedApps, app],
                      }))}
                      style={{
                        padding: '3px 10px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500,
                        border: `1px solid ${active ? C.blue : C.border}`,
                        background: active ? C.blueBg : 'transparent',
                        color: active ? C.blue : C.dim,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {active ? '✕ ' : ''}{app}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Stats cards ───────────────────────────────────────────────── */}
      {data && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <StatCard label="Fully Compliant"      value={counts.compliant}    color={C.green}  bg={C.greenBg}
            active={filter === 'compliant'} onClick={() => setFilter(f => f === 'compliant' ? 'all' : 'compliant')} />
          <StatCard label="Non-Compliant Device" value={counts.nonCompliant} color={C.red}    bg={C.redBg}
            active={filter === 'issues'} onClick={() => setFilter(f => f === 'issues' ? 'all' : 'issues')} />
          <StatCard label="BYOD"        value={counts.byod}     color={C.yellow} bg={C.yellowBg} />
          <StatCard label="Unregistered" value={counts.personal} color={C.orange} bg={C.orangeBg} />
          <StatCard label="Legacy Auth"  value={counts.legacy}   color={C.purple} bg={C.purpleBg} />
        </div>
      )}

      {/* ── Filter tabs ────────────────────────────────────────────────── */}
      {data && (
        <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${C.border}`, marginBottom: 10 }}>
          <div style={{ display: 'flex', flex: 1 }}>
            {(['all', 'compliant', 'issues'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '8px 18px', background: 'transparent', border: 'none',
                borderBottom: filter === f ? `2px solid ${C.green}` : '2px solid transparent',
                color: filter === f ? C.green : C.dim, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8125rem', marginBottom: -1,
              }}>
                {f === 'all' ? `All (${computedUsers.length})` : f === 'compliant' ? `Fully Compliant (${counts.compliant})` : `Issues (${computedUsers.length - counts.compliant})`}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingBottom: 2 }}>
            <button onClick={selectAllCompliant} style={{ padding: '5px 10px', background: 'transparent', border: 'none', color: C.blue, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', borderRadius: 4 }}>
              Select all compliant
            </button>
            {selectedUsers.size > 0 && (
              <button onClick={clearSelection} style={{ padding: '5px 10px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem', borderRadius: 4 }}>
                Clear {selectedUsers.size}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Group filter bar ──────────────────────────────────────────── */}
      {data && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 10, padding: '7px 10px' }}>

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: groupFilters.length > 0 ? 8 : 0 }}>
            <span style={{ fontSize: '0.75rem', color: C.dim, fontWeight: 600, whiteSpace: 'nowrap' }}>Group filter</span>

            {/* AND / OR toggle — only shown when ≥2 conditions */}
            {groupFilters.length >= 2 && (
              <div style={{ display: 'flex', gap: 2, background: '#18181b', borderRadius: 5, padding: 2 }}>
                {(['and', 'or'] as const).map(l => (
                  <button key={l} onClick={() => setGroupFilterLogic(l)} style={{
                    padding: '2px 10px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    background: groupFilterLogic === l ? C.blue : 'transparent',
                    color:      groupFilterLogic === l ? '#000'  : C.dim,
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>{l}</button>
                ))}
              </div>
            )}

            <button
              onClick={() => {
                setGroupsNeeded(true);
                setGroupFilters(prev => [...prev, { id: crypto.randomUUID(), groupKey: '', mode: 'member' }]);
              }}
              style={{
                padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', fontWeight: 500,
                border: `1px solid ${C.border}`, background: 'transparent',
                color: C.dim, cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <span style={{ fontSize: '1rem', lineHeight: 1 }}>+</span> Add condition
            </button>

            {groupFilters.length > 0 && (
              <>
                <span style={{ fontSize: '0.75rem', color: C.muted }}>
                  {filteredUsers.length} / {computedUsers.length} users
                </span>
                <button onClick={() => setGroupFilters([])} style={{ marginLeft: 'auto', padding: '2px 7px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.75rem' }}>
                  Clear all
                </button>
              </>
            )}
          </div>

          {/* Condition rows */}
          {groupFilters.map((row, idx) => {
            const members     = memberCache[row.groupKey];
            const isLoading   = members === null;
            const noBackup    = members instanceof Set && members.size === 0 && row.groupKey;
            const isConfigured = row.groupKey !== '';

            return (
              <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: idx === 0 ? 0 : 6 }}>

                {/* AND / OR label between rows */}
                {idx > 0 && (
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 700, color: C.blue,
                    textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 28, textAlign: 'center',
                  }}>
                    {groupFilterLogic}
                  </span>
                )}
                {idx === 0 && groupFilters.length > 1 && (
                  <span style={{ minWidth: 28 }} />
                )}

                {/* Group selector */}
                <select
                  value={row.groupKey}
                  onChange={e => setGroupFilters(prev => prev.map(f => f.id === row.id ? { ...f, groupKey: e.target.value } : f))}
                  onFocus={() => setGroupsNeeded(true)}
                  style={{
                    background: '#18181b', border: `1px solid ${C.border}`,
                    color: row.groupKey ? C.text : C.muted,
                    borderRadius: 5, padding: '4px 7px', fontSize: '0.8125rem',
                    fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
                    minWidth: 160, maxWidth: 300,
                  }}
                >
                  <option value="">— select group —</option>
                  {groupsLoading && <option disabled>Loading…</option>}
                  {groups.map(g => <option key={g.id || g.displayName} value={g.id || g.displayName}>{g.displayName}</option>)}
                </select>

                {/* Member / Not member */}
                {isConfigured && (
                  <div style={{ display: 'flex', gap: 3 }}>
                    {(['member', 'not-member'] as const).map(mode => {
                      const active = row.mode === mode;
                      const color  = mode === 'member' ? C.green : C.orange;
                      const bg     = mode === 'member' ? C.greenBg : C.orangeBg;
                      return (
                        <button key={mode}
                          onClick={() => setGroupFilters(prev => prev.map(f => f.id === row.id ? { ...f, mode } : f))}
                          style={{
                            padding: '3px 10px', borderRadius: 5, fontSize: '0.75rem', fontWeight: 500,
                            border: `1px solid ${active ? color : C.border}`,
                            background: active ? bg : 'transparent',
                            color: active ? color : C.dim,
                            cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          {mode === 'member' ? 'Is member' : 'Not member'}
                        </button>
                      );
                    })}
                  </div>
                )}

                {isLoading    && <span style={{ fontSize: '0.75rem', color: C.dim }}>Loading…</span>}
                {!isLoading && noBackup && <span style={{ fontSize: '0.75rem', color: C.yellow }}>⚠ No backup</span>}

                {/* Remove row */}
                <button
                  onClick={() => setGroupFilters(prev => prev.filter(f => f.id !== row.id))}
                  style={{ padding: '3px 6px', background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.875rem' }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Action bar ────────────────────────────────────────────────── */}
      {selectedUsers.size > 0 && (
        <div style={{ background: 'rgba(34,197,94,0.05)', border: `1px solid rgba(34,197,94,0.25)`, borderRadius: 8, padding: '12px 16px', marginTop: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: C.green, fontWeight: 600 }}>{selectedUsers.size} user{selectedUsers.size !== 1 ? 's' : ''} selected</span>
            <button onClick={clearSelection} style={{ background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: '0.75rem', fontFamily: 'inherit', padding: 0 }}>Clear selection</button>
          </div>
          <div style={{ width: 1, height: 20, background: C.border, flexShrink: 0 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Btn onClick={() => void copySelectedUsers()}>Copy UPNs</Btn>
            <Btn onClick={exportSelectedUsersCsv}>Export CSV</Btn>
          </div>
          <div style={{ width: 1, height: 20, background: C.border, flexShrink: 0 }} />
          {groupsLoading ? (
            <span style={{ color: C.muted }}>Loading groups…</span>
          ) : groups.length === 0 ? (
            <span style={{ color: C.muted, fontSize: '0.8125rem' }}>No security groups in backup — run a backup first</span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '0.6875rem', color: C.dim, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Group</span>
                <select value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)}
                  style={{ background: '#18181b', border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: '6px 10px', fontSize: '0.8125rem', fontFamily: 'inherit', outline: 'none', cursor: 'pointer', minWidth: 220, maxWidth: 320 }}>
                  <option value="">— select group —</option>
                  {groups.map(g => <option key={g.id || g.displayName} value={g.id || g.displayName}>{g.displayName}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <Btn variant="primary" disabled={!selectedGroup || actionLoading} onClick={() => void handleGroupAction('add')}>
                  {actionLoading ? 'Queuing…' : `＋ Add ${selectedUsers.size} to group`}
                </Btn>
                <Btn variant="danger" disabled={!selectedGroup || actionLoading} onClick={() => void handleGroupAction('remove')}>
                  {actionLoading ? 'Queuing…' : `− Remove ${selectedUsers.size} from group`}
                </Btn>
              </div>
            </div>
          )}
          {actionMsg && (
            <div style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: actionMsg.type === 'ok' ? C.greenBg : C.redBg, color: actionMsg.type === 'ok' ? C.green : C.red, fontSize: '0.8125rem' }}>
              {actionMsg.text}
            </div>
          )}
          {exportMsg && (
            <div style={{ width: '100%', padding: '8px 12px', borderRadius: 6, background: C.blueBg, color: C.blue, fontSize: '0.8125rem' }}>
              {exportMsg}
            </div>
          )}
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {data && filteredUsers.length === 0 && !loading && (
        <div style={{ color: C.muted, padding: '32px 0', textAlign: 'center' }}>
          {data.availableDates.length === 0 ? 'No backup data found. Run the backup pipeline to populate sign-in logs.' : 'No users match the current filter.'}
        </div>
      )}

      {/* ── User table ────────────────────────────────────────────────── */}
      {filteredUsers.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, color: C.muted, fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={{ width: 48, padding: '9px 0' }} />
                <th style={{ textAlign: 'left', padding: '9px 8px 9px 0', fontWeight: 600 }}>User</th>
                <th style={{ width: 84, textAlign: 'center', padding: '9px 8px', borderLeft: `1px solid ${C.border}`, fontWeight: 600 }}>Joined</th>
                <th style={{ width: 94, textAlign: 'center', padding: '9px 8px', borderLeft: `1px solid ${C.border}`, fontWeight: 600 }}>Compliant</th>
                <th style={{ width: 84, textAlign: 'center', padding: '9px 8px', borderLeft: `1px solid ${C.border}`, fontWeight: 600 }}>Legacy</th>
                <th style={{ width: 110, textAlign: 'right', padding: '9px 16px', borderLeft: `1px solid ${C.border}`, fontWeight: 600 }}>Last Seen</th>
                <th style={{ width: 80, textAlign: 'right', padding: '9px 8px', fontWeight: 600 }}>Sign-ins</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user, i) => {
                const isSelected = selectedUsers.has(user.userId);
                const isExpanded = expandedUsers.has(user.userId);
                const isLast     = i === filteredUsers.length - 1;
                const relevantEntries = getFilteredEntries(user.entries, criteria);
                const joinState  = getJoinState(relevantEntries);
                const complState = getComplState(relevantEntries);

                const joinTitle  = joinState  === 'good' ? 'All sign-ins from Entra joined devices'
                                : joinState  === 'warn' ? 'Mix — some Entra joined, some not'
                                :                         'No Entra joined devices';
                const complTitle = complState === 'good' ? 'All sign-ins compliant'
                                : complState === 'bad'  ? 'All sign-ins non-compliant'
                                : complState === 'na'   ? 'Mix — some compliant, some non-compliant (or unknown)'
                                :                         'Unknown';
                const legacyTitle = user.hasLegacyAuth ? 'Has legacy auth sign-ins (SMTP/IMAP/EAS)' : 'No legacy auth';
                const rowBorder   = !isLast || isExpanded ? `1px solid ${C.border}` : 'none';

                return (
                  <Fragment key={user.userId}>
                    <tr
                      style={{ borderBottom: rowBorder, background: isSelected ? 'rgba(34,197,94,0.05)' : 'transparent', cursor: 'pointer', userSelect: 'none', transition: 'background 0.1s' }}
                      onClick={() => toggleExpand(user.userId)}
                    >
                      <td
                        onClick={e => { e.stopPropagation(); toggleUser(user.userId); }}
                        title={isSelected ? 'Deselect' : 'Select'}
                        style={{ textAlign: 'center', verticalAlign: 'middle', padding: '12px 0' }}
                      >
                        <Checkbox checked={isSelected} />
                      </td>
                      <td style={{ padding: '10px 8px 10px 0', verticalAlign: 'middle' }}>
                        <div style={{ fontWeight: 500, color: C.white }}>{user.userDisplayName || user.userPrincipalName}</div>
                        {user.userDisplayName && <div style={{ color: C.muted, fontSize: '0.75rem' }}>{user.userPrincipalName}</div>}
                      </td>
                      <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', borderLeft: `1px solid ${C.border}` }}>
                        <StatusIcon state={joinState} title={joinTitle} />
                      </td>
                      <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', borderLeft: `1px solid ${C.border}` }}>
                        <StatusIcon state={complState} title={complTitle} />
                      </td>
                      <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', borderLeft: `1px solid ${C.border}` }}>
                        <StatusIcon state={user.hasLegacyAuth ? 'bad' : 'na'} title={legacyTitle} />
                      </td>
                      <td style={{ textAlign: 'right', verticalAlign: 'middle', color: C.dim, whiteSpace: 'nowrap', padding: '10px 16px', borderLeft: `1px solid ${C.border}` }}>
                        {user.lastSeen ? new Date(user.lastSeen).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right', verticalAlign: 'middle', color: C.dim, padding: '10px 8px' }}>
                        {user.totalSignIns.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', color: isExpanded ? C.blue : C.muted }}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'block', margin: '0 auto' }}>
                          <path d="M4 2.5L8 6L4 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr style={{ borderBottom: isLast ? 'none' : `1px solid ${C.border}` }}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <UserEntries entries={user.entries} namedLocations={namedLocations} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Last run result ────────────────────────────────────────────── */}
      {lastRun && (
        <div style={{ marginTop: 24, border: `1px solid ${C.border}`, borderRadius: 8, padding: '14px 18px', background: C.surface }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
            <div style={{ color: C.dim, fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last Group Action</div>
            <span style={{ color: C.muted, fontSize: '0.75rem' }}>{new Date(lastRun.completedAt).toLocaleString()}</span>
          </div>
          {lastRun.actions.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.8125rem', color: C.body, marginBottom: i < lastRun.actions.length - 1 ? 8 : 0, paddingBottom: i < lastRun.actions.length - 1 ? 8 : 0, borderBottom: i < lastRun.actions.length - 1 ? `1px solid ${C.border}` : 'none' }}>
              <span>{a.mode === 'remove' ? '− Removed from' : '＋ Added to'}: <strong style={{ color: C.text }}>{a.groupDisplayName}</strong></span>
              <span>Requested: <strong style={{ color: C.text }}>{a.totalRequested}</strong></span>
              {a.mode === 'add'    && <span style={{ color: C.green }}>Added: <strong>{a.added}</strong></span>}
              {a.mode === 'remove' && <span style={{ color: C.red }}>Removed: <strong>{a.removed}</strong></span>}
              {a.alreadyMember > 0 && <span style={{ color: C.dim }}>Already member: {a.alreadyMember}</span>}
              {a.notMember > 0     && <span style={{ color: C.dim }}>Not a member: {a.notMember}</span>}
              {a.failed > 0        && <span style={{ color: C.red }}>Failed: {a.failed}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
