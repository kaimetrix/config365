<#
.SYNOPSIS
    Creates and manages Microsoft Teams via Microsoft Graph API

.DESCRIPTION
    Creates and updates Microsoft Teams, channels, and settings that are deployed to Tenant tenants.
    The script is idempotent - it will create teams if they don't exist, or verify/update if they do.

.PARAMETER ConfigDirectory
    Path to the directory containing JSON Teams definition files

.PARAMETER WhatIf
    Show what would be changed without making changes

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes

.EXAMPLE
    .\Configure-Teams.ps1 -ConfigDirectory "baseline-teams"
    
.EXAMPLE
    .\Configure-Teams.ps1 -ConfigDirectory "baseline-teams" -WhatIf -OutputPath "teams-plan.json"

.NOTES
    Requires Microsoft.Graph.Teams module
    Requires appropriate Graph API permissions: Team.ReadWrite.All, Group.ReadWrite.All
    Each JSON file in the directory should define a single team
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
    [string]$TenantRepoPath  # Path to Tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import placeholder resolver module
$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

Write-Host "##[section]Configuring Microsoft Teams"

# Load team configurations from directory
if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

$teamFiles = Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File
if ($teamFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    Write-Host "Skipping Teams configuration"
    exit 0
}

Write-Host "Found $($teamFiles.Count) team definition(s) in: $ConfigDirectory"

# Load all team configurations
$teamConfigs = @()
foreach ($file in $teamFiles) {
    Write-Host "  Loading: $($file.Name)"
    $teamConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json
    
    # Convert to hashtable and resolve placeholders
    $configHash = $teamConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $configHash = Resolve-Placeholders -ConfigObject $configHash

    # Track source file path for plan-scoped apply
    $configHash['_SourceFile'] = $file.FullName
    
    # Convert back to PSObject
    $teamConfig = $configHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    if ($teamConfig.displayName) { $teamConfig.displayName = $teamConfig.displayName.Trim() }
    $teamConfigs += $teamConfig
}

Write-Host "Teams to process: $($teamConfigs.Count)"

# Import required modules
$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Teams",
    "Microsoft.Graph.Groups"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("Team.ReadWrite.All", "Group.ReadWrite.All")
    Write-Host "✓ Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Function to create or update a Team
function Set-Team {
    param(
        [Parameter(Mandatory=$true)]
        [object]$TeamConfig
    )
    
    Write-Host "`n##[group]Processing: $($TeamConfig.DisplayName)"
    
    try {
        # Check if team already exists (search by group display name)
        $existingGroup = Find-MgGroupByDisplayName -DisplayName $TeamConfig.DisplayName -TeamsOnly
        
        if ($existingGroup) {
            Write-Host "Team already exists: $($existingGroup.Id)"
            
            # Update team settings if needed
            if ($PSCmdlet.ShouldProcess($TeamConfig.DisplayName, "Update team")) {
                # Prepare update parameters (only modifiable properties)
                $updateParams = @{}
                if ($TeamConfig.Description) { $updateParams['Description'] = $TeamConfig.Description }
                if ($TeamConfig.MemberSettings) { $updateParams['MemberSettings'] = $TeamConfig.MemberSettings }
                if ($TeamConfig.GuestSettings) { $updateParams['GuestSettings'] = $TeamConfig.GuestSettings }
                if ($TeamConfig.MessagingSettings) { $updateParams['MessagingSettings'] = $TeamConfig.MessagingSettings }
                if ($TeamConfig.FunSettings) { $updateParams['FunSettings'] = $TeamConfig.FunSettings }
                
                if ($updateParams.Count -gt 0) {
                    Update-MgTeam -TeamId $existingGroup.Id -BodyParameter $updateParams
                    Write-Host "✓ Team updated successfully"
                }
                else {
                    Write-Host "✓ Team is up to date - no changes needed"
                }
            }
            else {
                Write-Host "[WhatIf] Would update team: $($TeamConfig.DisplayName)"
            }
            
            return $existingGroup
        }
        else {
            # Create new team (which creates the group automatically)
            Write-Host "Team does not exist - creating new team"
            
            if ($PSCmdlet.ShouldProcess($TeamConfig.DisplayName, "Create team")) {
                $teamParams = $TeamConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
                
                $newTeam = New-MgTeam -BodyParameter $teamParams
                Write-Host "✓ Team created successfully"
                Write-Host "  Team ID: $($newTeam.Id)"
                return $newTeam
            }
            else {
                Write-Host "[WhatIf] Would create team: $($TeamConfig.DisplayName)"
                return $null
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process team: $($TeamConfig.DisplayName)"
        Write-Host "##[error]Error: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Process all teams
Write-Host "`n##[section]Creating/Updating Microsoft Teams"

$results = @()
$successCount = 0
$errorCount = 0

foreach ($teamConfig in $teamConfigs) {
    try {
        $team = Set-Team -TeamConfig $teamConfig
        if ($team -or $WhatIfPreference) {
            $successCount++
            $results += [PSCustomObject]@{
                DisplayName = $teamConfig.DisplayName
                Id = $team.Id
                Status = "Success"
                FilePath = $teamConfig._SourceFile
            }
        }
    }
    catch {
        $errorCount++
        $results += [PSCustomObject]@{
            DisplayName = $teamConfig.DisplayName
            Id = $null
            Status = "Failed: $_"
            FilePath = $teamConfig._SourceFile
        }
    }
}

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total teams processed: $($teamConfigs.Count)"
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
        Service = "Teams"
        Timestamp = Get-Date -Format "o"
        TotalTeams = $teamConfigs.Count
        SuccessCount = $successCount
        ErrorCount = $errorCount
        Results = $results
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some teams failed to process"
    exit 1
}
else {
    Write-Host "##[command]All Microsoft Teams configured successfully!"
}

