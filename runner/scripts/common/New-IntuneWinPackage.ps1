function Write-PackLog {
    param([string]$Message)
    # Avoid Write-Host during pack — act_runner can block when the pts log pipe fills.
    [Console]::Error.WriteLine($Message)
}

function Invoke-IntuneWinPack {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackagerPath,
        [Parameter(Mandatory = $true)]
        [string]$SourceDir,
        [Parameter(Mandatory = $true)]
        [string]$OutputFile,
        [int]$TimeoutSec = 120
    )

    Write-PackLog "    intunewin pack starting (timeout ${TimeoutSec}s)..."
    Write-PackLog "      source: $SourceDir"
    Write-PackLog "      output: $OutputFile"

    $logDir = Split-Path -Parent $OutputFile
    $stdoutLog = Join-Path $logDir 'intunewin-stdout.log'
    $stderrLog = Join-Path $logDir 'intunewin-stderr.log'
    Remove-Item $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

    if ($IsLinux -or (-not $IsWindows -and -not $IsMacOS)) {
        # Shell-out via bash+timeout — avoids act_runner deadlocks from Start-Process / pipe capture.
        $shQuote = {
            param([string]$s)
            if ($s -match "'") { throw "Path contains single quote: $s" }
            return "'$s'"
        }
        $bashCmd = "timeout ${TimeoutSec}s $( & $shQuote $PackagerPath) pack $( & $shQuote $SourceDir) $( & $shQuote $OutputFile)"
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            bash -lc $bashCmd 1> $stdoutLog 2> $stderrLog
            $exit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevEap
        }
        if ($exit -eq 124) { throw "intunewin pack timed out after ${TimeoutSec}s" }
        if ($exit -ne 0) {
            $stderr = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { '' }
            throw "intunewin pack failed with exit code $exit. $stderr"
        }
    } else {
        $proc = Start-Process -FilePath $PackagerPath `
            -ArgumentList @('pack', $SourceDir, $OutputFile) `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -NoNewWindow -PassThru -Wait
        if ($proc.ExitCode -ne 0) {
            $stderr = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { '' }
            throw "intunewin pack failed with exit code $($proc.ExitCode). $stderr"
        }
    }

    if (Test-Path $stdoutLog) {
        Get-Content $stdoutLog -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_) { Write-PackLog "    $_" }
        }
    }
    if (-not (Test-Path -LiteralPath $OutputFile)) {
        throw "intunewin pack failed — output not created: $OutputFile"
    }
}

function New-IntuneWinPackage {
    <#
    .SYNOPSIS
        Package install.ps1 (and optional attachments) into install.intunewin.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallPs1Path,
        [string]$UninstallPs1Path,
        [Parameter(Mandatory = $true)]
        [string]$TmpDir
    )

    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {

    if (-not (Test-Path -LiteralPath $InstallPs1Path)) {
        throw "Install script not found: $InstallPs1Path"
    }

    $sourceDir = Join-Path $TmpDir 'source'
    $outputDir = Join-Path $TmpDir 'output'
    Write-PackLog "    Preparing source folder: $sourceDir"
    $packager  = Get-IntuneWinPackager
    Write-PackLog "    Packager resolved: $($packager.Kind) @ $($packager.Path)"

    New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

    Copy-Item -LiteralPath $InstallPs1Path -Destination (Join-Path $sourceDir 'install.ps1') -Force
    if ($UninstallPs1Path -and (Test-Path -LiteralPath $UninstallPs1Path)) {
        Copy-Item -LiteralPath $UninstallPs1Path -Destination (Join-Path $sourceDir 'uninstall.ps1') -Force
    }

    $attachDir = Join-Path (Split-Path -Parent $InstallPs1Path) 'attachments'
    if (Test-Path -LiteralPath $attachDir) {
        Write-PackLog "    Copying attachments from: $attachDir"
        Get-ChildItem -LiteralPath $attachDir -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $sourceDir $_.Name) -Force
            Write-PackLog "      + $($_.Name)"
        }
    }

    $intuneWinPath = Join-Path $outputDir 'install.intunewin'

    if ($packager.Kind -eq 'native-cli') {
        Write-PackLog "    Packaging with intunewin CLI..."
        Invoke-IntuneWinPack -PackagerPath $packager.Path -SourceDir $sourceDir -OutputFile $intuneWinPath
    } else {
        Write-PackLog "    Packaging with IntuneWinAppUtil.exe ($($packager.Path))..."
        $proc = Start-Process -FilePath $packager.Path `
            -ArgumentList "-c `"$sourceDir`" -s install.ps1 -o `"$outputDir`" -q" `
            -Wait -PassThru -NoNewWindow
        if ($proc.ExitCode -ne 0) {
            throw "IntuneWinAppUtil.exe exited with exit code $($proc.ExitCode)"
        }
    }

    if (-not (Test-Path -LiteralPath $intuneWinPath)) {
        throw ".intunewin file not created at: $intuneWinPath"
    }

    Write-PackLog "    Package created: $intuneWinPath ($((Get-Item -LiteralPath $intuneWinPath).Length) bytes)"
    return $intuneWinPath
    } finally {
        $ProgressPreference = $prevProgress
    }
}
