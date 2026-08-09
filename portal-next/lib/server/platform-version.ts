import 'server-only';

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const INIT_PLATFORM = '/data/init-data/installed-platform.json';
const INIT_APP_VERSION = '/data/app/installed-version.json';
const APP_CURRENT = '/data/app/current/VERSION';
const BAKED_VERSION = '/app/../VERSION';

export interface InstalledPlatformInfo {
  platformVersion: number;
  imageTag?: string;
  installedAt?: string;
}

export function readInstalledPlatformVersion(): InstalledPlatformInfo {
  if (existsSync(INIT_PLATFORM)) {
    try {
      const json = JSON.parse(readFileSync(INIT_PLATFORM, 'utf-8')) as InstalledPlatformInfo;
      return {
        platformVersion: Number(json.platformVersion) || Number(process.env.CONFIG365_PLATFORM_VERSION) || 1,
        imageTag: json.imageTag,
        installedAt: json.installedAt,
      };
    } catch { /* fall through */ }
  }
  return {
    platformVersion: Number(process.env.CONFIG365_PLATFORM_VERSION) || 1,
  };
}

export function readInstalledAppVersion(): string {
  if (existsSync(INIT_APP_VERSION)) {
    try {
      const json = JSON.parse(readFileSync(INIT_APP_VERSION, 'utf-8')) as { appVersion?: string };
      if (json.appVersion) return json.appVersion;
    } catch { /* fall through */ }
  }
  if (existsSync(APP_CURRENT)) {
    try {
      return readFileSync(APP_CURRENT, 'utf-8').trim();
    } catch { /* fall through */ }
  }
  for (const p of ['/app/VERSION', join(process.cwd(), 'VERSION')]) {
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf-8').trim(); } catch { /* next */ }
    }
  }
  return '0.0.0';
}

export function resolveAppLayerRoot(): string | null {
  const currentPortal = '/data/app/current/portal/server.js';
  if (existsSync(currentPortal)) return '/data/app/current';
  return null;
}
