<#
.SYNOPSIS
    Wipes all Intune policies and optionally Conditional Access policies from a tenant.

.DESCRIPTION
    This script removes ALL Intune configurations from a tenant. Use with caution!
    
    Intune items that will be deleted:
    - Device Configurations
    - Compliance Policies
    - Settings Catalog Policies (configurationPolicies)
    - App Protection Policies (iOS, Android, Windows)
    - Endpoint Security Policies (Intents)
    - Windows Autopilot Deployment Profiles
    - Platform Scripts (PowerShell & Shell)
    - Proactive Remediations (Device Health Scripts)
    
    Optionally can also delete:
    - Conditional Access Policies
    - Named Locations

.PARAMETER TenantId
    The Azure AD Tenant ID to target

.PARAMETER ClientId
    Service Principal Application ID

.PARAMETER ClientSecret
    Service Principal Client Secret

.PARAMETER IncludeConditionalAccess
    Also delete Conditional Access policies and Named Locations

.PARAMETER WhatIf
    Preview what would be deleted without actually deleting

.PARAMETER Force
    Skip confirmation prompts (DANGEROUS!)

.EXAMPLE
    .\Wipe-TenantPolicies.ps1 -TenantId "xxx" -ClientId "xxx" -ClientSecret "xxx" -WhatIf
    
.EXAMPLE
    .\Wipe-TenantPolicies.ps1 -TenantId "xxx" -ClientId "xxx" -ClientSecret "xxx" -IncludeConditionalAccess

.NOTES
    ⚠️ WARNING: This script performs DESTRUCTIVE operations!
    Always use -WhatIf first to preview changes.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$TenantId,
    
    [Parameter(Mandatory=$true)]
    [string]$ClientId,
    
    [Parameter(Mandatory=$true)]
    [string]$ClientSecret,
    
    [Parameter(Mandatory=$false)]
    [switch]$IncludeConditionalAccess,
    
    [Parameter(Mandatory=$false)]
    [switch]$Force
)

$ErrorActionPreference = "Stop"

#region Helper Functions

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "SUCCESS", "DELETE")]
        [string]$Level = "INFO"
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $color = switch ($Level) {
        "INFO"    { "White" }
        "WARN"    { "Yellow" }
        "ERROR"   { "Red" }
        "SUCCESS" { "Green" }
        "DELETE"  { "Magenta" }
        default   { "White" }
    }
    
    Write-Host "[$timestamp] [$Level] $Message" -ForegroundColor $color
}

function Get-AllGraphResults {
    param(
        [string]$Uri,
        [string]$Description = "items"
    )
    
    $allResults = @()
    $response = Invoke-MgGraphRequest -Uri $Uri -Method GET
    $allResults = @($response.value)
    
    while ($response.ContainsKey('@odata.nextLink') -and $response.'@odata.nextLink') {
        $response = Invoke-MgGraphRequest -Uri $response.'@odata.nextLink' -Method GET
        $allResults += $response.value
    }
    
    return $allResults
}

function Remove-GraphObject {
    param(
        [string]$Uri,
        [string]$DisplayName,
        [string]$Type,
        [switch]$WhatIf
    )
    
    if ($WhatIf) {
        Write-Log "Would delete $Type : $DisplayName" "DELETE"
        return $true
    }
    
    try {
        Invoke-MgGraphRequest -Uri $Uri -Method DELETE
        Write-Log "Deleted $Type : $DisplayName" "DELETE"
        return $true
    }
    catch {
        Write-Log "Failed to delete $Type '$DisplayName': $($_.Exception.Message)" "ERROR"
        return $false
    }
}

#endregion

#region Main Script

Write-Host ""
Write-Host "========================================================================" -ForegroundColor Red
Write-Host "          !!!  TENANT POLICY WIPE SCRIPT  !!!                           " -ForegroundColor Red
Write-Host "                                                                        " -ForegroundColor Red
Write-Host "  This script will DELETE ALL Intune policies from the tenant!         " -ForegroundColor Red
Write-Host "========================================================================" -ForegroundColor Red
Write-Host ""

Write-Log "Target Tenant: $TenantId" "WARN"
Write-Log "Include Conditional Access: $IncludeConditionalAccess" "INFO"
Write-Log "WhatIf Mode: $WhatIfPreference" "INFO"
Write-Host ""

# Connect to Microsoft Graph
Write-Log "Connecting to Microsoft Graph..." "INFO"
try {
    $secureSecret = ConvertTo-SecureString -String $ClientSecret -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($ClientId, $secureSecret)
    Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $credential -NoWelcome
    
    $context = Get-MgContext
    Write-Log "Connected to tenant: $($context.TenantId)" "SUCCESS"
    
    # Verify this is the expected tenant
    if ($context.TenantId -ne $TenantId) {
        Write-Log "Tenant ID mismatch! Expected: $TenantId, Got: $($context.TenantId)" "ERROR"
        throw "Tenant ID mismatch"
    }
}
catch {
    Write-Log "Failed to connect: $_" "ERROR"
    exit 1
}

# Confirmation prompt (unless Force or WhatIf)
if (-not $Force -and -not $WhatIfPreference) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  You are about to DELETE ALL Intune policies from tenant:" -ForegroundColor Yellow
    Write-Host "  $TenantId" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  This action CANNOT be undone!" -ForegroundColor Red
    Write-Host "═══════════════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""
    
    $confirmation = Read-Host "Type 'DELETE ALL' to confirm"
    if ($confirmation -ne "DELETE ALL") {
        Write-Log "Operation cancelled by user" "WARN"
        exit 0
    }
    Write-Host ""
}

# Track deletion stats
$stats = @{
    DeviceConfigurations = @{ Found = 0; Deleted = 0; Failed = 0 }
    CompliancePolicies = @{ Found = 0; Deleted = 0; Failed = 0 }
    SettingsCatalog = @{ Found = 0; Deleted = 0; Failed = 0 }
    AppProtection = @{ Found = 0; Deleted = 0; Failed = 0 }
    EndpointSecurity = @{ Found = 0; Deleted = 0; Failed = 0 }
    Autopilot = @{ Found = 0; Deleted = 0; Failed = 0 }
    PlatformScripts = @{ Found = 0; Deleted = 0; Failed = 0 }
    Remediations = @{ Found = 0; Deleted = 0; Failed = 0 }
    ConditionalAccess = @{ Found = 0; Deleted = 0; Failed = 0 }
    NamedLocations = @{ Found = 0; Deleted = 0; Failed = 0 }
}

#region Delete Intune Policies

Write-Host ""
Write-Log "=== Starting Intune Policy Deletion ===" "WARN"
Write-Host ""

# 1. Device Configurations
Write-Log "Processing Device Configurations..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations" -Description "device configs"
    $stats.DeviceConfigurations.Found = $items.Count
    Write-Log "Found $($items.Count) device configurations" "INFO"
    
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceConfigurations/$($item.id)" `
            -DisplayName $item.displayName -Type "Device Configuration" -WhatIf:$WhatIfPreference
        if ($result) { $stats.DeviceConfigurations.Deleted++ } else { $stats.DeviceConfigurations.Failed++ }
    }
}
catch {
    Write-Log "Error processing Device Configurations: $_" "ERROR"
}

# 2. Compliance Policies
Write-Log "Processing Compliance Policies..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies" -Description "compliance policies"
    $stats.CompliancePolicies.Found = $items.Count
    Write-Log "Found $($items.Count) compliance policies" "INFO"
    
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies/$($item.id)" `
            -DisplayName $item.displayName -Type "Compliance Policy" -WhatIf:$WhatIfPreference
        if ($result) { $stats.CompliancePolicies.Deleted++ } else { $stats.CompliancePolicies.Failed++ }
    }
}
catch {
    Write-Log "Error processing Compliance Policies: $_" "ERROR"
}

# 3. Settings Catalog (Configuration Policies)
Write-Log "Processing Settings Catalog Policies..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies" -Description "settings catalog"
    $stats.SettingsCatalog.Found = $items.Count
    Write-Log "Found $($items.Count) Settings Catalog policies" "INFO"
    
    foreach ($item in $items) {
        $displayName = if ($item.name) { $item.name } else { $item.displayName }
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies/$($item.id)" `
            -DisplayName $displayName -Type "Settings Catalog" -WhatIf:$WhatIfPreference
        if ($result) { $stats.SettingsCatalog.Deleted++ } else { $stats.SettingsCatalog.Failed++ }
    }
}
catch {
    Write-Log "Error processing Settings Catalog: $_" "ERROR"
}

# 4. App Protection Policies
Write-Log "Processing App Protection Policies..." "INFO"

# iOS
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections" -Description "iOS app protection"
    $stats.AppProtection.Found += $items.Count
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceAppManagement/iosManagedAppProtections/$($item.id)" `
            -DisplayName $item.displayName -Type "iOS App Protection" -WhatIf:$WhatIfPreference
        if ($result) { $stats.AppProtection.Deleted++ } else { $stats.AppProtection.Failed++ }
    }
}
catch { Write-Log "Error with iOS App Protection: $_" "WARN" }

# Android
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections" -Description "Android app protection"
    $stats.AppProtection.Found += $items.Count
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceAppManagement/androidManagedAppProtections/$($item.id)" `
            -DisplayName $item.displayName -Type "Android App Protection" -WhatIf:$WhatIfPreference
        if ($result) { $stats.AppProtection.Deleted++ } else { $stats.AppProtection.Failed++ }
    }
}
catch { Write-Log "Error with Android App Protection: $_" "WARN" }

# Windows
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceAppManagement/windowsInformationProtectionPolicies" -Description "Windows app protection"
    $stats.AppProtection.Found += $items.Count
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceAppManagement/windowsInformationProtectionPolicies/$($item.id)" `
            -DisplayName $item.displayName -Type "Windows App Protection" -WhatIf:$WhatIfPreference
        if ($result) { $stats.AppProtection.Deleted++ } else { $stats.AppProtection.Failed++ }
    }
}
catch { Write-Log "Error with Windows App Protection: $_" "WARN" }

Write-Log "Found $($stats.AppProtection.Found) App Protection policies" "INFO"

# 5. Endpoint Security (Intents)
Write-Log "Processing Endpoint Security Policies..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/intents" -Description "endpoint security"
    $stats.EndpointSecurity.Found = $items.Count
    Write-Log "Found $($items.Count) Endpoint Security policies" "INFO"
    
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/intents/$($item.id)" `
            -DisplayName $item.displayName -Type "Endpoint Security" -WhatIf:$WhatIfPreference
        if ($result) { $stats.EndpointSecurity.Deleted++ } else { $stats.EndpointSecurity.Failed++ }
    }
}
catch {
    Write-Log "Error processing Endpoint Security: $_" "ERROR"
}

# 6. Autopilot Profiles
Write-Log "Processing Autopilot Profiles..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles" -Description "autopilot"
    $stats.Autopilot.Found = $items.Count
    Write-Log "Found $($items.Count) Autopilot profiles" "INFO"
    
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/windowsAutopilotDeploymentProfiles/$($item.id)" `
            -DisplayName $item.displayName -Type "Autopilot Profile" -WhatIf:$WhatIfPreference
        if ($result) { $stats.Autopilot.Deleted++ } else { $stats.Autopilot.Failed++ }
    }
}
catch {
    Write-Log "Error processing Autopilot: $_" "ERROR"
}

# 7. Platform Scripts (PowerShell)
Write-Log "Processing Platform Scripts..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts" -Description "PowerShell scripts"
    $stats.PlatformScripts.Found += $items.Count
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceManagementScripts/$($item.id)" `
            -DisplayName $item.displayName -Type "PowerShell Script" -WhatIf:$WhatIfPreference
        if ($result) { $stats.PlatformScripts.Deleted++ } else { $stats.PlatformScripts.Failed++ }
    }
}
catch { Write-Log "Error with PowerShell Scripts: $_" "WARN" }

# Platform Scripts (Shell/macOS)
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts" -Description "Shell scripts"
    $stats.PlatformScripts.Found += $items.Count
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceShellScripts/$($item.id)" `
            -DisplayName $item.displayName -Type "Shell Script" -WhatIf:$WhatIfPreference
        if ($result) { $stats.PlatformScripts.Deleted++ } else { $stats.PlatformScripts.Failed++ }
    }
}
catch { Write-Log "Error with Shell Scripts: $_" "WARN" }

Write-Log "Found $($stats.PlatformScripts.Found) Platform Scripts" "INFO"

# 8. Remediations
Write-Log "Processing Proactive Remediations..." "INFO"
try {
    $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts" -Description "remediations"
    $stats.Remediations.Found = $items.Count
    Write-Log "Found $($items.Count) Remediations" "INFO"
    
    foreach ($item in $items) {
        $result = Remove-GraphObject -Uri "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts/$($item.id)" `
            -DisplayName $item.displayName -Type "Remediation" -WhatIf:$WhatIfPreference
        if ($result) { $stats.Remediations.Deleted++ } else { $stats.Remediations.Failed++ }
    }
}
catch {
    Write-Log "Error processing Remediations: $_" "ERROR"
}

#endregion

#region Delete Conditional Access (if requested)

if ($IncludeConditionalAccess) {
    Write-Host ""
    Write-Log "=== Starting Conditional Access Deletion ===" "WARN"
    Write-Host ""
    
    # Conditional Access Policies
    Write-Log "Processing Conditional Access Policies..." "INFO"
    try {
        $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" -Description "CA policies"
        $stats.ConditionalAccess.Found = $items.Count
        Write-Log "Found $($items.Count) Conditional Access policies" "INFO"
        
        foreach ($item in $items) {
            $result = Remove-GraphObject -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/$($item.id)" `
                -DisplayName $item.displayName -Type "Conditional Access" -WhatIf:$WhatIfPreference
            if ($result) { $stats.ConditionalAccess.Deleted++ } else { $stats.ConditionalAccess.Failed++ }
        }
    }
    catch {
        Write-Log "Error processing Conditional Access: $_" "ERROR"
    }
    
    # Named Locations
    Write-Log "Processing Named Locations..." "INFO"
    try {
        $items = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations" -Description "named locations"
        $stats.NamedLocations.Found = $items.Count
        Write-Log "Found $($items.Count) Named Locations" "INFO"
        
        foreach ($item in $items) {
            $result = Remove-GraphObject -Uri "https://graph.microsoft.com/v1.0/identity/conditionalAccess/namedLocations/$($item.id)" `
                -DisplayName $item.displayName -Type "Named Location" -WhatIf:$WhatIfPreference
            if ($result) { $stats.NamedLocations.Deleted++ } else { $stats.NamedLocations.Failed++ }
        }
    }
    catch {
        Write-Log "Error processing Named Locations: $_" "ERROR"
    }
}

#endregion

#region Summary

Write-Host ""
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "                        DELETION SUMMARY                                " -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ""

if ($WhatIfPreference) {
    Write-Host "  [WHATIF] No changes were made - preview only" -ForegroundColor Yellow
    Write-Host ""
}

$totalFound = 0
$totalDeleted = 0
$totalFailed = 0

foreach ($category in $stats.Keys) {
    $s = $stats[$category]
    if ($s.Found -gt 0) {
        $totalFound += $s.Found
        $totalDeleted += $s.Deleted
        $totalFailed += $s.Failed
        
        if ($s.Failed -gt 0) {
            Write-Host "  [!] $category : $($s.Deleted)/$($s.Found) deleted" -ForegroundColor Yellow
        } else {
            Write-Host "  [OK] $category : $($s.Deleted)/$($s.Found) deleted" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "  -----------------------------------------" -ForegroundColor Gray
if ($totalFailed -gt 0) {
    Write-Host "  Total: $totalDeleted/$totalFound deleted, $totalFailed failed" -ForegroundColor Yellow
} else {
    Write-Host "  Total: $totalDeleted/$totalFound deleted, $totalFailed failed" -ForegroundColor Green
}
Write-Host ""

if ($WhatIfPreference) {
    Write-Host "  To execute deletion, run without -WhatIf parameter" -ForegroundColor Cyan
    Write-Host ""
}

#endregion

Disconnect-MgGraph | Out-Null


