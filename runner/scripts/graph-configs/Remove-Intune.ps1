<#
.SYNOPSIS
    Removes Intune policies specified in baseline-remove

.DESCRIPTION
    Processes the baseline-remove/intune folder and removes matching policies.
    Supports all Intune policy types (device config, compliance, settings catalog, etc.)

.PARAMETER RemoveDirectory
    Path to the baseline-remove/intune directory

.EXAMPLE
    .\Remove-Intune.ps1 -RemoveDirectory "baseline-remove/intune"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$RemoveDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Removing Intune Policies"

if (-not (Test-Path $RemoveDirectory)) {
    Write-Host "##[warning]Removal directory not found: $RemoveDirectory"
    exit 0
}

# Find all JSON files recursively (supports subfolders by policy type)
# Exclude assignment files - they are metadata for policies, not standalone configurations
$policyFiles = @(Get-ChildItem -Path $RemoveDirectory -Filter "*.json" -File -Recurse -ErrorAction SilentlyContinue | 
    Where-Object { $_.Name -notlike "*.assignment.json" -and $_.Name -notlike "*.assignment.MSP.json" })

if ($policyFiles.Count -eq 0) {
    Write-Host "No Intune policy removal files found"
    exit 0
}

Write-Host "Found $($policyFiles.Count) policy(ies) to remove"

# Import modules
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Check connection (supports GCC High and Tenant-specific credentials)
$context = Ensure-M365GraphConnection
Write-Host "Connected to tenant: $((Get-MgContext).TenantId)"

# Policy type to API endpoint mapping (aligned with Configure-Intune-Helpers Get-AllPoliciesOfType)
$policyEndpoints = @{
    "device-configurations" = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"
    "compliance-policies" = "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies"
    "settings-catalog" = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
    "app-protection-ios" = "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections"
    "app-protection-android" = "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections"
    "windows-update-rings" = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"
    "windows-updates" = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"
    "windows-feature-updates" = "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles"
    "windows-quality-updates" = "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles"
    "windows-driver-updates" = "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles"
    "endpoint-security" = "https://graph.microsoft.com/beta/deviceManagement/intents"
    "platform-scripts-powershell" = "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts"
    "platform-scripts-bash" = "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts"
    "filters" = "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters"
    "autopilot" = "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles"
    "mobile-apps" = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
    "remediations" = "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts"
}

function Invoke-ODataPolicySearch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri
    )
    try {
        return Invoke-MgGraphRequest -Method GET -Uri $Uri -ErrorAction Stop
    }
    catch {
        return $null
    }
}

$results = @()
$successCount = 0
$notFoundCount = 0
$errorCount = 0
$skippedUnknownTypeCount = 0

foreach ($file in $policyFiles) {
    $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
    
    # Get display name - try displayName first, then name, then fallback to filename (strip .MSP suffix)
    $displayName = if ($config.displayName) { $config.displayName.Trim() }
                   elseif ($config.name) { $config.name.Trim() }
                   else { $file.BaseName -replace '\.MSP$', '' }
    
    # Skip entries with empty/whitespace-only names
    if ([string]::IsNullOrWhiteSpace($displayName)) {
        Write-Host "`n##[warning]Skipping file with empty policy name: $($file.Name)"
        continue
    }
    
    $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
    
    # Detect policy type from JSON content first, then fall back to folder name
    $policyType = $null
    
    # Check @odata.context first - it's the most reliable indicator of the actual API endpoint
    if ($config.'@odata.context' -like "*configurationPolicies*") {
        $policyType = "settings-catalog"
        Write-Verbose "  Detected settings-catalog from @odata.context"
    }
    # Check for templateId which indicates endpoint-security intent (old style)
    elseif ($config.templateId -and -not $config.templateReference) {
        $policyType = "endpoint-security"
        Write-Verbose "  Detected endpoint-security intent from templateId"
    }
    
    # Check for @odata.type which indicates device configuration, Windows Update profiles, or mobile apps
    if (-not $policyType -and $config.'@odata.type') {
        $odataType = $config.'@odata.type'
        if ($odataType -like "*windowsUpdateForBusinessConfiguration*") {
            $policyType = "windows-updates"
        }
        elseif ($odataType -like "*windowsFeatureUpdateProfile*") {
            $policyType = "windows-feature-updates"
        }
        elseif ($odataType -like "*windowsQualityUpdateProfile*") {
            $policyType = "windows-quality-updates"
        }
        elseif ($odataType -like "*windowsDriverUpdateProfile*") {
            $policyType = "windows-driver-updates"
        }
        elseif ($odataType -like "*deviceConfiguration*" -or $odataType -like "*CustomConfiguration*") {
            $policyType = "device-configurations"
        }
        elseif ($odataType -like "*LobApp*" -or $odataType -like "*StoreApp*" -or
                $odataType -like "*webApp*" -or $odataType -like "*officeSuiteApp*") {
            $policyType = "mobile-apps"
            Write-Verbose "  Detected mobile-apps from @odata.type: $odataType"
        }
    }
    
    # Fall back to explicit policyType property or folder name
    if (-not $policyType) {
        $policyType = if ($config.policyType) { $config.policyType } else { $file.Directory.Name }
    }
    
    # Resolve generic app-protection to platform-specific key (mirrors Configure-Intune-AppProtection.ps1)
    if ($policyType -eq "app-protection") {
        $isAndroid = $displayName -match "Android" -or $config.'@odata.type' -like "*android*"
        $policyType = if ($isAndroid) { "app-protection-android" } else { "app-protection-ios" }
    }
    
    Write-Host "`n##[group]Removing policy: $displayName"
    Write-Host "  Type: $policyType"
    Write-Host "  Reason: $reason"
    
    try {
        # Determine endpoint based on policy type
        $baseUri = $policyEndpoints[$policyType]
        $existingPolicy = $null

        # All known fallback endpoints (used both for primary-miss and unknown-type discovery)
        $allFallbackEndpoints = @(
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/intents"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"; Filter = "name" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/windowsFeatureUpdateProfiles"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/windowsQualityUpdateProfiles"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/windowsDriverUpdateProfiles"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"; Filter = "displayName" },
            @{ Uri = "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts"; Filter = "displayName" }
        )

        if (-not $baseUri) {
            # Unknown type — go straight to full fallback discovery instead of skipping immediately
            Write-Host "##[warning]Unknown policy type '$policyType' - no direct endpoint mapping. Attempting fallback discovery..."

            foreach ($fallback in $allFallbackEndpoints) {
                $allPolicies = @()
                $uri = "$($fallback.Uri)`?`$select=id,$($fallback.Filter)"
                do {
                    $r = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction SilentlyContinue
                    if ($r.value) { $allPolicies += $r.value }
                    $uri = $r.'@odata.nextLink'
                } while ($uri)

                $existingPolicy = $allPolicies | Where-Object { $_.$($fallback.Filter) -eq $displayName } | Select-Object -First 1
                if ($existingPolicy) {
                    $baseUri = $fallback.Uri
                    Write-Host "  Found in fallback endpoint: $baseUri"
                    break
                }
            }

            if (-not $existingPolicy) {
                Write-Host "##[warning]Not found in any endpoint. Skipping."
                $results += [PSCustomObject]@{
                    DisplayName = $displayName
                    Type = $policyType
                    Id = $null
                    Status = "SkippedUnknownType"
                }
                $skippedUnknownTypeCount++
            }
        }
        else {
            # Use correct filter property: 'name' for settings-catalog/configurationPolicies, 'displayName' for others
            $filterProp = if ($baseUri -like "*configurationPolicies*") { "name" } else { "displayName" }
            
            # Try OData filter first (OData lookup in helper to avoid nested try/catch in foreach)
            $searchUri = "$baseUri`?`$filter=$filterProp eq '$displayName'"
            $response = Invoke-ODataPolicySearch -Uri $searchUri
            $existingPolicy = if ($response -and $response.value) { $response.value | Select-Object -First 1 } else { $null }
            
            # If OData filter returned nothing, try local filtering (handles special characters like [])
            if (-not $existingPolicy) {
                Write-Host "  OData filter returned no results, trying local filter..."
                $allPolicies = @()
                $uri = "$baseUri`?`$select=id,$filterProp"
                do {
                    $r = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction SilentlyContinue
                    if ($r.value) { $allPolicies += $r.value }
                    $uri = $r.'@odata.nextLink'
                } while ($uri)
                
                $existingPolicy = $allPolicies | Where-Object { $_.$filterProp -eq $displayName } | Select-Object -First 1
                if ($existingPolicy) {
                    Write-Host "  Found via local filter"
                }
            }
            
            # If still not found, try other common endpoints as fallback
            if (-not $existingPolicy) {
                $fallbackEndpoints = $allFallbackEndpoints | Where-Object { $_.Uri -ne $baseUri }
                
                foreach ($fallback in $fallbackEndpoints) {
                    $allPolicies = @()
                    $uri = "$($fallback.Uri)`?`$select=id,$($fallback.Filter)"
                    do {
                        $r = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction SilentlyContinue
                        if ($r.value) { $allPolicies += $r.value }
                        $uri = $r.'@odata.nextLink'
                    } while ($uri)
                    
                    $existingPolicy = $allPolicies | Where-Object { $_.$($fallback.Filter) -eq $displayName } | Select-Object -First 1
                    if ($existingPolicy) {
                        $baseUri = $fallback.Uri
                        Write-Host "  Found in fallback endpoint: $baseUri"
                        break
                    }
                }
            }
        }

        if ($existingPolicy) {
            Write-Host "  Found policy with ID: $($existingPolicy.id)"
            
            if ($PSCmdlet.ShouldProcess($displayName, "Remove Intune policy")) {
                $deleteUri = "$baseUri/$($existingPolicy.id)"
                Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
                Write-Host "  ##[command]Policy removed successfully"
                
                $results += [PSCustomObject]@{
                    DisplayName = $displayName
                    Type = $policyType
                    Id = $existingPolicy.id
                    Status = "Removed"
                }
                $successCount++
            }
            else {
                Write-Host "  [WhatIf] Would remove policy: $displayName"
                $results += [PSCustomObject]@{
                    DisplayName = $displayName
                    Type = $policyType
                    Id = $existingPolicy.id
                    Status = "WouldRemove"
                }
            }
        }
        elseif ($baseUri) {
            Write-Host "  Policy not found - skipping"
            $results += [PSCustomObject]@{
                DisplayName = $displayName
                Type = $policyType
                Id = $null
                Status = "NotFound"
            }
            $notFoundCount++
        }
    }
    catch {
        Write-Host "  ##[error]Failed: $_"
        $results += [PSCustomObject]@{
            DisplayName = $displayName
            Type = $policyType
            Id = $null
            Status = "Failed: $($_.Exception.Message)"
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
Write-Host "Total policies processed: $($policyFiles.Count)"

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
if ($skippedUnknownTypeCount -gt 0) {
    Write-Host "  ⚠ Skipped (unknown policy type): $skippedUnknownTypeCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nRemoval Results:"
    foreach ($r in $results) {
        $icon = switch ($r.Status) {
            "Removed" { "✓ REMOVED" }
            "WouldRemove" { "🗑️ WOULD REMOVE" }
            "NotFound" { "○ NOT FOUND" }
            "SkippedUnknownType" { "⚠ SKIPPED (unknown type)" }
            default { "✗ $($r.Status)" }
        }
        Write-Host "  $icon : [$($r.Type)] $($r.DisplayName)"
    }
}

if ($OutputPath) {
    $summary = @{
        Service = "Intune-Remove"
        TotalItems = $policyFiles.Count
        RemovedCount = $removedCount
        WouldRemoveCount = $wouldRemoveCount
        NotFoundCount = $notFoundCount
        SkippedUnknownTypeCount = $skippedUnknownTypeCount
        ErrorCount = $errorCount
        Results = $results
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File $OutputPath -Encoding UTF8 -WhatIf:$false
}

if ($errorCount -gt 0) { exit 1 }
Write-Host "##[command]Intune removal completed!"

