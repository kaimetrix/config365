<#
.SYNOPSIS
    Creates and manages Windows Update policies via Microsoft Graph API
    
.DESCRIPTION
    Handles Windows Update rings, Feature updates, Quality updates, and Driver updates.
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
# WINDOWS UPDATE SPECIFIC REPAIR FUNCTIONS
# ============================================================================

function Repair-WindowsUpdateRingPayload {
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
                       'deviceManagementApplicabilityRuleDeviceMode',
                       'featureUpdatesWillBeRolledBack', 'qualityUpdatesWillBeRolledBack')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -is [string]) {
            $json['roleScopeTagIds'] = @($tagIds)
        }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    # Ensure @odata.type is present
    if (-not $json.ContainsKey('@odata.type')) {
        $json['@odata.type'] = '#microsoft.graph.windowsUpdateForBusinessConfiguration'
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

function Repair-WindowsFeatureUpdatePayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', 'deployableContentDisplayName', 'endOfSupportDate',
                       '_sourceFile', '_policyType', '_assignments', '_settings')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) { $json['roleScopeTagIds'] = @("0") }
        elseif ($tagIds -is [string]) { $json['roleScopeTagIds'] = @($tagIds) }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    return $json
}

function Repair-WindowsQualityUpdatePayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', 'releaseDateDisplayName',
                       '_sourceFile', '_policyType', '_assignments', '_settings')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) { $json['roleScopeTagIds'] = @("0") }
        elseif ($tagIds -is [string]) { $json['roleScopeTagIds'] = @($tagIds) }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    return $json
}

function Repair-WindowsDriverUpdatePayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', 'deviceReporting', 'newUpdates',
                       '_sourceFile', '_policyType', '_assignments', '_settings')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) { $json['roleScopeTagIds'] = @("0") }
        elseif ($tagIds -is [string]) { $json['roleScopeTagIds'] = @($tagIds) }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    return $json
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-WindowsUpdatePolicies {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        $policyType = $policyConfig._policyType
        
        Write-Host "`n##[group]Processing [$policyType]: $displayName"
        
        try {
            # Determine URI and repair function based on policy type
            $uri = $null
            $repairedConfig = $null
            $lookupType = $null
            
            switch ($policyType) {
                "windows-updates" {
                    $uri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"
                    $repairedConfig = Repair-WindowsUpdateRingPayload -Payload $policyConfig
                    $lookupType = "windows-updates"
                }
                "windows-feature-updates" {
                    $uri = "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles"
                    $repairedConfig = Repair-WindowsFeatureUpdatePayload -Payload $policyConfig
                    $lookupType = "windows-feature-updates"
                }
                "windows-quality-updates" {
                    $uri = "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles"
                    $repairedConfig = Repair-WindowsQualityUpdatePayload -Payload $policyConfig
                    $lookupType = "windows-quality-updates"
                }
                "windows-driver-updates" {
                    $uri = "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles"
                    $repairedConfig = Repair-WindowsDriverUpdatePayload -Payload $policyConfig
                    $lookupType = "windows-driver-updates"
                }
                default {
                    throw "Unknown Windows Update policy type: $policyType"
                }
            }
            
            # Check if policy exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType $lookupType
            $existingPolicy = $allPolicies | Where-Object { $_.displayName.Trim() -ieq $displayName } | Select-Object -First 1
            
            $action = "Create"
            $hasChanges = $true
            
            $typeNames = @{
                "windows-updates" = "Windows Update Ring"
                "windows-feature-updates" = "Windows Feature Update Profile"
                "windows-quality-updates" = "Windows Quality Update Profile"
                "windows-driver-updates" = "Windows Driver Update Profile"
            }
            
            $changeDetails = $null
            if ($existingPolicy) {
                # Check if policy is protected from baseline updates via description marker
                if (Test-ResourceProtected -Description $existingPolicy.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  [!] Protected: Policy has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = $policyType
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Windows Update policies comparison - ignore runtime/status properties
                $ignoreProps = @('assignments', 'deviceUpdateStates', 'userStatuses', 'deviceStatuses', 
                                 'installLatestWindows10OnWindows11IneligibleDevice', 'driversExcluded',
                                 'approvalType', 'deployableContentDisplayName', 'endOfSupportDate',
                                 'featureUpdatesWillBeRolledBack', 'qualityUpdatesWillBeRolledBack')
                # Driver update profiles return read-only reporting fields that cannot be PATCHed
                if ($policyType -eq 'windows-driver-updates') {
                    $ignoreProps += @('deviceReporting', 'newUpdates')
                }
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingPolicy -DesiredPolicy $policyConfig -IgnoreProperties $ignoreProps -ReturnDetails
                
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
            
            Write-Host "  Type: $($typeNames[$policyType])"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $policyType -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    PolicyType = $policyType
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no policy content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $policyType -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                    PolicyType  = $policyType
                }
                continue
            }
            
            # Apply monitor filter for PATCH/update operations
            $patchRepairedConfig = if ($action -ne "Create") {
                $patchPayload = Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig
                switch ($policyType) {
                    "windows-updates" { Repair-WindowsUpdateRingPayload -Payload $patchPayload }
                    "windows-feature-updates" { Repair-WindowsFeatureUpdatePayload -Payload $patchPayload }
                    "windows-quality-updates" { Repair-WindowsQualityUpdatePayload -Payload $patchPayload }
                    "windows-driver-updates" { Repair-WindowsDriverUpdatePayload -Payload $patchPayload }
                    default { $repairedConfig }
                }
            } else { $repairedConfig }

            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $patchRepairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body (ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30) -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] $($typeNames[$policyType]) created: $displayName (ID: $policyId)"
            }
            else {
                # Windows Feature Update and Quality Update profiles don't support PATCH
                # They must be deleted and recreated
                if ($policyType -in @("windows-feature-updates", "windows-quality-updates")) {
                    $deleteUri = "$uri/$($existingPolicy.id)"
                    Write-Host "  Deleting existing policy (recreate required for this policy type)..."
                    Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
                    
                    # Create new policy
                    $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                    $policyId = $response.id
                    Write-Host "  [+] $($typeNames[$policyType]) recreated: $displayName (ID: $policyId)"
                }
                else {
                    # Other policy types support PATCH
                    $patchUri = "$uri/$($existingPolicy.id)"
                    Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                    $policyId = $existingPolicy.id
                    Write-Host "  [+] $($typeNames[$policyType]) updated: $displayName"
                }
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType $policyType -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
                PolicyType = $policyType
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
                PolicyType = $policyType
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

$windowsUpdatePolicies = $PolicyConfigs | Where-Object { 
    $_._policyType -in @("windows-updates", "windows-feature-updates", "windows-quality-updates", "windows-driver-updates") 
}

if ($windowsUpdatePolicies.Count -eq 0) {
    Write-Host "No Windows Update policies to process"
    return @()
}

Write-Host "`n##[section]Processing Windows Update Policies ($($windowsUpdatePolicies.Count) policies)"

$results = Invoke-WindowsUpdatePolicies -Policies $windowsUpdatePolicies -WhatIf:$WhatIfMode

return $results

