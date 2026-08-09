# Debug helper: pack a single install.ps1 and report timing (no Graph).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallPs1Path,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
$common     = Join-Path $scriptRoot '..\common'

. (Join-Path $common 'Get-IntuneWinPackager.ps1')
. (Join-Path $common 'New-IntuneWinPackage.ps1')

function Write-DebugLog {
    param([string]$Message)
    Write-Host $Message
}

if (-not (Test-Path -LiteralPath $InstallPs1Path)) {
    throw "install.ps1 not found: $InstallPs1Path"
}

Write-DebugLog "=== WinGet pack debug ==="
Write-DebugLog "InstallPs1: $InstallPs1Path"
Write-DebugLog "Size: $((Get-Item -LiteralPath $InstallPs1Path).Length) bytes"

$packager = Get-IntuneWinPackager
Write-DebugLog "Packager: $($packager.Kind) @ $($packager.Path)"

$pkgTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("winget-pack-debug-" + [guid]::NewGuid().ToString('n'))
Write-DebugLog "TmpDir: $pkgTmp"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$intuneWin = New-IntuneWinPackage -InstallPs1Path $InstallPs1Path -TmpDir $pkgTmp
$sw.Stop()

Write-DebugLog "Pack elapsed: $($sw.Elapsed.TotalSeconds)s"
Write-DebugLog "Output: $intuneWin ($((Get-Item -LiteralPath $intuneWin).Length) bytes)"

if (-not ('System.IO.Compression.ZipFile' -as [type])) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($intuneWin)
try {
    $entries = @($zip.Entries | ForEach-Object { $_.FullName })
    Write-DebugLog "Zip entries: $($entries -join ', ')"
    if (-not ($entries | Where-Object { $_ -like '*Metadata/Detection.xml' })) {
        throw 'Detection.xml missing from .intunewin'
    }
} finally {
    $zip.Dispose()
}

$result = @{
    Status       = 'OK'
    InstallPs1   = $InstallPs1Path
    IntuneWin    = $intuneWin
    SizeBytes    = (Get-Item -LiteralPath $intuneWin).Length
    ElapsedSec   = $sw.Elapsed.TotalSeconds
    PackagerKind = $packager.Kind
    PackagerPath = $packager.Path
    Entries      = $entries
}

Write-DebugLog 'PACK_DEBUG_OK'

if ($OutputPath) {
    $result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8
    Write-DebugLog "Wrote: $OutputPath"
}

return $result
