<#
.SYNOPSIS
    Backs up Intune managed devices and MAM app-protection registrations.

.DESCRIPTION
    Exports per-device Intune compliance state and MAM-only app protection devices
    for the Device Compliance portal page.

    Output files under backups/intune/:
        managed-devices.json    — all Intune MDM-enrolled devices with complianceState
        mam-registrations.json  — Android/iOS MAM registrations (deduplicated by azureADDeviceId)

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable detailed debug logging.

.EXAMPLE
    .\Backup-IntuneDevices.ps1 -BackupPath "C:\backups"
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
if (-not (Get-Command 'Write-Log' -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode  = $DebugMode
}

if (-not $script:LogFile) {
    Initialize-BackupLogging     -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}

if (-not $BackupPath) {
    throw 'BackupPath is required.'
}

Write-Log '=== Starting Intune Device Backup ===' 'INFO'

$managedSelect = @(
    'id', 'deviceName', 'azureADDeviceId', 'managementAgent', 'operatingSystem',
    'osVersion', 'complianceState', 'complianceGracePeriodExpirationDateTime',
    'userPrincipalName', 'userDisplayName', 'lastSyncDateTime', 'enrolledDateTime',
    'isEncrypted', 'jailBroken', 'model', 'manufacturer', 'wiFiMacAddress'
) -join ','

function Format-ManagedDeviceRecord {
    param($Device)
    return @{
        id                                      = $Device.id
        deviceName                              = $Device.deviceName
        azureADDeviceId                         = $Device.azureADDeviceId
        managementAgent                         = $Device.managementAgent
        operatingSystem                         = $Device.operatingSystem
        osVersion                               = $Device.osVersion
        complianceState                         = $Device.complianceState
        complianceGracePeriodExpirationDateTime = $Device.complianceGracePeriodExpirationDateTime
        userPrincipalName                       = $Device.userPrincipalName
        userDisplayName                         = $Device.userDisplayName
        lastSyncDateTime                        = $Device.lastSyncDateTime
        enrolledDateTime                        = $Device.enrolledDateTime
        isEncrypted                             = $Device.isEncrypted
        jailBroken                              = $Device.jailBroken
        model                                   = $Device.model
        manufacturer                            = $Device.manufacturer
        wiFiMacAddress                          = $Device.wiFiMacAddress
    }
}

function Get-PlatformFromOs {
    param([string]$OperatingSystem)
    switch -Wildcard ($OperatingSystem.ToLower()) {
        'windows*' { return 'windows' }
        'macos*'   { return 'macos' }
        'mac os*'  { return 'macos' }
        'ios'      { return 'ios' }
        'android'  { return 'android' }
        default    { return 'other' }
    }
}

function Get-AllMamRegistrations {
    $uri = 'https://graph.microsoft.com/beta/deviceAppManagement/managedAppRegistrations'
    $all = @()
    $page = 0

    do {
        $page++
        $sep = if ($uri -match '\?') { '&' } else { '?' }
        $pagedUri = if ($uri -match '\$top=') { $uri } else { "$uri${sep}`$top=999" }
        $response = Invoke-GraphRequestWithDebug -Uri $pagedUri -Method GET
        if ($null -eq $response) { break }
        $all += @($response.value)
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    Write-Log "Fetched $($all.Count) raw MAM registration(s) across $page page(s)" 'INFO'
    return $all
}

function Format-MamRegistrationRecord {
    param($Reg)
    $type = [string]$Reg.'@odata.type'
    $platform = if ($type -like '*android*') { 'android' }
                elseif ($type -like '*ios*') { 'ios' }
                else { 'other' }

    return @{
        azureADDeviceId              = $Reg.azureADDeviceId
        deviceName                   = $Reg.deviceName
        platform                     = $platform
        # Graph leaves deviceOperatingSystemVersion null on Android/iOS MAM.
        # platformVersion is the OS release the app-protection client reports (e.g. "16", "26.6").
        deviceOperatingSystemVersion = if ($Reg.deviceOperatingSystemVersion) {
            [string]$Reg.deviceOperatingSystemVersion
        } elseif ($Reg.platformVersion) {
            [string]$Reg.platformVersion
        } else {
            $null
        }
        patchVersion                 = if ($Reg.patchVersion) { $Reg.patchVersion } else { $null }
        userId                       = $Reg.userId
        createdDateTime              = $Reg.createdDateTime
        lastSyncDateTime             = $Reg.lastSyncDateTime
    }
}

$results = @{ ManagedDevices = 0; MamRegistrations = 0; Failed = 0 }

try {
    $managedUri = "https://graph.microsoft.com/beta/deviceManagement/managedDevices?`$select=$managedSelect"
    $rawManaged = @(Get-AllGraphResults -Uri $managedUri -Description 'managed devices')

    $formattedManaged = @($rawManaged | ForEach-Object { Format-ManagedDeviceRecord -Device $_ })
    Save-BackupFile -Content $formattedManaged -RelativePath 'intune/managed-devices.json'
    $results.ManagedDevices = $formattedManaged.Count
    Write-Log "Saved intune/managed-devices.json ($($formattedManaged.Count) device(s))" 'INFO'

    try {
        $rawMam = @(Get-AllMamRegistrations)
        $mamMap = @{}

        foreach ($reg in $rawMam) {
            $type = [string]$reg.'@odata.type'
            if ($type -notlike '*android*' -and $type -notlike '*ios*') { continue }

            $formatted = Format-MamRegistrationRecord -Reg $reg
            if (-not $formatted.azureADDeviceId) { continue }

            $key = $formatted.azureADDeviceId
            if (-not $mamMap.ContainsKey($key)) {
                $mamMap[$key] = $formatted
                continue
            }

            $existing = $mamMap[$key]
            $existingPatch = [string]$existing.patchVersion
            $newPatch      = [string]$formatted.patchVersion
            if ($newPatch -and (-not $existingPatch -or $newPatch -gt $existingPatch)) {
                $mamMap[$key] = $formatted
                continue
            }

            $existingSync = [string]$existing.lastSyncDateTime
            $newSync      = [string]$formatted.lastSyncDateTime
            if ($newSync -and $newSync -gt $existingSync) {
                $mamMap[$key] = $formatted
            }
        }

        $formattedMam = @($mamMap.Values)
        Save-BackupFile -Content $formattedMam -RelativePath 'intune/mam-registrations.json'
        $results.MamRegistrations = $formattedMam.Count
        Write-Log "Saved intune/mam-registrations.json ($($formattedMam.Count) unique device(s))" 'INFO'
    }
    catch {
        Write-Log "MAM registration backup failed (DeviceManagementApps.Read.All may not be granted): $_" 'WARN'
        Save-BackupFile -Content @() -RelativePath 'intune/mam-registrations.json'
    }

    Write-Log "=== Intune Device Backup Complete === ($($results.ManagedDevices) managed, $($results.MamRegistrations) MAM)" 'INFO'
}
catch {
    Write-Log "Intune device backup failed: $_" 'ERROR'
    throw
}

return @{
    Type             = 'IntuneDevices'
    Success          = $true
    ManagedDevices   = $results.ManagedDevices
    MamRegistrations = $results.MamRegistrations
    Failed           = $results.Failed
}
