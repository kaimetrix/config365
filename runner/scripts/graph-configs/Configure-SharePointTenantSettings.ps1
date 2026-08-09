<#
.SYNOPSIS
    Deploys SharePoint Online tenant cmdlet settings from baseline JSON (one file per property).

.DESCRIPTION
    Reads baseline files under:
      sharepoint-settings/tenant-configuration/{PropertyName}.json  → Set-PnPTenant

.PARAMETER ConfigDirectory
    Path to baseline sharepoint-settings folder (e.g. baseline/baseline/sharepoint-settings)

.PARAMETER OutputPath
    Optional path to save plan/results JSON for the deploy pipeline
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigDirectory,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$TenantBaselinePath,

    [Parameter(Mandatory = $false)]
    [string]$TenantRepoPath
)

$ErrorActionPreference = 'Stop'

$connectGraphPath = Join-Path $PSScriptRoot '..\common\Connect-M365Graph.ps1'
$resolverPath     = Join-Path $PSScriptRoot 'Resolve-Placeholders.ps1'
$ignoreHelpersPath = Join-Path $PSScriptRoot 'Common-IgnoreHelpers.ps1'
$diffHelpersPath  = Join-Path $PSScriptRoot 'Common-DiffHelpers.ps1'
$settingsPath     = Join-Path $PSScriptRoot 'SharePoint-TenantSettings.ps1'

if (Test-Path $connectGraphPath) { . $connectGraphPath }
. $resolverPath
. $ignoreHelpersPath
. $diffHelpersPath
. $settingsPath

Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

$baselineRoot = if ($TenantBaselinePath) {
    Join-Path $TenantBaselinePath 'baseline'
} else {
    Split-Path $ConfigDirectory -Parent
}

$tenantConfigDir = Join-Path $ConfigDirectory 'tenant-configuration'

function Get-SharePointTenantConfigHash {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    $configHash = Get-Content $FilePath -Raw | ConvertFrom-Json |
        ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
    Resolve-Placeholders -ConfigObject $configHash
}

function Get-SharePointTenantPropertyFiles {
    if (-not (Test-Path $tenantConfigDir)) { return @() }

    $files = @(Get-ChildItem -Path $tenantConfigDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '_*' })
    return @(Get-FilteredPolicyFiles -PolicyFiles $files -BaselineRoot $baselineRoot)
}

function Save-SharePointTenantPlanOutput {
    param(
        [array]$Results,
        [int]$UpdatedCount,
        [int]$NoChangeCount,
        [int]$WouldUpdateCount,
        [int]$ErrorCount
    )

    if (-not $OutputPath) { return }

    @{
        Service          = 'SharePointTenantSettings'
        Timestamp        = (Get-Date -Format 'o')
        TotalPolicies    = $Results.Count
        CreatedCount     = 0
        UpdatedCount     = $UpdatedCount
        NoChangeCount    = $NoChangeCount
        WouldCreateCount = 0
        WouldUpdateCount = $WouldUpdateCount
        ErrorCount       = $ErrorCount
        Results          = $Results
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Plan saved to: $OutputPath"
}

Write-Host '##[section]Configuring SharePoint Tenant Settings (PnP / SpoTenant)'

if (-not (Import-PnPModuleSafe)) {
    Write-Host '##[warning]PnP.PowerShell unavailable — skipping SharePoint tenant cmdlet settings'
    Save-SharePointTenantPlanOutput -Results @() -UpdatedCount 0 -NoChangeCount 0 -WouldUpdateCount 0 -ErrorCount 0
    exit 0
}

$propertyFiles = @(Get-SharePointTenantPropertyFiles)
if ($propertyFiles.Count -eq 0) {
    Write-Host 'No tenant-configuration baseline files found — skipping'
    Save-SharePointTenantPlanOutput -Results @() -UpdatedCount 0 -NoChangeCount 0 -WouldUpdateCount 0 -ErrorCount 0
    exit 0
}

Write-Host "Found $($propertyFiles.Count) SharePoint tenant setting(s) to process"
foreach ($file in $propertyFiles) {
    Write-Host "  - tenant-configuration/$($file.Name)"
}

try {
    Connect-SharePointOnlineDelegated | Out-Null
}
catch {
    Write-Host "##[warning]Could not connect to SharePoint Online: $_"
    Save-SharePointTenantPlanOutput -Results @() -UpdatedCount 0 -NoChangeCount 0 -WouldUpdateCount 0 -ErrorCount 1
    exit 0
}

$currentTenant = Get-SharePointTenantConfigurationObject
$results = @()
$updatedCount = 0
$noChangeCount = 0
$wouldUpdateCount = 0
$errorCount = 0

foreach ($file in $propertyFiles) {
    $propertyName = $file.BaseName
    $sourceFile = $file.FullName

    Write-Host "##[group]Processing tenant-configuration/$($file.Name)"

    try {
        $configHash = Get-SharePointTenantConfigHash -FilePath $sourceFile
        if (-not $configHash.ContainsKey($propertyName)) {
            Write-Host "##[warning]Expected property '$propertyName' in $($file.Name) — skipping"
            $results += @{
                DisplayName = $propertyName
                Type        = 'SharePointTenantSettings'
                Status      = 'Skipped'
                Changes     = $null
                FilePath    = $sourceFile
            }
            continue
        }

        $desiredValue = $configHash[$propertyName]
        $currentValue = Get-SharePointTenantPropertyValue -Object $currentTenant -PropertyName $propertyName

        if (Compare-PropertyValues -Current $currentValue -New $desiredValue) {
            Write-Host "○ $propertyName is up to date"
            $noChangeCount++
            $results += @{
                DisplayName = $propertyName
                Type        = 'SharePointTenantSettings'
                Status      = 'No changes'
                Changes     = $null
                FilePath    = $sourceFile
            }
            continue
        }

        $changesObj = @{
            Added    = @()
            Removed  = @()
            Modified = @("$propertyName`: $currentValue → $desiredValue")
        }

        $setParams = @{ $propertyName = $desiredValue }
        $label = "Set-PnPTenant -$propertyName"

        if ($PSCmdlet.ShouldProcess($propertyName, $label)) {
            Set-SharePointTenantConfiguration -Parameters $setParams
            $currentTenant = Get-SharePointTenantConfigurationObject
            Write-Host "✓ Updated $propertyName"
            $updatedCount++
            $results += @{
                DisplayName = $propertyName
                Type        = 'SharePointTenantSettings'
                Status      = 'Updated'
                Changes     = $changesObj
                FilePath    = $sourceFile
            }
        }
        else {
            Write-Host "[WhatIf] Would update $propertyName"
            foreach ($mod in $changesObj.Modified) { Write-Host "  ~ $mod" }
            $wouldUpdateCount++
            $results += @{
                DisplayName = $propertyName
                Type        = 'SharePointTenantSettings'
                Status      = 'WouldUpdate'
                Changes     = $changesObj
                FilePath    = $sourceFile
            }
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure $propertyName`: $_"
        $errorCount++
        $results += @{
            DisplayName = $propertyName
            Type        = 'SharePointTenantSettings'
            Status      = "Failed: $_"
            Changes     = $null
            FilePath    = $sourceFile
        }
    }
    finally {
        Write-Host '##[endgroup]'
    }
}

Save-SharePointTenantPlanOutput -Results $results -UpdatedCount $updatedCount -NoChangeCount $noChangeCount -WouldUpdateCount $wouldUpdateCount -ErrorCount $errorCount
Write-Host '##[section]SharePoint Tenant Settings (PnP) Configuration Complete'
