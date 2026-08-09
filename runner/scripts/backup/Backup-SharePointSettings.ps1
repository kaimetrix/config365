<#
.SYNOPSIS
    Backs up SharePoint tenant settings

.DESCRIPTION
    This script backs up SharePoint Online tenant-level settings including:
    - Sharing capability (internal, external guests, anonymous)
    - Default sharing link type and permissions
    - External user expiration settings
    - Site creation settings
    - Other tenant-level SharePoint policies

    Note: OneDrive inherits sharing settings from SharePoint tenant settings.

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-SharePointSettings.ps1 -BackupPath "C:\backups"
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

Write-Log "=== Starting SharePoint Settings Backup ===" "INFO"

$settingsBackedUp = 0
$settingsFailed = 0

#region SharePoint Tenant Settings
try {
    Write-Log "Backing up SharePoint Tenant Settings..." "INFO"
    
    # Use the SharePoint admin settings endpoint via Microsoft Graph
    $uri = "https://graph.microsoft.com/v1.0/admin/sharepoint/settings"
    
    try {
        $sharepointSettings = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
        
        if ($sharepointSettings) {
            Save-BackupFile -Content $sharepointSettings -RelativePath "sharepoint-settings/sharepoint-tenant.json"
            $settingsBackedUp++
            Write-Log "Saved SharePoint tenant settings" "DEBUG"
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
            Write-Log "Permission denied. Ensure the service principal has SharePointTenantSettings.Read.All permission." "WARN"
        }
        elseif ($errorMessage -match "404" -or $errorMessage -match "Not Found") {
            Write-Log "SharePoint settings endpoint not found." "WARN"
        }
        $settingsFailed++
        Write-Log "Failed to backup SharePoint Tenant Settings: $_" "WARN"
    }
}
catch {
    Write-Log "Failed to backup SharePoint Tenant Settings: $_" "ERROR"
}
#endregion

Write-Log "=== SharePoint Settings Backup Complete ===" "INFO"
Write-Log "Settings: Backed up $settingsBackedUp, Failed $settingsFailed" "INFO"

# Return summary
return @{
    Type = "SharePointSettings"
    Success = ($settingsFailed -eq 0)
    Settings = @{
        BackedUp = $settingsBackedUp
        Failed = $settingsFailed
    }
}
