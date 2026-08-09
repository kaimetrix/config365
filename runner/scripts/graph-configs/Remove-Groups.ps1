<#
.SYNOPSIS
    Removes Azure AD groups specified in baseline-remove

.DESCRIPTION
    Processes the baseline-remove/groups folder and removes matching groups
    from the target tenant.

.PARAMETER RemoveDirectory
    Path to the baseline-remove/groups directory

.PARAMETER WhatIf
    Show what would be removed without making changes

.EXAMPLE
    .\Remove-Groups.ps1 -RemoveDirectory "baseline-remove/groups"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$RemoveDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Removing Azure AD Groups"

if (-not (Test-Path $RemoveDirectory)) {
    Write-Host "##[warning]Removal directory not found: $RemoveDirectory"
    Write-Host "No groups to remove"
    exit 0
}

$groupFiles = @(Get-ChildItem -Path $RemoveDirectory -Filter "*.json" -File -ErrorAction SilentlyContinue)

if ($groupFiles.Count -eq 0) {
    Write-Host "No group removal files found"
    exit 0
}

Write-Host "Found $($groupFiles.Count) group(s) to remove"

# Import modules
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
Import-Module Microsoft.Graph.Groups -ErrorAction Stop

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
if (Test-Path $moduleHelpersPath) { . $moduleHelpersPath }

# Check connection (supports GCC High and Tenant-specific credentials)
$context = Ensure-M365GraphConnection -Scopes @("Group.ReadWrite.All")
Write-Host "Connected to tenant: $((Get-MgContext).TenantId)"

$results = @()
$successCount = 0
$notFoundCount = 0
$errorCount = 0

foreach ($file in $groupFiles) {
    $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
    $displayName = if ($config.displayName) { $config.displayName.Trim() } else { $config.displayName }
    $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
    
    Write-Host "`n##[group]Removing group: $displayName"
    Write-Host "  Reason: $reason"
    
    try {
        $existingGroup = Find-MgGroupByDisplayName -DisplayName $displayName
        
        if ($existingGroup) {
            Write-Host "  Found group with ID: $($existingGroup.Id)"
            
            if ($PSCmdlet.ShouldProcess($displayName, "Remove group")) {
                Remove-MgGroup -GroupId $existingGroup.Id
                Write-Host "  ##[command]Group removed successfully"
                
                $results += [PSCustomObject]@{
                    DisplayName = $displayName
                    Id = $existingGroup.Id
                    Status = "Removed"
                    Reason = $reason
                }
                $successCount++
            }
            else {
                Write-Host "  [WhatIf] Would remove group: $displayName"
                $results += [PSCustomObject]@{
                    DisplayName = $displayName
                    Id = $existingGroup.Id
                    Status = "WouldRemove"
                    Reason = $reason
                }
            }
        }
        else {
            Write-Host "  Group not found - skipping"
            $results += [PSCustomObject]@{
                DisplayName = $displayName
                Id = $null
                Status = "NotFound"
                Reason = $reason
            }
            $notFoundCount++
        }
    }
    catch {
        Write-Host "  ##[error]Failed: $_"
        $results += [PSCustomObject]@{
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

# Count by status
$wouldRemoveCount = ($results | Where-Object { $_.Status -eq "WouldRemove" }).Count
$removedCount = ($results | Where-Object { $_.Status -eq "Removed" }).Count

Write-Host "`n##[section]Summary"
Write-Host "Total groups processed: $($groupFiles.Count)"

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
        Write-Host "  $icon : $($r.DisplayName)"
    }
}

if ($OutputPath) {
    $summary = @{
        Service = "Groups-Remove"
        TotalItems = $groupFiles.Count
        RemovedCount = $removedCount
        WouldRemoveCount = $wouldRemoveCount
        NotFoundCount = $notFoundCount
        ErrorCount = $errorCount
        Results = $results
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File $OutputPath -Encoding UTF8 -WhatIf:$false
}

if ($errorCount -gt 0) { exit 1 }
Write-Host "##[command]Group removal completed!"

