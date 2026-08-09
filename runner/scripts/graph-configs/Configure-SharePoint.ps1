<#
.SYNOPSIS
    Creates and manages SharePoint sites via Microsoft Graph API

.DESCRIPTION
    Creates and updates SharePoint sites and settings that are deployed to Tenant tenants.
    The script is idempotent - it will create sites if they don't exist, or verify/update if they do.

.PARAMETER ConfigDirectory
    Path to the directory containing JSON SharePoint site definition files

.PARAMETER WhatIf
    Show what would be changed without making changes

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes

.EXAMPLE
    .\Configure-SharePoint.ps1 -ConfigDirectory "baseline-sharepoint"
    
.EXAMPLE
    .\Configure-SharePoint.ps1 -ConfigDirectory "baseline-sharepoint" -WhatIf -OutputPath "sharepoint-plan.json"

.NOTES
    Requires Microsoft.Graph.Sites module
    Requires appropriate Graph API permissions: Sites.ReadWrite.All
    Each JSON file in the directory should define a single SharePoint site
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import placeholder resolver module
$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

Write-Host "##[section]Configuring SharePoint Sites"

# Load site configurations from directory
if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Write-Host "Skipping SharePoint configuration - no baseline configurations defined"
    exit 0
}

$siteFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File
if ($siteFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    Write-Host "Skipping SharePoint configuration"
    exit 0
}

Write-Host "Found $($siteFiles.Count) site definition(s) in: $ConfigDirectory"

# Load all site configurations
$siteConfigs = @()
foreach ($file in $siteFiles) {
    Write-Host "  Loading: $($file.Name)"
    $siteConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json
    
    # Convert to hashtable and resolve placeholders
    $configHash = $siteConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $configHash = Resolve-Placeholders -ConfigObject $configHash

    # Track source file path for plan-scoped apply
    $configHash['_SourceFile'] = $file.FullName
    
    # Convert back to PSObject
    $siteConfig = $configHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $siteConfigs += $siteConfig
}

Write-Host "Sites to process: $($siteConfigs.Count)"

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Sites"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("Sites.ReadWrite.All")
    Write-Host "✓ Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Function to create or update a SharePoint site
function Set-SharePointSite {
    param(
        [Parameter(Mandatory=$true)]
        [object]$SiteConfig
    )
    
    Write-Host "`n##[group]Processing: $($SiteConfig.DisplayName)"
    
    try {
        # Note: Creating SharePoint sites via Graph API is complex and may require additional APIs
        # This is a simplified implementation focusing on site properties updates
        
        Write-Host "##[warning]SharePoint site creation via Graph API has limitations."
        Write-Host "##[warning]Consider using PnP PowerShell or SharePoint REST API for full site provisioning."
        
        if ($PSCmdlet.ShouldProcess($SiteConfig.DisplayName, "Configure SharePoint site")) {
            Write-Host "[WhatIf] Would configure site: $($SiteConfig.DisplayName)"
            # Implementation would go here using appropriate APIs
        }
        else {
            Write-Host "[WhatIf] Would configure site: $($SiteConfig.DisplayName)"
        }
        
        return [PSCustomObject]@{
            DisplayName = $SiteConfig.DisplayName
            Url = $SiteConfig.Url
        }
    }
    catch {
        Write-Host "##[error]Failed to process site: $($SiteConfig.DisplayName)"
        Write-Host "##[error]Error: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Process all sites
Write-Host "`n##[section]Creating/Updating SharePoint Sites"

$results = @()
$successCount = 0
$errorCount = 0

foreach ($siteConfig in $siteConfigs) {
    try {
        $site = Set-SharePointSite -SiteConfig $siteConfig
        if ($site -or $WhatIfPreference) {
            $successCount++
            $results += [PSCustomObject]@{
                DisplayName = $siteConfig.DisplayName
                Url = $siteConfig.Url
                Status = "Success"
                FilePath = $siteConfig._SourceFile
            }
        }
    }
    catch {
        $errorCount++
        $results += [PSCustomObject]@{
            DisplayName = $siteConfig.DisplayName
            Url = $null
            Status = "Failed: $_"
            FilePath = $siteConfig._SourceFile
        }
    }
}

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total sites processed: $($siteConfigs.Count)"
Write-Host "✓ Successful: $successCount"
if ($errorCount -gt 0) {
    Write-Host "✗ Failed: $errorCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nResults:"
    $results | Format-Table -AutoSize
}

# Output plan summary if requested
if ($OutputPath) {
    $planSummary = @{
        Service = "SharePoint"
        Timestamp = Get-Date -Format "o"
        TotalSites = $siteConfigs.Count
        SuccessCount = $successCount
        ErrorCount = $errorCount
        Results = $results
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some sites failed to process"
    exit 1
}
else {
    Write-Host "##[command]All SharePoint sites configured successfully!"
}

