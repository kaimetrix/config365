<#
.SYNOPSIS
    Backs up Azure AD Groups

.DESCRIPTION
    This script backs up all Azure AD groups including:
    - Static membership groups
    - Dynamic membership groups (with membership rules)
    - Group assignments and properties
    
    This script should run FIRST to populate the group cache for other backup scripts.

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-Groups.ps1 -BackupPath "C:\backups"
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

# Initialize caches if needed
if (-not $script:GroupCache) {
    $script:GroupCache = @{}
}
if (-not $script:NamedLocationCache) {
    $script:NamedLocationCache = @{}
}

if (-not $BackupPath) {
    throw "BackupPath is required. Either pass it as a parameter or ensure Backup-Common.ps1 has been initialized."
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

Write-Log "=== Starting Groups Backup ===" "INFO"

$groupsBackedUp = 0
$groupsFailed = 0

try {
    # Get all groups with relevant properties
    Write-Log "Retrieving Azure AD groups..." "INFO"
    
    $groups = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/groups?`$select=id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,securityEnabled,mailEnabled,mail,mailNickname,visibility,isAssignableToRole,createdDateTime" -Description "groups"
    
    Write-Log "Found $($groups.Count) groups" "INFO"
    
    # Also build the cache while we're at it
    foreach ($group in $groups) {
        $script:GroupCache[$group.id] = $group.displayName
    }
    Write-Log "Group cache populated with $($script:GroupCache.Count) groups" "INFO"
    
    # Save each group
    $outputFolder = "groups"
    
    foreach ($group in $groups) {
        try {
            $fileName = Get-SafeFileName -Name $group.displayName
            
            # Create a clean group object with only important properties
            $groupData = @{
                displayName = $group.displayName
                description = $group.description
                groupTypes = $group.groupTypes
                securityEnabled = $group.securityEnabled
                mailEnabled = $group.mailEnabled
                mailNickname = $group.mailNickname
                visibility = $group.visibility
                isAssignableToRole = $group.isAssignableToRole
            }
            
            # Add dynamic membership info if applicable
            if ($group.groupTypes -contains "DynamicMembership") {
                $groupData.membershipRule = $group.membershipRule
                $groupData.membershipRuleProcessingState = $group.membershipRuleProcessingState
            }
            
            # Save the group
            Save-BackupFile -Content $groupData -RelativePath "$outputFolder/$fileName.json"
            
            $groupsBackedUp++
            Write-Log "Saved group: $($group.displayName)" "DEBUG"
        }
        catch {
            $groupsFailed++
            Write-Log "Failed to backup group '$($group.displayName)': $_" "WARN"
        }
    }
    
    Write-Log "=== Groups Backup Complete ===" "INFO"
    Write-Log "Backed up: $groupsBackedUp, Failed: $groupsFailed" "INFO"
}
catch {
    Write-Log "Groups backup failed: $_" "ERROR"
    throw
}

# Return summary
return @{
    Type = "Groups"
    Success = $groupsFailed -eq 0
    BackedUp = $groupsBackedUp
    Failed = $groupsFailed
    CacheCount = $script:GroupCache.Count
}

