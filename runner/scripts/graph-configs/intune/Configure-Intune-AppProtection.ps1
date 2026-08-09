<#
.SYNOPSIS
    Creates and manages Intune App Protection policies via Microsoft Graph API
    
.DESCRIPTION
    Handles Android and iOS App Protection policies (MAM policies).
    This module is called by the main Configure-Intune.ps1 orchestrator.
    
.PARAMETER PolicyConfigs
    Array of policy configuration objects to process
    
.PARAMETER WhatIf
    Show what would be changed without making changes
    
.NOTES
    Requires Microsoft.Graph.Authentication module
    Requires the Configure-Intune-Helpers.ps1 module to be loaded
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
# APP PROTECTION SPECIFIC REPAIR FUNCTION
# ============================================================================

function Repair-AppProtectionPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', '@odata.type',
                       '_sourceFile', '_policyType', '_assignments', '_settings',
                       'deployedAppCount', 'isAssigned')
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
        # Ensure it's a proper array even if already a list
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    # Properties that must be REMOVED if null (scalars)
    $propsToRemoveIfNull = @(
        # Version properties that may be null
        'minimumRequiredAppVersion', 'minimumRequiredSdkVersion', 'minimumRequiredOsVersion',
        'minimumRequiredCompanyPortalVersion', 'minimumRequiredPatchVersion',
        'minimumWarningAppVersion', 'minimumWarningOsVersion', 'minimumWarningCompanyPortalVersion',
        'minimumWarningPatchVersion', 'minimumWipeAppVersion', 'minimumWipeOsVersion',
        'minimumWipeCompanyPortalVersion', 'minimumWipePatchVersion', 'minimumWipeSdkVersion',
        'maximumRequiredOsVersion', 'maximumWarningOsVersion', 'maximumWipeOsVersion',
        'minimumWarningSdkVersion',
        # Action properties
        'appActionIfAccountIsClockedOut', 'appActionIfDevicePasscodeComplexityLessThanHigh',
        'appActionIfDevicePasscodeComplexityLessThanMedium', 'appActionIfDevicePasscodeComplexityLessThanLow',
        'appActionIfSamsungKnoxAttestationRequired', 'appActionIfUnableToAuthenticateUser',
        # iOS-specific intelligence properties
        'writingToolsConfigurationState', 'genmojiConfigurationState',
        'imagePlaygroundConfigurationState', 'intelligenceConfigurationState',
        'screenCaptureConfigurationState',
        # Other nullable properties
        'fingerprintAndBiometricEnabled', 'mobileThreatDefensePartnerPriority',
        'gracePeriodToBlockAppsDuringOffClockHours', 'pinRequiredInsteadOfBiometricTimeout',
        # Browser/Dialer customization
        'customBrowserProtocol', 'customBrowserPackageId', 'customBrowserDisplayName',
        'customDialerAppProtocol', 'customDialerAppPackageId', 'customDialerAppDisplayName'
    )
    foreach ($prop in $propsToRemoveIfNull) {
        if ($json.ContainsKey($prop) -and $null -eq $json[$prop]) {
            $json.Remove($prop)
        }
    }
    
    # Array properties that should be REMOVED if null
    $arrayPropsToRemoveIfNull = @(
        'approvedKeyboards', 'allowedAndroidDeviceModels', 'allowedAndroidDeviceManufacturers',
        'allowedIosDeviceModels', 'allowedDataStorageLocations', 'allowedDataIngestionLocations'
    )
    foreach ($prop in $arrayPropsToRemoveIfNull) {
        if ($json.ContainsKey($prop)) {
            $value = $json[$prop]
            if ($null -eq $value) {
                $json.Remove($prop)
            }
            elseif ($value -is [string]) {
                # Convert single string value to array
                $json[$prop] = @($value)
            }
        }
    }
    
    # Array properties that SHOULD have values - keep as arrays
    # 'apps' omitted — Graph rejects PATCH on navigation property apps; sync via .../apps POST/DELETE.
    $arrayPropsToKeep = @(
        'exemptedUniversalLinks', 'managedUniversalLinks', 'assignments'
    )
    foreach ($prop in $arrayPropsToKeep) {
        if ($json.ContainsKey($prop)) {
            $value = $json[$prop]
            if ($null -eq $value) {
                $json[$prop] = @()
            }
            elseif ($value -is [string]) {
                $json[$prop] = @($value)
            }
        }
    }
    
    # exemptedAppProtocols needs special handling - API expects array of key-value pairs
    if ($json.ContainsKey('exemptedAppProtocols')) {
        $protocols = $json['exemptedAppProtocols']
        if ($null -eq $protocols) {
            $json.Remove('exemptedAppProtocols')
        }
        elseif ($protocols -is [hashtable] -or $protocols -is [PSCustomObject]) {
            # Convert to hashtable and wrap in array
            $protoHash = @{}
            if ($protocols -is [PSCustomObject]) {
                $protocols.PSObject.Properties | ForEach-Object { $protoHash[$_.Name] = $_.Value }
            } else {
                $protoHash = $protocols
            }
            $json['exemptedAppProtocols'] = @($protoHash)
        }
        elseif ($protocols -isnot [System.Collections.IList]) {
            $json.Remove('exemptedAppProtocols')
        }
    }
    
    # exemptedAppPackages needs special handling - API expects array of {name, value} objects
    if ($json.ContainsKey('exemptedAppPackages')) {
        $packages = $json['exemptedAppPackages']
        if ($null -eq $packages) {
            $json.Remove('exemptedAppPackages')
        }
        elseif ($packages -is [hashtable] -or $packages -is [PSCustomObject]) {
            # Convert to hashtable and wrap in array
            $pkgHash = @{}
            if ($packages -is [PSCustomObject]) {
                $packages.PSObject.Properties | ForEach-Object { $pkgHash[$_.Name] = $_.Value }
            } else {
                $pkgHash = $packages
            }
            $json['exemptedAppPackages'] = @($pkgHash)
        }
        elseif ($packages -isnot [System.Collections.IList]) {
            $json.Remove('exemptedAppPackages')
        }
    }
    
    # approvedKeyboards needs special handling - API expects array of {packageId, name} objects
    if ($json.ContainsKey('approvedKeyboards')) {
        $keyboards = $json['approvedKeyboards']
        if ($null -eq $keyboards) {
            $json.Remove('approvedKeyboards')
        }
        elseif ($keyboards -is [hashtable] -or $keyboards -is [PSCustomObject]) {
            # Convert to hashtable and wrap in array
            $kbHash = @{}
            if ($keyboards -is [PSCustomObject]) {
                $keyboards.PSObject.Properties | ForEach-Object { $kbHash[$_.Name] = $_.Value }
            } else {
                $kbHash = $keyboards
            }
            $json['approvedKeyboards'] = @($kbHash)
        }
        elseif ($keyboards -isnot [System.Collections.IList]) {
            $json.Remove('approvedKeyboards')
        }
    }
    
    # Final cleanup: Remove ALL remaining null values recursively
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
    # Never include 'apps' on policy POST/PATCH (navigation property — use .../apps collection).
    if ($json.ContainsKey('apps')) { $null = $json.Remove('apps') }

    Remove-NullValues -Object $json
    
    return $json
}

function Get-MobileAppIdentifierSortKey {
    param([object]$App)
    if ($null -eq $App) { return '' }
    try {
        $h = if ($App -is [hashtable]) { $App } else { $App | ConvertTo-Json -Depth 15 | ConvertFrom-Json -AsHashtable }
        $mid = $h['mobileAppIdentifier']
        if ($null -eq $mid) { return '' }
        $mh = if ($mid -is [hashtable]) { $mid } else { $mid | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable }
        $b = [string]$mh['bundleId']
        $p = [string]$mh['packageId']
        if ($b) { return "ios:$b" }
        if ($p) { return "and:$p" }
        return ($mh | ConvertTo-Json -Depth 5 -Compress)
    }
    catch { return '' }
}

function Normalize-ExemptedAppProtocolsInHashtable {
    param([hashtable]$Json)
    if (-not $Json -or -not $Json.ContainsKey('exemptedAppProtocols')) { return }
    $protos = $Json['exemptedAppProtocols']
    if ($null -eq $protos) { $Json.Remove('exemptedAppProtocols'); return }
    $items = [System.Collections.Generic.List[object]]::new()
    if ($protos -is [System.Collections.IList]) {
        foreach ($p in $protos) {
            if ($null -eq $p) { continue }
            $ph = if ($p -is [hashtable]) { $p } else { $p | ConvertTo-Json -Depth 5 | ConvertFrom-Json -AsHashtable }
            $items.Add(@{ name = [string]$ph['name']; value = [string]$ph['value'] })
        }
    }
    elseif ($protos -is [hashtable]) {
        $items.Add(@{ name = [string]$protos['name']; value = [string]$protos['value'] })
    }
    elseif ($null -ne $protos.PSObject) {
        $n = $null; $v = $null
        foreach ($prop in $protos.PSObject.Properties) {
            if ($prop.Name -eq 'name') { $n = [string]$prop.Value }
            if ($prop.Name -eq 'value') { $v = [string]$prop.Value }
        }
        $items.Add(@{ name = $n; value = $v })
    }
    $sorted = @($items.ToArray() | Sort-Object { "$(if ($_.name) { $_.name } else { '' })`0$(if ($_.value) { $_.value } else { '' })" })
    $Json['exemptedAppProtocols'] = $sorted
}

function Sort-AppsInHashtable {
    param([hashtable]$Json)
    if (-not $Json -or -not $Json.ContainsKey('apps')) { return }
    $apps = $Json['apps']
    if ($null -eq $apps) { return }
    $arr = @($apps)
    if ($arr.Count -le 1) { return }
    $sorted = @($arr | Sort-Object { Get-MobileAppIdentifierSortKey $_ })
    $Json['apps'] = $sorted
}

function Copy-PolicyToHashtableForCompare {
    param([object]$Policy)
    if ($null -eq $Policy) { return $null }
    return ($Policy | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable)
}

function Prepare-ManagedAppProtectionForCompare {
    param([object]$Policy)
    $h = Copy-PolicyToHashtableForCompare -Policy $Policy
    if ($null -eq $h) { return $null }
    Normalize-ExemptedAppProtocolsInHashtable -Json $h
    Sort-AppsInHashtable -Json $h
    return $h
}

function Merge-AppProtectionBaselineFieldsNotInMonitor {
    param(
        [object]$FilteredPatchBody,
        [object]$FullBaselineConfig
    )
    if ($null -eq $FullBaselineConfig._monitorConfig) { return $FilteredPatchBody }
    $fb = Copy-PolicyToHashtableForCompare -Policy $FilteredPatchBody
    $full = Copy-PolicyToHashtableForCompare -Policy $FullBaselineConfig
    if ($null -eq $fb) { return $FilteredPatchBody }
    # Do not merge 'apps' into PATCH body — monitor filter must not re-inject apps (not patchable on parent).
    foreach ($key in @('exemptedAppProtocols', 'appGroupType')) {
        if (-not $fb.ContainsKey($key) -and $null -ne $full -and $full.ContainsKey($key)) {
            $fb[$key] = $full[$key]
        }
    }
    return $fb
}

function Test-AppProtectionAppsSyncApplicable {
    param([object]$BaselineConfig)
    if ($null -eq $BaselineConfig) { return $false }
    $agt = $null
    if ($BaselineConfig -is [hashtable] -and $BaselineConfig.ContainsKey('appGroupType')) {
        $agt = $BaselineConfig['appGroupType']
    }
    elseif ($null -ne $BaselineConfig.PSObject.Properties['appGroupType']) {
        $agt = $BaselineConfig.appGroupType
    }
    return ($agt -eq 'selectedPublicApps')
}

function Get-NormalizedAppProtectionAppPostBodies {
    param([object]$BaselineConfig)
    $result = @()
    if ($null -eq $BaselineConfig) { return $result }
    $apps = $null
    if ($BaselineConfig -is [hashtable] -and $BaselineConfig.ContainsKey('apps')) {
        $apps = $BaselineConfig['apps']
    }
    elseif ($null -ne $BaselineConfig.PSObject.Properties['apps']) {
        $apps = $BaselineConfig.apps
    }
    if ($null -eq $apps) { return $result }
    foreach ($app in @($apps)) {
        if ($null -eq $app) { continue }
        $ah = if ($app -is [hashtable]) { $app } else {
            try { $app | ConvertTo-Json -Depth 15 | ConvertFrom-Json -AsHashtable } catch { continue }
        }
        if (-not $ah.ContainsKey('mobileAppIdentifier')) { continue }
        $mid = $ah['mobileAppIdentifier']
        if ($null -eq $mid) { continue }
        $mh = if ($mid -is [hashtable]) { $mid } else {
            try { $mid | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable } catch { continue }
        }
        $bundleId = [string]$mh['bundleId']
        $packageId = [string]$mh['packageId']
        $type = [string]$mh['@odata.type']
        if (-not $bundleId -and -not $packageId) { continue }
        if (-not $type) {
            if ($bundleId) { $type = 'microsoft.graph.iosMobileAppIdentifier' }
            elseif ($packageId) { $type = 'microsoft.graph.androidMobileAppIdentifier' }
        }
        # Nested identifier: Learn examples use microsoft.graph.* without leading '#'
        $nestedType = [string]$type
        if ($nestedType.StartsWith('#')) { $nestedType = $nestedType.Substring(1) }
        $ident = @{}
        $ident['@odata.type'] = $nestedType
        if ($bundleId) { $ident['bundleId'] = $bundleId }
        if ($packageId) { $ident['packageId'] = $packageId }
        $ver = if ($ah.ContainsKey('version') -and $null -ne $ah['version'] -and [string]$ah['version']) {
            [string]$ah['version']
        }
        else { '1' }
        $result += @{
            '@odata.type'         = '#microsoft.graph.managedMobileApp'
            'mobileAppIdentifier' = $ident
            'version'             = $ver
        }
    }
    return $result
}

function Get-ManagedMobileAppStableKey {
    param([object]$App)
    if ($null -eq $App) { return $null }
    try {
        $h = if ($App -is [hashtable]) { $App } else { $App | ConvertTo-Json -Depth 15 | ConvertFrom-Json -AsHashtable }
        $mid = $h['mobileAppIdentifier']
        if ($null -eq $mid) { return $null }
        $mh = if ($mid -is [hashtable]) { $mid } else { $mid | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable }
        $b = [string]$mh['bundleId']
        $p = [string]$mh['packageId']
        if ($b) { return "ios:$b" }
        if ($p) { return "and:$p" }
    }
    catch { }
    return $null
}

function Get-ManagedAppProtectionPolicyAppsBaseUri {
    <#
    .SYNOPSIS
        Base URL for **GET** .../ios|androidManagedAppProtections/{policyId}/apps (list targeted apps).
        Writes use POST .../managedAppPolicies/{policyId}/targetApps (see Sync-AppProtectionPolicyApps);
        POST to .../ManagedAppProtections/.../apps is not reliably bound on MAMAdmin.
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$GraphApiVersion,
        [Parameter(Mandatory = $true)]
        [bool]$IsAndroid,
        [Parameter(Mandatory = $true)]
        [string]$PolicyId
    )
    $root = if ($IsAndroid) {
        "https://graph.microsoft.com/$GraphApiVersion/deviceAppManagement/androidManagedAppProtections"
    }
    else {
        "https://graph.microsoft.com/$GraphApiVersion/deviceAppManagement/iosManagedAppProtections"
    }
    $idSeg = [Uri]::EscapeDataString($PolicyId)
    return "$root/$idSeg"
}

function Get-ManagedAppProtectionAppsPaginated {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PolicyAppsBaseUri
    )
    $all = [System.Collections.Generic.List[object]]::new()
    $next = "$PolicyAppsBaseUri/apps"
    while ($next) {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $next
        if ($resp.value) {
            foreach ($v in @($resp.value)) { $all.Add($v) }
        }
        $next = $resp.'@odata.nextLink'
    }
    return @($all)
}

function Sync-AppProtectionPolicyApps {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PolicyId,
        [Parameter(Mandatory = $true)]
        [bool]$IsAndroid,
        [Parameter(Mandatory = $true)]
        [object]$BaselineConfig,
        [switch]$WhatIf
    )
    $summary = @{ Added = 0; Removed = 0; Skipped = $false }
    if (-not (Test-AppProtectionAppsSyncApplicable -BaselineConfig $BaselineConfig)) {
        Write-Host "  [i] Skipping apps collection sync (appGroupType is not selectedPublicApps)"
        $summary.Skipped = $true
        return $summary
    }
    # Read: type-specific GET .../apps. Write: POST .../managedAppPolicies/{id}/targetApps (MAMAdmin rejects POST .../apps).
    $appsGraphVersion = 'v1.0'
    $policyAppsBaseUri = Get-ManagedAppProtectionPolicyAppsBaseUri -GraphApiVersion $appsGraphVersion -IsAndroid $IsAndroid -PolicyId $PolicyId
    $desiredBodies = @(Get-NormalizedAppProtectionAppPostBodies -BaselineConfig $BaselineConfig)
    $desiredKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($d in $desiredBodies) {
        $k = Get-ManagedMobileAppStableKey -App $d
        if ($k) { [void]$desiredKeys.Add($k) }
    }
    if ($desiredBodies.Count -eq 0) {
        Write-Host "  [!] appGroupType is selectedPublicApps but baseline has no valid apps entries; skipping targetApps (add apps to baseline or change appGroupType)." -ForegroundColor Yellow
        return $summary
    }
    $existingList = @(Get-ManagedAppProtectionAppsPaginated -PolicyAppsBaseUri $policyAppsBaseUri)
    $existingKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($e in $existingList) {
        $k = Get-ManagedMobileAppStableKey -App $e
        if ($k) { [void]$existingKeys.Add($k) }
    }
    $toAdd = @($desiredKeys | Where-Object { -not $existingKeys.Contains($_) })
    $toRemove = @($existingKeys | Where-Object { -not $desiredKeys.Contains($_) })
    $needsWrite = ($toAdd.Count -gt 0 -or $toRemove.Count -gt 0)
    if (-not $needsWrite) {
        if ($WhatIf) {
            Write-Host "  [WhatIf] App targeting already matches baseline ($($desiredKeys.Count) app(s))"
        }
        return $summary
    }
    $policySeg = [Uri]::EscapeDataString($PolicyId)
    $targetAppsUri = "https://graph.microsoft.com/$appsGraphVersion/deviceAppManagement/managedAppPolicies/$policySeg/targetApps"
    if ($WhatIf) {
        foreach ($k in $toRemove) { Write-Host "  [WhatIf] Would remove targeted app '$k' (via targetApps replace)" }
        foreach ($k in $toAdd) { Write-Host "  [WhatIf] Would add targeted app '$k' (via targetApps replace)" }
        Write-Host "  [WhatIf] Would POST targetApps: $targetAppsUri ($($desiredBodies.Count) app(s))"
        return $summary
    }
    $payload = @{
        'appGroupType' = 'selectedPublicApps'
        'apps'         = @($desiredBodies)
    }
    $jsonBody = ConvertTo-SafeJson -InputObject $payload -Depth 20
    Invoke-MgGraphRequest -Method POST -Uri $targetAppsUri -Body $jsonBody -ContentType "application/json"
    $summary.Added = $toAdd.Count
    $summary.Removed = $toRemove.Count
    if ($summary.Added -gt 0 -or $summary.Removed -gt 0) {
        Write-Host "  [+] App targeting sync (targetApps): +$($summary.Added) / -$($summary.Removed) (total $($desiredBodies.Count))"
    }
    return $summary
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-AppProtectionPolicies {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        $isAndroid = $displayName -match "Android" -or $policyConfig.'@odata.type' -like "*android*"
        
        Write-Host "`n##[group]Processing [app-protection]: $displayName"
        
        try {
            # Check if policy exists
            $existingPolicy = $null
            $policyTypeKey = if ($isAndroid) { "app-protection-android" } else { "app-protection-ios" }
            $allPolicies = Get-AllPoliciesOfType -PolicyType $policyTypeKey
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
                        PolicyType = "app-protection"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Compare key properties to determine if update is needed
                # Fetch the policy body and apps via separate beta requests — mirroring the backup
                # approach — so both sides use the same API and field set. Using $expand=apps on the
                # compare GET injects an 'apps@odata.context' OData annotation that is absent from
                # the baseline, causing a spurious "Removed" diff every run.
                $mamUri = if ($isAndroid) {
                    "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$($existingPolicy.id)"
                } else {
                    "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$($existingPolicy.id)"
                }
                $mamAppsUri = if ($isAndroid) {
                    "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$($existingPolicy.id)/apps"
                } else {
                    "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$($existingPolicy.id)/apps"
                }
                $existingPolicyExpanded = $null
                try {
                    $existingPolicyExpanded = Invoke-MgGraphRequest -Method GET -Uri $mamUri
                    # Fetch apps separately — same pattern as backup — to avoid $expand injecting
                    # OData annotation keys into the comparison object.
                    try {
                        $appsResponse = Invoke-MgGraphRequest -Method GET -Uri $mamAppsUri
                        $fetchedApps = @($appsResponse.value)
                        if ($existingPolicyExpanded -is [hashtable]) {
                            $existingPolicyExpanded['apps'] = $fetchedApps
                        } else {
                            $existingPolicyExpanded | Add-Member -NotePropertyName 'apps' -NotePropertyValue $fetchedApps -Force
                        }
                    }
                    catch {
                        Write-Host "  [!] Could not fetch apps for existing policy; comparing without apps: $_" -ForegroundColor Yellow
                    }
                }
                catch {
                    Write-Host "  [!] Could not fetch existing policy for comparison: $_" -ForegroundColor Yellow
                    $existingPolicyExpanded = $existingPolicy
                }
                $existingForCompare = Prepare-ManagedAppProtectionForCompare -Policy $existingPolicyExpanded
                $desiredForCompare = Prepare-ManagedAppProtectionForCompare -Policy $policyConfig

                # Ignore runtime/status properties AND nullable properties that API may add with defaults
                $ignoreProps = @(
                    # Runtime/status properties (apps / exemptedAppProtocols compared explicitly above)
                    'deployedAppCount', 'isAssigned',
                    # Version properties that may be null
                    'minimumRequiredAppVersion', 'minimumRequiredSdkVersion', 'minimumRequiredOsVersion',
                    'minimumRequiredCompanyPortalVersion', 'minimumRequiredPatchVersion',
                    'minimumWarningAppVersion', 'minimumWarningOsVersion', 'minimumWarningCompanyPortalVersion',
                    'minimumWarningPatchVersion', 'minimumWipeAppVersion', 'minimumWipeOsVersion',
                    'minimumWipeCompanyPortalVersion', 'minimumWipePatchVersion', 'minimumWipeSdkVersion',
                    'maximumRequiredOsVersion', 'maximumWarningOsVersion', 'maximumWipeOsVersion',
                    'minimumWarningSdkVersion',
                    # Action properties (API defaults)
                    'appActionIfAccountIsClockedOut', 'appActionIfDevicePasscodeComplexityLessThanHigh',
                    'appActionIfDevicePasscodeComplexityLessThanMedium', 'appActionIfDevicePasscodeComplexityLessThanLow',
                    'appActionIfSamsungKnoxAttestationRequired', 'appActionIfUnableToAuthenticateUser',
                    # iOS-specific intelligence properties
                    'writingToolsConfigurationState', 'genmojiConfigurationState',
                    'imagePlaygroundConfigurationState', 'intelligenceConfigurationState',
                    'screenCaptureConfigurationState',
                    # Other nullable properties
                    'fingerprintAndBiometricEnabled', 'mobileThreatDefensePartnerPriority',
                    'gracePeriodToBlockAppsDuringOffClockHours', 'pinRequiredInsteadOfBiometricTimeout',
                    # Browser/Dialer customization
                    'customBrowserProtocol', 'customBrowserPackageId', 'customBrowserDisplayName',
                    'customDialerAppProtocol', 'customDialerAppPackageId', 'customDialerAppDisplayName',
                    # Array properties that may be null or empty
                    'approvedKeyboards', 'allowedAndroidDeviceModels', 'allowedAndroidDeviceManufacturers',
                    'allowedIosDeviceModels', 'allowedDataStorageLocations', 'allowedDataIngestionLocations',
                    'exemptedUniversalLinks', 'managedUniversalLinks', 'exemptedAppPackages'
                )
                # If the baseline explicitly sets a version/patch property (non-null, non-empty),
                # remove it from $ignoreProps so the comparison can detect the change and trigger an update.
                $versionPropsInIgnore = @(
                    'minimumRequiredAppVersion', 'minimumRequiredSdkVersion', 'minimumRequiredOsVersion',
                    'minimumRequiredCompanyPortalVersion', 'minimumRequiredPatchVersion',
                    'minimumWarningAppVersion', 'minimumWarningOsVersion', 'minimumWarningCompanyPortalVersion',
                    'minimumWarningPatchVersion', 'minimumWipeAppVersion', 'minimumWipeOsVersion',
                    'minimumWipeCompanyPortalVersion', 'minimumWipePatchVersion', 'minimumWipeSdkVersion',
                    'maximumRequiredOsVersion', 'maximumWarningOsVersion', 'maximumWipeOsVersion',
                    'minimumWarningSdkVersion'
                )
                $explicitlySetVersionProps = $versionPropsInIgnore | Where-Object {
                    $val = if ($policyConfig -is [hashtable]) { $policyConfig[$_] } else { $policyConfig.$_ }
                    $null -ne $val -and '' -ne $val
                }
                if ($explicitlySetVersionProps.Count -gt 0) {
                    $ignoreProps = $ignoreProps | Where-Object { $_ -notin $explicitlySetVersionProps }
                    Write-Host "  [Info] Version properties set in baseline — included in comparison: $($explicitlySetVersionProps -join ', ')" -ForegroundColor Cyan
                }
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingForCompare -DesiredPolicy $desiredForCompare -IgnoreProperties $ignoreProps -ReturnDetails
                
                if ($comparison.IsEquivalent) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Policy exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  Policy exists - changes detected, will be updated"
                    if ($changeDetails.Added.Count -gt 0) { Write-Host "    Added: $($changeDetails.Added -join ', ')" }
                    if ($changeDetails.Removed.Count -gt 0) { Write-Host "    Removed: $($changeDetails.Removed -join ', ')" }
                    if ($changeDetails.Modified.Count -gt 0) { Write-Host "    Modified: $($changeDetails.Modified -join ', ')" }
                }
            }
            else {
                Write-Host "  Policy does not exist - will be created"
            }
            
            Write-Host "  Type: App Protection Policy ($( if ($isAndroid) { 'Android' } else { 'iOS' } ))"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $policyTypeKey -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                elseif ($action -eq "Update" -and $existingPolicy -and (Test-AppProtectionAppsSyncApplicable -BaselineConfig $policyConfig)) {
                    Sync-AppProtectionPolicyApps -PolicyId $existingPolicy.id -IsAndroid $isAndroid -BaselineConfig $policyConfig -WhatIf | Out-Null
                }
                elseif ($action -eq "Create" -and (Test-AppProtectionAppsSyncApplicable -BaselineConfig $policyConfig)) {
                    $n = @(Get-NormalizedAppProtectionAppPostBodies -BaselineConfig $policyConfig).Count
                    Write-Host "  [WhatIf] After policy create, would sync $n targeted app(s) on .../apps"
                }
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    Platform = if ($isAndroid) { "Android" } else { "iOS" }
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no policy content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $policyTypeKey -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                    Platform    = if ($isAndroid) { "Android" } else { "iOS" }
                }
                continue
            }
            
            # Repair the policy payload (apply monitor filter for PATCH when sidecar is active)
            $patchPolicyConfig = if ($action -ne "Create") {
                $filtered = Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig
                Merge-AppProtectionBaselineFieldsNotInMonitor -FilteredPatchBody $filtered -FullBaselineConfig $policyConfig
            } else { $policyConfig }
            $repairedConfig = Repair-AppProtectionPayload -Payload $patchPolicyConfig
            
            # Determine endpoint
            $uri = if ($isAndroid) {
                "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections"
            } else {
                "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections"
            }
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] App Protection Policy created: $displayName (ID: $policyId)"
            }
            else {
                $patchUri = "$uri/$($existingPolicy.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                $policyId = $existingPolicy.id
                Write-Host "  [+] App Protection Policy updated: $displayName"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType $policyTypeKey -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
                if (Test-AppProtectionAppsSyncApplicable -BaselineConfig $policyConfig) {
                    Sync-AppProtectionPolicyApps -PolicyId $policyId -IsAndroid $isAndroid -BaselineConfig $policyConfig -WhatIf:$WhatIf | Out-Null
                }
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
                Platform = if ($isAndroid) { "Android" } else { "iOS" }
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
                Platform = if ($isAndroid) { "Android" } else { "iOS" }
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

# Filter to only app-protection policies
$appProtectionPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "app-protection" }

if ($appProtectionPolicies.Count -eq 0) {
    Write-Host "No App Protection policies to process"
    return @()
}

Write-Host "`n##[section]Processing App Protection Policies ($($appProtectionPolicies.Count) policies)"

$results = Invoke-AppProtectionPolicies -Policies $appProtectionPolicies -WhatIf:$WhatIfMode

# Return results for summary
return $results

