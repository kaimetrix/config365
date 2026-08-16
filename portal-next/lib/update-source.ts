/** Pure helpers for the in-container Software update check (no I/O). */

export type UpdateChannel = 'preview' | 'ga';

export interface UpdateSourceDebug {
  channel: UpdateChannel;
  repo: string;
  releasesUrl: string;
  htmlUrl: string;
  authenticated: boolean;
  httpStatus?: number;
  rateLimitRemaining?: string;
  rateLimitLimit?: string;
  error?: string;
}

export function repoForChannel(channel: UpdateChannel): string {
  return channel === 'ga' ? 'potsolutions/config365' : 'potsolutions/config365-preview';
}

export function githubReleasesLatestUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

export function githubReleaseTagUrl(repo: string, version: string): string {
  return `https://api.github.com/repos/${repo}/releases/tags/v${version.replace(/^v/, '')}`;
}

export function githubRepoHtmlUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

export function githubReleaseHtmlUrl(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/tag/v${version.replace(/^v/, '')}`;
}

export function parseSemverParts(version: string): { epoch: number; platform: number; app: number } {
  const p = version.replace(/^v/, '').split('.').map(n => Number(n) || 0);
  return { epoch: p[0] ?? 0, platform: p[1] ?? 0, app: p[2] ?? 0 };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (const key of ['epoch', 'platform', 'app'] as const) {
    const d = pa[key] - pb[key];
    if (d !== 0) return d;
  }
  return 0;
}

/** VERSION is EPOCH.PLATFORM.APP — the 2nd digit is the required Docker platform. */
export function inferRequiredPlatformVersion(version: string): number {
  return parseSemverParts(version).platform;
}

export function formatBlockedUpdateError(opts: {
  latestVersion: string;
  requiredPlatformVersion: number;
  installedPlatformVersion: number;
  repo: string;
}): string {
  const tag = opts.latestVersion.replace(/^v/, '');
  return (
    `Docker update required: v${tag} needs platform v${opts.requiredPlatformVersion} ` +
    `(this instance is platform v${opts.installedPlatformVersion}). ` +
    `Software update only applies app (3rd-digit) releases. ` +
    `Release: ${githubReleaseHtmlUrl(opts.repo, tag)}`
  );
}

export function formatNoUpdateError(debug: UpdateSourceDebug): string {
  if (debug.error) {
    return `No update available. Last check of ${debug.releasesUrl} failed: ${debug.error}`;
  }
  return `No update available (checked ${debug.releasesUrl}).`;
}

export function emptySourceDebug(channel: UpdateChannel, repo: string, authenticated: boolean): UpdateSourceDebug {
  return {
    channel,
    repo,
    releasesUrl: githubReleasesLatestUrl(repo),
    htmlUrl: githubRepoHtmlUrl(repo),
    authenticated,
  };
}
