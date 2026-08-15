import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFieldFilter,
  getFolderSidecarPath,
  getSidecarPath,
  mergeMonitorConfigs,
  parseMonitorConfig,
} from './monitor-config.ts';

describe('sidecar paths', () => {
  it('maps policy JSON to file and folder monitor sidecars', () => {
    const fp = 'exchange/anti-spam-policies/Default.json';
    assert.equal(getSidecarPath(fp), 'exchange/anti-spam-policies/Default.monitor.json');
    assert.equal(getFolderSidecarPath(fp), 'exchange/anti-spam-policies/_default.monitor.json');
  });
});

describe('mergeMonitorConfigs', () => {
  it('drops folder include AllowedSenders when file excludes AllowedSenders', () => {
    const merged = mergeMonitorConfigs(
      { exclude: ['AllowedSenders'] },
      { include: ['EnableEndUserSpamNotifications', 'AllowedSenders', 'SpamAction'] },
    );
    assert.deepEqual(merged?.exclude, ['AllowedSenders']);
    assert.ok(merged?.include);
    assert.equal(merged.include.includes('AllowedSenders'), false);
    assert.deepEqual(merged.include, ['EnableEndUserSpamNotifications', 'SpamAction']);
  });

  it('drops folder include AllowedSenders.Sender when file excludes AllowedSenders', () => {
    const merged = mergeMonitorConfigs(
      { exclude: ['AllowedSenders'] },
      { include: ['AllowedSenders.Sender', 'SpamAction'] },
    );
    assert.equal(merged?.include?.includes('AllowedSenders.Sender'), false);
    assert.deepEqual(merged?.exclude, ['AllowedSenders']);
    assert.deepEqual(merged?.include, ['SpamAction']);
  });

  it('exclude wins over include for the same path in a single sidecar', () => {
    const merged = mergeMonitorConfigs(
      { include: ['AllowedSenders', 'SpamAction'], exclude: ['AllowedSenders'] },
      null,
    );
    assert.equal(merged?.include?.includes('AllowedSenders'), false);
    assert.deepEqual(merged?.exclude, ['AllowedSenders']);
  });
});

describe('applyFieldFilter', () => {
  const policy = {
    AddXHeaderValue: '',
    AllowedSenders: {
      Group: 'Default',
      Sender: { Address: 'no-reply@mintago.com' },
    },
    SpamAction: 'MoveToJmf',
  };

  it('removes AllowedSenders for a single-element exclude list', () => {
    const filtered = applyFieldFilter(policy, { exclude: ['AllowedSenders'] }) as Record<string, unknown>;
    assert.equal('AllowedSenders' in filtered, false);
    assert.equal(filtered.SpamAction, 'MoveToJmf');
  });

  it('file exclude wins after folder include copied AllowedSenders.Sender', () => {
    const merged = mergeMonitorConfigs(
      { exclude: ['AllowedSenders'] },
      { include: ['AllowedSenders.Sender', 'SpamAction'] },
    );
    const filtered = applyFieldFilter(policy, merged ?? {}) as Record<string, unknown>;
    assert.equal('AllowedSenders' in filtered, false);
    assert.equal(filtered.SpamAction, 'MoveToJmf');
  });

  it('removes empty parent after nested exclude', () => {
    const filtered = applyFieldFilter(
      { AllowedSenders: { Sender: { Address: 'a@b.com' } }, SpamAction: 'MoveToJmf' },
      { exclude: ['AllowedSenders.Sender'] },
    ) as Record<string, unknown>;
    assert.equal('AllowedSenders' in filtered, false);
  });
});

describe('parseMonitorConfig', () => {
  it('reads exclude-only sidecar JSON', () => {
    const cfg = parseMonitorConfig('{\n  "exclude": [\n    "AllowedSenders"\n  ]\n}\n');
    assert.deepEqual(cfg, { exclude: ['AllowedSenders'] });
  });
});
