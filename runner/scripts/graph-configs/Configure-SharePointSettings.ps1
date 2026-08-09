<#
.SYNOPSIS
    Configures SharePoint tenant settings via Microsoft Graph API

.DESCRIPTION
    Applies SharePoint Online tenant-level settings including:
    - Sharing capability (internal, external guests, anonymous)
    - Default sharing link type and permissions
    - External user expiration settings
    - Site creation settings
    - Other tenant-level SharePoint policies

    Note: OneDrive inherits sharing settings from SharePoint tenant settings.

    All JSON files in the directory starting with "sharepoint-" are processed.
    You can create granular files like:
    - sharepoint-sharing.json (just sharing settings)
    - sharepoint-siteCreation.json (just site creation settings)

.PARAMETER ConfigDirectory
    Path to the directory containing SharePoint settings JSON files

.PARAMETER ConfigPath
    Path to a single JSON configuration file

.PARAMETER OutputPath
    Path to save the plan/results JSON file for pipeline summary

.EXAMPLE
    .\Configure-SharePointSettings.ps1 -ConfigDirectory "baseline/sharepoint-settings"

.EXAMPLE
    .\Configure-SharePointSettings.ps1 -ConfigPath "sharepoint-tenant.json" -WhatIf -OutputPath "plan.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$false)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$ConfigPath,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import shared diff helpers
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

Write-Host "##[section]Configuring SharePoint Tenant Settings"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Validate parameters - need at least one
if (-not $ConfigDirectory -and -not $ConfigPath) {
    throw "Either -ConfigDirectory or -ConfigPath must be specified"
}

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("SharePointTenantSettings.ReadWrite.All")
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Initialize plan tracking for summary output
$planResults = @{
    Service = "SharePointSettings"
    Timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    WouldCreateCount = 0
    WouldUpdateCount = 0
    NoChangeCount = 0
    ErrorCount = 0
    Results = @()
}

# Helper function to save plan output
function Save-PlanOutput {
    if ($OutputPath) {
        $script:planResults | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
        Write-Host "Plan saved to: $OutputPath"
    }
}

# Function to clean config object for API submission
function Get-CleanConfigHash {
    param([object]$Config)
    
    $configHash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $propsToRemove = @('id', '@odata.type', '@odata.context', '_comment', '_notes')
    foreach ($prop in $propsToRemove) {
        if ($configHash.ContainsKey($prop)) {
            $configHash.Remove($prop)
        }
    }
    # Strip any remaining metadata/internal properties (e.g. _SourceFile, _monitorConfig)
    @($configHash.Keys) | Where-Object { $_ -like '_*' } | ForEach-Object { $configHash.Remove($_) }
    return $configHash
}

# Function to configure SharePoint settings
function Set-SharePointSettings {
    param(
        [object]$Config,
        [string]$FileName
    )
    
    Write-Host "`n##[group]Configuring SharePoint Settings ($FileName)..."
    
    $result = @{
        DisplayName = "SharePoint Tenant Settings ($FileName)"
        Type = "SharePointSettings"
        Status = ""
        Changes = @{}
        FilePath = if ($Config._SourceFile) { $Config._SourceFile } else { $null }
    }
    
    try {
        $configHash = Get-CleanConfigHash -Config $Config
        $uri = "https://graph.microsoft.com/v1.0/admin/sharepoint/settings"
        
        # Get current settings for comparison
        $currentSettings = $null
        try {
            $currentSettings = Invoke-MgGraphRequest -Uri $uri -Method GET
        }
        catch {
            Write-Host "  Could not retrieve current settings for comparison"
        }
        
        # Apply field-monitor filter if sidecar is present
        $spMonitorConfig = $null
        if ($Config._monitorConfig) {
            $spMonitorConfig = @{}
            if ($Config._monitorConfig.Include) { $spMonitorConfig['Include'] = @($Config._monitorConfig.Include) }
            if ($Config._monitorConfig.Exclude) { $spMonitorConfig['Exclude'] = @($Config._monitorConfig.Exclude) }
            if ($spMonitorConfig.Count -eq 0) { $spMonitorConfig = $null }
        }
        $compareConfigHash = if ($spMonitorConfig) { Apply-MonitorFilter -PolicyObject $configHash -MonitorConfig $spMonitorConfig } else { $configHash }

        # Compare settings to detect changes
        $hasChanges = $false
        $changesObj = @{ Modified = @(); ModifiedValues = @{} }
        if ($currentSettings) {
            $changesObj = New-ChangesObject -Existing $currentSettings -Desired $compareConfigHash -Keys @($compareConfigHash.Keys)
            $hasChanges = $changesObj.Modified.Count -gt 0
        }
        else {
            $hasChanges = $true
            $changesObj = @{ Modified = @("(Unable to compare - treating as update)"); ModifiedValues = @{} }
        }
        
        if ($hasChanges) {
            if ($PSCmdlet.ShouldProcess("SharePoint Settings", "Update")) {
                $patchSPHash = if ($spMonitorConfig) { Apply-MonitorFilter -PolicyObject $configHash -MonitorConfig $spMonitorConfig } else { $configHash }
                Invoke-MgGraphRequest -Uri $uri -Method PATCH -Body ($patchSPHash | ConvertTo-Json -Depth 10) -ContentType "application/json"
                Write-Host "✓ SharePoint settings configured"
                Write-Host "  Applied settings: $($configHash.Keys -join ', ')"
                $result.Status = "Updated"
                $script:planResults.WouldUpdateCount++
            }
            else {
                Write-Host "[WhatIf] Would update SharePoint settings"
                foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
                $result.Status  = "WouldUpdate"
                $result.Changes = $changesObj
                $script:planResults.WouldUpdateCount++
            }
        }
        else {
            Write-Host "○ SharePoint Settings ($FileName) - no changes needed"
            $result.Status = "No changes"
            $script:planResults.NoChangeCount++
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
            Write-Host "##[error]Permission denied. Ensure the service principal has SharePointTenantSettings.ReadWrite.All permission."
        }
        Write-Host "##[warning]Failed to configure SharePoint settings: $_"
        $result.Status = "Failed: $_"
        $script:planResults.ErrorCount++
    }
    
    $script:planResults.Results += $result
    Write-Host "##[endgroup]"
}

# Process configuration based on input type
if ($ConfigDirectory) {
    # Process JSON files from directory
    if (-not (Test-Path $ConfigDirectory)) {
        Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
        Save-PlanOutput
        exit 0
    }
    
    # Get all JSON files starting with "sharepoint-" or legacy files
    $configFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File | Where-Object {
        $_.Name -match "^sharepoint-" -or $_.Name -eq "sharing-policy.json"
    }
    
    # Filter out ignored files based on .baseline-ignore
    # Use the baseline folder root so patterns like "sharepoint-settings/file.json" work correctly
    $baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
    $configFiles = @(Get-FilteredPolicyFiles -PolicyFiles $configFiles -BaselineRoot $baselineRoot)
    $configFiles = @(Get-GroupExcludedFiles -Files $configFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
    
    if ($configFiles.Count -eq 0) {
        Write-Host "##[warning]No SharePoint settings files found in directory: $ConfigDirectory"
        Write-Host "  Expected files starting with 'sharepoint-' (e.g., sharepoint-tenant.json, sharepoint-sharing.json)"
        Save-PlanOutput
        exit 0
    }
    
    Write-Host "Found $($configFiles.Count) SharePoint settings configuration(s)"
    
    foreach ($file in $configFiles) {
        Write-Host "`nProcessing: $($file.Name)"
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $spMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
        if ($spMonitorCfg) {
            $config | Add-Member -NotePropertyName '_monitorConfig' -NotePropertyValue $spMonitorCfg -Force
        }
        $config | Add-Member -NotePropertyName '_SourceFile' -NotePropertyValue $file.FullName -Force
        Set-SharePointSettings -Config $config -FileName $file.Name
    }
}
elseif ($ConfigPath) {
    # Process single JSON file
    if (-not (Test-Path $ConfigPath)) {
        throw "Configuration file not found: $ConfigPath"
    }
    
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    $fileName = [System.IO.Path]::GetFileName($ConfigPath)
    $config | Add-Member -NotePropertyName '_SourceFile' -NotePropertyValue $ConfigPath -Force
    
    Write-Host "Loaded configuration from: $ConfigPath"
    Set-SharePointSettings -Config $config -FileName $fileName
}

# Output plan summary
Save-PlanOutput

Write-Host "`n##[section]SharePoint Settings Configuration Complete"
