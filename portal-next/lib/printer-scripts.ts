/** Generate install/detection/uninstall.ps1 for printer Win32 packages. */

import type { CustomScriptMode, PrinterPathEntry, PrinterRole } from '@/lib/group-definitions';

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Shared helpers — match printers by UNC port (PortName), not display name. */
const PRINTER_UNC_HELPERS = `function Get-NormalizedUncPath {
    param([string]$Path)
    if (-not $Path) { return '' }
    ($Path.Trim().TrimEnd("\\") -replace '\\\\+', [char]92)
}

function Test-PrinterConnectionExists {
    param([string]$ConnectionPath)
    $normalized = Get-NormalizedUncPath -Path $ConnectionPath
    if (-not $normalized) { return $false }
    foreach ($printer in @(Get-Printer -ErrorAction SilentlyContinue)) {
        if (-not $printer.PortName) { continue }
        $port = Get-NormalizedUncPath -Path $printer.PortName
        if ($port -ieq $normalized) { return $true }
    }
    return $false
}

function Remove-PrinterByConnectionPath {
    param([string]$ConnectionPath)
    $normalized = Get-NormalizedUncPath -Path $ConnectionPath
    if (-not $normalized) { return }
    foreach ($printer in @(Get-Printer -ErrorAction SilentlyContinue)) {
        if (-not $printer.PortName) { continue }
        $port = Get-NormalizedUncPath -Path $printer.PortName
        if ($port -ieq $normalized) {
            Remove-Printer -Name $printer.Name -ErrorAction SilentlyContinue
        }
    }
}
`;

function buildAutoAddBlock(printers: PrinterPathEntry[]): string {
  const valid = printers.filter(p => p.path.trim());
  if (valid.length === 0) return '';

  const entries = valid.map(p => {
    const path = psQuote(p.path.trim());
    const displayName = p.displayName?.trim();
    if (displayName) {
      return `    @{ Path = '${path}'; DisplayName = '${psQuote(displayName)}' }`;
    }
    return `    @{ Path = '${path}'; DisplayName = $null }`;
  }).join('\n');

  return `# Add network printers
$printers = @(
${entries}
)
foreach ($p in $printers) {
    $params = @{ ConnectionName = $p.Path }
    if ($p.DisplayName) { $params['DisplayName'] = $p.DisplayName }
    Add-Printer @params
}
`;
}

function buildCustomBlock(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) return '';
  return `${trimmed}\n`;
}

function buildDriverMarkerBlock(packageId: string): string {
  const id = psQuote(packageId);
  return `# Record successful driver deployment
$markerDir = Join-Path $env:ProgramData 'Config365\\printers'
New-Item -ItemType Directory -Path $markerDir -Force | Out-Null
Set-Content -Path (Join-Path $markerDir '${id}-driver.ok') -Value (Get-Date -Format o) -Force
`;
}

export const DEFAULT_DRIVER_INSTALL_SCRIPT = `# Install driver packages from attachments folder
Get-ChildItem -Path $PSScriptRoot -Filter *.inf -File -ErrorAction SilentlyContinue | ForEach-Object {
    pnputil.exe /add-driver $_.FullName /install | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "pnputil failed for $($_.Name) with exit code $LASTEXITCODE."
    }
}
`;

/** Single-package install (legacy / non-split). */
export function buildPrinterInstallScript(opts: {
  printers: PrinterPathEntry[];
  customScript?: string;
  customScriptMode: CustomScriptMode;
}): string {
  const mode = opts.customScriptMode ?? 'none';
  const custom = buildCustomBlock(opts.customScript ?? '');
  const autoAdd = buildAutoAddBlock(opts.printers);

  let body = '';
  if (mode === 'only') {
    body = custom || '# No install steps configured\n';
  } else {
    const parts: string[] = [];
    if (mode === 'before' && custom) parts.push(custom);
    if (autoAdd) parts.push(autoAdd);
    if (mode === 'after' && custom) parts.push(custom);
    body = parts.join('\n') || autoAdd;
  }

  return `$ErrorActionPreference = 'Stop'

${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Driver package — system context, installs drivers from attachments / custom script. */
export function buildPrinterDriverInstallScript(opts: {
  packageId: string;
  customScript?: string;
  customScriptMode?: CustomScriptMode;
}): string {
  const mode = opts.customScriptMode ?? 'only';
  const custom = buildCustomBlock(opts.customScript ?? DEFAULT_DRIVER_INSTALL_SCRIPT);
  const marker = buildDriverMarkerBlock(opts.packageId);

  let body = '';
  if (mode === 'only') {
    body = `${custom}${marker}`;
  } else {
    const parts: string[] = [];
    if (mode === 'before' && custom) parts.push(custom);
    if (mode === 'after') {
      if (custom) parts.push(custom);
      parts.push(marker);
    } else {
      parts.push(marker);
    }
    body = parts.join('\n');
  }

  return `$ErrorActionPreference = 'Stop'

${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Connect package — user context, adds printer connections only. */
export function buildPrinterConnectInstallScript(opts: {
  printers: PrinterPathEntry[];
  customScript?: string;
  customScriptMode?: CustomScriptMode;
}): string {
  const mode = opts.customScriptMode ?? 'none';
  const custom = buildCustomBlock(opts.customScript ?? '');
  const autoAdd = buildAutoAddBlock(opts.printers);

  let body = '';
  if (mode === 'only') {
    body = custom || autoAdd || '# No connect steps configured\n';
  } else {
    const parts: string[] = [];
    if (mode === 'before' && custom) parts.push(custom);
    if (autoAdd) parts.push(autoAdd);
    if (mode === 'after' && custom) parts.push(custom);
    body = parts.join('\n') || autoAdd;
  }

  return `$ErrorActionPreference = 'Stop'

${body}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function buildPrinterDetectionScript(opts: {
  printers: PrinterPathEntry[];
  customDetectionScript?: string;
}): string {
  const custom = opts.customDetectionScript?.trim();
  if (custom) return custom.endsWith('\n') ? custom : `${custom}\n`;

  const paths = opts.printers.filter(p => p.path.trim()).map(p => p.path.trim());
  if (paths.length === 0) {
    return `# Detection — exit 0 = detected, exit 1 = not detected
Write-Output "No printers configured"
exit 1
`;
  }

  const pathLines = paths.map(p => `    '${psQuote(p)}'`).join('\n');
  return `# Detection — exit 0 = all printer connections present, exit 1 = missing
${PRINTER_UNC_HELPERS}
$requiredPaths = @(
${pathLines}
)
foreach ($path in $requiredPaths) {
    if (-not (Test-PrinterConnectionExists -ConnectionPath $path)) {
        Write-Output "Missing printer connection: $path"
        exit 1
    }
}
Write-Output "All printer connections detected"
exit 0
`;
}

export function buildPrinterDriverDetectionScript(opts: {
  packageId: string;
  customDetectionScript?: string;
}): string {
  const custom = opts.customDetectionScript?.trim();
  if (custom) return custom.endsWith('\n') ? custom : `${custom}\n`;

  const id = psQuote(opts.packageId);
  return `# Detection — exit 0 = driver package installed, exit 1 = not detected
$marker = Join-Path (Join-Path $env:ProgramData 'Config365\\printers') '${id}-driver.ok'
if (Test-Path -LiteralPath $marker) {
    Write-Output "Driver marker present"
    exit 0
}
Write-Output "Driver marker missing: $marker"
exit 1
`;
}

export function buildPrinterUninstallScript(printers: PrinterPathEntry[]): string {
  const paths = printers.filter(p => p.path.trim()).map(p => p.path.trim());
  if (paths.length === 0) {
    return `$ErrorActionPreference = 'Stop'
exit 0
`;
  }

  const pathLines = paths.map(p => `    '${psQuote(p)}'`).join('\n');
  return `$ErrorActionPreference = 'Stop'

${PRINTER_UNC_HELPERS}
$connectionPaths = @(
${pathLines}
)
foreach ($path in $connectionPaths) {
    Remove-PrinterByConnectionPath -ConnectionPath $path
}
`;
}

export function buildPrinterDriverUninstallScript(packageId: string): string {
  const id = psQuote(packageId);
  return `$ErrorActionPreference = 'Stop'

$marker = Join-Path (Join-Path $env:ProgramData 'Config365\\printers') '${id}-driver.ok'
if (Test-Path -LiteralPath $marker) {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
exit 0
`;
}

/** Split driver in connect mode — system-context Add-Printer with before/after script. */
export function buildPrinterDriverConnectInstallScript(opts: {
  printers: PrinterPathEntry[];
  customScript?: string;
  customScriptMode?: CustomScriptMode;
}): string {
  return buildPrinterConnectInstallScript(opts);
}

export function buildPrinterDriverConnectDetectionScript(opts: {
  printers: PrinterPathEntry[];
  customDetectionScript?: string;
}): string {
  return buildPrinterDetectionScript(opts);
}

export function buildPrinterDriverConnectUninstallScript(printers: PrinterPathEntry[]): string {
  return buildPrinterUninstallScript(printers);
}

export function printerPackageRoleSuffix(role: PrinterRole): string {
  return role === 'driver' ? 'Driver' : 'Connect';
}
