/** AppLocker RuleCollection parse/serialize, default rules, and tenant overlay merge. */

export type CollectionType = 'Exe' | 'Msi' | 'Script' | 'Appx' | 'Dll';
export type EnforcementMode = 'Enabled' | 'AuditOnly' | 'NotConfigured';
export type RuleAction = 'Allow' | 'Deny';
export type RuleXmlName = 'FilePublisherRule' | 'FilePathRule' | 'FileHashRule';

export const COLLECTION_TYPES: CollectionType[] = ['Exe', 'Msi', 'Script', 'Appx', 'Dll'];

export const COLLECTION_LABELS: Record<CollectionType, string> = {
  Exe: 'Executable',
  Msi: 'Windows Installer',
  Script: 'Script',
  Appx: 'Packaged app',
  Dll: 'DLL',
};

export const OMA_URI: Record<CollectionType, string> = {
  Exe: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/EXE/Policy',
  Msi: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/MSI/Policy',
  Script: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/Script/Policy',
  Appx: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/StoreApps/Policy',
  Dll: './Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/apps/DLL/Policy',
};

export const OVERLAY_FILE: Record<CollectionType, string> = {
  Exe: 'exe.overlay.json',
  Msi: 'msi.overlay.json',
  Script: 'script.overlay.json',
  Appx: 'appx.overlay.json',
  Dll: 'dll.overlay.json',
};

export const BASELINE_DEVICE_CONFIG_DIR = 'baseline/intune/device-configurations';
export const TENANT_BACKUP_DEVICE_CONFIG_DIR = 'backups/intune/device-configurations';
export const TENANT_OVERLAY_DIR = 'intune/applocker';
export const TENANT_IMPORT_MARKER_PATH = `${TENANT_OVERLAY_DIR}/imported.json`;

export const SID_EVERYONE = 'S-1-1-0';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
export const SID_USERS = 'S-1-5-32-545';

export const WELL_KNOWN_SIDS: Array<{ sid: string; label: string }> = [
  { sid: SID_EVERYONE, label: 'Everyone' },
  { sid: SID_ADMINISTRATORS, label: 'Administrators' },
  { sid: SID_USERS, label: 'Users' },
];

export interface PublisherCondition {
  kind: 'publisher';
  publisherName: string;
  productName: string;
  binaryName: string;
  lowSection: string;
  highSection: string;
}

export interface PathCondition {
  kind: 'path';
  path: string;
}

export interface FileHashEntry {
  type: string;
  data: string;
  sourceFileName: string;
  sourceFileLength: string;
}

export interface HashCondition {
  kind: 'hash';
  hashes: FileHashEntry[];
}

export type RuleCondition = PublisherCondition | PathCondition | HashCondition;

export interface AppLockerRule {
  id: string;
  xmlName: RuleXmlName;
  name: string;
  description: string;
  userOrGroupSid: string;
  action: RuleAction;
  conditions: RuleCondition[];
  exceptions: RuleCondition[];
}

export interface RuleCollection {
  type: CollectionType;
  enforcementMode: EnforcementMode;
  rules: AppLockerRule[];
}

export interface AppLockerOverlay {
  excludeRuleIds: string[];
  rules: AppLockerRule[];
  enforcementMode?: EnforcementMode;
}

export function newRuleId(): string {
  return crypto.randomUUID().toUpperCase();
}

export function sidLabel(sid: string): string {
  return WELL_KNOWN_SIDS.find(s => s.sid === sid)?.label ?? sid;
}

export function ruleKind(rule: AppLockerRule): 'publisher' | 'path' | 'hash' {
  if (rule.xmlName === 'FilePathRule') return 'path';
  if (rule.xmlName === 'FileHashRule') return 'hash';
  return 'publisher';
}

export function collectionFromOmaUri(uri: string): CollectionType | null {
  const u = uri.toUpperCase();
  if (u.includes('/EXE/POLICY')) return 'Exe';
  if (u.includes('/MSI/POLICY')) return 'Msi';
  if (u.includes('/SCRIPT/POLICY')) return 'Script';
  if (u.includes('/STOREAPPS/POLICY')) return 'Appx';
  if (u.includes('/DLL/POLICY')) return 'Dll';
  return null;
}

export function collectionFromFileName(fileName: string): CollectionType | null {
  const n = fileName.toLowerCase();
  if (!/applocker|app.?lock/i.test(n)) return null;
  if (n.includes('script')) return 'Script';
  if (n.includes('appx') || n.includes('store')) return 'Appx';
  if (n.includes('msi')) return 'Msi';
  if (n.includes('dll')) return 'Dll';
  if (n.includes('exe')) return 'Exe';
  return null;
}

export function overlayFileName(type: CollectionType): string {
  return OVERLAY_FILE[type];
}

export function overlayPath(type: CollectionType): string {
  return `${TENANT_OVERLAY_DIR}/${OVERLAY_FILE[type]}`;
}

export function isAppLockerOmaUri(uri: string | undefined): boolean {
  return typeof uri === 'string' && /ApplicationLaunchRestrictions/i.test(uri);
}

export function isAppLockerFileName(fileName: string): boolean {
  return /applocker|app.?lock/i.test(fileName);
}

export function detectCollectionFromPolicy(
  fileName: string,
  omaUri?: string,
  xml?: string,
): CollectionType | null {
  if (omaUri) {
    const fromUri = collectionFromOmaUri(omaUri);
    if (fromUri) return fromUri;
  }
  if (xml) {
    const m = xml.match(/<RuleCollection\b[^>]*\bType="([^"]+)"/i);
    if (m) {
      const t = normalizeCollectionType(m[1]);
      if (t) return t;
    }
  }
  return collectionFromFileName(fileName);
}

export function normalizeCollectionType(raw: string): CollectionType | null {
  switch (raw.trim().toLowerCase()) {
    case 'exe': return 'Exe';
    case 'msi': return 'Msi';
    case 'script': return 'Script';
    case 'appx':
    case 'storeapps':
    case 'appxpackage': return 'Appx';
    case 'dll': return 'Dll';
    default: return null;
  }
}

export function normalizeEnforcement(raw: string | undefined): EnforcementMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enabled' || v === 'enforce') return 'Enabled';
  if (v === 'auditonly' || v === 'audit only' || v === 'audit') return 'AuditOnly';
  return 'NotConfigured';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]] = decodeXmlEntities(m[2]);
  return attrs;
}

function extractInner(xml: string, tagName: string): string | null {
  const open = xml.match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'));
  if (!open || open.index === undefined) return null;
  if (/\/>\s*$/.test(open[0])) return '';
  const start = open.index + open[0].length;
  const close = xml.slice(start).search(new RegExp(`</${tagName}\\s*>`, 'i'));
  if (close < 0) return xml.slice(start);
  return xml.slice(start, start + close);
}

function extractBlocks(xml: string, tagName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tagName}\\b[^>]*(?:/>|>[\\s\\S]*?</${tagName}\\s*>)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) blocks.push(m[0]);
  return blocks;
}

function parsePublisherCondition(xml: string): PublisherCondition {
  const attrs = parseAttrs(xml);
  const range = xml.match(/<BinaryVersionRange\b[^>]*>/i);
  const rangeAttrs = range ? parseAttrs(range[0]) : {};
  return {
    kind: 'publisher',
    publisherName: attrs.PublisherName ?? '*',
    productName: attrs.ProductName ?? '*',
    binaryName: attrs.BinaryName ?? '*',
    lowSection: rangeAttrs.LowSection ?? '*',
    highSection: rangeAttrs.HighSection ?? '*',
  };
}

function parsePathCondition(xml: string): PathCondition {
  return { kind: 'path', path: parseAttrs(xml).Path ?? '*' };
}

function parseHashCondition(xml: string): HashCondition {
  const hashes = extractBlocks(xml, 'FileHash').map(h => {
    const a = parseAttrs(h);
    return {
      type: a.Type ?? 'SHA256',
      data: a.Data ?? '',
      sourceFileName: a.SourceFileName ?? '',
      sourceFileLength: a.SourceFileLength ?? '0',
    };
  });
  return { kind: 'hash', hashes };
}

function parseConditions(xml: string): RuleCondition[] {
  const out: RuleCondition[] = [];
  for (const b of extractBlocks(xml, 'FilePublisherCondition')) out.push(parsePublisherCondition(b));
  for (const b of extractBlocks(xml, 'FilePathCondition')) out.push(parsePathCondition(b));
  for (const b of extractBlocks(xml, 'FileHashCondition')) out.push(parseHashCondition(b));
  return out;
}

function parseRule(xml: string, xmlName: RuleXmlName): AppLockerRule {
  const attrs = parseAttrs(xml);
  const conditionsXml = extractInner(xml, 'Conditions') ?? '';
  const exceptionsXml = extractInner(xml, 'Exceptions') ?? '';
  const action = attrs.Action?.toLowerCase() === 'deny' ? 'Deny' : 'Allow';
  return {
    id: attrs.Id || newRuleId(),
    xmlName,
    name: attrs.Name ?? '',
    description: attrs.Description ?? '',
    userOrGroupSid: attrs.UserOrGroupSid ?? SID_EVERYONE,
    action,
    conditions: parseConditions(conditionsXml),
    exceptions: parseConditions(exceptionsXml),
  };
}

function extractRuleCollectionXml(xml: string, preferType?: CollectionType): string {
  const trimmed = xml.trim();
  const collections = extractBlocks(trimmed, 'RuleCollection');
  if (collections.length === 0) {
    throw new Error('No RuleCollection found in AppLocker XML');
  }
  if (preferType) {
    const match = collections.find(c => normalizeCollectionType(parseAttrs(c).Type ?? '') === preferType);
    if (match) return match;
  }
  return collections[0];
}

export function parseRuleCollectionXml(xml: string, preferType?: CollectionType): RuleCollection {
  const block = extractRuleCollectionXml(xml, preferType);
  const attrs = parseAttrs(block);
  const type = normalizeCollectionType(attrs.Type ?? '') ?? preferType ?? 'Exe';
  const inner = extractInner(block, 'RuleCollection') ?? '';
  const rules: AppLockerRule[] = [
    ...extractBlocks(inner, 'FilePublisherRule').map(b => parseRule(b, 'FilePublisherRule')),
    ...extractBlocks(inner, 'FilePathRule').map(b => parseRule(b, 'FilePathRule')),
    ...extractBlocks(inner, 'FileHashRule').map(b => parseRule(b, 'FileHashRule')),
  ];
  return {
    type,
    enforcementMode: normalizeEnforcement(attrs.EnforcementMode),
    rules,
  };
}

function serializeCondition(c: RuleCondition): string {
  if (c.kind === 'publisher') {
    return (
      `<FilePublisherCondition PublisherName="${encodeXml(c.publisherName)}" ProductName="${encodeXml(c.productName)}" BinaryName="${encodeXml(c.binaryName)}">` +
      `<BinaryVersionRange LowSection="${encodeXml(c.lowSection)}" HighSection="${encodeXml(c.highSection)}" />` +
      `</FilePublisherCondition>`
    );
  }
  if (c.kind === 'path') {
    return `<FilePathCondition Path="${encodeXml(c.path)}" />`;
  }
  const hashes = c.hashes.map(h =>
    `<FileHash Type="${encodeXml(h.type || 'SHA256')}" Data="${encodeXml(h.data)}" SourceFileName="${encodeXml(h.sourceFileName)}" SourceFileLength="${encodeXml(h.sourceFileLength)}" />`,
  ).join('');
  return `<FileHashCondition>${hashes}</FileHashCondition>`;
}

export function serializeRule(rule: AppLockerRule): string {
  const desc = rule.description ? ` Description="${encodeXml(rule.description)}"` : '';
  const open =
    `<${rule.xmlName} Id="${encodeXml(rule.id)}" Name="${encodeXml(rule.name)}"${desc}` +
    ` UserOrGroupSid="${encodeXml(rule.userOrGroupSid)}" Action="${rule.action}">`;
  const conditions = `<Conditions>${rule.conditions.map(serializeCondition).join('')}</Conditions>`;
  const exceptions = rule.exceptions.length
    ? `<Exceptions>${rule.exceptions.map(serializeCondition).join('')}</Exceptions>`
    : '';
  return `${open}${conditions}${exceptions}</${rule.xmlName}>`;
}

export function prettyXml(xml: string): string {
  const lines = xml.replace(/></g, '>\n<').split('\n');
  let indent = 0;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('</')) indent = Math.max(0, indent - 1);
    out.push(`${'  '.repeat(indent)}${line}`);
    const opened = line.startsWith('<') && !line.startsWith('</') && !line.startsWith('<?');
    const selfClose = /\/>$/.test(line) || /<\/[^>]+>$/.test(line.slice(1));
    if (opened && !selfClose) indent += 1;
  }
  return out.join('\n');
}

export type AppLockerXmlDiff = {
  type: 'change' | 'add' | 'remove';
  key: string;
  label: string;
  existing?: string;
  desired?: string;
};

export function diffAppLockerXml(existingXml: string, desiredXml: string): AppLockerXmlDiff[] | null {
  try {
    const a = parseRuleCollectionXml(existingXml);
    const b = parseRuleCollectionXml(desiredXml);
    const byA = new Map(a.rules.map(r => [r.id.toLowerCase(), r]));
    const byB = new Map(b.rules.map(r => [r.id.toLowerCase(), r]));
    const keys = [...new Set([...byA.keys(), ...byB.keys()])].sort();
    const diffs: AppLockerXmlDiff[] = [];
    if (a.enforcementMode !== b.enforcementMode || a.type !== b.type) {
      diffs.push({
        type: 'change',
        key: 'RuleCollection',
        label: `RuleCollection  ${a.type}→${b.type}  ${a.enforcementMode}→${b.enforcementMode}`,
        existing: `<RuleCollection Type="${a.type}" EnforcementMode="${a.enforcementMode}" />`,
        desired: `<RuleCollection Type="${b.type}" EnforcementMode="${b.enforcementMode}" />`,
      });
    }
    for (const k of keys) {
      const left = byA.get(k);
      const right = byB.get(k);
      if (!left && right) {
        diffs.push({
          type: 'add',
          key: right.id,
          label: `${right.xmlName}  ${right.name}  ${right.action}`,
          desired: prettyXml(serializeRule(right)),
        });
      } else if (left && !right) {
        diffs.push({
          type: 'remove',
          key: left.id,
          label: `${left.xmlName}  ${left.name}  ${left.action}`,
          existing: prettyXml(serializeRule(left)),
        });
      } else if (left && right && serializeRule(left) !== serializeRule(right)) {
        diffs.push({
          type: 'change',
          key: left.id,
          label: `${right.xmlName}  ${right.name}  ${right.action}`,
          existing: prettyXml(serializeRule(left)),
          desired: prettyXml(serializeRule(right)),
        });
      }
    }
    return diffs;
  } catch {
    return null;
  }
}

export function serializeRuleCollectionXml(collection: RuleCollection): string {
  const rules = [...collection.rules]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'accent' }))
    .map(serializeRule)
    .join('');
  return `<RuleCollection Type="${collection.type}" EnforcementMode="${collection.enforcementMode}">${rules}</RuleCollection>`;
}

export function mergeOverlay(baseline: RuleCollection, overlay: AppLockerOverlay): RuleCollection {
  const excluded = new Set(overlay.excludeRuleIds.map(id => id.toLowerCase()));
  const kept = baseline.rules.filter(r => !excluded.has(r.id.toLowerCase()));
  const byId = new Map(kept.map(r => [r.id.toLowerCase(), r]));
  const additions: AppLockerRule[] = [];
  for (const raw of overlay.rules) {
    const next = { ...raw, id: raw.id || newRuleId() };
    const key = next.id.toLowerCase();
    if (byId.has(key)) {
      byId.set(key, next);
      continue;
    }
    byId.set(key, next);
    additions.push(next);
  }
  return {
    type: baseline.type,
    enforcementMode: overlay.enforcementMode ?? baseline.enforcementMode,
    rules: [...kept.map(r => byId.get(r.id.toLowerCase()) ?? r), ...additions],
  };
}

export function emptyOverlay(): AppLockerOverlay {
  return { excludeRuleIds: [], rules: [] };
}

export function rulesContentEqual(a: AppLockerRule, b: AppLockerRule): boolean {
  const strip = (r: AppLockerRule) => JSON.stringify({
    xmlName: r.xmlName,
    name: r.name,
    description: r.description,
    userOrGroupSid: r.userOrGroupSid,
    action: r.action,
    conditions: r.conditions,
    exceptions: r.exceptions,
  });
  return strip(a) === strip(b);
}

/** Diff a tenant backup collection against baseline into an overlay (one-time import). */
export function overlayFromTenantBackup(baseline: RuleCollection, tenant: RuleCollection): AppLockerOverlay {
  const baselineById = new Map(baseline.rules.map(r => [r.id.toLowerCase(), r]));
  const tenantById = new Map(tenant.rules.map(r => [r.id.toLowerCase(), r]));
  const excludeRuleIds: string[] = [];
  const rules: AppLockerRule[] = [];

  for (const b of baseline.rules) {
    const t = tenantById.get(b.id.toLowerCase());
    if (!t) {
      excludeRuleIds.push(b.id);
      continue;
    }
    if (!rulesContentEqual(b, t)) {
      excludeRuleIds.push(b.id);
      rules.push(t);
    }
  }

  for (const t of tenant.rules) {
    if (!baselineById.has(t.id.toLowerCase())) rules.push(t);
  }

  const overlay: AppLockerOverlay = { excludeRuleIds, rules };
  if (tenant.enforcementMode !== baseline.enforcementMode) {
    overlay.enforcementMode = tenant.enforcementMode;
  }
  return overlay;
}

export function overlayHasChanges(overlay: AppLockerOverlay): boolean {
  return overlay.excludeRuleIds.length > 0 || overlay.rules.length > 0 || overlay.enforcementMode !== undefined;
}

export function parseOverlayJson(raw: unknown): AppLockerOverlay {
  if (!raw || typeof raw !== 'object') return emptyOverlay();
  const o = raw as Record<string, unknown>;
  const excludeRuleIds = Array.isArray(o.excludeRuleIds)
    ? o.excludeRuleIds.filter((x): x is string => typeof x === 'string')
    : [];
  const rules = Array.isArray(o.rules) ? o.rules.map(normalizeOverlayRule).filter((r): r is AppLockerRule => !!r) : [];
  const enforcementMode = typeof o.enforcementMode === 'string' ? normalizeEnforcement(o.enforcementMode) : undefined;
  return { excludeRuleIds, rules, enforcementMode };
}

function normalizeOverlayRule(raw: unknown): AppLockerRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const xmlName = r.xmlName === 'FilePathRule' || r.xmlName === 'FileHashRule' || r.xmlName === 'FilePublisherRule'
    ? r.xmlName
    : null;
  if (!xmlName) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newRuleId(),
    xmlName,
    name: typeof r.name === 'string' ? r.name : '',
    description: typeof r.description === 'string' ? r.description : '',
    userOrGroupSid: typeof r.userOrGroupSid === 'string' ? r.userOrGroupSid : SID_EVERYONE,
    action: r.action === 'Deny' ? 'Deny' : 'Allow',
    conditions: Array.isArray(r.conditions) ? r.conditions.map(normalizeCondition).filter((c): c is RuleCondition => !!c) : [],
    exceptions: Array.isArray(r.exceptions) ? r.exceptions.map(normalizeCondition).filter((c): c is RuleCondition => !!c) : [],
  };
}

function normalizeCondition(raw: unknown): RuleCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.kind === 'path') return { kind: 'path', path: String(c.path ?? '*') };
  if (c.kind === 'hash') {
    const hashes = Array.isArray(c.hashes)
      ? c.hashes.filter((h): h is Record<string, unknown> => !!h && typeof h === 'object').map(h => ({
        type: String(h.type ?? 'SHA256'),
        data: String(h.data ?? ''),
        sourceFileName: String(h.sourceFileName ?? ''),
        sourceFileLength: String(h.sourceFileLength ?? '0'),
      }))
      : [];
    return { kind: 'hash', hashes };
  }
  if (c.kind === 'publisher' || c.publisherName !== undefined) {
    return {
      kind: 'publisher',
      publisherName: String(c.publisherName ?? '*'),
      productName: String(c.productName ?? '*'),
      binaryName: String(c.binaryName ?? '*'),
      lowSection: String(c.lowSection ?? '*'),
      highSection: String(c.highSection ?? '*'),
    };
  }
  return null;
}

function pathRule(name: string, path: string, sid: string): AppLockerRule {
  return {
    id: newRuleId(),
    xmlName: 'FilePathRule',
    name,
    description: '',
    userOrGroupSid: sid,
    action: 'Allow',
    conditions: [{ kind: 'path', path }],
    exceptions: [],
  };
}

function publisherStarRule(name: string, sid: string): AppLockerRule {
  return {
    id: newRuleId(),
    xmlName: 'FilePublisherRule',
    name,
    description: '',
    userOrGroupSid: sid,
    action: 'Allow',
    conditions: [{
      kind: 'publisher',
      publisherName: '*',
      productName: '*',
      binaryName: '*',
      lowSection: '*',
      highSection: '*',
    }],
    exceptions: [],
  };
}

/** MMC "Create Default Rules" templates. */
export function defaultRules(type: CollectionType): AppLockerRule[] {
  switch (type) {
    case 'Exe':
    case 'Dll':
      return [
        pathRule('(Default Rule) All files located in the Program Files folder', '%PROGRAMFILES%\\*', SID_EVERYONE),
        pathRule('(Default Rule) All files located in the Windows folder', '%WINDIR%\\*', SID_EVERYONE),
        pathRule('(Default Rule) All files', '*', SID_ADMINISTRATORS),
      ];
    case 'Msi':
      return [
        publisherStarRule('(Default Rule) All digitally signed Windows Installer files', SID_EVERYONE),
        pathRule('(Default Rule) All Windows Installer files in %systemdrive%\\Windows\\Installer', '%WINDIR%\\Installer\\*', SID_EVERYONE),
        pathRule('(Default Rule) All Windows Installer files', '*', SID_ADMINISTRATORS),
      ];
    case 'Script':
      return [
        pathRule('(Default Rule) All scripts located in the Program Files folder', '%PROGRAMFILES%\\*', SID_EVERYONE),
        pathRule('(Default Rule) All scripts located in the Windows folder', '%WINDIR%\\*', SID_EVERYONE),
        pathRule('(Default Rule) All scripts', '*', SID_ADMINISTRATORS),
      ];
    case 'Appx':
      return [
        publisherStarRule('(Default Rule) All signed packaged apps', SID_EVERYONE),
      ];
  }
}

export function emptyCollection(type: CollectionType, enforcementMode: EnforcementMode = 'NotConfigured'): RuleCollection {
  return { type, enforcementMode, rules: [] };
}

export function buildEmptyDeviceConfig(type: CollectionType): Record<string, unknown> {
  const fileKey = type.toLowerCase() === 'appx' ? 'appx' : type.toLowerCase();
  return {
    '@odata.type': '#microsoft.graph.windows10CustomConfiguration',
    displayName: `Baseline - Applocker ${fileKey}`,
    description: null,
    roleScopeTagIds: ['0'],
    omaSettings: [{
      '@odata.type': '#microsoft.graph.omaSettingString',
      displayName: `applocker${fileKey}`,
      description: null,
      omaUri: OMA_URI[type],
      value: serializeRuleCollectionXml(emptyCollection(type)),
    }],
  };
}

/** Backup JSON often has a single omaSetting object — PowerShell ConvertTo-Json collapses 1-element arrays. */
function omaSettingList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object');
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.value === 'string' || typeof rec.omaUri === 'string') return [rec];
    return Object.values(rec).filter((s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && (typeof (s as Record<string, unknown>).value === 'string' || typeof (s as Record<string, unknown>).omaUri === 'string'));
  }
  return [];
}

export function extractOmaSetting(json: Record<string, unknown>): { omaUri: string; displayName: string; value: string } | null {
  const settings = omaSettingList(json.omaSettings);
  for (const rec of settings) {
    const uri = typeof rec.omaUri === 'string' ? rec.omaUri : '';
    const value = typeof rec.value === 'string' ? rec.value : '';
    if (isAppLockerOmaUri(uri) || /RuleCollection/i.test(value)) {
      return {
        omaUri: uri,
        displayName: typeof rec.displayName === 'string' ? rec.displayName : '',
        value,
      };
    }
  }
  if (settings[0] && typeof settings[0].value === 'string') {
    const rec = settings[0];
    return {
      omaUri: typeof rec.omaUri === 'string' ? rec.omaUri : '',
      displayName: typeof rec.displayName === 'string' ? rec.displayName : '',
      value: rec.value as string,
    };
  }
  return null;
}

/** Parse + reserialize AppLocker XML so whitespace/order do not create false diffs. */
export function canonicalizeAppLockerXml(xml: string, type?: CollectionType): string {
  const col = parseRuleCollectionXml(xml, type);
  return serializeRuleCollectionXml(col);
}

/**
 * Rewrite a device-configuration JSON string's AppLocker OMA value:
 * optional overlay merge, then canonical XML. Returns the original string if
 * the file is not an AppLocker policy.
 */
export function applyOverlayToDeviceConfigJson(
  raw: string,
  overlay: AppLockerOverlay | null | undefined,
  fileName = '',
): string {
  try {
    const json = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const oma = extractOmaSetting(json);
    if (!oma?.value) return raw;
    const type = detectCollectionFromPolicy(fileName, oma.omaUri, oma.value);
    if (!type) return raw;
    const baseline = parseRuleCollectionXml(oma.value, type);
    const merged = overlay && overlayHasChanges(overlay) ? mergeOverlay(baseline, overlay) : baseline;
    return `${JSON.stringify(applyCollectionToDeviceConfig(json, merged))}\n`;
  } catch {
    return raw;
  }
}

export function applyCollectionToDeviceConfig(
  json: Record<string, unknown>,
  collection: RuleCollection,
): Record<string, unknown> {
  const next = { ...json };
  const settings = [...omaSettingList(json.omaSettings)];
  const xml = serializeRuleCollectionXml(collection);
  if (settings.length === 0) {
    next.omaSettings = [{
      '@odata.type': '#microsoft.graph.omaSettingString',
      displayName: `applocker${collection.type.toLowerCase()}`,
      description: null,
      omaUri: OMA_URI[collection.type],
      value: xml,
    }];
    return next;
  }
  const idx = settings.findIndex(s => {
    if (!s || typeof s !== 'object') return false;
    const uri = (s as Record<string, unknown>).omaUri;
    return typeof uri === 'string' && isAppLockerOmaUri(uri);
  });
  const target = idx >= 0 ? idx : 0;
  const prev = (settings[target] && typeof settings[target] === 'object')
    ? { ...(settings[target] as Record<string, unknown>) }
    : {};
  prev.value = xml;
  if (!prev.omaUri) prev.omaUri = OMA_URI[collection.type];
  settings[target] = prev;
  next.omaSettings = settings;
  return next;
}

export function baselineFileNameFor(type: CollectionType): string {
  const key = type === 'Appx' ? 'appx' : type.toLowerCase();
  return `Baseline - Applocker ${key}.json`;
}

export interface ApplockerBackupPolicy {
  type: CollectionType;
  path: string;
  displayName: string;
  enforcementMode: EnforcementMode;
  ruleCount: number;
}

export interface ApplockerBackupImportStatus {
  available: boolean;
  imported: boolean;
  importedAt?: string;
  types: CollectionType[];
  policies: ApplockerBackupPolicy[];
}

export interface ApplockerTenantOverlayDto {
  slug: string;
  displayName: string;
  excludeRuleIds: string[];
  rules: AppLockerRule[];
  enforcementMode?: EnforcementMode;
}

export interface FlattenedTenantOverlayRow {
  key: string;
  rule: AppLockerRule;
  slug: string;
  displayName: string;
  customized: boolean;
}

/** Flatten every tenant overlay into table rows plus baseline exclusion labels. */
export function flattenTenantOverlayRows(
  baselineRules: AppLockerRule[],
  tenantOverlays: ApplockerTenantOverlayDto[],
): { rows: FlattenedTenantOverlayRow[]; excludedBy: Record<string, string[]> } {
  const baselineById = new Map(baselineRules.map(r => [r.id.toLowerCase(), r]));
  const excludedBy: Record<string, string[]> = {};
  const rows: FlattenedTenantOverlayRow[] = [];

  for (const overlay of tenantOverlays) {
    for (const rule of overlay.rules) {
      rows.push({
        key: `${overlay.slug}:${rule.id}`,
        rule,
        slug: overlay.slug,
        displayName: overlay.displayName,
        customized: baselineById.has(rule.id.toLowerCase()),
      });
    }
    for (const id of overlay.excludeRuleIds) {
      const baseline = baselineById.get(id.toLowerCase());
      if (!baseline) continue;
      const names = excludedBy[baseline.id] ?? (excludedBy[baseline.id] = []);
      if (!names.includes(overlay.displayName)) names.push(overlay.displayName);
    }
  }

  return { rows, excludedBy };
}

export interface ApplockerCollectionDto {
  type: CollectionType;
  path: string;
  sha: string | null;
  displayName: string;
  omaUri: string;
  enforcementMode: EnforcementMode;
  rules: AppLockerRule[];
  exists: boolean;
  overlay: {
    path: string;
    sha: string | null;
    exists: boolean;
    excludeRuleIds: string[];
    rules: AppLockerRule[];
    enforcementMode?: EnforcementMode;
  };
  tenantOverlays?: ApplockerTenantOverlayDto[];
}
