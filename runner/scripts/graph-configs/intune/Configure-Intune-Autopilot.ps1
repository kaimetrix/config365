<#
.SYNOPSIS
    Creates and manages Windows Autopilot profiles via Microsoft Graph API
    
.DESCRIPTION
    Handles Windows Autopilot deployment profiles.
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
# AUTOPILOT SPECIFIC REPAIR FUNCTION
# ============================================================================

function Repair-AutopilotPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context',
                       '_sourceFile', '_policyType', '_assignments', '_settings',
                       'managementServiceAppId')
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
    
    # Ensure @odata.type is present for Autopilot profiles
    if (-not $json.ContainsKey('@odata.type')) {
        $json['@odata.type'] = '#microsoft.graph.azureADWindowsAutopilotDeploymentProfile'
    }
    
    # Remove null properties
    $propsToRemoveIfNull = @('enrollmentStatusScreenSettings', 'managementServiceAppId',
                             'deviceNameTemplate', 'language', 'locale')
    foreach ($prop in $propsToRemoveIfNull) {
        if ($json.ContainsKey($prop) -and $null -eq $json[$prop]) {
            $json.Remove($prop)
        }
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

function Invoke-AutopilotProfiles {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles"
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        
        Write-Host "`n##[group]Processing [autopilot]: $displayName"
        
        try {
            # Check if profile exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType "autopilot"
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
                        PolicyType = "autopilot"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Autopilot profile comparison
                $ignoreProps = @('assignments', 'assignedDevices', 'managementServiceAppId')
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingPolicy -DesiredPolicy $policyConfig -IgnoreProperties $ignoreProps -ReturnDetails
                
                if ($comparison.IsEquivalent) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Profile exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  Profile exists - changes detected, will be updated"
                    if ($changeDetails.Added.Count -gt 0) { Write-Host "    Added: $($changeDetails.Added -join ', ')" }
                    if ($changeDetails.Removed.Count -gt 0) { Write-Host "    Removed: $($changeDetails.Removed -join ', ')" }
                    if ($changeDetails.Modified.Count -gt 0) { Write-Host "    Modified: $($changeDetails.Modified -join ', ')" }
                }
            }
            else {
                Write-Host "  Profile does not exist - will be created"
            }
            
            Write-Host "  Type: Autopilot Profile"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus profile: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "autopilot" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
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
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "autopilot" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                }
                continue
            }
            
            # Repair the payload
            $patchPolicyConfig = if ($action -ne "Create") { Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig } else { $policyConfig }
            $repairedConfig = Repair-AutopilotPayload -Payload $patchPolicyConfig
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $createRepairedConfig = Repair-AutopilotPayload -Payload $policyConfig
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body (ConvertTo-SafeJson -InputObject $createRepairedConfig -Depth 30) -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] Autopilot Profile created: $displayName (ID: $policyId)"
            }
            else {
                $patchUri = "$uri/$($existingPolicy.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                $policyId = $existingPolicy.id
                Write-Host "  [+] Autopilot Profile updated: $displayName"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "autopilot" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
            }
        }
        catch {
            $errStr = $_.ToString()

            # FeatureNotEnabled / Forbidden from the Autopilot service means this tenant
            # doesn't have the Autopilot feature licensed or enabled (common in dev/test
            # tenants).  Treat as a warning rather than a hard failure so the pipeline
            # step doesn't turn red and block other policies.
            $isFeatureGap = $errStr -match '"code"\s*:\s*"FeatureNotEnabled"' -or
                            ($errStr -match '403' -and $errStr -match 'DeviceEnrollmentFE')

            if ($isFeatureGap) {
                Write-Host "  ⚠ Autopilot assignment skipped — FeatureNotEnabled (tenant may not have Autopilot licensed/enabled)" -ForegroundColor Yellow
                Write-Host "##[warning]Autopilot assignment not supported on this tenant for: $displayName"
                $results += @{
                    DisplayName = $displayName
                    Status = "SkippedFeatureNotEnabled"
                    Error = "Autopilot assignments not supported on this tenant"
                }
            }
            else {
                Write-Host "  ✗ Failed to $($action.ToLower()) profile: $errStr" -ForegroundColor Red
                Write-Host "##[error]Failed to process profile: $displayName"
                Write-Host "##[error]Error: $errStr"
                $results += @{
                    DisplayName = $displayName
                    Status = "Failed"
                    Error = $errStr
                }
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

$autopilotPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "autopilot" }

if ($autopilotPolicies.Count -eq 0) {
    Write-Host "No Autopilot profiles to process"
    return @()
}

Write-Host "`n##[section]Processing Autopilot Profiles ($($autopilotPolicies.Count) profiles)"

$results = Invoke-AutopilotProfiles -Policies $autopilotPolicies -WhatIf:$WhatIfMode

return $results

