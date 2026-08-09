<#
.SYNOPSIS
    Creates and manages Intune Assignment Filters via Microsoft Graph API
    
.DESCRIPTION
    Handles deployment of Assignment Filters which are used to scope policy assignments.
    Filters must be created BEFORE policies that reference them.
    
.PARAMETER PolicyConfigs
    Array of filter configuration objects to process
    
.PARAMETER WhatIf
    Show what would be changed without making changes
    
.NOTES
    Requires Microsoft.Graph.Authentication module
    API: https://graph.microsoft.com/beta/deviceManagement/assignmentFilters
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
# FILTER REPAIR FUNCTION
# ============================================================================

function Repair-FilterPayload {
    param(
        [object]$Payload,
        [switch]$IsUpdate
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    
    # Remove read-only properties
    $propsToRemove = @(
        'id', 'createdDateTime', 'lastModifiedDateTime', 
        '@odata.context', '@odata.type',
        '_sourceFile', '_policyType', '_assignments',
        'payloads'  # Read-only - shows which policies use this filter
    )
    
    # For updates, also remove 'platform' as it cannot be changed
    if ($IsUpdate) {
        $propsToRemove += 'platform'
        $propsToRemove += 'assignmentFilterManagementType'  # Also can't be changed
    }
    
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Ensure required properties exist
    if (-not $json.ContainsKey('displayName')) {
        throw "Filter must have a displayName"
    }
    
    if (-not $json.ContainsKey('platform')) {
        $json['platform'] = 'windows10AndLater'
    }
    
    if (-not $json.ContainsKey('rule')) {
        throw "Filter must have a rule expression"
    }
    
    # Fix roleScopeTagIds - MUST be array of strings
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
    
    # Fix roleScopeTags (older format) - convert to roleScopeTagIds array
    if ($json.ContainsKey('roleScopeTags')) {
        $tags = $json['roleScopeTags']
        if ($tags -is [string]) {
            $json['roleScopeTagIds'] = @($tags)
        }
        $json.Remove('roleScopeTags')
    }
    
    return $json
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-FilterDeployment {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Filters,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters"
    
    # Fetch all existing filters once (API doesn't support $filter by displayName)
    $existingFilters = @{}
    try {
        $allFiltersResponse = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        foreach ($f in $allFiltersResponse.value) {
            $existingFilters[$f.displayName.ToLower()] = $f
        }
        Write-Verbose "Loaded $($existingFilters.Count) existing filters from tenant"
    }
    catch {
        Write-Verbose "Could not load existing filters: $_"
    }
    
    foreach ($filterConfig in $Filters) {
        $displayName = $filterConfig.displayName.Trim()
        
        Write-Host "`n##[group]Processing [filter]: $displayName"
        
        try {
            # Check if filter exists (from pre-loaded cache)
            $existingFilter = $existingFilters[$displayName.ToLower()]
            
            $action = "Create"
            $hasChanges = $true
            
            $changeDetails = $null
            if ($existingFilter) {
                # Check if filter is protected from baseline updates via description marker
                if (Test-ResourceProtected -Description $existingFilter.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  ⛔ Protected: Filter has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = "filters"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Compare key properties to determine if update is needed
                $compareProps = @('rule', 'description', 'roleScopeTagIds')
                $comparison = Compare-PolicyConfigurations -ExistingPolicy $existingFilter -DesiredPolicy $filterConfig -CompareProperties $compareProps -ReturnDetails
                
                if ($comparison.IsEquivalent) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Filter exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  Filter exists - changes detected, will be updated"
                    if ($changeDetails.Added.Count -gt 0) { Write-Host "    Added: $($changeDetails.Added -join ', ')" }
                    if ($changeDetails.Removed.Count -gt 0) { Write-Host "    Removed: $($changeDetails.Removed -join ', ')" }
                    if ($changeDetails.Modified.Count -gt 0) { Write-Host "    Modified: $($changeDetails.Modified -join ', ')" }
                }
            }
            else {
                Write-Host "  Filter does not exist - will be created"
            }
            
            Write-Host "  Platform: $($filterConfig.platform)"
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus filter: $displayName"
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    Platform = $filterConfig.platform
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no changes needed
            if (-not $hasChanges) {
                $results += @{
                    DisplayName = $displayName
                    Status = "No changes"
                    FilterId = $existingFilter.id
                    Platform = $filterConfig.platform
                }
                continue
            }
            
            # Repair the payload (pass IsUpdate for updates to exclude immutable properties)
            $isUpdating = $action -eq "Update"
            $patchFilterConfig = if ($isUpdating) { Get-IntuneMonitoredPatchBody -PolicyConfig $filterConfig } else { $filterConfig }
            $repairedConfig = Repair-FilterPayload -Payload $patchFilterConfig -IsUpdate:$isUpdating
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 10
            
            $filterId = $null
            if ($action -eq "Create") {
                $createRepairedConfig = Repair-FilterPayload -Payload $filterConfig -IsUpdate:$false
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body (ConvertTo-SafeJson -InputObject $createRepairedConfig -Depth 10) -ContentType "application/json"
                $filterId = $response.id
                Write-Host "  ✓ Filter created: $displayName (ID: $filterId)"
            }
            else {
                $patchUri = "$uri/$($existingFilter.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $jsonBody -ContentType "application/json"
                $filterId = $existingFilter.id
                Write-Host "  ✓ Filter updated: $displayName"
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                FilterId = $filterId
                Platform = $filterConfig.platform
            }
        }
        catch {
            Write-Host "  ✗ Failed to $($action.ToLower()) filter: $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process filter: $displayName"
            Write-Host "##[error]Error: $_"
            
            $results += @{
                DisplayName = $displayName
                Status = "Failed"
                Error = $_.ToString()
                Platform = $filterConfig.platform
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

$filterPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "filters" }

if ($filterPolicies.Count -eq 0) {
    Write-Host "No Assignment Filters to process"
    return @()
}

Write-Host "`n##[section]Processing Assignment Filters ($($filterPolicies.Count) filters)"

$results = Invoke-FilterDeployment -Filters $filterPolicies -WhatIf:$WhatIfMode

# Return results for summary
return $results

