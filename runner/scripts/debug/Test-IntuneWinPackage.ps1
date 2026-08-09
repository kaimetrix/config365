# Smoke test: native intunewin CLI packaging on Linux runner
$ErrorActionPreference = 'Stop'

$common = if (Test-Path '/tmp/common') { '/tmp/common' } else { Join-Path $PSScriptRoot '..\common' }
. (Join-Path $common 'Get-IntuneWinPackager.ps1')
. (Join-Path $common 'New-IntuneWinPackage.ps1')

$tmpdir = Join-Path ([System.IO.Path]::GetTempPath()) ("intunewin-smoke-" + [guid]::NewGuid().ToString('n'))
$installPs1 = Join-Path $tmpdir 'install.ps1'
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null
Set-Content -Path $installPs1 -Value "Write-Host 'smoke test'"

$packager = Get-IntuneWinPackager
Write-Host "Packager: $($packager.Kind) @ $($packager.Path)"

$pkgTmp = Join-Path $tmpdir 'pkg'
New-Item -ItemType Directory -Path $pkgTmp -Force | Out-Null
$intuneWin = New-IntuneWinPackage -InstallPs1Path $installPs1 -TmpDir $pkgTmp
Write-Host "Created: $intuneWin"

Add-Type -Assembly System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($intuneWin)
try {
    $entries = $zip.Entries | ForEach-Object { $_.FullName }
    Write-Host "Entries: $($entries -join ', ')"
    if (-not ($entries | Where-Object { $_ -like '*Metadata/Detection.xml' })) {
        throw 'Detection.xml missing from package'
    }
} finally {
    $zip.Dispose()
}

Write-Host 'SMOKE_OK'
