<#
.SYNOPSIS
    Shared SharePoint Online tenant (Get/Set-PnPTenant) property helpers for backup and deploy.
#>

$script:SharePointTenantConfigurationRelativePath = 'sharepoint-settings/tenant-configuration'

$script:SharePointTenantCmdletExcludeParameters = @(
    'Identity', 'Confirm', 'WhatIf', 'Force',
    'ErrorAction', 'Verbose', 'Debug', 'WarningAction', 'InformationAction',
    'OutVariable', 'OutBuffer', 'PipelineVariable', 'WarningVariable',
    'InformationVariable', 'ErrorVariable'
)

function Import-PnPModuleSafe {
    if (Get-Module -Name PnP.PowerShell -ErrorAction SilentlyContinue) {
        return $true
    }

    if (-not (Get-Module -ListAvailable -Name PnP.PowerShell)) {
        Write-Host '##[warning]PnP.PowerShell module is not installed'
        return $false
    }

    try {
        Import-Module PnP.PowerShell -ErrorAction Stop
        return $true
    }
    catch {
        Write-Host "##[warning]PnP.PowerShell could not be loaded: $($_.Exception.Message)"
        return $false
    }
}

function Get-SharePointTenantPrefixFromDomain {
    param([string]$Domain)

    if ([string]::IsNullOrWhiteSpace($Domain)) { return $null }
    $normalized = $Domain.Trim().ToLowerInvariant()
    if ($normalized -match '^([a-z0-9-]+)\.onmicrosoft\.(com|us|de)$') {
        return $Matches[1]
    }
    if ($normalized -match '^([a-z0-9-]+)\.sharepoint\.com$') {
        return $Matches[1]
    }
    $first = ($normalized -split '\.')[0]
    if ($first) { return $first }
    return $null
}

function Get-SharePointAdminUrlFromPrefix {
    param([Parameter(Mandatory = $true)][string]$TenantPrefix)

    return "https://$TenantPrefix-admin.sharepoint.com"
}

function Get-SharePointTenantSetCmdletName {
    if (Get-Command Set-PnPTenant -ErrorAction SilentlyContinue) { return 'Set-PnPTenant' }
    if (Get-Command Set-SPOTenant -ErrorAction SilentlyContinue) { return 'Set-SPOTenant' }
    return $null
}

function Get-SharePointTenantGetCmdletName {
    if (Get-Command Get-PnPTenant -ErrorAction SilentlyContinue) { return 'Get-PnPTenant' }
    if (Get-Command Get-SPOTenant -ErrorAction SilentlyContinue) { return 'Get-SPOTenant' }
    return $null
}

function Get-SharePointTenantDeployableProperties {
    $cmdletName = Get-SharePointTenantSetCmdletName
    if (-not $cmdletName) { return @() }

    $cmd = Get-Command $cmdletName
    return @($cmd.Parameters.Keys |
        Where-Object { $_ -notin $script:SharePointTenantCmdletExcludeParameters } |
        Sort-Object)
}

function Get-SharePointTenantPropertyValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$PropertyName
    )

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($PropertyName)) {
        return $Object[$PropertyName]
    }
    $prop = $Object.PSObject.Properties[$PropertyName]
    if ($prop) { return $prop.Value }
    return $null
}

function Test-SharePointTenantBackupValue {
    param($Value)

    if ($null -eq $Value) { return $false }
    if ($Value -is [string] -and [string]::IsNullOrWhiteSpace($Value)) { return $false }
    if ($Value -is [System.Collections.ICollection] -and $Value.Count -eq 0) { return $false }
    if ($Value -is [System.Management.Automation.PSCustomObject]) { return $false }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        foreach ($item in @($Value)) {
            if ($item -is [System.Management.Automation.PSCustomObject]) { return $false }
            if ($item -is [System.Collections.IDictionary]) { return $false }
        }
    }
    return $true
}

function Select-SharePointTenantBackupProperties {
    param(
        [Parameter(Mandatory = $true)]$SourceObject,
        [Parameter(Mandatory = $true)][string[]]$DeployableProperties
    )

    $backup = @{}
    foreach ($prop in $DeployableProperties) {
        $value = Get-SharePointTenantPropertyValue -Object $SourceObject -PropertyName $prop
        if (-not (Test-SharePointTenantBackupValue -Value $value)) { continue }
        $backup[$prop] = $value
    }
    return $backup
}

function Get-SharePointTenantConfigurationObject {
    $getCmdlet = Get-SharePointTenantGetCmdletName
    if (-not $getCmdlet) {
        throw 'Get-PnPTenant / Get-SPOTenant is not available. Connect to SharePoint Online first.'
    }
    return & $getCmdlet -ErrorAction Stop
}

function Set-SharePointTenantConfiguration {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Parameters
    )

    $setCmdlet = Get-SharePointTenantSetCmdletName
    if (-not $setCmdlet) {
        throw 'Set-PnPTenant / Set-SPOTenant is not available. Connect to SharePoint Online first.'
    }
    if ($Parameters.Count -eq 0) { return }

    & $setCmdlet @Parameters -ErrorAction Stop
}

function ConvertTo-SharePointTenantBackupJsonValue {
    param($Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Guid]) { return "$Value" }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object {
            if ($_ -is [System.Guid]) { "$_" }
            else { $_ }
        })
    }
    return $Value
}
