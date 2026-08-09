<#
.SYNOPSIS
    Creates and manages Intune Device Configuration profiles via Microsoft Graph API
    
.DESCRIPTION
    Handles device configuration profiles (custom profiles, templates, etc.)
    This module is called by the main Configure-Intune.ps1 orchestrator.
    
.PARAMETER PolicyConfigs
    Array of policy configuration objects to process
    
.PARAMETER WhatIf
    Show what would be changed without making changes
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [array]$PolicyConfigs,
    
    [Parameter(Mandatory=$false)]
    [switch]$WhatIfMode
)

# Always load helpers (required when called from orchestrator with & operator)
$helpersPath = Join-Path $PSScriptRoot "Configure-Intune-Helpers.ps1"
. $helpersPath

# Load common ignore helpers for protection marker support
$ignoreHelpersPath = Join-Path $PSScriptRoot "..\Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# ============================================================================
# DEVICE CONFIGURATION SPECIFIC REPAIR FUNCTION
# ============================================================================

function Repair-DeviceConfigurationPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', 'supportsScopeTags',
                       '_sourceFile', '_policyType', '_assignments', '_settings',
                       'deviceManagementApplicabilityRuleOsEdition',
                       'deviceManagementApplicabilityRuleOsVersion',
                       'deviceManagementApplicabilityRuleDeviceMode')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds - MUST be an array of strings
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -is [string]) {
            if ($tagIds -match ',') {
                $json['roleScopeTagIds'] = @($tagIds -split ',' | ForEach-Object { $_.Trim() })
            }
            else {
                $json['roleScopeTagIds'] = @($tagIds)
            }
        }
        elseif ($tagIds -isnot [System.Collections.IList]) {
            $json['roleScopeTagIds'] = @($tagIds.ToString())
        }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    # =========================================================================
    # FIX: VPN configuration properties that require non-null collections
    # MUST happen BEFORE $propsToRemoveIfNull processing
    # These properties must be empty arrays instead of null per Graph API schema
    # =========================================================================
    $vpnCollectionProps = @(
        'excludedDomains',      # iOS/macOS VPN - domains excluded from VPN
        'associatedDomains',    # iOS VPN - associated domains
        'safariDomains',        # iOS VPN - Safari domains
        'targetedMobileApps'    # iOS VPN - apps that use this VPN
    )
    
    foreach ($prop in $vpnCollectionProps) {
        if ($json.ContainsKey($prop) -and $null -eq $json[$prop]) {
            $json[$prop] = @()
            Write-Verbose "  Converted null '$prop' to empty array for VPN configuration"
        }
    }
    
    # Fix nested VPN onDemandRules properties that require non-null collections
    if ($json.ContainsKey('onDemandRules') -and $json['onDemandRules'] -is [hashtable]) {
        $onDemandRule = $json['onDemandRules']
        $onDemandCollectionProps = @('dnsSearchDomains', 'ssids', 'domains', 'dnsServerAddressMatch')
        foreach ($prop in $onDemandCollectionProps) {
            if ($onDemandRule.ContainsKey($prop) -and $null -eq $onDemandRule[$prop]) {
                $onDemandRule[$prop] = @()
                Write-Verbose "  Converted null onDemandRules.'$prop' to empty array"
            }
        }
    }
    
    # =========================================================================
    # FIX: Convert single objects to arrays where API expects arrays
    # This handles common issues in backup files where arrays become objects
    # =========================================================================
    $propsRequiringArrays = @('customData', 'customKeyValueData', 'onDemandRules', 
                               'servers', 'routes', 'trafficRules', 'dnsRules')
    foreach ($prop in $propsRequiringArrays) {
        if ($json.ContainsKey($prop)) {
            $value = $json[$prop]
            # If it's a single object (hashtable), wrap it in an array
            if ($value -is [hashtable]) {
                $json[$prop] = @($value)
                Write-Verbose "  Converted single object '$prop' to array"
            }
            # If it's null, remove it (let the default kick in)
            elseif ($null -eq $value) {
                $json.Remove($prop)
            }
        }
    }
    
    # Fix 'server' property for VPN configs - should be nested under 'servers' array for some types
    # But for iOS VPN, 'server' is a single object property that should remain as-is
    # Just ensure if 'server' exists and is a hashtable, it's valid
    
    # Properties that should be REMOVED if null
    $propsToRemoveIfNull = @('customKeyValueData', 'customUpdateTimeWindows',
                   'systemExtensionsAllowedTypes', 'systemExtensionsAllowedTeamIdentifiers',
                   'systemExtensionsAllowed', 'kernelExtensionsAllowed',
                   'kernelExtensionAllowedTeamIdentifiers',
                   # Android/iOS specific arrays that can't be null
                   'allowedGoogleAccountDomains', 'azureAdSharedDeviceDataClearApps',
                   'appsHideList', 'appsInstallAllowList', 'appsLaunchBlockList',
                   'kioskModeApps', 'compliantAppsList',
                   'personalProfilePersonalApplications', 'workProfileBlockedAppsList',
                   # Android kiosk/device owner arrays
                   'kioskModeWifiAllowedSsids', 'kioskModeAppPositions',
                   'kioskModeManagedFolders', 'kioskModeAppsInFolderOrderedByName',
                   'kioskModeManagedHomeScreenAppSettings',
                   'stayOnModes', 'globalProxy', 'systemUpdateFreezePeriods',
                   # Windows specific arrays
                   'printerNames', 'defenderProcessesToExclude', 'defenderFileExtensionsToExclude',
                   'defenderFilesAndFoldersToExclude', 'defenderDetectedMalwareActions',
                   'defenderAttackSurfaceReductionExcludedPaths', 'defenderGuardedFoldersAllowedAppPaths',
                   'defenderAdditionalGuardedFolders', 'firewallRules',
                   'displayAppListWithGdiDPIScalingTurnedOff', 'displayAppListWithGdiDPIScalingTurnedOn',
                   # macOS specific arrays
                   'contentCachingParents', 'contentCachingPeerFilterRanges',
                   'contentCachingPublicRanges', 'contentCachingClientListenRanges',
                   'contentCachingPeerListenRanges',
                   'autoLaunchItems', 'appAssociatedDomains',
                   'singleSignOnExtensionPkinitCertificateAuthority', 'airPrintDestinations',
                   # iOS/iPad specific arrays (excludes VPN-specific props handled separately)
                   'scheduledInstallDays', 'customData', 'onDemandRules',
                   'safariManagedDomains',
                   'safariPasswordAutoFillDomains', 'webContentFilteringBlockList',
                   # VPN specific arrays
                   'customXml', 'servers', 'routes', 'trafficRules', 'dnsRules',
                   # OMA settings
                   'omaSettings',
                   # Windows 10 specific
                   'applicationGuardCertificateThumbprints')
    foreach ($prop in $propsToRemoveIfNull) {
        if ($json.ContainsKey($prop)) {
            $value = $json[$prop]
            # Remove if null, empty array, or empty object
            if ($null -eq $value -or 
                ($value -is [System.Collections.IList] -and $value.Count -eq 0) -or
                ($value -is [hashtable] -and $value.Count -eq 0)) {
                $json.Remove($prop)
            }
        }
    }
    
    # Handle omaSettings - remove secretReferenceValueId and isEncrypted
    if ($json.ContainsKey('omaSettings')) {
        $omaSettings = $json['omaSettings']
        
        # Ensure omaSettings is an array
        if ($omaSettings -isnot [System.Collections.IList]) {
            $omaSettings = @($omaSettings)
            $json['omaSettings'] = $omaSettings
        }
        
        foreach ($setting in $omaSettings) {
            if ($setting -is [hashtable]) {
                if ($setting.ContainsKey('secretReferenceValueId')) {
                    $setting.Remove('secretReferenceValueId')
                }
                if ($setting.ContainsKey('isEncrypted')) {
                    $setting.Remove('isEncrypted')
                }
            }
        }
    }
    
    # Fix macOSSingleSignOnExtension nested object
    if ($json.ContainsKey('macOSSingleSignOnExtension') -and $json['macOSSingleSignOnExtension'] -is [hashtable]) {
        $ssoExt = $json['macOSSingleSignOnExtension']
        $ssoArrayProps = @('bundleIdAccessControlList', 'configurations', 'urlPrefixes', 'domains')
        foreach ($prop in $ssoArrayProps) {
            if ($ssoExt.ContainsKey($prop) -and $null -eq $ssoExt[$prop]) {
                $ssoExt.Remove($prop)
            }
        }
    }
    
    # Fix singleSignOnExtension nested object
    if ($json.ContainsKey('singleSignOnExtension') -and $json['singleSignOnExtension'] -is [hashtable]) {
        $ssoExt = $json['singleSignOnExtension']
        $ssoArrayProps = @('bundleIdAccessControlList', 'configurations', 'urlPrefixes', 'domains')
        foreach ($prop in $ssoArrayProps) {
            if ($ssoExt.ContainsKey($prop) -and $null -eq $ssoExt[$prop]) {
                $ssoExt.Remove($prop)
            }
        }
    }
    
    # =========================================================================
    # Remove 'notConfigured' enum values - API expects these properties to be ABSENT
    # This handles windows10GeneralConfiguration and similar profiles where enum
    # properties like defenderSubmitSamplesConsentType cannot be set to 'notConfigured'
    # =========================================================================
    $removedNotConfigured = [System.Collections.ArrayList]@()
    
    function Remove-NotConfiguredValuesRecursive {
        param(
            [Parameter(Mandatory=$true)]
            $Object,
            [string]$Path = ""
        )
        
        if ($null -eq $Object) { return }
        
        if ($Object -is [hashtable]) {
            $keysToRemove = [System.Collections.ArrayList]@()
            
            foreach ($key in @($Object.Keys)) {
                $value = $Object[$key]
                $currentPath = if ($Path) { "$Path.$key" } else { $key }
                
                # Check if value is the string 'notConfigured' (case-insensitive)
                if ($value -is [string] -and $value -ieq 'notConfigured') {
                    [void]$keysToRemove.Add($key)
                    [void]$removedNotConfigured.Add($currentPath)
                }
                elseif ($value -is [hashtable]) {
                    Remove-NotConfiguredValuesRecursive -Object $value -Path $currentPath
                    # Remove empty hashtables
                    if ($value.Count -eq 0) {
                        [void]$keysToRemove.Add($key)
                    }
                }
                elseif ($value -is [System.Collections.IList]) {
                    foreach ($item in $value) {
                        if ($item -is [hashtable]) {
                            Remove-NotConfiguredValuesRecursive -Object $item -Path $currentPath
                        }
                    }
                }
            }
            
            # Remove the identified keys
            foreach ($key in $keysToRemove) {
                $Object.Remove($key)
            }
        }
    }
    
    Remove-NotConfiguredValuesRecursive -Object $json
    
    if ($removedNotConfigured.Count -gt 0) {
        Write-Verbose "  Removed 'notConfigured' values from: $($removedNotConfigured -join ', ')"
    }
    
    # Final cleanup - remove null values
    function Remove-NullValues {
        param([hashtable]$Object)
        $keysToRemove = @()
        foreach ($key in $Object.Keys) {
            $value = $Object[$key]
            if ($null -eq $value) {
                $keysToRemove += $key
            }
            elseif ($value -is [hashtable]) {
                Remove-NullValues -Object $value
                if ($value.Count -eq 0) {
                    $keysToRemove += $key
                }
            }
        }
        foreach ($key in $keysToRemove) {
            $Object.Remove($key)
        }
    }
    Remove-NullValues -Object $json
    
    return $json
}

# ============================================================================
# OMA SETTINGS COMPARISON HELPER
# ============================================================================

function Get-OmaSettingsWithPlainText {
    <#
    .SYNOPSIS
        Fetches OMA settings with decrypted plain text values for comparison
    .DESCRIPTION
        The API returns omaSettings with value="****" for encrypted settings.
        This function fetches the actual plain text values using getOmaSettingPlainTextValue
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,
        [Parameter(Mandatory=$true)]
        [array]$OmaSettings
    )
    
    $result = @()
    
    foreach ($setting in $OmaSettings) {
        $settingCopy = $setting | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        
        # If encrypted, fetch the plain text value
        if ($settingCopy.isEncrypted -eq $true -and $settingCopy.secretReferenceValueId) {
            try {
                $plainTextUri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$PolicyId/getOmaSettingPlainTextValue(secretReferenceValueId='$($settingCopy.secretReferenceValueId)')"
                $plainTextResponse = Invoke-MgGraphRequest -Method GET -Uri $plainTextUri
                
                if ($plainTextResponse -and $plainTextResponse.value) {
                    $settingCopy['value'] = $plainTextResponse.value
                    Write-Verbose "    Decrypted OMA setting: $($settingCopy.displayName)"
                }
                else {
                    Write-Verbose "    Warning: Empty response decrypting '$($settingCopy.displayName)'"
                }
            }
            catch {
                Write-Host "    Warning: Could not decrypt OMA setting '$($settingCopy.displayName)': $_" -ForegroundColor Yellow
            }
        }
        elseif ($settingCopy.value -eq '****') {
            # API returned masked value but without secretReferenceValueId - can't decrypt
            Write-Verbose "    Warning: OMA setting '$($settingCopy.displayName)' is masked but missing secretReferenceValueId"
        }
        
        # Remove encryption-related properties for comparison
        if ($settingCopy.ContainsKey('isEncrypted')) { $settingCopy.Remove('isEncrypted') }
        if ($settingCopy.ContainsKey('secretReferenceValueId')) { $settingCopy.Remove('secretReferenceValueId') }
        
        $result += $settingCopy
    }
    
    return $result
}

function Compare-OmaSettings {
    <#
    .SYNOPSIS
        Compares OMA settings between existing policy and desired config
    .OUTPUTS
        PSCustomObject with IsMatch (bool) and Differences (array of detail strings)
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,
        [array]$ExistingOmaSettings,
        [array]$DesiredOmaSettings,
        [switch]$ReturnDetails
    )
    
    $differences = @()
    
    # If neither has OMA settings, they're equal
    if (-not $ExistingOmaSettings -and -not $DesiredOmaSettings) {
        if ($ReturnDetails) { return @{ IsMatch = $true; Differences = @() } }
        return $true
    }
    
    # If one has and other doesn't, they differ
    if (-not $ExistingOmaSettings -or -not $DesiredOmaSettings) {
        if (-not $ExistingOmaSettings) {
            $differences += "OMA settings will be added (currently none exist)"
        } else {
            $differences += "OMA settings will be removed (baseline has none)"
        }
        if ($ReturnDetails) { return @{ IsMatch = $false; Differences = $differences } }
        return $false
    }
    
    # Count difference
    if ($ExistingOmaSettings.Count -ne $DesiredOmaSettings.Count) {
        $differences += "OMA setting count: $($ExistingOmaSettings.Count) â†’ $($DesiredOmaSettings.Count)"
    }
    
    # Fetch decrypted values from API
    $decryptedExisting = Get-OmaSettingsWithPlainText -PolicyId $PolicyId -OmaSettings $ExistingOmaSettings
    
    # Normalize desired settings (remove encryption props if present in backup)
    $normalizedDesired = @()
    foreach ($setting in $DesiredOmaSettings) {
        $settingCopy = $setting | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        if ($settingCopy.ContainsKey('isEncrypted')) { $settingCopy.Remove('isEncrypted') }
        if ($settingCopy.ContainsKey('secretReferenceValueId')) { $settingCopy.Remove('secretReferenceValueId') }
        $normalizedDesired += $settingCopy
    }
    
    # Build lookup by omaUri
    $existingByUri = @{}
    foreach ($e in $decryptedExisting) { $existingByUri[$e.omaUri] = $e }
    
    $desiredByUri = @{}
    foreach ($d in $normalizedDesired) { $desiredByUri[$d.omaUri] = $d }
    
    # Find added settings (in desired but not existing)
    foreach ($uri in $desiredByUri.Keys) {
        if (-not $existingByUri.ContainsKey($uri)) {
            $setting = $desiredByUri[$uri]
            $differences += "+ ADD: $($setting.displayName) ($uri)"
        }
    }
    
    # Find removed settings (in existing but not desired)
    foreach ($uri in $existingByUri.Keys) {
        if (-not $desiredByUri.ContainsKey($uri)) {
            $setting = $existingByUri[$uri]
            $differences += "- REMOVE: $($setting.displayName) ($uri)"
        }
    }
    
    # Compare matching settings by omaUri
    foreach ($desired in $normalizedDesired) {
        $matching = $existingByUri[$desired.omaUri]
        if (-not $matching) { continue }  # Already handled in added/removed
        
        # Error if baseline has masked values - backup needs to be re-run
        # Note: Must check type first to avoid PowerShell coercing '****' to boolean $true
        if ($desired.value -is [string] -and $desired.value -eq '****') {
            Write-Error "Baseline file contains masked OMA value '****' for setting '$($desired.displayName)'. Re-run backup to capture actual values."
            if ($ReturnDetails) { return @{ IsMatch = $false; Differences = @("ERROR: Masked value '****' in baseline") } }
            return $false
        }
        
        # Compare key properties and collect differences
        $settingName = $desired.displayName
        
        if ($matching.displayName -ne $desired.displayName) {
            $differences += "~ $settingName displayName: '$($matching.displayName)' â†’ '$($desired.displayName)'"
        }
        
        if ($matching.value -ne $desired.value) {
            # Truncate long values for display
            $existingVal = if ($matching.value.Length -gt 80) { $matching.value.Substring(0, 77) + "..." } else { $matching.value }
            $desiredVal = if ($desired.value.Length -gt 80) { $desired.value.Substring(0, 77) + "..." } else { $desired.value }
            $differences += "~ $settingName value:"
            $differences += "    FROM: $existingVal"
            $differences += "    TO:   $desiredVal"
        }
        
        if ($matching.'@odata.type' -ne $desired.'@odata.type') {
            $differences += "~ $settingName type: '$($matching.'@odata.type')' â†’ '$($desired.'@odata.type')'"
        }
    }
    
    $isMatch = $differences.Count -eq 0
    
    if ($ReturnDetails) {
        return @{ IsMatch = $isMatch; Differences = $differences }
    }
    return $isMatch
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-DeviceConfigurations {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        
        Write-Host "`n##[group]Processing [device-configurations]: $displayName"
        
        try {
            # Check if policy exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType "device-configurations"
            $existingPolicy = $allPolicies | Where-Object { $_.displayName.Trim() -ieq $displayName } | Select-Object -First 1
            
            $action = "Create"
            $hasChanges = $true
            
            $changeDetails = $null
            if ($existingPolicy) {
                # Check if policy is protected from baseline updates via description marker
                if (Test-ResourceProtected -Description $existingPolicy.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  [!] Protected: Policy has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = "device-configurations"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Compare key properties to determine if update is needed
                # Ignore runtime/status properties AND properties with API-specific formatting
                $ignoreProps = @(
                    # Runtime/status properties
                    'assignments', 'deviceStatusOverview', 'userStatusOverview', 'deviceSettingStateSummaries',
                    # Navigation properties
                    'groupAssignments', 'deviceStatuses', 'userStatuses',
                    # API-specific properties
                    'supportsScopeTags', 'deviceManagementApplicabilityRuleOsEdition',
                    'deviceManagementApplicabilityRuleOsVersion', 'deviceManagementApplicabilityRuleDeviceMode',
                    'isReadOnly',
                    # omaSettings - handled separately with decryption
                    'omaSettings'
                )
                
                # These policy types return verbose API defaults (100+ properties) but baselines only configure a few
                # Only compare properties explicitly defined in the baseline for these policy types
                $requiresOnlyDesiredKeyComparison = $policyConfig.'@odata.type' -in @(
                    '#microsoft.graph.windows10GeneralConfiguration',
                    '#microsoft.graph.androidDeviceOwnerGeneralDeviceConfiguration'
                )
                
                # Apply field-monitor filter if sidecar is present
                $devCfgMonitorConfig = $null
                if ($policyConfig._monitorConfig) {
                    $devCfgMonitorConfig = @{}
                    if ($policyConfig._monitorConfig.Include) { $devCfgMonitorConfig['Include'] = @($policyConfig._monitorConfig.Include) }
                    if ($policyConfig._monitorConfig.Exclude) { $devCfgMonitorConfig['Exclude'] = @($policyConfig._monitorConfig.Exclude) }
                    if ($devCfgMonitorConfig.Count -eq 0) { $devCfgMonitorConfig = $null }
                }
                $compareDesiredPolicy = if ($devCfgMonitorConfig) { Apply-MonitorFilter -PolicyObject $policyConfig -MonitorConfig $devCfgMonitorConfig } else { $policyConfig }

                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingPolicy -DesiredPolicy $compareDesiredPolicy -IgnoreProperties $ignoreProps -CompareOnlyDesiredKeys:$requiresOnlyDesiredKeyComparison -ReturnDetails
                
                # Additionally compare OMA settings if present (requires fetching decrypted values)
                # omaSettings are not returned by the list endpoint - fetch the full policy first
                $omaComparison = @{ IsMatch = $true; Differences = @() }
                $fullDevCfgUri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($existingPolicy.id)"
                try {
                    $fullExistingForOma = Invoke-MgGraphRequest -Method GET -Uri $fullDevCfgUri
                } catch {
                    Write-Warning "  Could not fetch full policy details for OMA comparison: $_"
                    $fullExistingForOma = $existingPolicy
                }
                $existingOma = if ($fullExistingForOma.omaSettings) { @($fullExistingForOma.omaSettings) } else { @() }
                $desiredOma  = if ($policyConfig.omaSettings)        { @($policyConfig.omaSettings)       } else { @() }
                
                if ($existingOma -or $desiredOma) {
                    $omaComparison = Compare-OmaSettings -PolicyId $existingPolicy.id -ExistingOmaSettings $existingOma -DesiredOmaSettings $desiredOma -ReturnDetails
                }
                
                if ($comparison.IsEquivalent -and $omaComparison.IsMatch) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Policy exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  Policy exists - changes detected, will be updated"
                    
                    # DEBUG: Show raw configurations for comparison
                    Write-Host "  â•â•â• DEBUG: RAW COMPARISON DATA â•â•â•" -ForegroundColor Cyan
                    Write-Host "  CompareOnlyDesiredKeys mode: $requiresOnlyDesiredKeyComparison" -ForegroundColor Cyan
                    Write-Host "  " -ForegroundColor Cyan
                    Write-Host "  RAW EXISTING (from API):" -ForegroundColor Yellow
                    $existingJson = $existingPolicy | ConvertTo-Json -Depth 5 -Compress
                    if ($existingJson.Length -gt 2000) {
                        Write-Host "  $($existingJson.Substring(0, 2000))... [truncated]" -ForegroundColor Gray
                    } else {
                        Write-Host "  $existingJson" -ForegroundColor Gray
                    }
                    Write-Host "  " -ForegroundColor Cyan
                    Write-Host "  RAW DESIRED (from baseline):" -ForegroundColor Green
                    $desiredJson = $policyConfig | ConvertTo-Json -Depth 5 -Compress
                    if ($desiredJson.Length -gt 2000) {
                        Write-Host "  $($desiredJson.Substring(0, 2000))... [truncated]" -ForegroundColor Gray
                    } else {
                        Write-Host "  $desiredJson" -ForegroundColor Gray
                    }
                    Write-Host "  " -ForegroundColor Cyan
                    Write-Host "  DETECTED DIFFERENCES:" -ForegroundColor Red
                    if ($changeDetails.Added.Count -gt 0) { 
                        Write-Host "    Added: $($changeDetails.Added -join ', ')" -ForegroundColor Red
                    }
                    if ($changeDetails.Removed.Count -gt 0) { 
                        Write-Host "    Removed: $($changeDetails.Removed -join ', ')" -ForegroundColor Red
                    }
                    if ($changeDetails.Modified.Count -gt 0) { 
                        Write-Host "    Modified: $($changeDetails.Modified -join ', ')" -ForegroundColor Red
                    }
                    Write-Host "  â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•" -ForegroundColor Cyan
                    
                    # Show OMA setting differences with detail
                    if (-not $omaComparison.IsMatch -and $omaComparison.Differences.Count -gt 0) {
                        Write-Host "    OMA Settings changes:"
                        foreach ($diff in $omaComparison.Differences) {
                            Write-Host "      $diff"
                        }
                        # Add OMA differences to changeDetails for pipeline summary
                        if (-not $changeDetails) { $changeDetails = @{ Added = @(); Removed = @(); Modified = @(); OmaSettings = @() } }
                        $changeDetails.OmaSettings = $omaComparison.Differences
                    }
                }
            }
            else {
                Write-Host "  Policy does not exist - will be created"
            }
            
            Write-Host "  Type: Device Configuration"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "device-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no policy content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "device-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName      = $displayName
                    Status           = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId         = $existingPolicy.id
                }
                continue
            }
            
            # Repair the payload (use monitor-filtered version when a sidecar is active)
            $writePayload = if ($action -ne "Create" -and $devCfgMonitorConfig) {
                Apply-MonitorFilter -PolicyObject $policyConfig -MonitorConfig $devCfgMonitorConfig
            } else { $policyConfig }
            $repairedConfig = Repair-DeviceConfigurationPayload -Payload $writePayload
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $response = Invoke-GraphApiWrite -Method POST -Uri $uri -Body $jsonBody
                $policyId = $response.id
                Write-Host "  [+] Device Configuration created: $displayName (ID: $policyId)"
            }
            else {
                # DELETE + POST instead of PATCH so the policy state exactly mirrors the baseline.
                # This also handles configured -> notConfigured resets, which PATCH cannot do
                # (notConfigured values are stripped from the payload before sending).
                $deleteUri = "$uri/$($existingPolicy.id)"
                Write-Host "  [~] Recreating policy (DELETE + POST): $displayName"
                Invoke-GraphApiWrite -Method DELETE -Uri $deleteUri
                $response = Invoke-GraphApiWrite -Method POST -Uri $uri -Body $jsonBody
                $policyId = $response.id
                Write-Host "  [+] Device Configuration recreated: $displayName (new ID: $policyId)"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "device-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
            }
        }
        catch {
            Write-Host "  âœ— Failed to $($action.ToLower()) policy: $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process policy: $displayName"
            Write-Host "##[error]Error: $_"
            
            $results += @{
                DisplayName = $displayName
                Status = "Failed"
                Error = $_.ToString()
            }
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
    
    return $results
}

# ============================================================================
# ENTRY POINT
# ============================================================================

$deviceConfigPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "device-configurations" }

if ($deviceConfigPolicies.Count -eq 0) {
    Write-Host "No Device Configuration policies to process"
    return @()
}

Write-Host "`n##[section]Processing Device Configurations ($($deviceConfigPolicies.Count) policies)"

$results = Invoke-DeviceConfigurations -Policies $deviceConfigPolicies -WhatIf:$WhatIfMode

return $results

