import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  deviceBelowThreshold,
  normalizeOsVersion,
  resolveDeviceOsVersion,
} from './os-version-threshold.ts';

describe('normalizeOsVersion', () => {
  it('keeps Intune-style Windows versions', () => {
    assert.equal(normalizeOsVersion('10.0.22631.4037'), '10.0.22631.4037');
    assert.equal(normalizeOsVersion('10.0.28000.0'), '10.0.28000.0');
  });

  it('prefixes MDE build numbers with 10.0', () => {
    assert.equal(normalizeOsVersion('22631'), '10.0.22631');
    assert.equal(normalizeOsVersion(22631), '10.0.22631');
    assert.equal(normalizeOsVersion('22631.4037'), '10.0.22631.4037');
  });

  it('drops marketing labels', () => {
    assert.equal(normalizeOsVersion('22H2'), '');
    assert.equal(normalizeOsVersion('Windows11'), '');
    assert.equal(normalizeOsVersion(''), '');
    assert.equal(normalizeOsVersion(null), '');
  });

  it('keeps iOS and Android dotted versions', () => {
    assert.equal(normalizeOsVersion('18.5'), '18.5');
    assert.equal(normalizeOsVersion('15.0'), '15.0');
  });

  it('strips macOS Darwin build suffixes', () => {
    assert.equal(normalizeOsVersion('26.6.1 (25G76)'), '26.6.1');
    assert.equal(normalizeOsVersion('Version 15.3.1 (24D70)'), '15.3.1');
    assert.equal(normalizeOsVersion('macOS 14.6'), '14.6');
  });
});

describe('resolveDeviceOsVersion', () => {
  it('prefers dotted osVersion over osBuild', () => {
    assert.equal(resolveDeviceOsVersion({ osVersion: '10.0.22631.1', osBuild: '26100' }), '10.0.22631.1');
  });

  it('falls back to osBuild when osVersion is empty or a label', () => {
    assert.equal(resolveDeviceOsVersion({ osVersion: '', osBuild: '22631.4037' }), '10.0.22631.4037');
    assert.equal(resolveDeviceOsVersion({ osVersion: '22H2', osBuild: 22631 }), '10.0.22631');
    assert.equal(resolveDeviceOsVersion({ osVersion: null, osBuild: null }), '');
  });
});

describe('deviceBelowThreshold', () => {
  it('compares MDE build-only devices against Intune thresholds', () => {
    assert.equal(deviceBelowThreshold({ osBuild: '22631' }, '10.0.28000.0'), true);
    assert.equal(deviceBelowThreshold({ osBuild: '28000.1' }, '10.0.28000.0'), false);
    assert.equal(deviceBelowThreshold({ osVersion: '10.0.26100.3476' }, '10.0.22631.0'), false);
  });

  it('does not treat missing versions as below threshold', () => {
    assert.equal(deviceBelowThreshold({ osVersion: null, osBuild: null }, '10.0.22631.0'), false);
  });

  it('treats macOS versions with build suffixes as comparable', () => {
    assert.equal(deviceBelowThreshold({ osVersion: '26.6.1 (25G76)' }, '26.6.1'), false);
    assert.equal(deviceBelowThreshold({ osVersion: '15.3.1 (24D70)' }, '26.6.1'), true);
  });
});

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    assert.ok(compareVersions('10.0.22631.0', '10.0.28000.0') < 0);
    assert.ok(compareVersions('10.0.28000.1', '10.0.28000.0') > 0);
    assert.equal(compareVersions('10.0.22631', '10.0.22631.0'), 0);
  });
});
