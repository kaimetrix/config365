<#
.SYNOPSIS
    Shared helpers for Information Protection backup, deploy, and initialization scripts.
#>

$script:GroupUnifiedDirectoryTemplateId = '62375ab9-6b52-47ed-826b-58e47e0e304b'
$script:DefaultLabelContentTypes = 'File, Email, Site, UnifiedGroup'
$script:ExtendedLabelContentTypes = 'File, Email, Site, UnifiedGroup, Teamwork, PurviewAssets, SchematizedData'

function Test-IsManagedInformationProtectionLabel {
    param($Label)

    if ($null -eq $Label) { return $false }
    if ($Label.ReadOnly -eq $true) { return $false }
    if ($Label.Immutable -eq $true) { return $false }
    if ($Label.Creator -and "$($Label.Creator)" -match 'Microsoft|Office365') { return $false }
    if ($Label.Mode -eq 'PendingDeletion') { return $false }
    return $true
}

function Test-LabelIsActiveForDeploy {
    param($Label)

    if ($null -eq $Label) { return $false }
    if ($Label.Mode -eq 'PendingDeletion') { return $false }
    return $true
}

function Add-InformationProtectionLabelScopeParameters {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Params,

        [string]$GroupPrivacy = $null,
        [string]$ContentTypes = $null,
        [switch]$IncludeGroupSiteProtectionSettings
    )

    $Params['ContentType'] = if ($ContentTypes) { $ContentTypes } else { $script:DefaultLabelContentTypes }

    if ($IncludeGroupSiteProtectionSettings -and $GroupPrivacy -and $GroupPrivacy -ne 'Unspecified') {
        $Params['SiteAndGroupProtectionEnabled'] = $true
        $Params['SiteAndGroupProtectionPrivacy'] = $GroupPrivacy
    }

    return $Params
}

function Enable-EntraContainerSensitivityLabels {
    [CmdletBinding(SupportsShouldProcess)]
    param()

    if ($WhatIfPreference) {
        Write-Host 'WhatIf: would enable EnableMIPLabels in Group.Unified directory settings'
        return
    }

    if (-not (Get-Command Connect-M365Graph -ErrorAction SilentlyContinue)) {
        throw 'Connect-M365Graph is not available'
    }
    if (-not (Get-MgContext)) {
        Connect-M365Graph | Out-Null
    }

    $response = Invoke-MgGraphRequest -Method GET -Uri 'https://graph.microsoft.com/beta/settings'
    $grpSetting = @($response.value | Where-Object { $_.templateId -eq $script:GroupUnifiedDirectoryTemplateId })[0]

    if ($grpSetting) {
        $current = ($grpSetting.values | Where-Object { $_.name -eq 'EnableMIPLabels' }).value
        if ($current -eq 'True') {
            Write-Host 'EnableMIPLabels already enabled for Group.Unified'
            return
        }

        $values = @($grpSetting.values | ForEach-Object {
            if ($_.name -eq 'EnableMIPLabels') {
                @{ name = $_.name; value = 'True' }
            }
            else {
                @{ name = $_.name; value = "$($_.value)" }
            }
        })
        if (-not ($values | Where-Object { $_.name -eq 'EnableMIPLabels' })) {
            $values += @{ name = 'EnableMIPLabels'; value = 'True' }
        }

        if ($PSCmdlet.ShouldProcess('Group.Unified', 'Enable EnableMIPLabels')) {
            Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/beta/settings/$($grpSetting.id)" `
                -Body (@{ values = $values } | ConvertTo-Json -Depth 6) -ContentType 'application/json'
            Write-Host 'Enabled EnableMIPLabels in Group.Unified directory settings'
        }
        return
    }

    if ($PSCmdlet.ShouldProcess('Group.Unified', 'Create directory settings with EnableMIPLabels')) {
        $body = @{
            templateId = $script:GroupUnifiedDirectoryTemplateId
            values     = @(@{ name = 'EnableMIPLabels'; value = 'True' })
        }
        Invoke-MgGraphRequest -Method POST -Uri 'https://graph.microsoft.com/beta/settings' `
            -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json'
        Write-Host 'Created Group.Unified settings with EnableMIPLabels enabled'
    }
}

function Ensure-InformationProtectionLabelCmdletSession {
    if (Get-Command Get-Label -ErrorAction SilentlyContinue) { return }

    if (-not (Get-Command Connect-IPPSSessionDelegated -ErrorAction SilentlyContinue)) {
        throw 'Connect-IPPSSessionDelegated is not available'
    }

    Write-Host 'Re-establishing Security & Compliance PowerShell session for label cmdlets...'
    Connect-IPPSSessionDelegated | Out-Null
}

function Sync-AzureAdSensitivityLabels {
    [CmdletBinding(SupportsShouldProcess)]
    param()

    if ($WhatIfPreference) {
        Write-Host 'WhatIf: would run Execute-AzureAdLabelSync'
        return
    }

    if (-not (Get-Command Execute-AzureAdLabelSync -ErrorAction SilentlyContinue)) {
        Ensure-InformationProtectionLabelCmdletSession
    }

    if (-not (Get-Command Execute-AzureAdLabelSync -ErrorAction SilentlyContinue)) {
        throw 'Execute-AzureAdLabelSync is not available. Connect to Security & Compliance PowerShell first.'
    }

    if ($PSCmdlet.ShouldProcess('Microsoft Entra ID', 'Synchronize sensitivity labels (Execute-AzureAdLabelSync)')) {
        Execute-AzureAdLabelSync
        Write-Host 'Execute-AzureAdLabelSync completed'
    }
}

function Initialize-InformationProtectionContainerSupport {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [switch]$SkipEnableMipLabels
    )

    Write-Host 'Enabling sensitivity labels for Microsoft 365 groups, sites, and Teams containers...'

    if (-not $SkipEnableMipLabels) {
        Enable-EntraContainerSensitivityLabels
    }

    Sync-AzureAdSensitivityLabels
}

function Update-InformationProtectionLabelContainerScope {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory = $true)][string]$Identity,
        [string]$GroupPrivacy = $null
    )

    $scopeParams = @{}
    Add-InformationProtectionLabelScopeParameters -Params $scopeParams | Out-Null

    if ($WhatIfPreference) {
        Write-Host "WhatIf: would expand label scope for '$Identity' to include groups and sites"
        return
    }

    if ($PSCmdlet.ShouldProcess($Identity, 'Expand sensitivity label ContentType for groups and sites')) {
        try {
            Set-Label -Identity $Identity @scopeParams | Out-Null
            Write-Host "Updated label ContentType for '$Identity' (groups, sites, Teams)"
        }
        catch {
            Write-Warning "Could not expand ContentType for '$Identity' (Purview administrator consent may be required): $_"
            return
        }
    }

    if ($GroupPrivacy -and $GroupPrivacy -ne 'Unspecified') {
        $protectionParams = @{
            SiteAndGroupProtectionEnabled = $true
            SiteAndGroupProtectionPrivacy = $GroupPrivacy
        }
        try {
            if ($PSCmdlet.ShouldProcess($Identity, 'Configure groups/sites protection settings')) {
                Set-Label -Identity $Identity @protectionParams | Out-Null
                Write-Host "Updated groups/sites protection for '$Identity' (privacy: $GroupPrivacy)"
            }
        }
        catch {
            Write-Warning "Could not set groups/sites protection for '$Identity' (Purview consent may be required): $_"
        }
    }
}

function Ensure-InformationProtectionExternalConsumption {
    <#
    .SYNOPSIS
        Reports when Azure RMS licensing or OME one-time passcode are disabled.

    .DESCRIPTION
        Does not mutate tenant settings. Deploy exchange/irm-configuration and
        exchange/ome-configuration baseline JSON via Configure-ExchangeMessageEncryption.ps1.
    #>
    [CmdletBinding()]
    param()

    Write-Host '=== Checking external RMS consumption (AIP/IRM/OME baseline) ==='

    $settingsPath = Join-Path $PSScriptRoot '..\graph-configs\Exchange-MessageEncryption-Settings.ps1'
    if (Test-Path $settingsPath) { . $settingsPath }

    if (-not (Get-Command Connect-ExchangeOnlineDelegated -ErrorAction SilentlyContinue)) {
        Write-Warning 'Connect-ExchangeOnlineDelegated unavailable; skipping external consumption check'
        return
    }

    $connectedHere = $false
    try {
        Connect-ExchangeOnlineDelegated | Out-Null
        $connectedHere = $true
    }
    catch {
        Write-Warning "Could not connect Exchange Online for external consumption check: $_"
        return
    }

    try {
        if (Get-Command Get-IRMConfiguration -ErrorAction SilentlyContinue) {
            $irm = Get-IRMConfiguration -ErrorAction SilentlyContinue
            if ($irm -and -not $irm.AzureRMSLicensingEnabled) {
                Write-Warning 'AzureRMSLicensingEnabled is false. Promote exchange/irm-configuration/AzureRMSLicensingEnabled.json from tenant backup to baseline and deploy.'
            }
            elseif ($irm) {
                Write-Host 'AzureRMSLicensingEnabled is enabled'
            }

            $licensingLocation = Get-ExchangeMessageEncryptionPropertyValue -Object $irm -PropertyName 'LicensingLocation'
            if ($irm -and (-not $licensingLocation -or @($licensingLocation).Count -eq 0)) {
                Write-Warning 'IRM LicensingLocation is missing. Promote exchange/aip-service/configuration/LicensingIntranetDistributionPointUrl.json and exchange/aip-service/_apply-licensing-location-to-irm.json (Enabled=true), or exchange/irm-configuration/LicensingLocation.json.'
            }
        }

        try {
            Connect-AipServiceDelegated | Out-Null
            if (-not (Get-AipServiceEnabledState)) {
                Write-Warning 'AIP protection service is deactivated. Promote exchange/aip-service/ServiceEnabled.json (Enabled=true) from tenant backup to baseline and deploy.'
            }
            else {
                Write-Host 'AIP protection service is enabled'
            }
        }
        catch {
            Write-Warning "Could not verify AIP service activation: $_"
        }
        finally {
            if (Get-Command Disconnect-AipService -ErrorAction SilentlyContinue) {
                Disconnect-AipService -ErrorAction SilentlyContinue | Out-Null
            }
        }

        if ((Get-Command Get-OmeConfigurationObjects -ErrorAction SilentlyContinue) -or (Get-Command Get-OMEConfiguration -ErrorAction SilentlyContinue)) {
            $omeConfigs = if (Get-Command Get-OmeConfigurationObjects -ErrorAction SilentlyContinue) {
                @(Get-OmeConfigurationObjects)
            } else {
                @(Get-OMEConfiguration -ErrorAction Stop)
            }
            $omeIdentity = 'OME Configuration'
            $preferred = @($omeConfigs | Where-Object { "$($_.Identity)" -eq $omeIdentity } | Select-Object -First 1)[0]
            if ($preferred) {
                $omeIdentity = "$($preferred.Identity)"
            }
            elseif ($omeConfigs.Count -gt 0) {
                $omeIdentity = "$($omeConfigs[0].Identity)"
            }
            $ome = @($omeConfigs | Where-Object { "$($_.Identity)" -eq $omeIdentity } | Select-Object -First 1)[0]
            if ($ome -and -not $ome.OTPEnabled) {
                Write-Warning "OME OTPEnabled is false on '$omeIdentity'. Promote exchange/ome-configuration/OTPEnabled.json from tenant backup to baseline and deploy."
            }
            elseif ($ome) {
                Write-Host "OME one-time passcode enabled on '$omeIdentity'"
            }
        }
    }
    catch {
        Write-Warning "External consumption check failed: $_"
    }
    finally {
        if ($connectedHere -and (Get-Command Disconnect-ExchangeOnline -ErrorAction SilentlyContinue)) {
            Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        }
    }

    Write-Host 'Note: Authenticated Users grants RMS rights to any signed-in user (OTP or Microsoft account). External users are not required to be B2B guests unless Conditional Access forces tenant MFA.'
}
