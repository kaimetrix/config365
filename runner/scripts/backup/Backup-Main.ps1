<#
.SYNOPSIS
    Main orchestrator for M365 Configuration Backup

.DESCRIPTION
    This script orchestrates the backup of Microsoft 365 configurations.
    It coordinates the execution of individual backup modules:
    1. Groups (first - to build cache)
    2. Conditional Access (uses cached groups/locations)
    3. Custom Security Attributes
    4. Authentication Policies (FIDO2, TAP, SMS, etc.)
    5. SharePoint Settings (sharing policies)
    6. Consent Permissions (user consent, admin consent, permission classifications)
    7. Intune Policies (uses cached groups)
    
    All backup modules share common functions and caches from Backup-Common.ps1

.PARAMETER BackupPath
    The path where backup files will be stored

.PARAMETER TenantId
    The Azure AD Tenant ID (optional for interactive auth)

.PARAMETER ClientId
    Service Principal Application ID for authentication

.PARAMETER ClientSecret
    Service Principal Client Secret for authentication

.PARAMETER CertificateThumbprint
    Certificate thumbprint for certificate-based authentication

.PARAMETER DebugMode
    Enable detailed debug logging

.PARAMETER SkipGroups
    Skip backing up Groups

.PARAMETER SkipConditionalAccess
    Skip backing up Conditional Access

.PARAMETER SkipIntune
    Skip backing up Intune configurations

.PARAMETER SkipAuthenticationPolicies
    Skip backing up Authentication Policies

.PARAMETER SkipSharePointSettings
    Skip backing up SharePoint Settings

.PARAMETER SkipConsentPermissions
    Skip backing up Consent Permissions

.EXAMPLE
    .\Backup-Main.ps1 -BackupPath "C:\backups" -DebugMode
    
.EXAMPLE
    .\Backup-Main.ps1 -BackupPath "C:\backups" -TenantId "xxx" -ClientId "xxx" -ClientSecret "xxx"

.NOTES
    Requires Microsoft.Graph PowerShell modules
    Requires appropriate Microsoft Graph API permissions
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantId,
    
    [Parameter(Mandatory=$false)]
    [string]$ClientId,
    
    [Parameter(Mandatory=$false)]
    [string]$ClientSecret,
    
    [Parameter(Mandatory=$false)]
    [string]$CertificateThumbprint,
    
    [Parameter(Mandatory=$false)]
    [switch]$DebugMode,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipGroups,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipConditionalAccess,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipIntune,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipAuthenticationPolicies,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipSharePointSettings,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipConsentPermissions,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipExchange,

    [Parameter(Mandatory=$false)]
    [switch]$SkipInformationProtection
)

$ErrorActionPreference = "Stop"
$startTime = Get-Date

# Get script directory
$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

# Load common module
Write-Host "Loading Backup-Common module..." -ForegroundColor Cyan
. "$scriptDir\Backup-Common.ps1"

# Initialize backup
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  M365 Configuration Backup" -ForegroundColor Green
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

# Ensure backup directory exists
if (-not (Test-Path $BackupPath)) {
    New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null
}

# Initialize logging
Initialize-BackupLogging -BackupPath $BackupPath -DebugMode:$DebugMode

Write-Log "Backup path: $BackupPath" "INFO"
Write-Log "Debug mode: $DebugMode" "INFO"

# Clear and initialize backup directories
Clear-BackupDirectory -BackupPath $BackupPath
Initialize-BackupDirectories -BackupPath $BackupPath

# Connect to Microsoft Graph
$connected = Connect-M365Backup -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret -CertificateThumbprint $CertificateThumbprint

if (-not $connected) {
    Write-Log "Failed to connect to Microsoft Graph. Aborting backup." "ERROR"
    throw "Connection failed"
}

# Track results
$backupResults = @{
    StartTime = $startTime
    TenantId = $script:CurrentTenantId
    Components = @{}
}

#region Execute Backups

# Note: We use dot-sourcing (.) instead of call operator (&) to share script scope
# This allows child scripts to access $script: variables like GroupCache

# 1. Groups (FIRST - builds cache for other backups)
if (-not $SkipGroups) {
    Write-Host "`n--- Groups Backup ---" -ForegroundColor Yellow
    try {
        # Set parameters for the script
        $groupsBackupPath = $BackupPath
        $groupsDebugMode = $DebugMode
        . "$scriptDir\Backup-Groups.ps1" -BackupPath $groupsBackupPath -DebugMode:$groupsDebugMode
        # The script returns a hashtable, capture it from the output
        $groupsResult = @{
            Success = $true
            BackedUp = $script:GroupCache.Count
            Failed = 0
            CacheCount = $script:GroupCache.Count
        }
        $backupResults.Components["Groups"] = $groupsResult
        Write-Host "Groups backup completed: $($groupsResult.BackedUp) items" -ForegroundColor Green
    }
    catch {
        Write-Log "Groups backup failed: $_" "ERROR"
        $backupResults.Components["Groups"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Groups backup (--SkipGroups)" "INFO"
    # Still need to build the cache
    Initialize-GroupCache | Out-Null
}

# 2. Licenses (subscribed SKUs — used by dynamic group membership evaluation at deploy time)
Write-Host "`n--- Licenses Backup ---" -ForegroundColor Yellow
try {
    . "$scriptDir\Backup-Licenses.ps1" -BackupPath $BackupPath -DebugMode:$DebugMode
    $backupResults.Components['Licenses'] = @{ Success = $true; BackedUp = 1; Failed = 0 }
    Write-Host 'Licenses backup completed' -ForegroundColor Green
}
catch {
    Write-Log "Licenses backup failed: $_" 'ERROR'
    $backupResults.Components['Licenses'] = @{ Success = $false; Error = $_.ToString() }
}

# 3. Conditional Access
if (-not $SkipConditionalAccess) {
    Write-Host "`n--- Conditional Access Backup ---" -ForegroundColor Yellow
    try {
        $caBackupPath = $BackupPath
        . "$scriptDir\Backup-ConditionalAccess.ps1" -BackupPath $caBackupPath
        # The script returns a hashtable
        $caResult = @{
            Success = $true
            Policies = @{ BackedUp = 0; Failed = 0 }
            NamedLocations = @{ BackedUp = $script:NamedLocationCache.Count; Failed = 0; CacheCount = $script:NamedLocationCache.Count }
        }
        $backupResults.Components["ConditionalAccess"] = $caResult
        $totalCA = $script:NamedLocationCache.Count
        Write-Host "Conditional Access backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "Conditional Access backup failed: $_" "ERROR"
        $backupResults.Components["ConditionalAccess"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Conditional Access backup (--SkipConditionalAccess)" "INFO"
    # Still need to build the named location cache
    Initialize-NamedLocationCache | Out-Null
}

# 4. Custom Security Attributes (before Intune, as they may be used in CA dynamic filters)
Write-Host "`n--- Custom Security Attributes Backup ---" -ForegroundColor Yellow
try {
    . "$scriptDir\Backup-CustomAttributes.ps1"
    $customAttrResult = @{
        Success = $true
        AttributeSets = @{ BackedUp = 0; Failed = 0 }
        AttributeDefinitions = @{ BackedUp = 0; Failed = 0 }
    }
    $backupResults.Components["CustomAttributes"] = $customAttrResult
    Write-Host "Custom Security Attributes backup completed" -ForegroundColor Green
}
catch {
    Write-Log "Custom Security Attributes backup failed: $_" "ERROR"
    $backupResults.Components["CustomAttributes"] = @{ Success = $false; Error = $_.ToString() }
}

# 5. Authentication Policies
if (-not $SkipAuthenticationPolicies) {
    Write-Host "`n--- Authentication Policies Backup ---" -ForegroundColor Yellow
    try {
        $authBackupPath = $BackupPath
        . "$scriptDir\Backup-AuthenticationPolicies.ps1" -BackupPath $authBackupPath
        $authResult = @{
            Success = $true
            BackedUp = 0
            Failed = 0
        }
        $backupResults.Components["AuthenticationPolicies"] = $authResult
        Write-Host "Authentication Policies backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "Authentication Policies backup failed: $_" "ERROR"
        $backupResults.Components["AuthenticationPolicies"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Authentication Policies backup (--SkipAuthenticationPolicies)" "INFO"
}

# 6. SharePoint Settings
if (-not $SkipSharePointSettings) {
    Write-Host "`n--- SharePoint Settings Backup ---" -ForegroundColor Yellow
    try {
        $spBackupPath = $BackupPath
        . "$scriptDir\Backup-SharePointSettings.ps1" -BackupPath $spBackupPath
        $backupResults.Components["SharePointSettings"] = @{ Success = $true; BackedUp = 0; Failed = 0 }
        Write-Host "SharePoint Settings (Graph) backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "SharePoint Settings backup failed: $_" "ERROR"
        $backupResults.Components["SharePointSettings"] = @{ Success = $false; Error = $_.ToString() }
    }

    try {
        . "$scriptDir\Backup-SharePointTenantSettings.ps1" -BackupPath $BackupPath
        $backupResults.Components["SharePointTenantSettings"] = @{ Success = $true; BackedUp = 0; Failed = 0 }
        Write-Host "SharePoint Tenant Settings (PnP) backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "SharePoint Tenant Settings backup failed: $_" "ERROR"
        $backupResults.Components["SharePointTenantSettings"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping SharePoint Settings backup (--SkipSharePointSettings)" "INFO"
}

# 7. Consent Permissions
if (-not $SkipConsentPermissions) {
    Write-Host "`n--- Consent Permissions Backup ---" -ForegroundColor Yellow
    try {
        $consentBackupPath = $BackupPath
        . "$scriptDir\Backup-ConsentPermissions.ps1" -BackupPath $consentBackupPath
        $consentResult = @{
            Success = $true
            BackedUp = 0
            Failed = 0
        }
        $backupResults.Components["ConsentPermissions"] = $consentResult
        Write-Host "Consent Permissions backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "Consent Permissions backup failed: $_" "ERROR"
        $backupResults.Components["ConsentPermissions"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Consent Permissions backup (--SkipConsentPermissions)" "INFO"
}

# 8. Intune
if (-not $SkipIntune) {
    Write-Host "`n--- Intune Backup ---" -ForegroundColor Yellow
    try {
        $intuneBackupPath = $BackupPath
        . "$scriptDir\Backup-Intune.ps1" -BackupPath $intuneBackupPath
        $intuneResult = @{
            Success = $true
            TotalBackedUp = 0
            TotalFailed = 0
        }
        $backupResults.Components["Intune"] = $intuneResult
        Write-Host "Intune backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "Intune backup failed: $_" "ERROR"
        $backupResults.Components["Intune"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Intune backup (--SkipIntune)" "INFO"
}

# 9. Exchange Online
if (-not $SkipExchange) {
    Write-Host "`n--- Exchange Online Backup ---" -ForegroundColor Yellow
    try {
        $exchangeBackupPath = $BackupPath
        $exchangeResult = . "$scriptDir\Backup-Exchange.ps1" -BackupPath $exchangeBackupPath
        if ($exchangeResult) {
            $backupResults.Components["Exchange"] = $exchangeResult
        }
        else {
            $backupResults.Components["Exchange"] = @{
                Success = $true
                TotalBackedUp = 0
                TotalFailed = 0
            }
        }
        Write-Host "Exchange Online backup completed" -ForegroundColor Green
    }
    catch {
        # Exchange backup is non-fatal - certificate may not be configured
        Write-Log "Exchange backup failed (certificate may not be configured): $_" "WARN"
        $backupResults.Components["Exchange"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
        Write-Log "Skipping Exchange backup (--SkipExchange)" "INFO"
}

# 10. Information Protection (Sensitivity Labels)
if (-not $SkipInformationProtection) {
    Write-Host "`n--- Information Protection Backup ---" -ForegroundColor Yellow
    try {
        $ipResult = . "$scriptDir\Backup-InformationProtection.ps1" -BackupPath $BackupPath
        if ($ipResult) {
            $backupResults.Components["InformationProtection"] = $ipResult
        }
        else {
            $backupResults.Components["InformationProtection"] = @{
                Success = $true
                TotalBackedUp = 0
                TotalFailed = 0
            }
        }
        Write-Host "Information Protection backup completed" -ForegroundColor Green
    }
    catch {
        Write-Log "Information Protection backup failed: $_" "WARN"
        $backupResults.Components["InformationProtection"] = @{ Success = $false; Error = $_.ToString() }
    }
}
else {
    Write-Log "Skipping Information Protection backup (--SkipInformationProtection)" "INFO"
}

#endregion

#region Generate Manifest

$endTime = Get-Date
$duration = $endTime - $startTime

$manifest = @{
    BackupType = "M365Configuration"
    TenantId = $script:CurrentTenantId
    BackupTimestamp = $startTime.ToString("yyyy-MM-ddTHH:mm:ss")
    CompletedTimestamp = $endTime.ToString("yyyy-MM-ddTHH:mm:ss")
    DurationSeconds = [int]$duration.TotalSeconds
    DebugMode = [bool]$DebugMode
    Components = @{}
}

# Add component summaries
foreach ($component in $backupResults.Components.Keys) {
    $result = $backupResults.Components[$component]
    if ($result.Success -ne $false) {
        $manifest.Components[$component] = @{
            BackedUp = if ($result.TotalBackedUp) { $result.TotalBackedUp } elseif ($result.BackedUp) { $result.BackedUp } else { 0 }
            Failed = if ($result.TotalFailed) { $result.TotalFailed } elseif ($result.Failed) { $result.Failed } else { 0 }
        }
    }
    else {
        $manifest.Components[$component] = @{ Error = $result.Error }
    }
}

# Save manifest
$manifestPath = Join-Path $BackupPath "backup-manifest.json"
$manifest | ConvertTo-Json -Depth 10 | Out-File -FilePath $manifestPath -Encoding UTF8

Write-Log "Backup manifest saved to: $manifestPath" "INFO"

#endregion

#region Summary

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Backup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Duration: $([int]$duration.TotalMinutes) min $([int]$duration.Seconds) sec" -ForegroundColor Cyan
Write-Host "  Backup Path: $BackupPath" -ForegroundColor Cyan
Write-Host "  Log File: $script:LogFile" -ForegroundColor Cyan
Write-Host ""

# Show summary table
Write-Host "  Component Summary:" -ForegroundColor Yellow
Write-Host "  -----------------" -ForegroundColor Yellow
foreach ($component in $backupResults.Components.Keys) {
    $result = $backupResults.Components[$component]
    $backed = if ($result.TotalBackedUp) { $result.TotalBackedUp } elseif ($result.BackedUp) { $result.BackedUp } else { 0 }
    $failed = if ($result.TotalFailed) { $result.TotalFailed } elseif ($result.Failed) { $result.Failed } else { 0 }
    
    if ($result.Success -eq $false) {
        Write-Host "  $component : FAILED" -ForegroundColor Red
    }
    elseif ($failed -gt 0) {
        Write-Host "  $component : $backed backed up, $failed failed" -ForegroundColor Yellow
    }
    else {
        Write-Host "  $component : $backed backed up" -ForegroundColor Green
    }
}

Write-Host ""

#endregion

# Return results
return @{
    Success = $true
    BackupPath = $BackupPath
    LogFile = $script:LogFile
    Duration = $duration
    Manifest = $manifest
}

