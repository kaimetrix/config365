function Get-IntuneWinAppUtilPath {
    <#
    .SYNOPSIS
        Legacy resolver — returns Microsoft IntuneWinAppUtil.exe path when present.
        Prefer Get-IntuneWinPackager for OS-aware selection.
    #>
    $candidates = @(
        $env:INTUNE_WIN_APP_UTIL_PATH
        '/usr/local/share/config365/tools/IntuneWinAppUtil.exe'
        (Join-Path $PSScriptRoot '../../tools/IntuneWinAppUtil.exe')
        (Join-Path $PSScriptRoot '../tools/IntuneWinAppUtil.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    if ($candidates.Count -gt 0) {
        return $candidates[0]
    }

    throw @"
IntuneWinAppUtil.exe not found on this runner.
Expected at /usr/local/share/config365/tools/IntuneWinAppUtil.exe (Windows fallback).
On Linux, use the native intunewin CLI via Get-IntuneWinPackager.
"@
}
