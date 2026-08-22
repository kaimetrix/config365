import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { applockerSha256, parseAppLockerFileInfo, publisherFromSubject } from './applocker-fileinfo.ts';

function minimalPe(): Buffer {
  const buf = Buffer.alloc(0x200);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3C);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x014C, 0x84);
  buf.writeUInt16LE(0, 0x86);
  buf.writeUInt16LE(0xE0, 0x94);
  buf.writeUInt16LE(0x10B, 0x98);
  buf.writeUInt32LE(0, 0x98 + 64);
  return buf;
}

describe('applockerSha256', () => {
  it('hashes scripts as raw SHA256', () => {
    const buf = Buffer.from('Write-Host hello\r\n', 'utf8');
    const expected = createHash('sha256').update(buf).digest('hex').toUpperCase();
    assert.equal(applockerSha256(buf), expected);
  });

  it('hashes a minimal PE with the Authenticode skip algorithm', () => {
    const pe = minimalPe();
    const hash = applockerSha256(pe);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, createHash('sha256').update(pe).digest('hex').toUpperCase());
  });
});

describe('parseAppLockerFileInfo', () => {
  it('returns hash and filename for an unsigned PE', () => {
    const pe = minimalPe();
    const info = parseAppLockerFileInfo('Contoso.Setup.exe', pe);
    assert.equal(info.fileName, 'Contoso.Setup.exe');
    assert.equal(info.fileLength, pe.length);
    assert.equal(info.signed, false);
    assert.equal(info.hash.length, 64);
    assert.equal(info.binaryName, 'CONTOSO.SETUP.EXE');
  });

  it('rejects oversized buffers', () => {
    assert.throws(() => parseAppLockerFileInfo('big.exe', Buffer.alloc(21 * 1024 * 1024)));
  });
});

describe('publisherFromSubject', () => {
  it('parses Node newline-separated subjects into AppLocker O/L/S/C form', () => {
    const subject = 'C=US\nST=WASHINGTON\nL=REDMOND\nO=MICROSOFT CORPORATION\nCN=MICROSOFT CORPORATION';
    assert.equal(
      publisherFromSubject(subject),
      'O=MICROSOFT CORPORATION, L=REDMOND, S=WASHINGTON, C=US',
    );
  });

  it('parses comma-separated subjects and maps ST to S', () => {
    assert.equal(
      publisherFromSubject('CN=Contoso, O=Contoso Inc, L=Redmond, ST=Washington, C=US'),
      'O=CONTOSO INC, L=REDMOND, S=WASHINGTON, C=US',
    );
  });
});
