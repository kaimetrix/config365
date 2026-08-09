<#
.SYNOPSIS
    Backs up the Intune Windows Defender ATP (Mobile Threat Defense) connector

.DESCRIPTION
    Backs up mobileThreatDefenseConnector settings from Microsoft Graph to
    backups/intune/defender-connector/windows-defender-atp-connector.json

.PARAMETER BackupPath
    The base path where backup files will be stored

.EXAMPLE
    .\Backup-DefenderConnector.ps1 -BackupPath "C:\backups"
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

function Remove-ReadOnlyConnectorFields {
    param($Connector)

    if ($null -eq $Connector) { return $null }

    if ($Connector -is [System.Collections.IDictionary]) {
        $clone = @{}
        foreach ($key in $Connector.Keys) {
            if ($key -match '@odata\.' -or $key -eq 'id' -or $key -eq 'lastHeartbeatDateTime') { continue }
            $clone[$key] = $Connector[$key]
        }
        return $clone
    }

    if ($Connector -is [pscustomobject]) {
        $hash = @{}
        foreach ($prop in $Connector.PSObject.Properties) {
            if ($prop.Name -match '@odata\.' -or $prop.Name -eq 'id' -or $prop.Name -eq 'lastHeartbeatDateTime') { continue }
            $hash[$prop.Name] = $prop.Value
        }
        return $hash
    }

    return $Connector
}

Write-Log "=== Starting Defender Connector Backup ===" "INFO"

$settingsBackedUp = 0
$settingsFailed = 0

try {
    Write-Log "Backing up Windows Defender ATP connector..." "INFO"
    $uri = "https://graph.microsoft.com/v1.0/deviceManagement/mobileThreatDefenseConnectors"

    try {
        $response = Invoke-GraphRequestWithDebug -Uri $uri -Method GET
        $connectors = @($response.value)

        if ($connectors.Count -eq 0) {
            Write-Log "No mobileThreatDefenseConnector objects found in tenant." "WARN"
        }
        else {
            $mdeConnector = $connectors | Where-Object { $_.microsoftDefenderForEndpointAttachEnabled -eq $true } | Select-Object -First 1
            if (-not $mdeConnector) {
                $mdeConnector = $connectors | Select-Object -First 1
                Write-Log "No MDE attach connector found; saving first connector in list." "WARN"
            }

            $payload = Remove-ReadOnlyConnectorFields -Connector $mdeConnector
            Save-BackupFile -Content $payload -RelativePath "intune/defender-connector/windows-defender-atp-connector.json"
            $settingsBackedUp++

            Write-Log ("Saved connector: partnerState={0}, mdeAttach={1}, windows={2}, android={3}, ios={4}" -f `
                $mdeConnector.partnerState, `
                $mdeConnector.microsoftDefenderForEndpointAttachEnabled, `
                $mdeConnector.windowsEnabled, `
                $mdeConnector.androidEnabled, `
                $mdeConnector.iosEnabled) "INFO"
        }
    }
    catch {
        $errorMessage = $_.Exception.Message
        if ($errorMessage -match "403" -or $errorMessage -match "Forbidden") {
            Write-Log "Permission denied. Ensure DeviceManagementServiceConfig.Read.All is granted." "WARN"
        }
        $settingsFailed++
        Write-Log "Failed to backup Defender connector: $_" "WARN"
    }
}
catch {
    Write-Log "Failed to backup Defender connector: $_" "ERROR"
}

Write-Log "=== Defender Connector Backup Complete ===" "INFO"
Write-Log "Settings: Backed up $settingsBackedUp, Failed $settingsFailed" "INFO"

return @{
    Type     = "DefenderConnector"
    Success  = ($settingsFailed -eq 0)
    Settings = @{
        BackedUp = $settingsBackedUp
        Failed   = $settingsFailed
    }
}
