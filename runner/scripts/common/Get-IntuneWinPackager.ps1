function Get-IntuneWinPackager {
    <#
    .SYNOPSIS
        Resolve the active Intune Win32 packager for this runner OS.
    .OUTPUTS
        Hashtable with Kind ('native-cli' | 'microsoft-exe') and Path.
    #>
    if ($env:INTUNEWIN_PACKAGER_PATH -and (Test-Path -LiteralPath $env:INTUNEWIN_PACKAGER_PATH)) {
        $custom = $env:INTUNEWIN_PACKAGER_PATH
        if ($custom -match '\.exe$') {
            return @{ Kind = 'microsoft-exe'; Path = $custom }
        }
        return @{ Kind = 'native-cli'; Path = $custom }
    }

    $nativeCandidates = @(
        $env:INTUNEWIN_CLI_PATH
        '/usr/local/share/config365/tools/intunewin'
        (Join-Path $PSScriptRoot '../../tools/intunewin')
    ) | Where-Object { $_ }

    $exeCandidates = @(
        $env:INTUNE_WIN_APP_UTIL_PATH
        '/usr/local/share/config365/tools/IntuneWinAppUtil.exe'
        (Join-Path $PSScriptRoot '../../tools/IntuneWinAppUtil.exe')
        (Join-Path $PSScriptRoot '../tools/IntuneWinAppUtil.exe')
    ) | Where-Object { $_ }

    $native = $nativeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $exe    = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($IsLinux -or (-not $IsWindows -and -not $IsMacOS)) {
        if ($native) { return @{ Kind = 'native-cli'; Path = $native } }
        throw @"
Intune Win32 packager not found on Linux runner.
Expected native CLI at /usr/local/share/config365/tools/intunewin.
Ensure the container image includes intunewin or set INTUNEWIN_PACKAGER_PATH.
"@
    }

    if ($exe) { return @{ Kind = 'microsoft-exe'; Path = $exe } }
    if ($native) { return @{ Kind = 'native-cli'; Path = $native } }

    throw @"
Intune Win32 packager not found.
Expected IntuneWinAppUtil.exe or intunewin CLI under /usr/local/share/config365/tools/.
Set INTUNEWIN_PACKAGER_PATH to override.
"@
}
