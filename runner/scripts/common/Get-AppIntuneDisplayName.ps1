function Resolve-IntuneAppDisplayName {
    param(
        [PSCustomObject]$Config,
        [string]$PackageId,
        [string]$Prefix
    )
    if ($Config.PSObject.Properties.Name -contains 'intuneDisplayName') {
        $custom = [string]$Config.intuneDisplayName
        if ($custom.Trim()) { return $custom.Trim() }
    }
    $displayName = if ($Config.displayName) { [string]$Config.displayName.Trim() } else { $PackageId }
    return "$Prefix - $displayName"
}

function Get-LegacyIntuneAppDisplayName {
    param(
        [PSCustomObject]$Config,
        [string]$PackageId,
        [string]$Prefix
    )
    $displayName = if ($Config.displayName) { [string]$Config.displayName.Trim() } else { $PackageId }
    return "$Prefix - $displayName"
}

function Find-ExistingWin32AppForConfig {
    param(
        [PSCustomObject]$Config,
        [string]$PackageId,
        [string]$Prefix,
        [scriptblock]$GetExisting
    )
    $appName = Resolve-IntuneAppDisplayName -Config $Config -PackageId $PackageId -Prefix $Prefix
    $existing = & $GetExisting $appName
    if ($existing) { return @{ Existing = $existing; AppName = $appName } }

    $legacy = Get-LegacyIntuneAppDisplayName -Config $Config -PackageId $PackageId -Prefix $Prefix
    if ($legacy -ne $appName) {
        $existing = & $GetExisting $legacy
        if ($existing) { return @{ Existing = $existing; AppName = $appName; WasLegacyName = $legacy } }
    }

    return @{ Existing = $null; AppName = $appName }
}
