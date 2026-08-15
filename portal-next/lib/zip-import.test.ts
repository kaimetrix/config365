import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBinaryImportPath, normalizeBaselineImportPaths } from './zip-import.ts';

describe('normalizeBaselineImportPaths', () => {
  it('flattens baseline/baseline/ deploy export', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'baseline/baseline/exchange/foo.json', content: '{}' },
    ]);
    assert.equal(out[0]?.path, 'baseline/exchange/foo.json');
  });

  it('maps baseline/baseline-remove/ to repo remove root', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'baseline/baseline-remove/groups/x.json', content: '{}' },
    ]);
    assert.equal(out[0]?.path, 'baseline-remove/groups/x.json');
  });

  it('prefixes bare policy paths with baseline/', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'exchange/foo.json', content: '{}' },
    ]);
    assert.equal(out[0]?.path, 'baseline/exchange/foo.json');
  });

  it('keeps groups-config.json at repo root (Groups tab reads repo root)', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'groups-config.json', content: '{"groups":{}}' },
    ]);
    assert.equal(out[0]?.path, 'groups-config.json');
  });

  it('hoists baseline/groups-config.json to repo root', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'baseline/groups-config.json', content: '{"groups":{}}' },
    ]);
    assert.equal(out[0]?.path, 'groups-config.json');
  });

  it('handles main (3).zip layout from full checkout export', () => {
    const out = normalizeBaselineImportPaths([
      { path: 'baseline/baseline/intune/x.json', content: '{}' },
      { path: 'baseline/baseline-remove/groups/y.json', content: '{}' },
      { path: 'baseline/maintenance/z.json', content: '{}' },
      { path: 'baseline/README.md', content: '# hi' },
    ]);
    assert.deepEqual(
      new Set(out.map((f) => f.path)),
      new Set([
        'baseline/README.md',
        'baseline/intune/x.json',
        'baseline/maintenance/z.json',
        'baseline-remove/groups/y.json',
      ]),
    );
  });

  it('preserves base64 encoding on binary paths', () => {
    const out = normalizeBaselineImportPaths([
      {
        path: 'baseline/baseline/apps/winget/Anthropic.Claude/icon.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64',
      },
    ]);
    assert.equal(out[0]?.path, 'baseline/apps/winget/Anthropic.Claude/icon.png');
    assert.equal(out[0]?.encoding, 'base64');
    assert.equal(out[0]?.content, 'iVBORw0KGgo=');
  });
});

describe('isBinaryImportPath', () => {
  it('detects icon and other binary extensions', () => {
    assert.equal(isBinaryImportPath('baseline/apps/winget/Anthropic.Claude/icon.png'), true);
    assert.equal(isBinaryImportPath('apps/x/icon.jpg'), true);
    assert.equal(isBinaryImportPath('foo.intunewin'), true);
    assert.equal(isBinaryImportPath('baseline/exchange/foo.json'), false);
    assert.equal(isBinaryImportPath('README.md'), false);
  });
});

describe('zip import binary encoding', () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('PNG magic bytes survive base64 and are destroyed by utf-8 decode', () => {
    const corrupted = Buffer.from(pngSignature.toString('utf-8'), 'utf-8');
    assert.notEqual(corrupted[0], 0x89);

    const restored = Buffer.from(pngSignature.toString('base64'), 'base64');
    assert.deepEqual([...restored], [...pngSignature]);
  });
});
