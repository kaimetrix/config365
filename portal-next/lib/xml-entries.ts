import { diffAppLockerXml, parseRuleCollectionXml, serializeRule } from './applocker';

/** Split XML blobs into comparable child entries for WhatIf diffs. */

export function looksLikeXml(value: string): boolean {
  const t = value.trim().replace(/^\uFEFF/, '');
  return t.startsWith('<') && /<[A-Za-z_][\w:.-]*[\s/>]/.test(t) && t.includes('>');
}

function stripDecl(xml: string): string {
  return xml.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\b[^?]*\?>\s*/i, '').trim();
}

function escapeRe(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]] = m[2];
  return attrs;
}

function extractInner(xml: string, tagName: string): string | null {
  const open = xml.match(new RegExp(`<${escapeRe(tagName)}\\b[^>]*>`, 'i'));
  if (!open || open.index === undefined) return null;
  if (/\/\s*>$/.test(open[0])) return '';
  const start = open.index + open[0].length;
  const close = xml.slice(start).search(new RegExp(`</${escapeRe(tagName)}\\s*>`, 'i'));
  if (close < 0) return xml.slice(start);
  return xml.slice(start, start + close);
}

function extractDirectChildren(inner: string): string[] {
  const blocks: string[] = [];
  let rest = inner;
  while (rest.length) {
    const start = rest.search(/<[A-Za-z_]/);
    if (start < 0) break;
    rest = rest.slice(start);
    const open = rest.match(/^<([A-Za-z_][\w:.-]*)\b[^>]*\/?>/);
    if (!open) break;
    const tag = open[1];
    if (/\/\s*>$/.test(open[0])) {
      blocks.push(open[0]);
      rest = rest.slice(open[0].length);
      continue;
    }
    let depth = 1;
    let i = open[0].length;
    const openPat = new RegExp(`<${escapeRe(tag)}\\b[^>]*>`, 'g');
    const closePat = new RegExp(`</${escapeRe(tag)}\\s*>`, 'g');
    while (depth > 0 && i < rest.length) {
      openPat.lastIndex = i;
      closePat.lastIndex = i;
      const nextOpen = openPat.exec(rest);
      const nextClose = closePat.exec(rest);
      if (!nextClose) {
        blocks.push(rest);
        return blocks;
      }
      const nested = nextOpen
        && nextOpen.index < nextClose.index
        && !/\/\s*>$/.test(nextOpen[0]);
      if (nested && nextOpen) {
        depth += 1;
        i = nextOpen.index + nextOpen[0].length;
      } else {
        depth -= 1;
        i = nextClose.index + nextClose[0].length;
      }
    }
    blocks.push(rest.slice(0, i));
    rest = rest.slice(i);
  }
  return blocks;
}

export interface XmlEntry {
  key: string;
  tag: string;
  label: string;
  xml: string;
}

export interface ParsedXmlEntries {
  root: string;
  attrs: Record<string, string>;
  entries: XmlEntry[];
}

function compactXml(xml: string): string {
  return xml.replace(/>\s+</g, '><').trim();
}

function entryFromBlock(block: string): XmlEntry {
  const xml = compactXml(block);
  const tag = xml.match(/^<([A-Za-z_][\w:.-]*)/)?.[1] ?? 'entry';
  const attrs = parseAttrs(xml);
  const key = attrs.Id || attrs.id || attrs.Name || attrs.name || xml;
  const label = [tag, attrs.Name || attrs.Id || attrs.id || '', attrs.Action, attrs.UserOrGroupSid]
    .filter(Boolean)
    .join('  ');
  return { key, tag, label, xml };
}

export function parseXmlEntries(xml: string): ParsedXmlEntries | null {
  if (!looksLikeXml(xml)) return null;
  const raw = stripDecl(xml);
  const open = raw.match(/^<([A-Za-z_][\w:.-]*)\b[^>]*\/?>/);
  if (!open) return null;
  const root = open[1];
  const attrs = parseAttrs(open[0]);
  if (/\/\s*>$/.test(open[0])) return { root, attrs, entries: [] };
  const inner = extractInner(raw, root);
  if (inner === null) return null;
  const children = extractDirectChildren(inner);
  if (children.length === 0) return null;
  const entries = children
    .map(entryFromBlock)
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'accent' }));
  return { root, attrs, entries };
}

function applockerDiffObject(xml: string): Record<string, unknown> | null {
  if (!/RuleCollection/i.test(xml)) return null;
  try {
    const col = parseRuleCollectionXml(xml);
    return {
      _xml: 'RuleCollection',
      Type: col.type,
      EnforcementMode: col.enforcementMode,
      entries: [...col.rules]
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'accent' }))
        .map(r => serializeRule(r)),
    };
  } catch {
    return null;
  }
}

/** Replace an XML string with a stable object so JSON line-diff is per entry. */
export function xmlToDiffObject(xml: string): Record<string, unknown> | string {
  const applocker = applockerDiffObject(xml);
  if (applocker) return applocker;
  const parsed = parseXmlEntries(xml);
  if (!parsed) return xml;
  return {
    _xml: parsed.root,
    ...parsed.attrs,
    entries: parsed.entries.map(e => e.xml),
  };
}

export function expandXmlInJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return looksLikeXml(value) ? xmlToDiffObject(value) : value;
  }
  if (Array.isArray(value)) return value.map(expandXmlInJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandXmlInJson(v);
    }
    return out;
  }
  return value;
}

export type XmlEntryDiff = {
  type: 'change' | 'add' | 'remove';
  key: string;
  label: string;
  existing?: string;
  desired?: string;
};

function isCompleteXml(xml: string): boolean {
  const t = xml.trim();
  return looksLikeXml(t) && /<\/[A-Za-z_][\w:.-]*>\s*$/.test(t);
}

/** Runner OMA diffs are three lines: "~ name value:" / "FROM: …" / "TO: …". */
export function extractOmaXmlPair(lines: string[]): { from: string; to: string } | null {
  let from = '';
  let to = '';
  for (const line of lines) {
    const t = line.trim();
    const fromM = t.match(/^FROM:\s*([\s\S]*)$/i);
    const toM = t.match(/^TO:\s*([\s\S]*)$/i);
    if (fromM) from = fromM[1];
    if (toM) to = toM[1];
  }
  if (!from || !to) return null;
  if (!looksLikeXml(from) || !looksLikeXml(to)) return null;
  return { from, to };
}

export type OmaXmlLineResult = { kind: 'match' | 'truncated' | 'unknown'; diffs: XmlEntryDiff[] };

/** Drop runner OMA lines when they are the same XML (or truncated FROM/TO leftovers). */
export function meaningfulOmaLines(lines: string[] | undefined): string[] {
  if (!lines?.length) return [];
  const interpreted = interpretOmaXmlLines(lines);
  return interpreted.kind === 'match' || interpreted.kind === 'truncated' ? [] : lines;
}

export function interpretOmaXmlLines(lines: string[]): OmaXmlLineResult {
  const pair = extractOmaXmlPair(lines);
  if (!pair) return { kind: 'unknown', diffs: [] };
  if (!isCompleteXml(pair.from) || !isCompleteXml(pair.to)) {
    return { kind: 'truncated', diffs: [] };
  }
  const diffs = diffAppLockerXml(pair.from, pair.to) ?? diffXmlEntries(pair.from, pair.to);
  if (!diffs) return { kind: 'unknown', diffs: [] };
  return { kind: diffs.length === 0 ? 'match' : 'unknown', diffs };
}

export function diffXmlEntries(existingXml: string, desiredXml: string): XmlEntryDiff[] | null {
  const a = parseXmlEntries(existingXml);
  const b = parseXmlEntries(desiredXml);
  if (!a || !b) return null;
  const byA = new Map(a.entries.map(e => [e.key.toLowerCase(), e]));
  const byB = new Map(b.entries.map(e => [e.key.toLowerCase(), e]));
  const keys = [...new Set([...byA.keys(), ...byB.keys()])].sort();
  const diffs: XmlEntryDiff[] = [];
  for (const k of keys) {
    const left = byA.get(k);
    const right = byB.get(k);
    if (!left && right) diffs.push({ type: 'add', key: right.key, label: right.label, desired: right.xml });
    else if (left && !right) diffs.push({ type: 'remove', key: left.key, label: left.label, existing: left.xml });
    else if (left && right && left.xml !== right.xml) {
      diffs.push({
        type: 'change',
        key: left.key,
        label: right.label || left.label,
        existing: left.xml,
        desired: right.xml,
      });
    }
  }
  for (const name of Object.keys({ ...a.attrs, ...b.attrs }).sort()) {
    if ((a.attrs[name] ?? '') === (b.attrs[name] ?? '')) continue;
    diffs.unshift({
      type: 'change',
      key: name,
      label: `${a.root}.${name}`,
      existing: a.attrs[name],
      desired: b.attrs[name],
    });
  }
  return diffs;
}
