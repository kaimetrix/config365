export type AppPkgManager = 'chocolatey' | 'winget' | 'custom' | 'printer';

const PREFIX: Record<AppPkgManager, string> = {
  winget: 'WinGet',
  chocolatey: 'Chocolatey',
  custom: 'Custom',
  printer: 'Printer',
};

export function defaultIntuneDisplayName(pkgMgr: AppPkgManager, displayName: string): string {
  return `${PREFIX[pkgMgr]} - ${displayName}`;
}

export function defaultPrinterSplitIntuneDisplayName(displayName: string, role: 'driver' | 'connect'): string {
  const suffix = role === 'driver' ? 'Driver' : 'Connect';
  return `Printer - ${displayName} (${suffix})`;
}

export function resolveIntuneDisplayName(
  pkgMgr: AppPkgManager,
  config: { displayName?: string; intuneDisplayName?: string; packageId?: string },
  packageId: string,
): string {
  if (config.intuneDisplayName?.trim()) return config.intuneDisplayName.trim();
  const displayName = config.displayName?.trim() || packageId;
  return defaultIntuneDisplayName(pkgMgr, displayName);
}
