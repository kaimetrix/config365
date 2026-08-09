<#
.SYNOPSIS
    Removes Conditional Access policies and named locations specified in baseline-remove

.DESCRIPTION
    Processes the baseline-remove/conditional-access folder and removes matching resources
    from the target tenant. This script runs BEFORE Configure-ConditionalAccess.ps1.
    
    Expected structure:
    baseline-remove/
    └── conditional-access/
        ├── policies/          # CA policies to remove
        │   └── *.json
        └── named-locations/   # Named locations to remove
            └── *.json

.PARAMETER RemoveDirectory
    Path to the baseline-remove/conditional-access directory

.PARAMETER WhatIf
    Show what would be removed without making changes

.EXAMPLE
    .\Remove-ConditionalAccess.ps1 -RemoveDirectory "baseline-remove/conditional-access"

.NOTES
    Requires Microsoft.Graph.Identity.SignIns module
    Requires Policy.ReadWrite.ConditionalAccess permission
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$RemoveDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Removing Conditional Access Resources"

# Check if removal directory exists
if (-not (Test-Path $RemoveDirectory)) {
    Write-Host "##[warning]Removal directory not found: $RemoveDirectory"
    Write-Host "No resources to remove"
    exit 0
}

# Find removal files
$policyRemovePath = Join-Path $RemoveDirectory "policies"
$locationRemovePath = Join-Path $RemoveDirectory "named-locations"

$policyFiles = @()
$locationFiles = @()

if (Test-Path $policyRemovePath) {
    $policyFiles = @(Get-ChildItem -Path $policyRemovePath -Filter "*.json" -File)
}

if (Test-Path $locationRemovePath) {
    $locationFiles = @(Get-ChildItem -Path $locationRemovePath -Filter "*.json" -File)
}

if ($policyFiles.Count -eq 0 -and $locationFiles.Count -eq 0) {
    Write-Host "No removal files found in: $RemoveDirectory"
    Write-Host "Skipping removal step"
    exit 0
}

Write-Host "Found $($policyFiles.Count) policy(ies) and $($locationFiles.Count) named location(s) to remove"

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Identity.SignIns"
)

Write-Host "`nChecking required PowerShell modules..."
foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        throw "Required module not found: $module. Install with: Install-Module $module"
    }
    Import-Module $module -ErrorAction Stop
    Write-Host "Loaded: $module"
}

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("Policy.ReadWrite.ConditionalAccess")
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Results tracking
$results = @()
$successCount = 0
$notFoundCount = 0
$errorCount = 0
$policiesRemoved = 0

# ============================================================================
# STEP 1: Remove Conditional Access Policies FIRST
# (Must happen before named locations, as policies may reference them)
# ============================================================================
if ($policyFiles.Count -gt 0) {
    Write-Host "`n##[section]Removing Conditional Access Policies"
    
    foreach ($file in $policyFiles) {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $displayName = if ($config.displayName) { $config.displayName.Trim() } else { $config.displayName }
        $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
        
        Write-Host "`n##[group]Removing policy: $displayName"
        Write-Host "  Reason: $reason"
        
        try {
            # Find existing policy
            $existingPolicy = Get-MgIdentityConditionalAccessPolicy -Filter "displayName eq '$displayName'" -ErrorAction SilentlyContinue
            
            if ($existingPolicy) {
                Write-Host "  Found policy with ID: $($existingPolicy.Id)"
                Write-Host "  Current state: $($existingPolicy.State)"
                
                if ($PSCmdlet.ShouldProcess($displayName, "Remove Conditional Access policy")) {
                    Remove-MgIdentityConditionalAccessPolicy -ConditionalAccessPolicyId $existingPolicy.Id
                    Write-Host "  ##[command]Policy removed successfully"
                    
                    $results += [PSCustomObject]@{
                        Type = "Policy"
                        DisplayName = $displayName
                        Id = $existingPolicy.Id
                        Status = "Removed"
                        Reason = $reason
                    }
                    $successCount++
                    $policiesRemoved++
                }
                else {
                    Write-Host "  [WhatIf] Would remove policy: $displayName"
                    $results += [PSCustomObject]@{
                        Type = "Policy"
                        DisplayName = $displayName
                        Id = $existingPolicy.Id
                        Status = "WouldRemove"
                        Reason = $reason
                    }
                }
            }
            else {
                Write-Host "  Policy not found in tenant - skipping"
                $results += [PSCustomObject]@{
                    Type = "Policy"
                    DisplayName = $displayName
                    Id = $null
                    Status = "NotFound"
                    Reason = $reason
                }
                $notFoundCount++
            }
        }
        catch {
            Write-Host "  ##[error]Failed to remove: $_"
            $results += [PSCustomObject]@{
                Type = "Policy"
                DisplayName = $displayName
                Id = $null
                Status = "Failed: $($_.Exception.Message)"
                Reason = $reason
            }
            $errorCount++
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
}

# ============================================================================
# STEP 2: Wait for policy deletion to propagate before removing named locations
# ============================================================================
if ($policiesRemoved -gt 0 -and $locationFiles.Count -gt 0) {
    Write-Host "`n##[section]Waiting for Policy Deletion to Propagate"
    Write-Host "  Policies removed: $policiesRemoved"
    Write-Host "  Named locations to remove: $($locationFiles.Count)"
    Write-Host "  Waiting 15 seconds for propagation..."
    Start-Sleep -Seconds 15
    Write-Host "  Propagation delay complete"
}

# ============================================================================
# STEP 3: Remove Named Locations (after policies that reference them are gone)
# ============================================================================
if ($locationFiles.Count -gt 0) {
    Write-Host "`n##[section]Removing Named Locations"
    
    foreach ($file in $locationFiles) {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $displayName = if ($config.displayName) { $config.displayName.Trim() } else { $config.displayName }
        $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
        
        Write-Host "`n##[group]Removing named location: $displayName"
        Write-Host "  Reason: $reason"
        
        try {
            # Find existing location
            $existingLocation = Get-MgIdentityConditionalAccessNamedLocation -Filter "displayName eq '$displayName'" -ErrorAction SilentlyContinue
            
            if ($existingLocation) {
                Write-Host "  Found location with ID: $($existingLocation.Id)"
                
                # Check if this is an IP named location with isTrusted = true
                # Trusted locations cannot be deleted directly - must first set isTrusted = false
                $isTrusted = $existingLocation.AdditionalProperties.isTrusted
                $locationType = $existingLocation.AdditionalProperties.'@odata.type'
                Write-Host "  Location type: $locationType"
                Write-Host "  isTrusted: $isTrusted"
                
                if ($isTrusted -eq $true) {
                    Write-Host "  Location is marked as TRUSTED - must untrust before removal"
                    
                    if ($PSCmdlet.ShouldProcess($displayName, "Set isTrusted to false")) {
                        try {
                            # Update to untrusted first - need to include @odata.type for PATCH
                            $untrusBody = @{ 
                                '@odata.type' = $locationType
                                isTrusted = $false 
                            } | ConvertTo-Json
                            $uri = "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations/$($existingLocation.Id)"
                            Invoke-MgGraphRequest -Method PATCH -Uri $uri -Body $untrusBody -ContentType "application/json"
                            Write-Host "  ✓ Set isTrusted = false"
                            Write-Host "  Waiting 10 seconds for isTrusted change to propagate..."
                            Start-Sleep -Seconds 10  # Longer delay for isTrusted propagation
                        }
                        catch {
                            Write-Host "  ##[warning]Failed to untrust location: $($_.Exception.Message)"
                            Write-Host "  Attempting removal anyway..."
                        }
                    }
                    else {
                        Write-Host "  [WhatIf] Would set isTrusted = false first"
                    }
                }
                
                if ($PSCmdlet.ShouldProcess($displayName, "Remove named location")) {
                    # Retry logic for removal (handles propagation delays for both policy references and isTrusted changes)
                    $maxRetries = 5
                    $retryDelay = 10
                    $removed = $false
                    
                    for ($retry = 1; $retry -le $maxRetries; $retry++) {
                        try {
                            Remove-MgIdentityConditionalAccessNamedLocation -NamedLocationId $existingLocation.Id -ErrorAction Stop
                            Write-Host "  ##[command]Named location removed successfully"
                            $removed = $true
                            break
                        }
                        catch {
                            $errorMsg = $_.Exception.Message
                            # Check for both "referenced by policies" and "marked as Trusted" errors
                            $isRetryableError = $errorMsg -match "referenced by one or more Conditional Access policies" -or 
                                               $errorMsg -match "marked as a Trusted location"
                            
                            if ($isRetryableError -and $retry -lt $maxRetries) {
                                if ($errorMsg -match "marked as a Trusted location") {
                                    Write-Host "  isTrusted change not yet propagated - waiting..."
                                } else {
                                    Write-Host "  Named location still referenced by policies - waiting for propagation..."
                                }
                                Write-Host "  Retry $retry/$maxRetries - waiting $retryDelay seconds..."
                                Start-Sleep -Seconds $retryDelay
                            }
                            else {
                                throw $_
                            }
                        }
                    }
                    
                    if ($removed) {
                        $results += [PSCustomObject]@{
                            Type = "NamedLocation"
                            DisplayName = $displayName
                            Id = $existingLocation.Id
                            Status = "Removed"
                            Reason = $reason
                        }
                        $successCount++
                    }
                    else {
                        throw "Failed to remove named location after $maxRetries attempts"
                    }
                }
                else {
                    Write-Host "  [WhatIf] Would remove named location: $displayName"
                    $results += [PSCustomObject]@{
                        Type = "NamedLocation"
                        DisplayName = $displayName
                        Id = $existingLocation.Id
                        Status = "WouldRemove"
                        Reason = $reason
                    }
                }
            }
            else {
                Write-Host "  Named location not found in tenant - skipping"
                $results += [PSCustomObject]@{
                    Type = "NamedLocation"
                    DisplayName = $displayName
                    Id = $null
                    Status = "NotFound"
                    Reason = $reason
                }
                $notFoundCount++
            }
        }
        catch {
            Write-Host "  ##[error]Failed to remove: $_"
            $results += [PSCustomObject]@{
                Type = "NamedLocation"
                DisplayName = $displayName
                Id = $null
                Status = "Failed: $($_.Exception.Message)"
                Reason = $reason
            }
            $errorCount++
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
}

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n##[section]Removal Summary"
Write-Host "Total resources processed: $($policyFiles.Count + $locationFiles.Count)"

# Count by status
$wouldRemoveCount = ($results | Where-Object { $_.Status -eq "WouldRemove" }).Count
$removedCount = ($results | Where-Object { $_.Status -eq "Removed" }).Count

if ($WhatIfPreference) {
    Write-Host "  🗑️ Would REMOVE: $wouldRemoveCount"
    Write-Host "  ○ Not found (already removed): $notFoundCount"
}
else {
    Write-Host "  ✓ Removed: $removedCount"
    Write-Host "  ○ Not found (already removed): $notFoundCount"
}
if ($errorCount -gt 0) {
    Write-Host "  ✗ Failed: $errorCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nRemoval Results:"
    foreach ($r in $results) {
        $icon = switch ($r.Status) {
            "Removed" { "✓ REMOVED" }
            "WouldRemove" { "🗑️ WOULD REMOVE" }
            "NotFound" { "○ NOT FOUND" }
            default { "✗ $($r.Status)" }
        }
        Write-Host "  $icon : [$($r.Type)] $($r.DisplayName)"
    }
}

# Save summary if OutputPath provided
if ($OutputPath) {
    $summary = @{
        Service = "ConditionalAccess-Remove"
        TotalItems = $policyFiles.Count + $locationFiles.Count
        RemovedCount = $removedCount
        WouldRemoveCount = $wouldRemoveCount
        NotFoundCount = $notFoundCount
        ErrorCount = $errorCount
        Results = $results
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nSummary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some resources failed to remove"
    exit 1
}
else {
    Write-Host "##[command]Conditional Access removal completed successfully!"
}

