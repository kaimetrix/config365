import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareSemver,
  emptySourceDebug,
  formatBlockedUpdateError,
  formatNoUpdateError,
  githubReleaseHtmlUrl,
  githubReleasesLatestUrl,
  inferRequiredPlatformVersion,
  parseSemverParts,
  repoForChannel,
} from './update-source.ts';

describe('repoForChannel', () => {
  it('maps preview and ga to public GitHub repos', () => {
    assert.equal(repoForChannel('preview'), 'potsolutions/config365-preview');
    assert.equal(repoForChannel('ga'), 'potsolutions/config365');
  });
});

describe('parseSemverParts / inferRequiredPlatformVersion', () => {
  it('reads EPOCH.PLATFORM.APP', () => {
    assert.deepEqual(parseSemverParts('1.2.10'), { epoch: 1, platform: 2, app: 10 });
    assert.equal(inferRequiredPlatformVersion('v1.2.0'), 2);
    assert.equal(inferRequiredPlatformVersion('1.1.0'), 1);
  });
});

describe('compareSemver', () => {
  it('orders platform bumps ahead of app bumps', () => {
    assert.ok(compareSemver('1.2.0', '1.1.0') > 0);
    assert.ok(compareSemver('1.1.5', '1.1.0') > 0);
    assert.equal(compareSemver('1.1.0', '1.1.0'), 0);
  });
});

describe('formatBlockedUpdateError', () => {
  it('names the GitHub release and required platform', () => {
    const msg = formatBlockedUpdateError({
      latestVersion: '1.2.0',
      requiredPlatformVersion: 2,
      installedPlatformVersion: 1,
      repo: 'potsolutions/config365-preview',
    });
    assert.match(msg, /Docker update required/);
    assert.match(msg, /platform v2/);
    assert.match(msg, /platform v1/);
    assert.match(msg, /github\.com\/potsolutions\/config365-preview\/releases\/tag\/v1\.2\.0/);
    assert.match(msg, /Software update only applies app/);
  });
});

describe('formatNoUpdateError', () => {
  it('includes the API URL and GitHub error', () => {
    const debug = emptySourceDebug('preview', 'potsolutions/config365-preview', false);
    debug.error = 'GitHub releases API 403';
    const msg = formatNoUpdateError(debug);
    assert.match(msg, /api\.github\.com\/repos\/potsolutions\/config365-preview\/releases\/latest/);
    assert.match(msg, /403/);
  });
});

describe('github URLs', () => {
  it('points at the public GitHub API and html release page', () => {
    assert.equal(
      githubReleasesLatestUrl('potsolutions/config365-preview'),
      'https://api.github.com/repos/potsolutions/config365-preview/releases/latest',
    );
    assert.equal(
      githubReleaseHtmlUrl('potsolutions/config365-preview', '1.2.0'),
      'https://github.com/potsolutions/config365-preview/releases/tag/v1.2.0',
    );
  });
});
