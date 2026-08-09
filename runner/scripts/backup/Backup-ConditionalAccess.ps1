<#
.SYNOPSIS
    Backs up Conditional Access policies and Named Locations

.DESCRIPTION
    This script backs up:
    - Conditional Access policies
    - Named Locations (IP-based and country-based)

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-ConditionalAccess.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,
    
    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

# Load common module if not already loaded
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

# Initialize if needed
if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}
if (-not $script:NamedLocationCache) {
    $script:NamedLocationCache = @{}
}

# Standalone execution: connect and initialize logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

if (-not $script:GroupCache -or $script:GroupCache.Count -eq 0) {
    Initialize-GroupCache | Out-Null
}

Write-Log "=== Starting Conditional Access Backup ===" "INFO"

$policiesBackedUp = 0
$policiesFailed = 0
$locationsBackedUp = 0
$locationsFailed = 0

#region Named Locations
try {
    Write-Log "Backing up Named Locations..." "INFO"
    
    $namedLocations = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations" -Description "named locations"
    
    Write-Log "Found $($namedLocations.Count) named locations" "INFO"
    
    # Build cache while saving
    foreach ($location in $namedLocations) {
        $script:NamedLocationCache[$location.id] = $location.displayName
        
        try {
            $fileName = Get-SafeFileName -Name $location.displayName
            Save-BackupFile -Content $location -RelativePath "conditional-access/named-locations/$fileName.json"
            $locationsBackedUp++
            Write-Log "Saved named location: $($location.displayName)" "DEBUG"
        }
        catch {
            $locationsFailed++
            Write-Log "Failed to backup named location '$($location.displayName)': $_" "WARN"
        }
    }
    
    Write-Log "Named Locations: Backed up $locationsBackedUp, Failed $locationsFailed" "INFO"
}
catch {
    Write-Log "Failed to backup Named Locations: $_" "ERROR"
}
#endregion

#region Conditional Access Policies
try {
    Write-Log "Backing up Conditional Access Policies..." "INFO"
    
    # Use beta endpoint to include policies with Identity Protection features (userRiskLevels, etc.)
    $caPolicies = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/identity/conditionalAccess/policies" -Description "CA policies"
    
    Write-Log "Found $($caPolicies.Count) Conditional Access policies" "INFO"
    
    foreach ($policy in $caPolicies) {
        try {
            $fileName = Get-SafeFileName -Name $policy.displayName
            Save-BackupFile -Content $policy -RelativePath "conditional-access/policies/$fileName.json"
            $policiesBackedUp++
            Write-Log "Saved CA policy: $($policy.displayName)" "DEBUG"
        }
        catch {
            $policiesFailed++
            Write-Log "Failed to backup CA policy '$($policy.displayName)': $_" "WARN"
        }
    }
    
    Write-Log "CA Policies: Backed up $policiesBackedUp, Failed $policiesFailed" "INFO"
}
catch {
    Write-Log "Failed to backup Conditional Access Policies: $_" "ERROR"
}
#endregion

Write-Log "=== Conditional Access Backup Complete ===" "INFO"

# Return summary
return @{
    Type = "ConditionalAccess"
    Success = ($policiesFailed -eq 0 -and $locationsFailed -eq 0)
    Policies = @{
        BackedUp = $policiesBackedUp
        Failed = $policiesFailed
    }
    NamedLocations = @{
        BackedUp = $locationsBackedUp
        Failed = $locationsFailed
        CacheCount = $script:NamedLocationCache.Count
    }
}

