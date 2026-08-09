<#
.SYNOPSIS
    Shared IRM/OME configuration property lists and helpers for backup and deploy.
#>

$script:ExchangeMessageEncryptionCmdletExcludeParameters = @(
    'Identity', 'Confirm', 'WhatIf', 'DomainController', 'Force',
    'ErrorAction', 'Verbose', 'Debug', 'WarningAction', 'InformationAction',
    'OutVariable', 'OutBuffer', 'PipelineVariable', 'WarningVariable',
    'InformationVariable', 'ErrorVariable'
)

$script:IrmConfigurationRelativePath = 'exchange/irm-configuration'
$script:OmeConfigurationRelativePath = 'exchange/ome-configuration'
$script:OmeIdentityBackupFile         = 'exchange/ome-configuration/_policy-identity.json'
$script:AipServiceRelativePath        = 'exchange/aip-service'
$script:AipServiceConfigurationRelativePath = 'exchange/aip-service/configuration'
$script:AipApplyLicensingLocationFile = 'exchange/aip-service/_apply-licensing-location-to-irm.json'

$script:AipServiceConfigurationBackupExcludeProperties = @(
    'Keys', 'Templates', 'SuperUsers', 'AdminRoleMembers', 'DevicePlatformState'
)

function Ensure-AipServiceModule {
    if (-not (Get-Command Import-AipServiceModuleSafe -ErrorAction SilentlyContinue)) {
        if (-not (Get-Module -ListAvailable -Name AIPService)) {
            Install-Module -Name AIPService -Force -AllowClobber -Scope CurrentUser -Confirm:$false
        }
        try {
            Import-Module AIPService -ErrorAction Stop
            return $true
        }
        catch {
            Write-Host "##[warning]AIPService module could not be loaded: $($_.Exception.Message)"
            return $false
        }
    }
    return Import-AipServiceModuleSafe
}

function Get-AipServiceEnabledState {
    if (-not (Get-Command Get-AipService -ErrorAction SilentlyContinue)) {
        throw 'Get-AipService cmdlet not available'
    }

    $result = Get-AipService -ErrorAction Stop
    if ($null -eq $result) { return $false }
    if ($result -is [bool]) { return $result }
    if ($result -is [string]) { return ($result -match 'Enabled|Active') }

    foreach ($prop in @('Status', 'FunctionalState', 'Enabled', 'ActivationStatus')) {
        $value = Get-ExchangeMessageEncryptionPropertyValue -Object $result -PropertyName $prop
        if ($null -eq $value) { continue }
        if ($value -is [bool]) { return $value }
        if ("$value" -match 'Enabled|Active') { return $true }
        if ("$value" -match 'Disabled|Deactivated|Inactive') { return $false }
    }

    return $false
}

function Select-AipServiceConfigurationBackupProperties {
    param([Parameter(Mandatory = $true)]$SourceObject)

    $backup = @{}
    foreach ($prop in $SourceObject.PSObject.Properties) {
        if ($prop.Name -in $script:AipServiceConfigurationBackupExcludeProperties) { continue }

        $value = $prop.Value
        if ($null -eq $value) { continue }
        if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) { continue }
        if ($value -is [System.Management.Automation.PSCustomObject]) { continue }

        if ($value -is [System.Collections.IEnumerable] -and $value -isnot [string]) {
            $items = @($value)
            if ($items.Count -eq 0) { continue }
            if ($items | Where-Object { $_ -isnot [string] -and $_ -isnot [bool] -and $_ -isnot [int] -and $_ -isnot [long] -and $_ -isnot [double] }) {
                continue
            }
        }

        $backup[$prop.Name] = $value
    }
    return $backup
}

function Get-ExchangeMessageEncryptionSetParameters {
    param([Parameter(Mandatory = $true)][string]$CmdletName)

    if (-not (Get-Command $CmdletName -ErrorAction SilentlyContinue)) {
        return @()
    }

    $cmd = Get-Command $CmdletName
    return @($cmd.Parameters.Keys |
        Where-Object { $_ -notin $script:ExchangeMessageEncryptionCmdletExcludeParameters } |
        Sort-Object)
}

function Get-IrmConfigurationDeployableProperties {
    return @(Get-ExchangeMessageEncryptionSetParameters -CmdletName 'Set-IRMConfiguration')
}

function Get-OmeConfigurationDeployableProperties {
    return @(Get-ExchangeMessageEncryptionSetParameters -CmdletName 'Set-OMEConfiguration')
}

function Get-ExchangeMessageEncryptionPropertyValue {
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

function Select-ExchangeMessageEncryptionBackupProperties {
    param(
        [Parameter(Mandatory = $true)]$SourceObject,
        [Parameter(Mandatory = $true)][string[]]$DeployableProperties
    )

    $backup = @{}
    foreach ($prop in $DeployableProperties) {
        $value = Get-ExchangeMessageEncryptionPropertyValue -Object $SourceObject -PropertyName $prop
        if ($null -eq $value) { continue }
        if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) { continue }
        if ($value -is [System.Collections.ICollection] -and $value.Count -eq 0) { continue }
        $backup[$prop] = $value
    }
    return $backup
}

function Resolve-OmeConfigurationIdentity {
    param(
        [Parameter(Mandatory = $true)][array]$OmeConfigurations,
        [string]$PreferredIdentity = 'OME Configuration'
    )

    $preferred = @($OmeConfigurations | Where-Object { "$($_.Identity)" -eq $PreferredIdentity } | Select-Object -First 1)[0]
    if ($preferred) { return "$($preferred.Identity)" }
    if ($OmeConfigurations.Count -gt 0) { return "$($OmeConfigurations[0].Identity)" }
    return $PreferredIdentity
}

function Convert-OmeConfigurationRestRow {
    param([Parameter(Mandatory = $true)]$Row)

    if ($Row -is [System.Collections.IDictionary]) {
        $props = @{}
        foreach ($key in $Row.Keys) {
            if ("$key" -like '@*' -or "$key" -like '*@odata*') { continue }
            $props[$key] = $Row[$key]
        }
        return [PSCustomObject]$props
    }

    return [PSCustomObject]@{
        TemplateName              = $Row.TemplateName
        Image                     = $Row.Image
        ImageUrl                  = $Row.ImageUrl
        EmailText                 = $Row.EmailText
        PortalText                = $Row.PortalText
        DisclaimerText            = $Row.DisclaimerText
        BackgroundColor           = $Row.BackgroundColor
        IntroductionText          = $Row.IntroductionText
        ReadButtonText            = $Row.ReadButtonText
        OTPEnabled                = $Row.OTPEnabled
        SocialIdSignIn            = $Row.SocialIdSignIn
        ExternalMailExpiryInterval = $Row.ExternalMailExpiryInterval
        PrivacyStatementUrl       = $Row.PrivacyStatementUrl
        Identity                  = $Row.Identity
        IsValid                   = $Row.IsValid
    }
}

function Get-OmeConfigurationObjects {
    <#
    .SYNOPSIS
        Returns OME configuration objects via cmdlet, with adminApi REST fallback.
        Get-IRMConfiguration in the same session can break the EXO module cmdlet path;
        REST remains reliable (see Invoke-ExoAdminCmdletRest).
    #>
    param(
        [string]$Identity,
        [switch]$PreferRest
    )

    if (-not $PreferRest -and (Get-Command Get-OMEConfiguration -ErrorAction SilentlyContinue)) {
        try {
            if ($Identity) {
                return @(Get-OMEConfiguration -Identity $Identity -ErrorAction Stop)
            }
            return @(Get-OMEConfiguration -ErrorAction Stop)
        }
        catch {
            Write-Host "##[warning]Get-OMEConfiguration cmdlet failed: $($_.Exception.Message) — trying adminApi REST..."
        }
    }

    if (-not (Get-Command Invoke-ExoAdminCmdletRest -ErrorAction SilentlyContinue)) {
        throw 'Invoke-ExoAdminCmdletRest is not available; connect Exchange Online first.'
    }

    $restParams = @{}
    if ($Identity) { $restParams.Identity = $Identity }

    foreach ($tenantKey in @($script:ExoDelegatedOrganization, $script:ExoDelegatedTenantId)) {
        if (-not $tenantKey) { continue }
        try {
            $json = Invoke-ExoAdminCmdletRest -CmdletName 'Get-OMEConfiguration' -Parameters $restParams -TenantKey $tenantKey
            $rows = @($json.value | Where-Object { $_ })
            if ($rows.Count -gt 0) {
                return @($rows | ForEach-Object { Convert-OmeConfigurationRestRow -Row $_ })
            }
        }
        catch {
            Write-Host "##[warning]REST Get-OMEConfiguration ($tenantKey) failed: $($_.Exception.Message)"
        }
    }

    throw 'Could not retrieve OME configuration via cmdlet or adminApi REST.'
}
