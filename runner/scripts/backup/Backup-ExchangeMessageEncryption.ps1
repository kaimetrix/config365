<#
.SYNOPSIS
    Backs up Exchange Online IRM and OME configuration (one JSON file per property).

.DESCRIPTION
    Writes tenant backup files under:
      exchange/aip-service/ServiceEnabled.json
      exchange/aip-service/configuration/{PropertyName}.json
      exchange/irm-configuration/{PropertyName}.json
      exchange/ome-configuration/{PropertyName}.json
      exchange/ome-configuration/_policy-identity.json

.PARAMETER BackupPath
    Base backup directory (tenant/backups).
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

$connectGraphPath = Join-Path $scriptDir '..\common\Connect-M365Graph.ps1'
if (Test-Path $connectGraphPath) { . $connectGraphPath }

$settingsPath = Join-Path $scriptDir '..\graph-configs\Exchange-MessageEncryption-Settings.ps1'
. $settingsPath

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

Write-Log '=== Starting Exchange Message Encryption backup (AIP/IRM/OME) ===' 'INFO'

$results = @{
    AipService             = @{ BackedUp = 0; Failed = 0 }
    AipServiceConfiguration = @{ BackedUp = 0; Failed = 0 }
    IrmConfiguration       = @{ BackedUp = 0; Failed = 0 }
    OmeConfiguration       = @{ BackedUp = 0; Failed = 0 }
}

#region AIP Service

if (Import-AipServiceModuleSafe) {
    try {
        Write-Log 'Backing up Azure Information Protection service...' 'INFO'
        Connect-AipServiceDelegated | Out-Null

        $serviceEnabled = Get-AipServiceEnabledState
        Save-BackupFile -Content @{ Enabled = $serviceEnabled } -RelativePath "$($script:AipServiceRelativePath)/ServiceEnabled.json"
        $results.AipService.BackedUp = 1
        Write-Log "AIP service activation backed up (Enabled=$serviceEnabled)" 'INFO'

        if (Get-Command Get-AipServiceConfiguration -ErrorAction SilentlyContinue) {
            $aipConfig = Get-AipServiceConfiguration -ErrorAction Stop
            $aipBackup = Select-AipServiceConfigurationBackupProperties -SourceObject $aipConfig
            foreach ($prop in @($aipBackup.Keys | Sort-Object)) {
                Save-BackupFile -Content @{ $prop = $aipBackup[$prop] } -RelativePath "$($script:AipServiceConfigurationRelativePath)/$prop.json"
            }
            $results.AipServiceConfiguration.BackedUp = $aipBackup.Keys.Count
            Write-Log "AIP service configuration backed up ($($results.AipServiceConfiguration.BackedUp) settings under $($script:AipServiceConfigurationRelativePath)/)" 'INFO'
        }
    }
    catch {
        $results.AipService.Failed = 1
        $results.AipServiceConfiguration.Failed = 1
        Write-Log "Failed to backup AIP service: $_" 'ERROR'
        Write-Host "##[error]AIP service backup failed: $_"
    }
}
else {
    Write-Log 'AIP service backup skipped — AIPService module unavailable on this Linux runner (IRM/OME via Exchange Online are unaffected).' 'WARN'
}

#endregion

try {
    Connect-ExchangeOnlineDelegated | Out-Null
}
catch {
    Write-Log "Failed to connect Exchange Online for IRM/OME backup: $_" 'ERROR'
    throw
}

#region OME Configuration (before IRM — Get-IRMConfiguration can break the EXO cmdlet path for OME)

try {
    Write-Log 'Backing up OME configuration...' 'INFO'

    $omeConfigs = @()
    $maxAttempts = 3
    $lastError = $null
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            if ($attempt -gt 1) {
                Write-Log "OME configuration retry attempt $attempt of $maxAttempts..." 'INFO'
            }
            $preferRest = ($attempt -gt 1)
            $omeConfigs = @(Get-OmeConfigurationObjects -PreferRest:$preferRest)
            if ($omeConfigs.Count -gt 0) { break }
        }
        catch {
            $lastError = $_
            if ($attempt -lt $maxAttempts) {
                Write-Log "OME configuration attempt $attempt failed: $lastError - retrying in 10s" 'WARN'
                Start-Sleep -Seconds 10
            }
        }
    }

    if ($omeConfigs.Count -eq 0) {
        if ($lastError) { throw $lastError }
        throw 'No OME configuration objects returned'
    }

    $omeIdentity = Resolve-OmeConfigurationIdentity -OmeConfigurations $omeConfigs
    $ome = @($omeConfigs | Where-Object { "$($_.Identity)" -eq $omeIdentity } | Select-Object -First 1)[0]
    if (-not $ome) {
        throw "Could not resolve OME configuration for identity '$omeIdentity'"
    }

    Save-BackupFile -Content @{ Identity = $omeIdentity } -RelativePath $script:OmeIdentityBackupFile

    $props = Get-OmeConfigurationDeployableProperties
    $omeBackup = Select-ExchangeMessageEncryptionBackupProperties -SourceObject $ome -DeployableProperties $props

    foreach ($prop in @($omeBackup.Keys | Sort-Object)) {
        Save-BackupFile -Content @{ $prop = $omeBackup[$prop] } -RelativePath "$($script:OmeConfigurationRelativePath)/$prop.json"
    }

    $results.OmeConfiguration.BackedUp = $omeBackup.Keys.Count
    Write-Log "OME configuration backed up ($($results.OmeConfiguration.BackedUp) settings under $($script:OmeConfigurationRelativePath)/; Identity=$omeIdentity)" 'INFO'
}
catch {
    $results.OmeConfiguration.Failed = 1
    Write-Log "Failed to backup OME configuration: $_" 'ERROR'
    Write-Host "##[error]OME configuration backup failed: $_"
}

#endregion

#region IRM Configuration

try {
    Write-Log 'Backing up IRM configuration...' 'INFO'

    if (-not (Get-Command Get-IRMConfiguration -ErrorAction SilentlyContinue)) {
        throw 'Get-IRMConfiguration cmdlet not available'
    }

    $irm = Get-IRMConfiguration -ErrorAction Stop
    $props = Get-IrmConfigurationDeployableProperties
    $irmBackup = Select-ExchangeMessageEncryptionBackupProperties -SourceObject $irm -DeployableProperties $props

    foreach ($prop in @($irmBackup.Keys | Sort-Object)) {
        Save-BackupFile -Content @{ $prop = $irmBackup[$prop] } -RelativePath "$($script:IrmConfigurationRelativePath)/$prop.json"
    }

    $results.IrmConfiguration.BackedUp = $irmBackup.Keys.Count
    Write-Log "IRM configuration backed up ($($results.IrmConfiguration.BackedUp) settings under $($script:IrmConfigurationRelativePath)/)" 'INFO'
}
catch {
    $results.IrmConfiguration.Failed = 1
    Write-Log "Failed to backup IRM configuration: $_" 'ERROR'
    Write-Host "##[error]IRM configuration backup failed: $_"
}

#endregion

try {
    if (Get-Command Disconnect-M365Connections -ErrorAction SilentlyContinue) {
        Disconnect-M365Connections
    }
}
catch { }

Write-Log '=== Exchange Message Encryption backup complete ===' 'INFO'
return $results
