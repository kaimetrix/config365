<#
.SYNOPSIS
    Backs up SharePoint Online tenant cmdlet settings (Get-PnPTenant), one JSON file per property.

.DESCRIPTION
    Writes tenant backup files under:
      sharepoint-settings/tenant-configuration/{PropertyName}.json

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

$settingsPath = Join-Path $scriptDir '..\graph-configs\SharePoint-TenantSettings.ps1'
. $settingsPath

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

if (-not $script:LogFile) {
    Initialize-BackupLogging -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}

Write-Log '=== Starting SharePoint tenant cmdlet settings backup (PnP) ===' 'INFO'

$results = @{
    BackedUp = 0
    Failed   = 0
    Skipped  = $false
}

if (-not (Import-PnPModuleSafe)) {
    Write-Log 'SharePoint tenant settings backup skipped — PnP.PowerShell unavailable' 'WARN'
    $results.Skipped = $true
    return $results
}

try {
    Connect-SharePointOnlineDelegated | Out-Null
}
catch {
    Write-Log "SharePoint tenant settings backup skipped — could not connect: $_" 'WARN'
    $results.Skipped = $true
    $results.Failed = 1
    return $results
}

try {
    $tenant = Get-SharePointTenantConfigurationObject
    $props = Get-SharePointTenantDeployableProperties
    if ($props.Count -eq 0) {
        throw 'No deployable Set-PnPTenant parameters discovered'
    }

    $backup = Select-SharePointTenantBackupProperties -SourceObject $tenant -DeployableProperties $props
    foreach ($prop in @($backup.Keys | Sort-Object)) {
        $value = ConvertTo-SharePointTenantBackupJsonValue -Value $backup[$prop]
        Save-BackupFile -Content @{ $prop = $value } -RelativePath "$($script:SharePointTenantConfigurationRelativePath)/$prop.json"
        $results.BackedUp++
    }

    Write-Log "SharePoint tenant settings backed up ($($results.BackedUp) properties under $($script:SharePointTenantConfigurationRelativePath)/)" 'INFO'
}
catch {
    $results.Failed = 1
    Write-Log "Failed to backup SharePoint tenant settings: $_" 'ERROR'
    Write-Host "##[error]SharePoint tenant settings backup failed: $_"
}

try {
    if (Get-Command Disconnect-M365Connections -ErrorAction SilentlyContinue) {
        Disconnect-M365Connections
    }
}
catch { }

Write-Log '=== SharePoint tenant cmdlet settings backup complete ===' 'INFO'
return $results
