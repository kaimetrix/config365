<#
.SYNOPSIS
    Creates and manages Intune Endpoint Security policies via Microsoft Graph API
    
.DESCRIPTION
    Handles Endpoint Security policies (intents) like Account Protection, Antivirus, etc.
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
# ENDPOINT SECURITY SPECIFIC FUNCTIONS
# ============================================================================

<#
.SYNOPSIS
    Fetches the settings collection for an existing Endpoint Security intent.
.DESCRIPTION
    Endpoint Security policies (intents) store their setting values at
    /deviceManagement/intents/{id}/settings. The list endpoint that returns
    intents themselves does NOT include settings, so this must be fetched
    separately when comparing tenant state to baseline.
#>
function Get-IntentSettings {
    param(
        [Parameter(Mandatory=$true)]
        [string]$IntentId
    )

    if (-not $script:IntentSettingsCache) { $script:IntentSettingsCache = @{} }
    if ($script:IntentSettingsCache.ContainsKey($IntentId)) {
        return $script:IntentSettingsCache[$IntentId]
    }

    $settings = @()
    try {
        $uri = "https://graph.microsoft.com/beta/deviceManagement/intents/$IntentId/settings"
        do {
            $response = Invoke-MgGraphRequest -Method GET -Uri $uri
            if ($response.value) { $settings += $response.value }
            $uri = $response.'@odata.nextLink'
        } while ($uri)
    }
    catch {
        Write-Verbose "  Failed to fetch settings for intent ${IntentId}: $_"
    }

    $script:IntentSettingsCache[$IntentId] = $settings
    return $settings
}

<#
.SYNOPSIS
    Compares baseline settings against the tenant's current intent settings.
.DESCRIPTION
    Endpoint Security intents store settings as a flat list keyed by
    definitionId. Tenant-side records also carry a per-instance random `id`
    (and read-only `@odata.context`) that must be ignored when comparing.

    Returns a hashtable:
        IsEquivalent : [bool]
        Added        : definitionIds present in baseline but missing in tenant
        Removed      : definitionIds present in tenant but missing in baseline
        Modified     : array of "definitionId: '<existing>' -> '<desired>'" strings
#>
function Compare-IntentSettings {
    param(
        [Parameter(Mandatory=$false)]$BaselineSettings,
        [Parameter(Mandatory=$false)]$TenantSettings
    )

    function _Normalize($items) {
        $map = @{}
        if (-not $items) { return $map }
        foreach ($s in @($items)) {
            if (-not $s) { continue }
            $defId = if ($s -is [hashtable]) { $s['definitionId'] } else { $s.definitionId }
            if (-not $defId) { continue }
            $valueJson = if ($s -is [hashtable]) { $s['valueJson'] } else { $s.valueJson }
            if ($null -eq $valueJson) {
                $value = if ($s -is [hashtable]) { $s['value'] } else { $s.value }
                $valueJson = ($value | ConvertTo-Json -Compress -Depth 20 -ErrorAction SilentlyContinue)
            }
            $odataType = if ($s -is [hashtable]) { $s['@odata.type'] } else { $s.'@odata.type' }
            $map[$defId] = [ordered]@{ valueJson = $valueJson; odataType = $odataType }
        }
        return $map
    }

    $baseMap = _Normalize $BaselineSettings
    $liveMap = _Normalize $TenantSettings

    $added    = @()
    $removed  = @()
    $modified = @()

    foreach ($key in $baseMap.Keys) {
        if (-not $liveMap.ContainsKey($key)) {
            $added += $key
            continue
        }
        $b = $baseMap[$key].valueJson
        $l = $liveMap[$key].valueJson
        if ($b -ne $l) {
            $bs = if ($b.Length -gt 60) { $b.Substring(0,57) + '...' } else { $b }
            $ls = if ($l.Length -gt 60) { $l.Substring(0,57) + '...' } else { $l }
            $modified += "${key}: '$ls' -> '$bs'"
        }
    }
    foreach ($key in $liveMap.Keys) {
        if (-not $baseMap.ContainsKey($key)) { $removed += $key }
    }

    return @{
        IsEquivalent = ($added.Count -eq 0 -and $removed.Count -eq 0 -and $modified.Count -eq 0)
        Added        = $added
        Removed      = $removed
        Modified     = $modified
        BaselineCount= $baseMap.Count
        TenantCount  = $liveMap.Count
    }
}

<#
.SYNOPSIS
    Builds the settings payload accepted by /intents/{id}/updateSettings.
.DESCRIPTION
    The Graph API expects an array of setting objects whose tenant-specific
    `id` must be omitted on create. For updates, supplying just definitionId
    + value + @odata.type is sufficient.
#>
function ConvertTo-IntentSettingsPayload {
    param([Parameter(Mandatory=$false)]$Settings)
    $out = @()
    foreach ($s in @($Settings)) {
        if (-not $s) { continue }
        $clean = [ordered]@{}
        $clean['definitionId'] = if ($s -is [hashtable]) { $s['definitionId'] } else { $s.definitionId }
        $odataType = if ($s -is [hashtable]) { $s['@odata.type'] } else { $s.'@odata.type' }
        $clean['@odata.type'] = $odataType
        # Prefer 'value' if present, otherwise parse valueJson back
        $value     = if ($s -is [hashtable]) { $s['value']     } else { $s.value }
        $valueJson = if ($s -is [hashtable]) { $s['valueJson'] } else { $s.valueJson }
        if ($null -eq $value -and $valueJson) {
            try { $value = $valueJson | ConvertFrom-Json -ErrorAction Stop } catch { $value = $valueJson }
        }

        # Graph's intent settings API rejects `value: null` for Collection types
        # with ModelValidationFailure ("a 'StartArray' node was expected"). Coerce
        # null/scalar to an array for any *Collection* setting type. Single non-array
        # scalars are also wrapped so the @odata.type contract is honored.
        if ($odataType -and $odataType -match 'Collection(SettingInstance)$') {
            if ($null -eq $value) {
                $value = @()
            }
            elseif ($value -isnot [System.Collections.IList] -or $value -is [string]) {
                $value = @($value)
            }
            else {
                $value = @($value)  # force [array] so ConvertTo-Json emits []
            }
        }

        $clean['value'] = $value
        if ($valueJson) { $clean['valueJson'] = $valueJson }
        $out += $clean
    }
    return $out
}

function Repair-EndpointSecurityPayload {
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
                       'isAssigned', 'settingCount')
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
    
    # Final cleanup
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
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-EndpointSecurityPolicies {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        
        Write-Host "`n##[group]Processing [endpoint-security]: $displayName"
        
        try {
            # Check if policy exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType "endpoint-security"
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
                        PolicyType = "endpoint-security"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Endpoint Security (intents) comparison - compare displayName, description, templateId
                # Settings are more complex and stored separately, so we compare basic metadata
                $ignoreProps = @(
                    # Runtime/status properties
                    'settings', 'categories', 'assignments', 'deviceStateSummary', 'deviceStates', 
                    'userStateSummary', 'userStates', 'isAssigned', 'lastModifiedDateTime',
                    # API-specific template properties - these are derived from templateId
                    'templateName', 'templateDisplayName', 'templateDisplayVersion',
                    # Description may be empty string vs null
                    'description',
                    # Migration flag added by Intune when migrating old policies - read-only, cannot be removed
                    'isMigratingToConfigurationPolicy'
                )
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingPolicy -DesiredPolicy $policyConfig -IgnoreProperties $ignoreProps -ReturnDetails

                # Endpoint Security settings live at a separate endpoint and must be
                # compared explicitly. Fetch tenant-side settings and diff by definitionId.
                $liveSettings    = Get-IntentSettings -IntentId $existingPolicy.id
                $settingsCompare = Compare-IntentSettings -BaselineSettings $policyConfig.settings -TenantSettings $liveSettings

                $metadataDiffers = -not $comparison.IsEquivalent
                $settingsDiffer  = -not $settingsCompare.IsEquivalent

                if (-not $metadataDiffers -and -not $settingsDiffer) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Policy exists - no changes needed (metadata + $($settingsCompare.BaselineCount) setting(s) match)"
                }
                else {
                    $action = "Update"
                    # Merge metadata diff + settings diff into a single details object so
                    # the WhatIf summary can surface every change in one place.
                    $changeDetails = if ($comparison.Differences) {
                        @{
                            Added    = @($comparison.Differences.Added)
                            Removed  = @($comparison.Differences.Removed)
                            Modified = @($comparison.Differences.Modified)
                        }
                    } else {
                        @{ Added = @(); Removed = @(); Modified = @() }
                    }
                    if ($settingsDiffer) {
                        foreach ($a in $settingsCompare.Added)    { $changeDetails.Added    += "settings.$a" }
                        foreach ($r in $settingsCompare.Removed)  { $changeDetails.Removed  += "settings.$r" }
                        foreach ($m in $settingsCompare.Modified) { $changeDetails.Modified += "settings.$m" }
                    }
                    Write-Host "  Policy exists - changes detected, will be updated"
                    if ($metadataDiffers) { Write-Host "    Metadata differs" }
                    if ($settingsDiffer)  { Write-Host "    Settings differ: +$($settingsCompare.Added.Count) -$($settingsCompare.Removed.Count) ~$($settingsCompare.Modified.Count) (of $($settingsCompare.BaselineCount) baseline / $($settingsCompare.TenantCount) tenant)" }
                    if ($changeDetails.Added.Count   -gt 0) { Write-Host "    Added:    $($changeDetails.Added    -join ', ')" }
                    if ($changeDetails.Removed.Count -gt 0) { Write-Host "    Removed:  $($changeDetails.Removed  -join ', ')" }
                    if ($changeDetails.Modified.Count -gt 0) { Write-Host "    Modified: $($changeDetails.Modified -join ', ')" }
                }
            }
            else {
                Write-Host "  Policy does not exist - will be created"
            }
            
            Write-Host "  Type: Endpoint Security"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "endpoint-security" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
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
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "endpoint-security" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                }
                continue
            }
            
            # Repair the payload
            $repairedConfig = Repair-EndpointSecurityPayload -Payload $policyConfig
            
            # For endpoint security (intents), we need to use the intent creation API
            $templateId = $repairedConfig.templateId
            if (-not $templateId) {
                throw "Endpoint security policy requires templateId"
            }
            
            $policyId = $null
            if ($action -eq "Create") {
                # Endpoint Security intents are created via the template instance endpoint
                # which accepts the FULL payload including settings up-front. This avoids
                # a separate updateSettings call (and is required for some templates).
                $intentBody = @{
                    displayName     = $displayName
                    description     = if ($repairedConfig.description) { $repairedConfig.description } else { "" }
                    roleScopeTagIds = $repairedConfig.roleScopeTagIds
                    settings        = @(ConvertTo-IntentSettingsPayload -Settings $policyConfig.settings)
                }

                $uri = "https://graph.microsoft.com/beta/deviceManagement/templates/$templateId/createInstance"
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body ($intentBody | ConvertTo-Json -Depth 30) -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] Endpoint Security created: $displayName (ID: $policyId, $($intentBody.settings.Count) setting(s) applied)"
            }
            else {
                # Update existing intent - metadata first, then settings via updateSettings
                $patchRepairedConfig = Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig -ExcludeProperties @('templateId')
                $patchBody = @{}
                if ($patchRepairedConfig.ContainsKey('displayName'))    { $patchBody['displayName']    = $displayName }
                if ($patchRepairedConfig.ContainsKey('description'))    { $patchBody['description']    = if ($patchRepairedConfig.description) { $patchRepairedConfig.description } else { "" } }
                if ($patchRepairedConfig.ContainsKey('roleScopeTagIds')){ $patchBody['roleScopeTagIds'] = $patchRepairedConfig.roleScopeTagIds }
                if ($patchBody.Count -gt 0) {
                    $patchUri = "https://graph.microsoft.com/beta/deviceManagement/intents/$($existingPolicy.id)"
                    Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body ($patchBody | ConvertTo-Json -Depth 10) -ContentType "application/json"
                    Write-Host "  [+] Endpoint Security metadata patched: $displayName"
                }

                # Push baseline settings only if they actually differ — avoids unnecessary
                # PATCH traffic and keeps the Graph audit log clean.
                if (-not $settingsCompare.IsEquivalent) {
                    $updateBody = @{ settings = @(ConvertTo-IntentSettingsPayload -Settings $policyConfig.settings) }
                    $updateUri  = "https://graph.microsoft.com/beta/deviceManagement/intents/$($existingPolicy.id)/updateSettings"
                    Invoke-MgGraphRequest -Method POST -Uri $updateUri -Body ($updateBody | ConvertTo-Json -Depth 30) -ContentType "application/json"
                    Write-Host "  [+] Endpoint Security settings updated: $displayName ($($updateBody.settings.Count) setting(s))"
                    # Invalidate cached settings so subsequent runs see fresh state
                    if ($script:IntentSettingsCache) { $script:IntentSettingsCache.Remove($existingPolicy.id) }
                }
                $policyId = $existingPolicy.id
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "endpoint-security" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
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

$endpointSecurityPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "endpoint-security" }

if ($endpointSecurityPolicies.Count -eq 0) {
    Write-Host "No Endpoint Security policies to process"
    return @()
}

Write-Host "`n##[section]Processing Endpoint Security Policies ($($endpointSecurityPolicies.Count) policies)"

$results = Invoke-EndpointSecurityPolicies -Policies $endpointSecurityPolicies -WhatIf:$WhatIfMode

return $results

