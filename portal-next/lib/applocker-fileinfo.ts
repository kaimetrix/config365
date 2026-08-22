import { createHash, X509Certificate } from 'crypto';

export interface AppLockerFileInfo {
  fileName: string;
  fileLength: number;
  hashType: 'SHA256';
  hash: string;
  signed: boolean;
  publisherName: string;
  productName: string;
  binaryName: string;
  fileVersion: string;
}

const MAX_BYTES = 20 * 1024 * 1024;

export function maxAppLockerUploadBytes(): number {
  return MAX_BYTES;
}

function readU16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

function isPe(buf: Buffer): boolean {
  if (buf.length < 64 || buf.toString('ascii', 0, 2) !== 'MZ') return false;
  const e_lfanew = readU32(buf, 0x3C);
  return e_lfanew + 4 < buf.length && buf.toString('ascii', e_lfanew, e_lfanew + 4) === 'PE\0\0';
}

/** SHA256 Authenticode image hash for PE, else raw file SHA256. */
export function applockerSha256(buf: Buffer): string {
  if (isPe(buf)) {
    const hashed = authenticodeImageHash(buf);
    if (hashed) return hashed;
  }
  return createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function authenticodeImageHash(buf: Buffer): string | null {
  try {
    const e_lfanew = readU32(buf, 0x3C);
    const optOff = e_lfanew + 24;
    const magic = readU16(buf, optOff);
    const pe32plus = magic === 0x20B;
    const checksumOff = optOff + 64;
    const ddOff = pe32plus ? optOff + 112 : optOff + 96;
    const certDirOff = ddOff + 4 * 8;
    if (certDirOff + 8 > buf.length || checksumOff + 4 > buf.length) return null;

    const certOff = readU32(buf, certDirOff);
    const hashEnd = certOff > 0 && certOff <= buf.length ? certOff : buf.length;

    const h = createHash('sha256');
    h.update(buf.subarray(0, checksumOff));
    h.update(buf.subarray(checksumOff + 4, certDirOff));
    h.update(buf.subarray(certDirOff + 8, hashEnd));
    return h.digest('hex').toUpperCase();
  } catch {
    return null;
  }
}

function extractPkcs7(buf: Buffer): Buffer | null {
  if (!isPe(buf)) return null;
  const e_lfanew = readU32(buf, 0x3C);
  const optOff = e_lfanew + 24;
  const magic = readU16(buf, optOff);
  const pe32plus = magic === 0x20B;
  const ddOff = pe32plus ? optOff + 112 : optOff + 96;
  const certDirOff = ddOff + 4 * 8;
  if (certDirOff + 8 > buf.length) return null;
  const certOff = readU32(buf, certDirOff);
  const certSize = readU32(buf, certDirOff + 4);
  if (certOff < 8 || certSize < 12 || certOff + certSize > buf.length) return null;
  const dwLength = readU32(buf, certOff);
  if (dwLength < 8 || certOff + dwLength > buf.length) return null;
  return buf.subarray(certOff + 8, certOff + dwLength);
}

interface DerNode {
  tag: number;
  header: number;
  contents: Buffer;
  raw: Buffer;
}

function readDer(buf: Buffer, offset = 0): { node: DerNode; next: number } | null {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset];
  let len = buf[offset + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7F;
    if (n === 0 || offset + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 2 + i];
    header = 2 + n;
  }
  const start = offset + header;
  const end = start + len;
  if (end > buf.length) return null;
  return {
    node: { tag, header, contents: buf.subarray(start, end), raw: buf.subarray(offset, end) },
    next: end,
  };
}

function derChildren(contents: Buffer): DerNode[] {
  const kids: DerNode[] = [];
  let off = 0;
  while (off < contents.length) {
    const parsed = readDer(contents, off);
    if (!parsed) break;
    kids.push(parsed.node);
    off = parsed.next;
  }
  return kids;
}

function unwrapContext(node: DerNode): DerNode | null {
  if ((node.tag & 0xE0) === 0xA0) {
    const inner = readDer(node.contents, 0);
    return inner?.node ?? null;
  }
  return node;
}

function firstCertificateDer(pkcs7: Buffer): Buffer | null {
  const root = readDer(pkcs7, 0);
  if (!root || root.node.tag !== 0x30) return null;
  const contentInfo = derChildren(root.node.contents);
  const signedWrap = contentInfo.find(n => (n.tag & 0x1F) === 0 && (n.tag & 0xE0) === 0xA0);
  if (!signedWrap) return null;
  const signed = unwrapContext(signedWrap);
  if (!signed || signed.tag !== 0x30) return null;
  const sdKids = derChildren(signed.contents);
  const certsWrap = sdKids.find(n => n.tag === 0xA0);
  if (!certsWrap) return null;
  const certs = derChildren(certsWrap.contents);
  const cert = certs.find(n => n.tag === 0x30);
  return cert?.raw ?? null;
}

/** Node X509Certificate.subject is newline-separated; AppLocker wants `O=..., L=..., S=..., C=US`. */
export function publisherFromSubject(subject: string): string {
  const parts: Record<string, string> = {};
  const pieces = subject.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  for (const piece of pieces) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    let key = piece.slice(0, eq).trim().toUpperCase();
    if (key === 'ST') key = 'S';
    const value = piece.slice(eq + 1).trim();
    if (key && value) parts[key] = value;
  }
  const order = ['O', 'L', 'S', 'C'];
  const used = order.filter(k => parts[k]).map(k => `${k}=${parts[k].toUpperCase()}`);
  if (used.length) return used.join(', ');
  if (parts.CN) return `CN=${parts.CN.toUpperCase()}`;
  return subject.replace(/\s+/g, ' ').trim().toUpperCase();
}

function parseVersionInfo(buf: Buffer): { productName: string; binaryName: string; fileVersion: string } {
  const empty = { productName: '*', binaryName: '*', fileVersion: '*' };
  if (!isPe(buf)) return empty;
  try {
    const ascii = buf.toString('latin1');
    const text = buf.toString('utf16le');
    const pick = (key: string): string | null => {
      const wide = key.split('').join('\0') + '\0';
      const idx = ascii.indexOf(wide);
      if (idx < 0) return null;
      const after = idx + wide.length;
      let start = after;
      while (start < ascii.length && ascii.charCodeAt(start) === 0) start++;
      const slice = text.slice(Math.floor(start / 2), Math.floor(start / 2) + 128);
      const end = slice.indexOf('\0');
      const val = (end >= 0 ? slice.slice(0, end) : slice).trim();
      return val || null;
    };
    const productName = pick('ProductName') ?? '*';
    const binaryName = pick('OriginalFilename') ?? pick('InternalName') ?? '*';
    const fileVersion = pick('FileVersion') ?? '*';
    return {
      productName: productName === '*' ? '*' : productName.toUpperCase(),
      binaryName: binaryName === '*' ? '*' : binaryName.toUpperCase(),
      fileVersion,
    };
  } catch {
    return empty;
  }
}

export function parseAppLockerFileInfo(fileName: string, buf: Buffer): AppLockerFileInfo {
  if (buf.length > MAX_BYTES) {
    throw new Error(`File exceeds ${MAX_BYTES / (1024 * 1024)} MB limit`);
  }
  const hash = applockerSha256(buf);
  let signed = false;
  let publisherName = '';
  const pkcs7 = extractPkcs7(buf);
  if (pkcs7) {
    try {
      const certDer = firstCertificateDer(pkcs7);
      if (certDer) {
        const cert = new X509Certificate(certDer);
        publisherName = publisherFromSubject(cert.subject);
        signed = true;
      }
    } catch {
      signed = false;
    }
  }
  const ver = parseVersionInfo(buf);
  const fallbackBinary = fileName.split(/[/\\]/).pop()?.toUpperCase() || '*';
  return {
    fileName,
    fileLength: buf.length,
    hashType: 'SHA256',
    hash,
    signed,
    publisherName,
    productName: ver.productName,
    binaryName: ver.binaryName === '*' ? fallbackBinary : ver.binaryName,
    fileVersion: ver.fileVersion,
  };
}
