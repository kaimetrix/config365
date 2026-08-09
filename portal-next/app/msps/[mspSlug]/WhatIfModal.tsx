'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { toGiteaWebUrl } from '@/lib/utils';
import { normalizeForCompare } from '@/lib/normalize-for-compare';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModifiedValue {
  Existing: string;
  Desired: string;
}

interface ChangesObject {
  Modified?: string[];
  ModifiedValues?: Record<string, ModifiedValue>;
  Added?: string[];
  Removed?: string[];
  OmaSettings?: string[];
  AssignmentsExisting?: string;
  AssignmentsDesired?: string;
  assignmentsExisting?: string;
  assignmentsDesired?: string;
}

export interface PlanItem {
  service: string;
  name: string;
  type?: string;
  filePath?: string;
  /** Passthrough of $r.Changes from the pipeline service scripts, or string[] from connector scripts */
  changes?: ChangesObject | string[];
  error?: string;
}

interface DeployPlan {
  generatedAt?: string;
  tenant?: string;
  runId?: string;
  summary?: {
    creates?: number;
    updates?: number;
    deletes?: number;
    noChanges?: number;
    errors?: number;
    groupMembership?: number;
  };
  creates?: PlanItem[];
  updates?: PlanItem[];
  assignments?: PlanItem[];
  deletes?: PlanItem[];
  errors?: PlanItem[];
  protected?: PlanItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SERVICE_FOLDERS: Record<string, string> = {
  ConditionalAccess:      'conditional-access',
  Intune:                 'intune',
  Groups:                 'groups',
  Teams:                  'teams',
  SharePoint:             'sharepoint-settings',
  Exchange:               'exchange',
  EnterpriseApps:         'enterprise-apps',
  AuthenticationPolicies: 'authentication-policies',
  ConsentPermissions:     'entra-id-consentpermissions',
  EntraIDSettings:        'entra-id-device-settings',
  DefenderConnector:      'intune/defender-connector',
  CustomAttributes:       'custom-attributes',
  InformationProtection:  'information-protection',
  DlpCompliance:          'information-protection',
  WingetApps:             'apps/winget',
  ChocoApps:              'apps/chocolatey',
  CustomApps:             'apps/custom',
  PrinterApps:            'apps/printer',
};

// Maps plan-level type strings → actual subfolder names.
// '' (empty string) means the file lives directly in the service folder (no subfolder).
const TYPE_SUBFOLDER_MAP: Record<string, string> = {
  // ConditionalAccess
  'ConditionalAccessPolicy': 'policies',
  'NamedLocation':           'named-locations',
  // Exchange: PowerShell cmdlet type → kebab-case folder
  'HostedContentFilterPolicy':       'anti-spam-policies',
  'HostedOutboundSpamFilterPolicy':  'anti-spam-policies',
  'AntiPhishPolicy':                 'anti-phishing-policies',
  'MalwareFilterPolicy':             'malware-filter-policies',
  'TransportRule':                   'transport-rules',
  'InboundConnector':                'connectors/inbound',
  'OutboundConnector':               'connectors/outbound',
  'OrganizationConfig':              'organization-config',
  'OrganizationCustomization':     'organization-config',
  'IrmConfiguration':                'irm-configuration',
  'OmeConfiguration':                'ome-configuration',
  'AipService':                      'aip-service',
  'AipServiceConfiguration':         'aip-service/configuration',
  'AipLicensingLocationSync':        'aip-service',
  'OwaMailboxPolicy':                'owa-policies',
  'ExternalInOutlook':               '',
  'MailboxAuditRemediation':         '',
  // ConsentPermissions
  'ConsentPolicy':                'policies',
  'AdminConsentRequestPolicy':    'policies',
  'PermissionClassification':     'permissionClassifications',
  // EntraIDSettings — files live directly in the service folder
  'Policy':                       '',
  'MdmScope':                     '',
  'MamScope':                     '',
  // DefenderConnector — single JSON in intune/defender-connector/
  'mobileThreatDefenseConnector': '',
  // AuthenticationPolicies — files live directly in the service folder
  'AuthenticationMethod':         '',
  // CustomAttributes
  'AttributeDefinition':          'attribute-definitions',
  'AttributeSet':                 'attribute-sets',
  // Intune — type values match folder names exactly
  'admx-files':                   'admx-files',
  'app-protection':               'app-protection',
  'autopilot':                    'autopilot',
  'compliance-policies':          'compliance-policies',
  'device-configurations':        'device-configurations',
  'endpoint-security':            'endpoint-security',
  'filters':                      'filters',
  'group-policy-configurations':  'group-policy-configurations',
  'mobile-apps':                  'mobile-apps',
  'platform-scripts-bash':        'platform-scripts-bash',
  'platform-scripts-powershell':  'platform-scripts-powershell',
  'settings-catalog':             'settings-catalog',
  'windows-driver-updates':       'windows-driver-updates',
  'windows-feature-updates':      'windows-feature-updates',
  'windows-quality-updates':      'windows-quality-updates',
  'windows-updates':              'windows-updates',
  // InformationProtection
  'Label':                        'sensitivity-labels',
  'LabelPolicy':                  'label-policies',
  'LabelPolicyRule':              'label-policy-rules',
  'AutoLabelPolicy':              'auto-label-policies',
  'AutoLabelRule':                'auto-label-rules',
  // DlpCompliance
  'DlpPolicy':                    'dlp-policies',
  'DlpRule':                      'dlp-rules',
};

// When a plan item has no type, try these subfolders in order (first match wins)
const FALLBACK_SUBFOLDERS: Record<string, string[]> = {
  Intune: [
    'app-protection', 'device-configurations', 'compliance-policies',
    'endpoint-security', 'platform-scripts-powershell', 'platform-scripts-bash',
    'group-policy-configurations', 'mobile-apps', 'filters', 'autopilot',
    'admx-files', 'settings-catalog', 'windows-updates',
    '',  // last resort: directly in intune/
  ],
  EnterpriseApps:  ['external-sps', 'registrations', ''],
  ConditionalAccess: ['policies', 'named-locations', ''],
  InformationProtection: [
    'sensitivity-labels', 'label-policies', 'label-policy-rules',
    'auto-label-policies', 'auto-label-rules', 'dlp-policies', 'dlp-rules', '',
  ],
  DlpCompliance: [
    'dlp-policies', 'dlp-rules', '',
  ],
};

// Services where filenames are kebab-cased rather than matching the display name directly
// e.g. "Authorization Policy" → "authorization-policy.json"
const KEBAB_FILENAME_SERVICES = new Set([
  'ConsentPermissions',
  'EntraIDSettings',
  'AuthenticationPolicies',
]);

// Display-name → filename overrides for items whose backup/baseline filenames
// don't match the kebab-cased display name (hardcoded in the PowerShell scripts).
const SERVICE_NAME_OVERRIDES: Record<string, Record<string, string>> = {
  AuthenticationPolicies: {
    'FIDO2 (Passkeys)':            'passkeys-fido2',
    'Hardware OATH Tokens (x509)': 'hardware-oath-tokens',
  },
  EntraIDSettings: {
    'MDM Scope': 'mdm-scope',
    'MAM Scope': 'mam-scope',
  },
  Exchange: {
    'ExternalInOutlook': 'external-in-outlook',
    'Organization Customization': 'OrganizationCustomization',
  },
};

function toKebabFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Derives the platform prefix used in app-protection filenames from the display name. */
function derivePlatformPrefix(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('ios'))                      return 'iOS_';
  if (lower.includes('android'))                  return 'Android_';
  if (lower.includes('macos') || lower.includes('mac os')) return 'macOS_';
  if (lower.includes('windows'))                  return 'Windows_';
  return '';
}

function itemKey(item: PlanItem, action: string): string {
  return `${action}/${item.service}/${item.name}`;
}

function suggestedPattern(item: PlanItem): string {
  const name = (item.name ?? '').trim();
  if (!name) return '';
  if (item.service === 'DefenderConnector') {
    return 'intune/defender-connector/windows-defender-atp-connector.json';
  }
  const filename = `${name}.json`;
  const folder = SERVICE_FOLDERS[item.service] ?? '';
  const subFolder = item.type && item.type !== item.service ? item.type : null;
  if (folder && subFolder) return `${folder}/${subFolder}/${filename}`;
  if (folder) return `${folder}/*/${filename}`;
  return filename;
}

/** Replaces {{VAR:Name}} tokens with resolved tenant values. Unresolved tokens are left as-is. */
function applyVariableTokens(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{VAR:([^}]+)\}\}/g, (match, rawName: string) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
  });
}

function normalizeChanges(changes: PlanItem['changes']): ChangesObject | null {
  if (!changes) return null;
  if (Array.isArray(changes)) return { Modified: changes };
  return changes;
}

function getAssignmentStrings(c: ChangesObject | null): { existing: string; desired: string } | null {
  if (!c) return null;
  const raw = c as Record<string, unknown>;
  const existing = raw.AssignmentsExisting ?? raw.assignmentsExisting;
  const desired = raw.AssignmentsDesired ?? raw.assignmentsDesired;
  if (typeof existing !== 'string' || typeof desired !== 'string') return null;
  return { existing, desired };
}

function formatAssignmentJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function countChanges(item: PlanItem): number {
  const c = normalizeChanges(item.changes);
  if (!c) return 0;
  return (c.Modified?.length ?? 0) + (c.Added?.length ?? 0) + (c.Removed?.length ?? 0) + (c.OmaSettings?.length ?? 0);
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

type ObjDiff = { type: 'change' | 'add' | 'remove'; key: string; existing?: unknown; desired?: unknown };

function computeObjectDiff(existingStr: string, desiredStr: string): ObjDiff[] | null {
  try {
    const existing = JSON.parse(existingStr);
    const desired  = JSON.parse(desiredStr);
    if (typeof existing !== 'object' || Array.isArray(existing) || typeof desired !== 'object' || Array.isArray(desired)) return null;
    const allKeys = [...new Set([...Object.keys(existing), ...Object.keys(desired)])].sort();
    const diffs: ObjDiff[] = [];
    for (const k of allKeys) {
      const hasE = Object.prototype.hasOwnProperty.call(existing, k);
      const hasD = Object.prototype.hasOwnProperty.call(desired, k);
      if (!hasE)                                                          diffs.push({ type: 'add',    key: k, desired:  desired[k] });
      else if (!hasD)                                                     diffs.push({ type: 'remove', key: k, existing: existing[k] });
      else if (JSON.stringify(existing[k]) !== JSON.stringify(desired[k])) diffs.push({ type: 'change', key: k, existing: existing[k], desired: desired[k] });
    }
    return diffs;
  } catch { return null; }
}

// ─── ExpandableValue ──────────────────────────────────────────────────────────

function ExpandableValue({ value, color }: { value: string; color: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!value) return <span style={{ color: '#52525b', fontStyle: 'italic', fontSize: '0.7rem' }}>—</span>;
  if (value.length <= 80) return <span style={{ color, fontSize: '0.7rem', fontFamily: 'monospace', wordBreak: 'break-word' }}>{value}</span>;
  return expanded ? (
    <pre style={{ margin: 0, padding: '6px 8px', background: '#111113', border: '1px solid #27272a', borderRadius: 4, fontSize: '0.68rem', color, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto' }}>{value}</pre>
  ) : (
    <button onClick={() => setExpanded(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.7rem', color, fontFamily: 'monospace', textAlign: 'left' }}>
      {value.slice(0, 60)}… <span style={{ color: '#52525b' }}>[expand]</span>
    </button>
  );
}

// ─── DiffCell (used inside full diff table) ───────────────────────────────────

function DiffCell({ value, color }: { value: string; color: string }) {
  if (!value) return <span style={{ color: '#3f3f46', fontStyle: 'italic', fontSize: '0.75rem' }}>—</span>;
  if (value.length <= 120) return <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color, wordBreak: 'break-word' }}>{value}</span>;
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.75rem', color, listStyle: 'none', outline: 'none' }}>
        {value.slice(0, 80)}… <span style={{ color: '#52525b', fontSize: '0.65rem' }}>[expand]</span>
      </summary>
      <pre style={{ margin: '4px 0 0', padding: 8, background: '#0a0a0c', border: '1px solid #27272a', borderRadius: 4, fontSize: '0.7rem', color, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflowY: 'auto' }}>{value}</pre>
    </details>
  );
}

// ─── PropertyChanges (inline summary inside each card) ───────────────────────

function PropertyChanges({ item }: { item: PlanItem }) {
  const c = normalizeChanges(item.changes);
  if (!c) return null;
  const hasContent = (c.Modified?.length ?? 0) + (c.Added?.length ?? 0) + (c.Removed?.length ?? 0) + (c.OmaSettings?.length ?? 0) > 0;
  if (!hasContent) return null;

  return (
    <div style={{ marginTop: 8, padding: '8px 10px', background: '#09090b', borderRadius: 6, border: '1px solid #1a1a1d' }}>
      {c.Modified?.map((m, i) => {
        if (m === 'Assignments') {
          const asgn = getAssignmentStrings(c);
          if (asgn) {
            const diffs = computeObjectDiff(formatAssignmentJson(asgn.existing), formatAssignmentJson(asgn.desired));
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.7rem', color: '#71717a', fontFamily: 'monospace', marginBottom: 3 }}>~ Assignments</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <ExpandableValue value={formatAssignmentJson(asgn.existing)} color="#f87171" />
                  <span style={{ color: '#52525b', fontSize: '0.7rem', fontFamily: 'monospace', alignSelf: 'center' }}>→</span>
                  <ExpandableValue value={formatAssignmentJson(asgn.desired)} color="#22c55e" />
                </div>
                {diffs && diffs.length > 0 && (
                  <div style={{ marginTop: 4, marginLeft: 10, padding: '4px 8px', background: '#0d0d0f', borderLeft: '2px solid #27272a', borderRadius: '0 4px 4px 0' }}>
                    <div style={{ fontSize: '0.65rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                      {diffs.length} value{diffs.length !== 1 ? 's' : ''} changed
                    </div>
                    {diffs.map((d, j) => (
                      <div key={j} style={{ fontSize: '0.68rem', fontFamily: 'monospace', marginBottom: 2 }}>
                        {d.type === 'change' && <><span style={{ color: '#f87171' }}>- {d.key}: {toStr(d.existing)}</span><br /><span style={{ color: '#22c55e' }}>+ {d.key}: {toStr(d.desired)}</span></>}
                        {d.type === 'add'    && <span style={{ color: '#22c55e' }}>+ {d.key}: {toStr(d.desired)}</span>}
                        {d.type === 'remove' && <span style={{ color: '#f87171' }}>- {d.key}: {toStr(d.existing)}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {(!diffs || diffs.length === 0) && (
                  <div style={{ marginTop: 4, fontSize: '0.68rem', color: '#71717a', fontStyle: 'italic' }}>
                    Same groups and intents — no assignment change needed.
                  </div>
                )}
              </div>
            );
          }
        }
        const colonIdx = m.indexOf(': ');
        const key = colonIdx !== -1 ? m.slice(0, colonIdx) : null;
        const mv = key ? c.ModifiedValues?.[key] : null;
        if (mv) {
          const diffs = computeObjectDiff(mv.Existing, mv.Desired);
          return (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: '0.7rem', color: '#71717a', fontFamily: 'monospace', marginBottom: 3 }}>~ {key}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <ExpandableValue value={mv.Existing} color="#f87171" />
                <span style={{ color: '#52525b', fontSize: '0.7rem', fontFamily: 'monospace', alignSelf: 'center' }}>→</span>
                <ExpandableValue value={mv.Desired} color="#22c55e" />
              </div>
              {diffs && diffs.length > 0 && (
                <div style={{ marginTop: 4, marginLeft: 10, padding: '4px 8px', background: '#0d0d0f', borderLeft: '2px solid #27272a', borderRadius: '0 4px 4px 0' }}>
                  <div style={{ fontSize: '0.65rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{diffs.length} value{diffs.length !== 1 ? 's' : ''} changed</div>
                  {diffs.map((d, j) => (
                    <div key={j} style={{ fontSize: '0.68rem', fontFamily: 'monospace', marginBottom: 2 }}>
                      {d.type === 'change' && <><span style={{ color: '#f87171' }}>- {d.key}: {toStr(d.existing)}</span><br /><span style={{ color: '#22c55e' }}>+ {d.key}: {toStr(d.desired)}</span></>}
                      {d.type === 'add'    && <span style={{ color: '#22c55e' }}>+ {d.key}: {toStr(d.desired)}</span>}
                      {d.type === 'remove' && <span style={{ color: '#f87171' }}>- {d.key}: {toStr(d.existing)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }
        // Indented child-level diff line (e.g. "    + [item 0] key: 'val'")
        const child = parseChildDiffLine(m);
        if (child) {
          const color = child.symbol === '+' ? '#22c55e' : child.symbol === '-' ? '#f87171' : '#a78bfa';
          const sym   = child.symbol === '+' ? '+' : child.symbol === '-' ? '-' : '~';
          return (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 2, fontFamily: 'monospace', fontSize: '0.72rem', paddingLeft: 16 }}>
              <span style={{ color }}>{sym} {child.label}</span>
              {child.currentVal && <span style={{ color: '#f87171' }}>&apos;{child.currentVal}&apos;</span>}
              {child.currentVal && child.desiredVal && <span style={{ color: '#52525b' }}>→</span>}
              {child.desiredVal && <span style={{ color: '#22c55e' }}>&apos;{child.desiredVal}&apos;</span>}
            </div>
          );
        }
        // Top-level "key: 'old' → 'new'" format
        const parsed = parseModifiedLine(m);
        if (parsed) {
          return (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 3, fontFamily: 'monospace', fontSize: '0.72rem' }}>
              <span style={{ color: '#71717a' }}>~ {parsed.key}:</span>
              <span style={{ color: '#f87171' }}>&apos;{parsed.current}&apos;</span>
              <span style={{ color: '#52525b' }}>→</span>
              <span style={{ color: '#22c55e' }}>&apos;{parsed.desired}&apos;</span>
            </div>
          );
        }
        // Parent "(sub-properties changed)" header — dim it slightly, it's just context
        return (
          <div key={i} style={{ fontSize: '0.72rem', color: '#52525b', fontFamily: 'monospace', marginBottom: 2 }}>~ {m}</div>
        );
      })}
      {c.Added?.map((a, i) => (
        <div key={`a${i}`} style={{ fontSize: '0.72rem', color: '#22c55e', fontFamily: 'monospace', marginBottom: 2 }}>+ {a}</div>
      ))}
      {c.Removed?.map((r, i) => (
        <div key={`r${i}`} style={{ fontSize: '0.72rem', color: '#f87171', fontFamily: 'monospace', marginBottom: 2 }}>- {r}</div>
      ))}
      {c.OmaSettings?.map((o, i) => (
        <div key={`o${i}`} style={{ fontSize: '0.72rem', color: '#a78bfa', fontFamily: 'monospace', marginBottom: 2 }}>  {o}</div>
      ))}
    </div>
  );
}

// ─── Child-diff line parser ───────────────────────────────────────────────────
// Parses lines like "    + [item 0] key: 'value'" or "    ~ [item 0] key: 'old' -> 'new'"
// emitted by Get-GroupSettingCollectionDiff in Configure-Intune-SettingsCatalog.ps1

type ChildDiff = { symbol: '+' | '-' | '~'; label: string; currentVal: string; desiredVal: string };

function parseChildDiffLine(m: string): ChildDiff | null {
  if (!m.startsWith('    ')) return null; // must be indented
  const trimmed = m.trimStart();
  const sym = trimmed[0];
  if (sym !== '+' && sym !== '-' && sym !== '~') return null;
  // Strip symbol + optional "[item N]" prefix
  const rest = trimmed.slice(1).trim().replace(/^\[item \d+\]\s*/, '');
  if (sym === '~') {
    // "key: 'oldval' -> 'newval'"
    const arrowIdx = rest.indexOf("' -> '");
    if (arrowIdx !== -1) {
      const colonIdx = rest.indexOf(': ');
      if (colonIdx !== -1) {
        const key     = rest.slice(0, colonIdx);
        const current = rest.slice(colonIdx + 3, arrowIdx);   // strip leading '
        const desired = rest.slice(arrowIdx + 6, -1);         // strip trailing '
        return { symbol: '~', label: key, currentVal: current, desiredVal: desired };
      }
    }
    // Fallback: no arrow found
    const colonIdx = rest.indexOf(': ');
    const label = colonIdx !== -1 ? rest.slice(0, colonIdx) : rest;
    const val   = colonIdx !== -1 ? rest.slice(colonIdx + 2).replace(/^'|'$/g, '') : '';
    return { symbol: '~', label, currentVal: val, desiredVal: val };
  }
  // "key: 'value'"
  const colonIdx = rest.indexOf(': ');
  const label = colonIdx !== -1 ? rest.slice(0, colonIdx) : rest;
  const val   = colonIdx !== -1 ? rest.slice(colonIdx + 2).replace(/^'|'$/g, '') : '';
  return {
    symbol: sym as '+' | '-',
    label,
    currentVal: sym === '-' ? val : '',
    desiredVal: sym === '+' ? val : '',
  };
}

// ─── Top-level Modified line parser ──────────────────────────────────────────
// Parses lines like "key: '26.4.2' → '26.5'" (unicode arrow or ASCII ->)
// emitted by non-settings-catalog policy scripts (AppProtection, WindowsUpdates, etc.)

type ModifiedLineParsed = { key: string; current: string; desired: string };

function parseModifiedLine(m: string): ModifiedLineParsed | null {
  // Match: key: 'old' → 'new'  OR  key: 'old' -> 'new'
  const match = m.match(/^(.+?):\s+'(.*)'\s*(?:\u2192|->)\s+'(.*)'$/);
  if (match) return { key: match[1].trim(), current: match[2], desired: match[3] };
  return parseConnectorChangeLine(m);
}

/** Parses Configure-DefenderConnector lines like "androidEnabled: False -> True" or "key: (none) -> True". */
function parseConnectorChangeLine(m: string): ModifiedLineParsed | null {
  const match = m.match(/^(.+?):\s*(.*?)\s*(?:\u2192|->)\s*(.+)$/);
  if (!match) return null;
  const key = match[1].trim();
  let current = match[2].trim();
  const desired = match[3].trim();
  if (current === '(none)') current = '';
  return { key, current, desired };
}

// ─── Full-file diff helpers ───────────────────────────────────────────────────

/** Returns an ordered list of candidate repo-relative paths to try (first match wins). */
function buildFilePaths(item: PlanItem): string[] {
  if (item.filePath) {
    return [item.filePath.replace(/^baseline\//, '')];
  }
  if (item.service === 'DefenderConnector') {
    return ['intune/defender-connector/windows-defender-atp-connector.json'];
  }
  const folder = SERVICE_FOLDERS[item.service];
  if (!folder) return [];
  const baseName = (() => {
    const override = SERVICE_NAME_OVERRIDES[item.service]?.[item.name];
    if (override) return override;
    return KEBAB_FILENAME_SERVICES.has(item.service)
      ? toKebabFilename(item.name)
      : item.name;
  })();
  const rawType = item.type && item.type !== item.service ? item.type : null;

  function pathsForSub(sub: string | null): string[] {
    const prefix = sub ? `${folder}/${sub}` : folder;
    // OWA/org nested settings use Identity/Parameter in item.name → exchange/owa-policies/Identity/Parameter.json
    const direct  = `${prefix}/${baseName}.json`;
    // App-protection files are prefixed with the platform: iOS_, Android_, etc.
    if (sub === 'app-protection') {
      const platform = derivePlatformPrefix(item.name);
      if (platform) return [`${prefix}/${platform}${baseName}.json`, direct];
    }
    if (rawType === 'ExternalInOutlook') {
      return [`${folder}/external-in-outlook.json`, `${folder}/external-in-outlook/Enabled.json`];
    }
    return [direct];
  }

  if (rawType) {
    const mapped = TYPE_SUBFOLDER_MAP[rawType];
    const sub = mapped === '' ? null : (mapped ?? rawType);
    return pathsForSub(sub);
  }

  // No type — try fallback subfolders in order
  const fallbacks = FALLBACK_SUBFOLDERS[item.service];
  if (fallbacks) {
    return fallbacks.flatMap(sub => pathsForSub(sub || null));
  }
  return pathsForSub(null);
}

type DiffLine = { b: string; a: string; same: boolean };

function computeLineDiff(before: string, after: string): DiffLine[] {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const m = bLines.length, n = aLines.length;
  if (m * n > 300_000) {
    const max = Math.max(m, n);
    return Array.from({ length: max }, (_, i) => ({ b: bLines[i] ?? '', a: aLines[i] ?? '', same: bLines[i] === aLines[i] }));
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = bLines[i-1] === aLines[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  let i = m, j = n;
  const raw: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && bLines[i-1] === aLines[j-1]) { raw.push({ b: bLines[i-1], a: aLines[j-1], same: true }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { raw.push({ b: '', a: aLines[j-1], same: false }); j--; }
    else { raw.push({ b: bLines[i-1], a: '', same: false }); i--; }
  }
  return raw.reverse();
}

// ─── DiffModal (full property table + full files view) ───────────────────────

function DiffModal({ item, onClose, mspSlug, mspOrg, tenantSlug }: { item: PlanItem; onClose: () => void; mspSlug: string; mspOrg: string; tenantSlug: string }) {
  const c = normalizeChanges(item.changes);
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  const [baselineJson, setBaselineJson] = useState<string | null>(null);
  const [tenantJson,   setTenantJson]   = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError,   setFilesError]   = useState('');

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch full files when the Files tab is activated
  useEffect(() => {
    if (tab !== 'files' || baselineJson !== null || tenantJson !== null) return;
    const relPaths = buildFilePaths(item);
    if (!relPaths.length) { setFilesError('Cannot resolve file path for this item.'); return; }
    setFilesLoading(true);
    setFilesError('');

    async function fetchFirst(
      paths: string[], prefix: string, params: string
    ): Promise<{ exists: boolean; content?: string }> {
      for (const p of paths) {
        const url = `/api/git/file?${params}&path=${encodeURIComponent(`${prefix}/${p}`)}`;
        const data = await fetch(url).then(r => r.json()).catch(() => ({ exists: false })) as { exists?: boolean; content?: string };
        if (data.exists) return data as { exists: boolean; content?: string };
      }
      return { exists: false };
    }

    // Normalize using the same pipeline as the deploy comparison:
    // strips API-only fields (per compare-ignore-fields/*.json), drops nulls,
    // sorts keys + arrays — so only real value differences show in the diff.
    const fmt = (s: string | undefined, relPath: string) => {
      try {
        const normalized = normalizeForCompare(s ?? '{}', relPath);
        return JSON.stringify(JSON.parse(normalized), null, 2);
      } catch { return s ?? ''; }
    };
    Promise.all([
      fetchFirst(relPaths, 'baseline', `scope=baseline&mspSlug=${encodeURIComponent(mspSlug)}`),
      fetchFirst(relPaths, 'backups',  `slug=${encodeURIComponent(tenantSlug)}`),
      fetch(`/api/git/resolve-variables?slug=${encodeURIComponent(tenantSlug)}`)
        .then(r => r.json())
        .catch(() => ({ variables: {} })) as Promise<{ variables?: Record<string, string> }>,
    ]).then(([bl, tn, varsRes]) => {
      // Use the first successfully resolved path as the relPath for normalization
      const relPath = relPaths[0];
      const resolvedVars = varsRes.variables ?? {};
      // Expand {{VAR:Name}} tokens to this tenant's resolved values before diffing,
      // so "Desired (baseline)" shows what will actually be deployed, not the raw token.
      const baselineContent = bl.exists && bl.content ? applyVariableTokens(bl.content, resolvedVars) : bl.content;
      setBaselineJson(bl.exists ? fmt(baselineContent, relPath) : '(not found in baseline)');
      setTenantJson(tn.exists ? fmt(tn.content, relPath) : '(not found in tenant backup)');
    }).catch(() => setFilesError('Failed to fetch files.'))
      .finally(() => setFilesLoading(false));
  }, [tab, baselineJson, tenantJson, item, mspOrg, tenantSlug]);

  const rows: React.ReactNode[] = [];
  let rowIdx = 0;

  if (c?.Modified) {
    for (const m of c.Modified) {
      if (m === 'Assignments') {
        const asgn = getAssignmentStrings(c);
        if (asgn) {
          const existingFmt = formatAssignmentJson(asgn.existing);
          const desiredFmt = formatAssignmentJson(asgn.desired);
          const stripe = rowIdx % 2 ? '#ffffff03' : 'transparent';
          rows.push(
            <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
              <td style={tdProp}>~ Assignments</td>
              <td style={tdExisting}><DiffCell value={existingFmt} color="#f87171" /></td>
              <td style={tdDesired}><DiffCell value={desiredFmt} color="#22c55e" /></td>
            </tr>
          );
          continue;
        }
      }
      const colonIdx = m.indexOf(': ');
      const propKey  = colonIdx !== -1 ? m.slice(0, colonIdx) : null;
      const mv       = propKey ? c.ModifiedValues?.[propKey] : null;
      if (mv) {
        const diffs = computeObjectDiff(mv.Existing, mv.Desired);
        if (diffs && diffs.length > 0) {
          for (const d of diffs) {
            const subName = `${propKey}.${d.key}`;
            const stripe  = rowIdx % 2 ? '#ffffff03' : 'transparent';
            rows.push(
              <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
                <td style={tdProp}>{d.type === 'add' ? `+ ${subName}` : d.type === 'remove' ? `- ${subName}` : `~ ${subName}`}</td>
                <td style={tdExisting}>{d.type !== 'add'    ? <DiffCell value={toStr(d.existing)} color="#f87171" /> : emptyCell}</td>
                <td style={tdDesired}> {d.type !== 'remove' ? <DiffCell value={toStr(d.desired)}  color="#22c55e" /> : emptyCell}</td>
              </tr>
            );
          }
        } else {
          const stripe = rowIdx % 2 ? '#ffffff03' : 'transparent';
          rows.push(
            <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
              <td style={tdProp}>~ {propKey}</td>
              <td style={tdExisting}><DiffCell value={mv.Existing} color="#f87171" /></td>
              <td style={tdDesired}> <DiffCell value={mv.Desired}  color="#22c55e" /></td>
            </tr>
          );
        }
        } else {
          const child = parseChildDiffLine(m);
          if (child) {
            // Indented child-level diff line (from groupSettingCollectionValue diffs)
            const color   = child.symbol === '+' ? '#22c55e' : child.symbol === '-' ? '#f87171' : '#a78bfa';
            const bgLeft  = child.symbol === '-' ? '#f871710d' : child.symbol === '~' ? '#a78bfa0d' : 'transparent';
            const bgRight = child.symbol === '+' ? '#22c55e0d' : child.symbol === '~' ? '#a78bfa0d' : 'transparent';
            const stripe  = rowIdx % 2 ? '#ffffff03' : 'transparent';
            const sym     = child.symbol === '+' ? '+' : child.symbol === '-' ? '-' : '~';
            rows.push(
              <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
                <td style={{ ...tdProp, color, paddingLeft: 20 }}>{sym} {child.label}</td>
                <td style={{ ...tdExisting, background: bgLeft }}>
                  {child.currentVal ? <DiffCell value={child.currentVal} color="#f87171" /> : emptyCell}
                </td>
                <td style={{ ...tdDesired, background: bgRight }}>
                  {child.desiredVal ? <DiffCell value={child.desiredVal} color="#22c55e" /> : emptyCell}
                </td>
              </tr>
            );
          } else {
            // Try parsing top-level "key: 'old' → 'new'" format
            const parsed = parseModifiedLine(m);
            const stripe = rowIdx % 2 ? '#ffffff03' : 'transparent';
            if (parsed) {
              rows.push(
                <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
                  <td style={tdProp}>~ {parsed.key}</td>
                  <td style={tdExisting}><DiffCell value={parsed.current} color="#f87171" /></td>
                  <td style={tdDesired}> <DiffCell value={parsed.desired} color="#22c55e" /></td>
                </tr>
              );
            } else {
              rows.push(
                <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
                  <td colSpan={3} style={{ ...tdProp, color: '#71717a' }}>~ {m}</td>
                </tr>
              );
            }
          }
        }
    }
  }

  if (c?.Added) {
    for (const a of c.Added) {
      const colonIdx = a.indexOf(': ');
      const propName = colonIdx !== -1 ? a.slice(0, colonIdx) : a;
      const val      = colonIdx !== -1 ? a.slice(colonIdx + 2) : a;
      const stripe   = rowIdx % 2 ? '#ffffff03' : 'transparent';
      rows.push(
        <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
          <td style={tdProp}>+ {propName}</td>
          <td style={tdExisting}>{emptyCell}</td>
          <td style={tdDesired}><DiffCell value={val} color="#22c55e" /></td>
        </tr>
      );
    }
  }

  if (c?.Removed) {
    for (const r of c.Removed) {
      const colonIdx = r.indexOf(': ');
      const propName = colonIdx !== -1 ? r.slice(0, colonIdx) : r;
      const val      = colonIdx !== -1 ? r.slice(colonIdx + 2) : r;
      const stripe   = rowIdx % 2 ? '#ffffff03' : 'transparent';
      rows.push(
        <tr key={rowIdx++} style={{ background: stripe, borderBottom: '1px solid #1a1a1d' }}>
          <td style={tdProp}>- {propName}</td>
          <td style={tdExisting}><DiffCell value={val} color="#f87171" /></td>
          <td style={tdDesired}>{emptyCell}</td>
        </tr>
      );
    }
  }

  const tabBtn = (t: 'changes' | 'files', label: string) => (
    <button
      onClick={() => setTab(t)}
      style={{ padding: '4px 12px', fontSize: '0.75rem', fontWeight: 600, borderRadius: 5, border: `1px solid ${tab === t ? '#3f3f46' : 'transparent'}`, background: tab === t ? '#1c1c1f' : 'transparent', color: tab === t ? '#e4e4e7' : '#52525b', cursor: 'pointer', fontFamily: 'inherit' }}
    >{label}</button>
  );

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 1200, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '14px 20px', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
          <span style={{ fontSize: '0.9375rem', fontWeight: 600, color: '#fff' }}>{item.name || 'Unknown'}</span>
          {item.service && <Tag>{item.service}</Tag>}
          {item.type && item.type !== item.service && <Tag>{item.type}</Tag>}
          <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
            {tabBtn('changes', 'Changes')}
            {tabBtn('files', 'Full files')}
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: 'transparent', border: 'none', borderRadius: 5, color: '#71717a', cursor: 'pointer', fontSize: '1.25rem', lineHeight: 1, fontFamily: 'inherit' }}>×</button>
          </div>
        </div>
        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>

          {tab === 'changes' && (
            <>
              {rows.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #1a1a1d', borderRadius: 6, overflow: 'hidden' }}>
                  <thead>
                    <tr style={{ background: '#0d0d10' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.65rem', color: '#52525b',  textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, borderBottom: '1px solid #27272a', borderRight: '1px solid #1a1a1d' }}>Property</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.65rem', color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, borderBottom: '1px solid #27272a', borderRight: '1px solid #1a1a1d' }}>Current</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: '0.65rem', color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, borderBottom: '1px solid #27272a' }}>Desired</th>
                    </tr>
                  </thead>
                  <tbody>{rows}</tbody>
                </table>
              ) : !c ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#52525b' }}>This is a new resource — no existing values to compare.</div>
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#52525b' }}>No detailed diff available.</div>
              )}
              {c?.OmaSettings && c.OmaSettings.length > 0 && (
                <div style={{ marginTop: 12, padding: 10, background: '#09090b', borderRadius: 6, border: '1px solid #1a1a1d' }}>
                  <div style={{ fontSize: '0.65rem', color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, fontWeight: 600 }}>OMA-URI Settings</div>
                  {c.OmaSettings.map((o, i) => <div key={i} style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: '#a78bfa', marginBottom: 3 }}>{o}</div>)}
                </div>
              )}
            </>
          )}

          {tab === 'files' && (
            <>
              {filesLoading && <div style={{ textAlign: 'center', padding: '40px 0', color: '#52525b' }}>Loading files…</div>}
              {filesError  && <div style={{ textAlign: 'center', padding: '40px 0', color: '#f87171', fontSize: '0.85rem' }}>{filesError}</div>}
              {!filesLoading && !filesError && baselineJson !== null && tenantJson !== null && (() => {
                // tenant = current (b/before), baseline = desired (a/after)
                const lines = computeLineDiff(tenantJson, baselineJson);
                const colBase = { width: '50%', verticalAlign: 'top', fontFamily: 'monospace', fontSize: '0.72rem', padding: '1px 10px', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const };
                return (
                  <div style={{ border: '1px solid #1a1a1d', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: '#0d0d10', borderBottom: '1px solid #27272a' }}>
                      <div style={{ padding: '6px 10px', fontSize: '0.65rem', color: '#f87171', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', borderRight: '1px solid #1a1a1d' }}>Current (tenant backup)</div>
                      <div style={{ padding: '6px 10px', fontSize: '0.65rem', color: '#22c55e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Desired (baseline)</div>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {lines.map((ln, i) => {
                          const bBg = ln.same ? 'transparent' : ln.b ? 'rgba(248,113,113,0.08)' : 'transparent';
                          const aBg = ln.same ? 'transparent' : ln.a ? 'rgba(34,197,94,0.08)'  : 'transparent';
                          const bColor = ln.same ? '#a1a1aa' : ln.b ? '#fca5a5' : '#3f3f46';
                          const aColor = ln.same ? '#a1a1aa' : ln.a ? '#86efac' : '#3f3f46';
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid #0f0f11' }}>
                              <td style={{ ...colBase, background: bBg, color: bColor, borderRight: '1px solid #1a1a1d' }}>{ln.b || ' '}</td>
                              <td style={{ ...colBase, background: aBg, color: aColor }}>{ln.a || ' '}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </>
          )}

        </div>
      </div>
    </div>
  );
}

// Shared cell styles for diff table
const tdProp: React.CSSProperties     = { padding: '8px 10px', fontFamily: 'monospace', fontSize: '0.75rem', color: '#71717a', verticalAlign: 'top', whiteSpace: 'nowrap', borderRight: '1px solid #1a1a1d', minWidth: 160, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' };
const tdExisting: React.CSSProperties = { padding: '8px 10px', background: '#f871710d', verticalAlign: 'top', borderRight: '1px solid #1a1a1d', width: '40%' };
const tdDesired: React.CSSProperties  = { padding: '8px 10px', background: '#22c55e0d', verticalAlign: 'top', width: '40%' };
const emptyCell = <span style={{ color: '#3f3f46', fontStyle: 'italic', fontSize: '0.75rem' }}>—</span>;

// ─── IgnoreForm ───────────────────────────────────────────────────────────────

function IgnoreForm({ pattern, onSave, onCancel }: {
  pattern: string;
  onSave: (pattern: string, comment: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [pat, setPat]         = useState(pattern);
  const [comment, setComment] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saveErr, setSaveErr] = useState('');

  async function handleSave() {
    if (!pat.trim()) return;
    setSaving(true);
    setSaveErr('');
    try {
      await onSave(pat.trim(), comment.trim());
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 8, padding: 10, background: '#09090b', borderRadius: 6, border: '1px solid #27272a' }}>
      <div style={{ fontSize: '0.75rem', color: '#71717a', marginBottom: 6 }}>
        Add pattern to <code style={{ fontFamily: 'monospace', color: '#a1a1aa' }}>.baseline-ignore</code>:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          type="text"
          value={pat}
          onChange={e => setPat(e.target.value)}
          style={{ background: '#111113', border: '1px solid #3f3f46', borderRadius: 4, padding: '4px 8px', color: '#d4d4d8', fontSize: '0.8125rem', fontFamily: 'monospace', outline: 'none' }}
        />
        <input
          type="text"
          placeholder="Reason for exclusion (optional)"
          value={comment}
          onChange={e => setComment(e.target.value)}
          style={{ background: '#111113', border: '1px solid #3f3f46', borderRadius: 4, padding: '4px 8px', color: '#d4d4d8', fontSize: '0.8125rem', outline: 'none' }}
        />
        {saveErr && <div style={{ fontSize: '0.75rem', color: '#f87171' }}>{saveErr}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ padding: '4px 12px', background: saving ? '#1d4ed8' : '#3b82f6', color: '#fff', border: 'none', borderRadius: 4, fontSize: '0.75rem', cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: saving ? 0.7 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={onCancel}
            style={{ padding: '4px 12px', background: 'transparent', color: '#71717a', border: '1px solid #3f3f46', borderRadius: 4, fontSize: '0.75rem', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: 4, background: '#18181b', color: '#71717a', border: '1px solid #27272a' }}>
      {children}
    </span>
  );
}

// ─── PlanItemRow ──────────────────────────────────────────────────────────────

interface PlanItemRowProps {
  item: PlanItem;
  action: string;
  color: string;
  prefix: string;
  isIgnored: boolean;
  isPermanent: boolean;
  onToggleIgnore: () => void;
  onViewDiff: () => void;
  onAddIgnore: (pattern: string, comment: string) => Promise<void>;
  onRemoveIgnore: () => Promise<void>;
}

function PlanItemRow({ item, action, color, prefix, isIgnored, isPermanent, onToggleIgnore, onViewDiff, onAddIgnore, onRemoveIgnore }: PlanItemRowProps) {
  const [showForm, setShowForm]         = useState(false);
  const [removingIgnore, setRemoving]   = useState(false);
  const pattern  = suggestedPattern(item);
  const nChanges = countChanges(item);
  const isCreate = action === 'create';
  const diffBtnLabel = isCreate ? 'View config →' : nChanges > 0 ? `View diff (${nChanges} change${nChanges !== 1 ? 's' : ''}) →` : 'View config →';
  const diffBtnColor = isCreate ? '#a78bfa' : '#60a5fa';

  async function handleRemove() {
    setRemoving(true);
    try { await onRemoveIgnore(); } finally { setRemoving(false); }
  }

  const cardBorder = isIgnored || isPermanent ? '#f9731644' : '#1e1e21';
  const cardLeft   = isIgnored || isPermanent ? '#f97316'   : '#1e1e21';

  return (
    <div style={{ background: '#0c0c0e', border: `1px solid ${cardBorder}`, borderLeft: `3px solid ${cardLeft}`, borderRadius: 8, padding: '12px 14px', opacity: isIgnored || isPermanent ? 0.65 : 1 }}>
      {/* Top row: badges + action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: '0.6875rem', fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: `${color}22`, color, textTransform: 'uppercase' }}>{prefix} {action}</span>
        {item.service && (
          <span style={{ fontSize: '0.6875rem', color: '#52525b', background: '#18181b', padding: '2px 6px', borderRadius: 3, border: '1px solid #27272a' }}>
            {item.service}{item.type && item.type !== item.service ? ` \\ ${item.type}` : ''}
          </span>
        )}
        {isIgnored   && <span style={{ fontSize: '0.6875rem', padding: '2px 6px', borderRadius: 3, background: '#f9731622', color: '#f97316', border: '1px solid #f9731644', fontWeight: 600 }}>Ignored</span>}
        {isPermanent && <span style={{ fontSize: '0.6875rem', padding: '2px 6px', borderRadius: 3, background: '#f9731622', color: '#f97316', border: '1px solid #f9731644', fontWeight: 600 }}>In .baseline-ignore</span>}
        {/* Action buttons */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={onToggleIgnore}
            style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: 4, border: `1px solid ${isIgnored ? '#f9731644' : '#3f3f46'}`, background: 'transparent', color: isIgnored ? '#f97316' : '#52525b', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}
          >
            {isIgnored ? 'Undo ignore' : 'Ignore this run'}
          </button>
          <button
            onClick={() => isPermanent ? handleRemove() : setShowForm(f => !f)}
            disabled={removingIgnore}
            title={isPermanent ? 'Click to remove from .baseline-ignore' : ''}
            style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: 4, border: `1px solid ${isPermanent ? '#f9731644' : '#3f3f46'}`, background: 'transparent', color: isPermanent ? '#f97316' : '#52525b', cursor: removingIgnore ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}
          >
            {removingIgnore ? 'Removing…' : isPermanent ? '✓ .baseline-ignore' : '+ .baseline-ignore'}
          </button>
        </div>
      </div>

      {/* Resource name */}
      <p style={{ margin: 0, fontSize: '0.875rem', color: '#a1a1aa' }}>{item.name || 'Unknown'}</p>
      {item.error && <p style={{ margin: '4px 0 0', fontSize: '0.75rem', color: '#f87171', fontFamily: 'monospace' }}>{item.error}</p>}

      {/* Diff button */}
      <button
        onClick={onViewDiff}
        style={{ marginTop: 8, fontSize: '0.75rem', padding: '4px 10px', borderRadius: 4, border: '1px solid #3f3f46', background: 'transparent', color: diffBtnColor, cursor: 'pointer', display: 'block', fontFamily: 'inherit' }}
      >
        {diffBtnLabel}
      </button>

      {/* Inline property diff */}
      <PropertyChanges item={item} />

      {/* Baseline-ignore form */}
      {showForm && (
        <IgnoreForm
          pattern={pattern}
          onSave={async (pat, comment) => {
            await onAddIgnore(pat, comment);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

// ─── WhatIfModal ──────────────────────────────────────────────────────────────

export interface WhatIfModalProps {
  mspSlug: string;
  mspOrg: string;
  tenantSlug: string;
  tenantName: string;
  issueUrl: string;
  onClose: () => void;
}

const SECTIONS = [
  { key: 'creates'     as const, label: 'Will Create',            color: '#22c55e', prefix: '+', action: 'create'     },
  { key: 'updates'     as const, label: 'Will Update',            color: '#60a5fa', prefix: '~', action: 'update'     },
  { key: 'assignments' as const, label: 'Assignment Changes Only', color: '#a78bfa', prefix: '⇄', action: 'assignment' },
  { key: 'deletes'     as const, label: 'Will Delete',            color: '#f87171', prefix: '-', action: 'delete'     },
  { key: 'errors'      as const, label: 'Errors',                 color: '#f97316', prefix: '!', action: 'error'      },
  { key: 'protected'   as const, label: 'Protected',              color: '#fbbf24', prefix: '🛡', action: 'protected'  },
];

export function WhatIfModal({ mspSlug, mspOrg, tenantSlug, tenantName, issueUrl, onClose }: WhatIfModalProps) {
  const [plan,       setPlan]       = useState<DeployPlan | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [err,        setErr]        = useState('');
  const [runIgnored, setRunIgnored] = useState<Set<string>>(new Set());
  // permanentlyIgnored: itemKey → pattern string currently in .baseline-ignore
  const [permanentlyIgnored, setPermanentlyIgnored] = useState<Map<string, string>>(new Map());
  const [ignoreContent, setIgnoreContent] = useState('');
  const [ignoreSha,     setIgnoreSha]     = useState<string | null>(null);
  const [diffItem, setDiffItem] = useState<PlanItem | null>(null);

  // Run-scoped skip file state (.baseline-skip-{runId} in tenant repo)
  const [skipSha, setSkipSha] = useState<string | null>(null);
  const skipSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to runIgnored so the debounced save always sees the latest set
  const runIgnoredRef = useRef<Set<string>>(new Set());
  // Keep ref to current plan for the debounced save
  const planRef = useRef<DeployPlan | null>(null);

  // ── Close on Escape ──────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !diffItem) onClose(); };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      // Flush any pending skip-file write on unmount
      if (skipSaveTimer.current) clearTimeout(skipSaveTimer.current);
    };
  }, [onClose, diffItem]);

  // ── Load plan + .baseline-ignore in parallel ─────────────────────────────
  useEffect(() => {
    const slugParam = `slug=${encodeURIComponent(tenantSlug)}`;
    const planUrl   = `/api/git/file?${slugParam}&path=config/deploy-plan-latest.json`;
    const ignoreUrl = `/api/git/file?${slugParam}&path=.baseline-ignore`;

    Promise.all([
      fetch(planUrl).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data as { error?: string }).error ?? 'Failed to load deploy plan');
        return data;
      }),
      fetch(ignoreUrl).then(r => r.json()).catch(() => ({ exists: false, content: null, sha: null })),
    ])
      .then(([planData, ignoreData]: [
        { content?: string; exists?: boolean },
        { content?: string; sha?: string; exists?: boolean },
      ]) => {
        if (!planData.exists || !planData.content) {
          setErr('No active WhatIf plan — plans are cleared after each deploy. Trigger a deploy to generate a new preview.');
          return;
        }
        let parsed: DeployPlan;
        try { parsed = JSON.parse(planData.content) as DeployPlan; }
        catch { setErr('Could not parse plan data.'); return; }

        setPlan(parsed);

        if (ignoreData.exists && ignoreData.content) {
          const content = ignoreData.content as string;
          const sha     = ignoreData.sha ?? null;
          setIgnoreContent(content);
          setIgnoreSha(sha);

          // Pre-mark permanently ignored items
          const existingPatterns = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
          const newMap = new Map<string, string>();
          for (const sec of SECTIONS) {
            for (const item of (parsed[sec.key] ?? []) as PlanItem[]) {
              const pat = suggestedPattern(item);
              if (!pat) continue;
              const lf = pat.toLowerCase();
              const matched = existingPatterns.find(p => { const lp = p.toLowerCase(); return lp === lf || lp.endsWith('/' + lf); });
              if (matched) newMap.set(itemKey(item, sec.action), matched);
            }
          }
          setPermanentlyIgnored(newMap);
        }
      })
      .catch(() => setErr('Failed to load plan data.'))
      .finally(() => setLoading(false));
  }, [tenantSlug]);

  // Keep refs in sync so the debounced save always reads the latest values
  useEffect(() => { planRef.current = plan; }, [plan]);
  useEffect(() => { runIgnoredRef.current = runIgnored; }, [runIgnored]);

  // ── Debounced write of .baseline-skip-{runId} to the tenant repo ─────────
  // The pipeline reads this file during the apply phase (Common-IgnoreHelpers.ps1).
  const saveSkipFile = useCallback(async (ignored: Set<string>, runId: string) => {
    const patterns = [...ignored]
      .map(key => {
        // key = "action/service/name" — build the gitignore pattern from name+service
        const parts = key.split('/');
        const name    = parts.slice(2).join('/');   // everything after action/service
        const service = parts[1] ?? '';
        const dummy   = { name, service } as PlanItem;
        return suggestedPattern(dummy);
      })
      .filter(Boolean);

    const skipPath = `.baseline-skip-${runId}`;

    if (patterns.length === 0) {
      // Nothing to skip — remove the file if it exists
      if (skipSha) {
        try {
          await fetch('/api/git/file', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slug: tenantSlug,
              path: skipPath, sha: skipSha,
              message: `portal: clear run-scoped skip file`,
            }),
          });
          setSkipSha(null);
        } catch { /* silent — skip file removal is best-effort */ }
      }
      return;
    }

    const content = patterns.join('\n') + '\n';
    try {
      const res = await fetch('/api/git/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: tenantSlug,
          path: skipPath, content,
          sha: skipSha ?? undefined,
          message: `portal: update run-scoped skip (${patterns.length} item${patterns.length !== 1 ? 's' : ''})`,
        }),
      });
      if (res.ok) {
        // Refresh SHA so subsequent writes don't conflict
        const updated = await fetch(`/api/git/file?slug=${encodeURIComponent(tenantSlug)}&path=${encodeURIComponent(skipPath)}`).then(r => r.json()).catch(() => ({})) as { sha?: string };
        if (updated.sha) setSkipSha(updated.sha);
      }
    } catch { /* silent — skip file write is best-effort */ }
  }, [tenantSlug, skipSha]);

  // ── Session ignore toggle ────────────────────────────────────────────────
  function toggleIgnore(key: string) {
    setRunIgnored(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);

      // Debounce write to .baseline-skip-{runId} (800 ms)
      const runId = planRef.current?.runId;
      if (runId) {
        if (skipSaveTimer.current) clearTimeout(skipSaveTimer.current);
        skipSaveTimer.current = setTimeout(() => {
          saveSkipFile(next, runId);
        }, 800);
      }

      return next;
    });
  }

  // ── Refresh .baseline-ignore SHA after write ─────────────────────────────
  async function refreshIgnoreSha() {
    const url = `/api/git/file?slug=${encodeURIComponent(tenantSlug)}&path=.baseline-ignore`;
    const data = await fetch(url).then(r => r.json()).catch(() => ({})) as { sha?: string };
    if (data.sha) setIgnoreSha(data.sha);
  }

  // ── Add a pattern to .baseline-ignore ───────────────────────────────────
  async function addBaselineIgnore(item: PlanItem, action: string, pattern: string, comment: string) {
    const block      = comment ? `# ${comment}\n${pattern}\n` : `${pattern}\n`;
    const newContent = ignoreContent ? `${ignoreContent.trimEnd()}\n\n${block}` : block;

    const res = await fetch('/api/git/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: tenantSlug,
        path: '.baseline-ignore', content: newContent,
        sha: ignoreSha ?? undefined,
        message: `portal: add ${pattern} to .baseline-ignore`,
      }),
    });
    if (!res.ok) throw new Error('Failed to save .baseline-ignore');

    setIgnoreContent(newContent);
    await refreshIgnoreSha();
    setPermanentlyIgnored(prev => new Map(prev).set(itemKey(item, action), pattern));
  }

  // ── Remove a pattern from .baseline-ignore ───────────────────────────────
  async function removeBaselineIgnore(item: PlanItem, action: string) {
    const key            = itemKey(item, action);
    const patternToRemove = permanentlyIgnored.get(key);
    if (!patternToRemove) return;

    // Remove the pattern line and any immediately preceding comment
    const lines    = ignoreContent.split('\n');
    const newLines: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() === patternToRemove) {
        // Remove preceding comment line if present
        if (newLines.length > 0 && newLines[newLines.length - 1].trim().startsWith('#')) newLines.pop();
        // Skip trailing blank line
        if (i + 1 < lines.length && lines[i + 1].trim() === '') i++;
      } else {
        newLines.push(lines[i]);
      }
      i++;
    }
    const newContent = newLines.join('\n');

    const res = await fetch('/api/git/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: tenantSlug,
        path: '.baseline-ignore', content: newContent,
        sha: ignoreSha ?? undefined,
        message: `portal: remove ${patternToRemove} from .baseline-ignore`,
      }),
    });
    if (!res.ok) throw new Error('Failed to update .baseline-ignore');

    setIgnoreContent(newContent);
    await refreshIgnoreSha();
    setPermanentlyIgnored(prev => { const next = new Map(prev); next.delete(key); return next; });
  }

  // ── Derived counts (excluding session-ignored items) ─────────────────────
  const activeCounts = {
    creates:     (plan?.creates     ?? []).filter(i => !runIgnored.has(itemKey(i, 'create'))).length,
    updates:     (plan?.updates     ?? []).filter(i => !runIgnored.has(itemKey(i, 'update'))).length,
    assignments: (plan?.assignments ?? []).filter(i => !runIgnored.has(itemKey(i, 'assignment'))).length,
    deletes:     (plan?.deletes     ?? []).filter(i => !runIgnored.has(itemKey(i, 'delete'))).length,
    errors:      (plan?.errors      ?? []).length,
    protected:   (plan?.protected   ?? []).length,
  };
  const ignoredCount   = runIgnored.size;
  const permanentCount = permanentlyIgnored.size;
  const totalExcluded  = ignoredCount + permanentCount;

  function exportPlan() {
    if (!plan) return;
    const exportData = {
      tenant:      tenantName,
      tenantSlug,
      mspOrg,
      exportedAt:  new Date().toISOString(),
      generatedAt: plan.generatedAt,
      runId:       plan.runId,
      summary:     plan.summary,
      creates:     plan.creates     ?? [],
      updates:     plan.updates     ?? [],
      assignments: plan.assignments ?? [],
      deletes:     plan.deletes     ?? [],
      errors:      plan.errors      ?? [],
      protected:   plan.protected   ?? [],
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `whatif-${tenantSlug}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{ background: '#111113', border: '1px solid #27272a', borderRadius: 12, width: '100%', maxWidth: 1000, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}>

          {/* ── Header ─────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #27272a', flexShrink: 0 }}>
            <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>WhatIf Analysis — {tenantName}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <a href={toGiteaWebUrl(issueUrl)} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: '#71717a', textDecoration: 'none' }}>View in Gitea ↗</a>
              {plan && (
                <button
                  onClick={exportPlan}
                  title="Export plan as JSON"
                  style={{ fontSize: '0.75rem', color: '#71717a', background: 'transparent', border: '1px solid #3f3f46', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}
                >↓ Export</button>
              )}
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#71717a', fontSize: '1.25rem', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit' }}>×</button>
            </div>
          </div>

          {/* ── Body ───────────────────────────────────────────────────── */}
          <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
            {loading && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#52525b' }}>
                <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid #27272a', borderTopColor: '#60a5fa', borderRadius: '50%', animation: 'wi-spin 0.7s linear infinite', marginRight: 8, verticalAlign: 'middle' }} />
                Loading WhatIf summary…
              </div>
            )}
            {err && <div style={{ textAlign: 'center', padding: '40px 0', color: '#71717a', fontSize: '0.85rem' }}>{err}</div>}

            {plan && (
              <>
                {/* Summary stat grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10, marginBottom: 16, padding: 14, background: '#0c0c0e', border: '1px solid #1e1e21', borderRadius: 8 }}>
                  {[
                    { label: 'Total',       val: activeCounts.creates + activeCounts.updates + activeCounts.assignments + activeCounts.deletes, color: '#fff' },
                    { label: 'Creates',     val: activeCounts.creates,      color: '#22c55e' },
                    { label: 'Updates',     val: activeCounts.updates,      color: '#60a5fa' },
                    { label: 'Assignments', val: activeCounts.assignments,  color: '#a78bfa' },
                    { label: 'Deletes',     val: activeCounts.deletes,      color: '#f87171' },
                    { label: 'No Change',   val: plan.summary?.noChanges ?? 0, color: '#71717a' },
                    { label: 'Errors',      val: activeCounts.errors,       color: '#f97316' },
                  ].map(s => (
                    <div key={s.label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '0.6875rem', color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{s.label}</div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: s.color, fontFamily: 'monospace' }}>{s.val}</div>
                    </div>
                  ))}
                </div>

                {/* Excluded banner */}
                {totalExcluded > 0 && (
                  <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f9731611', border: '1px solid #f9731633', borderRadius: 6, fontSize: '0.8125rem', color: '#f97316' }}>
                    {totalExcluded} item{totalExcluded !== 1 ? 's' : ''} excluded from counts above
                    {ignoredCount > 0 && permanentCount > 0
                      ? ` — ${ignoredCount} ignored this run, ${permanentCount} in .baseline-ignore`
                      : ignoredCount > 0 ? ' — ignored this run' : ' — in .baseline-ignore'}
                  </div>
                )}

                {/* Change sections */}
                {SECTIONS.map(sec => {
                  const items = (plan[sec.key] ?? []) as PlanItem[];
                  if (!items.length) return null;
                  const activeItems  = items.filter(i => !runIgnored.has(itemKey(i, sec.action)));
                  const activeCount  = activeItems.length;
                  const countLabel   = activeCount < items.length ? `${activeCount} of ${items.length}` : `${items.length}`;

                  return (
                    <details key={sec.key} open style={{ marginBottom: 16 }}>
                      <summary style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 0', borderBottom: '1px solid #1e1e21', marginBottom: 10, listStyle: 'none', outline: 'none' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${sec.color}22`, color: sec.color, textTransform: 'uppercase' }}>{sec.label}</span>
                        <span style={{ fontSize: '0.8125rem', color: '#71717a' }}>{countLabel} item{activeCount !== 1 ? 's' : ''}</span>
                        <span style={{ marginLeft: 'auto', color: '#52525b', fontSize: '0.75rem' }}>▾</span>
                      </summary>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {items.map((item, idx) => {
                          const key = itemKey(item, sec.action);
                          return (
                            <PlanItemRow
                              key={idx}
                              item={item}
                              action={sec.action}
                              color={sec.color}
                              prefix={sec.prefix}
                              isIgnored={runIgnored.has(key)}
                              isPermanent={permanentlyIgnored.has(key)}
                              onToggleIgnore={() => toggleIgnore(key)}
                              onViewDiff={() => setDiffItem(item)}
                              onAddIgnore={(pat, comment) => addBaselineIgnore(item, sec.action, pat, comment)}
                              onRemoveIgnore={() => removeBaselineIgnore(item, sec.action)}
                            />
                          );
                        })}
                      </div>
                    </details>
                  );
                })}

                {plan.generatedAt && (
                  <div style={{ fontSize: '0.7rem', color: '#3f3f46', marginTop: 8 }}>
                    Generated: {new Date(plan.generatedAt).toLocaleString()}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Full diff overlay */}
      {diffItem && <DiffModal item={diffItem} onClose={() => setDiffItem(null)} mspSlug={mspSlug} mspOrg={mspOrg} tenantSlug={tenantSlug} />}

      <style>{`@keyframes wi-spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
