/** Generate install.ps1 content for Chocolatey / WinGet app packages. */

import type { InstallRunAsAccount } from '@/lib/group-definitions';

function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function wingetScope(runAs: InstallRunAsAccount): 'machine' | 'user' {
  return runAs === 'user' ? 'user' : 'machine';
}

/** Keep in sync with runner/scripts/common/Resolve-WingetExecutable.ps1 */
const WINGET_RESOLVER = `function Resolve-WingetExecutable {
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $dir = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe" -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1
    if ($dir) {
        $exe = Join-Path $dir.FullName 'winget.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
}`;

/** Append optional CLI tokens to an existing ArgumentList array in generated PowerShell. */
function appendExtraArgsBlock(arrayVar: string, extraArgs?: string): string {
  const trimmed = extraArgs?.trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/).map(t => `'${psQuote(t)}'`).join(', ');
  return `\n${arrayVar} += @(${tokens})\n`;
}

function buildNativeInstallScript(
  executable: string,
  label: string,
  baseArgs: string[],
  options?: { version?: string; extraArgs?: string },
  trailingBlock?: string,
): string {
  const arrayVar = '$installArgs';
  const argLines = baseArgs.map(a => `    '${psQuote(a)}'`).join('\n');
  const versionBlock = options?.version?.trim()
    ? `\n${arrayVar} += @('--version', '${psQuote(options.version.trim())}')\n`
    : '';
  const extraBlock = appendExtraArgsBlock(arrayVar, options?.extraArgs);
  const suffix = trailingBlock ? `\n${trailingBlock}` : '';

  return `$ErrorActionPreference = 'Stop'

${arrayVar} = @(
${argLines}
)${versionBlock}${extraBlock}
$process = Start-Process -FilePath '${psQuote(executable)}' -ArgumentList ${arrayVar} -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) {
    throw "${label} failed with exit code $($process.ExitCode)."
}${suffix}
`;
}

export function buildWingetInstallScript(
  packageId: string,
  options?: { version?: string; extraArgs?: string; runAsAccount?: InstallRunAsAccount },
): string {
  const runAs = options?.runAsAccount ?? 'system';
  const scope = wingetScope(runAs);
  const id = psQuote(packageId);
  const arrayVar = '$installArgs';
  const versionBlock = options?.version?.trim()
    ? `\n${arrayVar} += @('--version', '${psQuote(options.version.trim())}')\n`
    : '';
  const extraBlock = appendExtraArgsBlock(arrayVar, options?.extraArgs);

  // PS 5.1 (Intune) rejects a trailing comma before ')' in array literals — last element has no comma.
  return `${WINGET_RESOLVER}

$ErrorActionPreference = 'Stop'
$winget = Resolve-WingetExecutable
if (-not $winget) { throw 'winget not found' }

${arrayVar} = @(
    'install',
    '--id', '${id}',
    '--exact',
    '--silent',
    '--scope', '${scope}',
    '--accept-source-agreements'
)${versionBlock}${extraBlock}
& $winget @installArgs
if ($LASTEXITCODE -ne 0) {
    throw "winget install failed with exit code $LASTEXITCODE."
}
$listResult = & $winget list --id '${id}' --exact --scope ${scope} --accept-source-agreements 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or -not (Select-String -InputObject $listResult -Pattern '${id}' -SimpleMatch)) {
    throw "winget install finished but package '${id}' is not listed by winget."
}
`;
}

export function buildWingetUninstallScript(
  packageId: string,
  runAsAccount: InstallRunAsAccount = 'system',
): string {
  const id = psQuote(packageId);
  const scope = wingetScope(runAsAccount);
  return `${WINGET_RESOLVER}

$ErrorActionPreference = 'Stop'
$winget = Resolve-WingetExecutable
if (-not $winget) { throw 'winget not found' }

$uninstallArgs = @(
    'uninstall',
    '--id', '${id}',
    '--exact',
    '--silent',
    '--scope', '${scope}',
    '--accept-source-agreements'
)
& $winget @uninstallArgs
if ($LASTEXITCODE -ne 0) {
    throw "winget uninstall failed with exit code $LASTEXITCODE."
}
`;
}

export function buildChocolateyInstallScript(packageId: string, options?: { version?: string; extraArgs?: string }): string {
  return buildNativeInstallScript('choco.exe', 'chocolatey install', [
    'install',
    packageId,
    '-y',
    '--no-progress',
  ], options);
}
