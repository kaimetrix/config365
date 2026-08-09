<#
.SYNOPSIS
    Backs up Entra ID device settings (Security Defaults and Device Registration Policy)

.DESCRIPTION
    Backs up tenant-level Entra ID settings to backups/entra-id-device-settings/:
    - security-defaults.json (identitySecurityDefaultsEnforcementPolicy)
    - device-registration-policy.json (deviceRegistrationPolicy, includes LAPS)
    - mdm-scope.json (Intune MDM user scope / mobileDeviceManagementPolicy)
    - mam-scope.json (Intune MAM user scope / mobileAppManagementPolicy)

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-EntraIDSettings.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [Parameter(Mandatory = $false)]
    [switch]$DebugMode
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

if (-not $script:LogFile) {
    Initialize-BackupLogging -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

Write-Log "=== Starting Entra ID Device Settings Backup ===" "INFO"

$IntuneMobilityPolicyId = '0000000a-0000-0000-c000-000000000000'

function ConvertTo-MobilityScopeBackupObject {
    param(
        [object]$Policy,
        [bool]$IncludeRegistrationFlag
    )

    $groups = @()
    if ($Policy.includedGroups) {
        foreach ($g in @($Policy.includedGroups)) {
            if ($g.id) {
                $groups += @{
                    id          = $g.id
                    displayName = $g.displayName
                }
            }
        }
    }

    $appliesTo = if ($Policy.appliesTo) { $Policy.appliesTo.ToString().ToLowerInvariant() } else { 'none' }

    $backup = @{
        id             = if ($Policy.id) { $Policy.id } else { $IntuneMobilityPolicyId }
        displayName    = $Policy.displayName
        appliesTo      = $appliesTo
        includedGroups = $groups
    }

    if ($IncludeRegistrationFlag) {
        $regDisabled = $false
        if ($null -ne $Policy.isMdmEnrollmentDuringRegistrationDisabled) {
            $regDisabled = [bool]$Policy.isMdmEnrollmentDuringRegistrationDisabled
        }
        $backup['isMdmEnrollmentDuringRegistrationDisabled'] = $regDisabled
    }

    return $backup
}

$script:MobilityScopeBackupConfigs = @(
    @{
        CollectionName          = 'mobileDeviceManagementPolicies'
        RelativePath            = 'entra-id-device-settings/mdm-scope.json'
        Label                   = 'MDM Scope'
        IncludeRegistrationFlag = $true
    },
    @{
        CollectionName          = 'mobileAppManagementPolicies'
        RelativePath            = 'entra-id-device-settings/mam-scope.json'
        Label                   = 'MAM Scope'
        IncludeRegistrationFlag = $false
    }
)

$settingsBackedUp = 0
$settingsFailed = 0

#region Security Defaults
try {
    Write-Log "Backing up Security Defaults..." "INFO"
    $uri = "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy"

    try {
        $securityDefaults = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
        if ($securityDefaults) {
            Save-BackupFile -Content $securityDefaults -RelativePath "entra-id-device-settings/security-defaults.json"
            $settingsBackedUp++
            Write-Log "Saved Security Defaults policy" "DEBUG"
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
            Write-Log "Permission denied backing up Security Defaults. Ensure Policy.Read.All is granted." "WARN"
        }
        $settingsFailed++
        Write-Log "Failed to backup Security Defaults: $_" "WARN"
    }
}
catch {
    Write-Log "Failed to backup Security Defaults: $_" "ERROR"
}
#endregion

#region Device Registration Policy
try {
    Write-Log "Backing up Device Registration Policy..." "INFO"
    $uri = "https://graph.microsoft.com/beta/policies/deviceRegistrationPolicy"

    try {
        $deviceRegPolicy = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
        if ($deviceRegPolicy) {
            Save-BackupFile -Content $deviceRegPolicy -RelativePath "entra-id-device-settings/device-registration-policy.json"
            $settingsBackedUp++
            Write-Log "Saved Device Registration Policy" "DEBUG"
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
            Write-Log "Permission denied backing up Device Registration Policy. Ensure Policy.Read.All is granted." "WARN"
        }
        $settingsFailed++
        Write-Log "Failed to backup Device Registration Policy: $_" "WARN"
    }
}
catch {
    Write-Log "Failed to backup Device Registration Policy: $_" "ERROR"
}
#endregion

#region Mobility Scopes (MDM & MAM)
foreach ($scopeCfg in $script:MobilityScopeBackupConfigs) {
    try {
        Write-Log "Backing up $($scopeCfg.Label)..." "INFO"
        $uri = "https://graph.microsoft.com/beta/policies/$($scopeCfg.CollectionName)/$IntuneMobilityPolicyId`?`$expand=includedGroups"

        try {
            $policy = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
            if ($policy) {
                $backupObject = ConvertTo-MobilityScopeBackupObject -Policy $policy -IncludeRegistrationFlag:$scopeCfg.IncludeRegistrationFlag
                Save-BackupFile -Content $backupObject -RelativePath $scopeCfg.RelativePath
                $settingsBackedUp++
                Write-Log "Saved $($scopeCfg.Label) (appliesTo=$($backupObject.appliesTo))" "DEBUG"
            }
        }
        catch {
            $errorMessage = $_.Exception.Message
            if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
                Write-Log "Permission denied backing up $($scopeCfg.Label). Ensure Policy.Read.All is granted." "WARN"
            }
            $settingsFailed++
            Write-Log "Failed to backup $($scopeCfg.Label): $_" "WARN"
        }
    }
    catch {
        Write-Log "Failed to backup $($scopeCfg.Label): $_" "ERROR"
    }
}
#endregion

Write-Log "=== Entra ID Device Settings Backup Complete ===" "INFO"
Write-Log "Settings: Backed up $settingsBackedUp, Failed $settingsFailed" "INFO"

return @{
    Type    = "EntraIDSettings"
    Success = ($settingsFailed -eq 0)
    Settings = @{
        BackedUp = $settingsBackedUp
        Failed   = $settingsFailed
    }
}
