<#
.SYNOPSIS
    Creates and manages Intune Compliance policies via Microsoft Graph API
    
.DESCRIPTION
    Handles device compliance policies for Windows, Android, iOS, and macOS.
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
# COMPLIANCE POLICY SPECIFIC REPAIR FUNCTION
# ============================================================================

function Repair-CompliancePolicyPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload,
        [switch]$IsUpdate
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context',
                       '_sourceFile', '_policyType', '_assignments', '_settings',
                       'assignments'  # Navigation property
                       )
    
    # For PATCH operations, also remove scheduledActionsForRule (navigation property can't be PATCHed)
    if ($IsUpdate) {
        $propsToRemove += 'scheduledActionsForRule'
    }
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
        # Ensure it's a proper array
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    # Remove null properties that API won't accept
    $propsToRemoveIfNull = @('restrictedApps', 'validOperatingSystemBuildRanges',
                   'deviceThreatProtectionRequiredSecurityLevel', 'advancedThreatProtectionRequiredSecurityLevel',
                   # Windows compliance specific
                   'defenderEnabled', 'bitLockerEnabled', 'secureBootEnabled',
                   'codeIntegrityEnabled', 'storageRequireEncryption', 'wslDistributions',
                   'configurationManagerComplianceRequired', 'tpmRequired', 'deviceCompliancePolicyScript',
                   'activeFirewallRequired', 'antiSpywareRequired', 'antivirusRequired',
                   'defenderVersion', 'signatureOutOfDate', 'rtpEnabled',
                   # Android compliance specific
                   'passwordBlockSimple', 'passwordMinimumLength', 'passwordRequiredType',
                   'passwordMinutesOfInactivityBeforeLock', 'passwordExpirationDays',
                   'passwordPreviousPasswordBlockCount', 'securityBlockJailbrokenDevices',
                   'requiredPasswordComplexity', 'passwordRequiredToUnlockFromIdle',
                   # iOS/macOS compliance specific
                   'passcodeBlockSimple', 'passcodeMinimumLength', 'passcodeMinutesOfInactivityBeforeLock',
                   'passcodeMinimumCharacterSetCount', 'passcodeExpirationDays', 'passcodePreviousPasscodeBlockCount')
    foreach ($prop in $propsToRemoveIfNull) {
        if ($json.ContainsKey($prop) -and $null -eq $json[$prop]) {
            $json.Remove($prop)
        }
    }
    
    # scheduledActionsForRule is REQUIRED for CREATE but cannot be PATCHed for UPDATE
    # Only process this for new policies (not updates)
    if (-not $IsUpdate) {
        if (-not $json.ContainsKey('scheduledActionsForRule') -or $null -eq $json['scheduledActionsForRule']) {
            # Create default scheduled action (mark as non-compliant immediately)
            $json['scheduledActionsForRule'] = @(
                @{
                    'ruleName' = $null
                    'scheduledActionConfigurations' = @(
                        @{
                            'actionType' = 'block'
                            'gracePeriodHours' = 0
                            'notificationTemplateId' = ''
                            'notificationMessageCCList' = @()
                        }
                    )
                }
            )
        }
        elseif ($json['scheduledActionsForRule'] -is [System.Collections.IList]) {
            # Ensure nested arrays are proper
            $repairedActions = @()
            foreach ($action in $json['scheduledActionsForRule']) {
                if ($action -is [hashtable]) {
                    if (-not $action.ContainsKey('scheduledActionConfigurations') -or $null -eq $action['scheduledActionConfigurations']) {
                        $action['scheduledActionConfigurations'] = @()
                    }
                    elseif ($action['scheduledActionConfigurations'] -isnot [System.Collections.IList]) {
                        $action['scheduledActionConfigurations'] = @($action['scheduledActionConfigurations'])
                    }
                    # Fix nested notificationMessageCCList
                    foreach ($config in $action['scheduledActionConfigurations']) {
                        if ($config -is [hashtable]) {
                            if ($config.ContainsKey('notificationMessageCCList') -and $null -eq $config['notificationMessageCCList']) {
                                $config['notificationMessageCCList'] = @()
                            }
                        }
                    }
                    $repairedActions += $action
                }
            }
            $json['scheduledActionsForRule'] = $repairedActions
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
    Remove-NullValues -Object $json
    
    return $json
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-CompliancePolicies {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies"
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        
        Write-Host "`n##[group]Processing [compliance-policies]: $displayName"
        
        try {
            # Check if policy exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType "compliance-policies"
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
                        PolicyType = "compliance-policies"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Compare key properties to determine if update is needed
                $ignoreProps = @('scheduledActionsForRule', 'assignments', 'deviceStatusOverview', 'userStatusOverview')
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
            
            Write-Host "  Type: Compliance Policy"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "compliance-policies" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
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
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "compliance-policies" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                }
                continue
            }
            
            # Repair the policy payload (pass IsUpdate to exclude navigation properties for PATCH)
            $isUpdating = $action -eq "Update"
            # For PATCH, apply field-monitor filter if sidecar is present
            $patchPolicyConfig = if ($isUpdating) { Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig } else { $policyConfig }
            $repairedConfig = Repair-CompliancePolicyPayload -Payload $patchPolicyConfig -IsUpdate:$isUpdating
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] Compliance Policy created: $displayName (ID: $policyId)"
            }
            else {
                $patchUri = "$uri/$($existingPolicy.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                $policyId = $existingPolicy.id
                Write-Host "  [+] Compliance Policy updated: $displayName"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "compliance-policies" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
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

# Filter to only compliance policies
$compliancePolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "compliance-policies" }

if ($compliancePolicies.Count -eq 0) {
    Write-Host "No Compliance policies to process"
    return @()
}

Write-Host "`n##[section]Processing Compliance Policies ($($compliancePolicies.Count) policies)"

$results = Invoke-CompliancePolicies -Policies $compliancePolicies -WhatIf:$WhatIfMode

return $results

