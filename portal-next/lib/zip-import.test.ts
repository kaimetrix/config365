import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaselineImportPaths } from './zip-import.ts';

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
});
