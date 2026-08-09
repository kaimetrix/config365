<#
.SYNOPSIS
    Creates and manages Intune Platform Scripts via Microsoft Graph API
    
.DESCRIPTION
    Handles PowerShell and Shell scripts for device management.
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
# PLATFORM SCRIPT SPECIFIC REPAIR FUNCTION
# ============================================================================

function Repair-PlatformScriptPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload,
        [Parameter(Mandatory=$true)]
        [ValidateSet("PowerShell", "Shell")]
        [string]$ScriptType
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', '@odata.type',
                       '_sourceFile', '_sourcePath', '_policyType', '_assignments', '_settings',
                       'isGlobalScript', 'highestAvailableVersion', 'deviceHealthScriptType')
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
    
    # Ensure required properties
    if ($ScriptType -eq "PowerShell") {
        if (-not $json.ContainsKey('runAs32Bit')) {
            $json['runAs32Bit'] = $false
        }
        if (-not $json.ContainsKey('enforceSignatureCheck')) {
            $json['enforceSignatureCheck'] = $false
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

function Invoke-PlatformScripts {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        
        # Determine script type (PowerShell or Shell) -- driven by folder (_policyType)
        $isShellScript = $policyConfig._policyType -eq "platform-scripts-bash" -or
                        $policyConfig.scriptContent -match "^#!" -or
                        $policyConfig.'@odata.type' -like "*ShellScript*"
        
        $scriptType = if ($isShellScript) { "Shell" } else { "PowerShell" }
        $uri = if ($isShellScript) {
            "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts"
        } else {
            "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts"
        }
        
        # Re-encode script content from plain-text source file if absent (plain-text storage)
        if (-not $policyConfig.scriptContent -and $policyConfig._sourcePath) {
            $ext = if ($isShellScript) { ".sh" } else { ".ps1" }
            $scriptFilePath = $policyConfig._sourcePath -replace '\.json$', $ext
            if (Test-Path $scriptFilePath) {
                $scriptText  = Get-Content -Path $scriptFilePath -Raw -Encoding UTF8
                $scriptBytes = [System.Text.Encoding]::UTF8.GetBytes($scriptText)
                $policyConfig | Add-Member -NotePropertyName "scriptContent" `
                    -NotePropertyValue ([System.Convert]::ToBase64String($scriptBytes)) -Force
                Write-Host "  Loaded script from: $(Split-Path $scriptFilePath -Leaf)"
            }
            else {
                Write-Host "  ##[warning]Script file not found: $scriptFilePath - scriptContent will be empty"
            }
        }
        
        Write-Host "`n##[group]Processing [$($policyConfig._policyType)]: $displayName"
        
        try {
            # Check if script exists
            $policyTypeKey = if ($isShellScript) { "platform-scripts-bash" } else { "platform-scripts-powershell" }
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
                        PolicyType = $policyConfig._policyType
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Fetch full script details (list API doesn't return scriptContent)
                $fullScriptUri = "$uri/$($existingPolicy.id)"
                try {
                    $fullExistingPolicy = Invoke-MgGraphRequest -Method GET -Uri $fullScriptUri
                }
                catch {
                    Write-Verbose "  Could not fetch full script details: $_"
                    $fullExistingPolicy = $existingPolicy
                }
                
                # Compare properties including scriptContent
                $ignoreProps = @('assignments', 'runSummary', 'deviceRunStates', 'userRunStates')
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $fullExistingPolicy -DesiredPolicy $policyConfig -IgnoreProperties $ignoreProps -ReturnDetails
                
                if ($comparison.IsEquivalent) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Script exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  Script exists - changes detected, will be updated"
                    if ($changeDetails.Added.Count -gt 0) { Write-Host "    Added: $($changeDetails.Added -join ', ')" }
                    if ($changeDetails.Removed.Count -gt 0) { Write-Host "    Removed: $($changeDetails.Removed -join ', ')" }
                    if ($changeDetails.Modified.Count -gt 0) { Write-Host "    Modified: $($changeDetails.Modified -join ', ')" }
                }
            }
            else {
                Write-Host "  Script does not exist - will be created"
            }
            
            Write-Host "  Type: Platform Script ($scriptType)"
            
            $assignPolicyType = if ($isShellScript) { "platform-scripts-bash" } else { "platform-scripts-powershell" }
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus script: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $assignPolicyType -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    ScriptType = $scriptType
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no policy content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType $assignPolicyType -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                    ScriptType  = $scriptType
                }
                continue
            }
            
            # Repair the payload
            $patchPolicyConfig = if ($action -ne "Create") { Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig } else { $policyConfig }
            $repairedConfig = Repair-PlatformScriptPayload -Payload $patchPolicyConfig -ScriptType $scriptType
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                $createRepairedConfig = Repair-PlatformScriptPayload -Payload $policyConfig -ScriptType $scriptType
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body (ConvertTo-SafeJson -InputObject $createRepairedConfig -Depth 30) -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] Platform Script created: $displayName (ID: $policyId)"
            }
            else {
                $patchUri = "$uri/$($existingPolicy.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                $policyId = $existingPolicy.id
                Write-Host "  [+] Platform Script updated: $displayName"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType $assignPolicyType -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
                ScriptType = $scriptType
            }
        }
        catch {
            Write-Host "  âœ— Failed to $($action.ToLower()) script: $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process script: $displayName"
            Write-Host "##[error]Error: $_"
            
            $results += @{
                DisplayName = $displayName
                Status = "Failed"
                Error = $_.ToString()
                ScriptType = $scriptType
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

$platformScripts = $PolicyConfigs | Where-Object { $_._policyType -in @("platform-scripts-powershell", "platform-scripts-bash") }

if ($platformScripts.Count -eq 0) {
    Write-Host "No Platform Scripts to process"
    return @()
}

Write-Host "`n##[section]Processing Platform Scripts ($($platformScripts.Count) scripts)"

$results = Invoke-PlatformScripts -Policies $platformScripts -WhatIf:$WhatIfMode

return $results

