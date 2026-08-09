function Resolve-WingetExecutable {
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $dir = Get-ChildItem "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe" -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1
    if ($dir) {
        $exe = Join-Path $dir.FullName 'winget.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
}

function Get-WingetClientScriptPreamble {
    @'
function Resolve-WingetExecutable {
    $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $dir = Get-ChildItem "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe" -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1
    if ($dir) {
        $exe = Join-Path $dir.FullName 'winget.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
}
'@
}

function Get-WingetInstallScope {
    param([string]$RunAsAccount)
    if ($RunAsAccount -eq 'user') { 'user' } else { 'machine' }
}

function New-WingetUninstallScript {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [string]$RunAsAccount = 'system'
    )
    $scope = Get-WingetInstallScope -RunAsAccount $RunAsAccount
    $preamble = Get-WingetClientScriptPreamble
    return @"
$preamble
`$ErrorActionPreference = 'Stop'
`$winget = Resolve-WingetExecutable
if (-not `$winget) { throw 'winget not found' }

`$uninstallArgs = @(
    'uninstall',
    '--id', '$PackageId',
    '--exact',
    '--silent',
    '--scope', '$scope',
    '--accept-source-agreements'
)
& `$winget @uninstallArgs
if (`$LASTEXITCODE -ne 0) {
    throw "winget uninstall failed with exit code `$LASTEXITCODE."
}
"@
}
