<#
.SYNOPSIS
    Configures the Intune Windows Defender ATP (Mobile Threat Defense) connector

.DESCRIPTION
    Creates or updates the mobileThreatDefenseConnector via Microsoft Graph using
    baseline/baseline/intune/defender-connector/windows-defender-atp-connector.json

.PARAMETER ConfigPath
    Path to the connector JSON configuration file

.PARAMETER OutputPath
    Path to save the plan/results JSON file for pipeline summary

.EXAMPLE
    .\Configure-DefenderConnector.ps1 -ConfigPath "windows-defender-atp-connector.json"

.EXAMPLE
    .\Configure-DefenderConnector.ps1 -ConfigPath "windows-defender-atp-connector.json" -WhatIf -OutputPath "plan.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$TenantBaselinePath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Configuring Windows Defender ATP Connector"

$planResults = @{
    Service          = "DefenderConnector"
    Timestamp        = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    WouldCreateCount = 0
    WouldUpdateCount = 0
    NoChangeCount    = 0
    ErrorCount       = 0
    Results          = @()
}

function Save-PlanOutput {
    if ($OutputPath) {
        $script:planResults | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
        Write-Host "Plan saved to: $OutputPath" -ForegroundColor DarkGray
    }
}

if (-not (Test-Path $ConfigPath)) {
    throw "Configuration file not found: $ConfigPath"
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
Write-Host "Loaded configuration from: $ConfigPath"

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$requiredModules = @(
    "Microsoft.Graph.Authentication"
)
Import-RequiredGraphModules -ModuleNames $requiredModules

$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

try {
    $context = Ensure-M365GraphConnection -Scopes @("DeviceManagementServiceConfig.ReadWrite.All")
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

$readOnlyProps = @(
    'id', 'partnerState', 'lastHeartbeatDateTime', 'version', 'microsoftDeviceId',
    '@odata.context', '@odata.type'
)

function Get-CleanConnectorHash {
    param([object]$Config)

    $hash = $Config | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    foreach ($prop in @($readOnlyProps)) {
        if ($hash.ContainsKey($prop)) { $hash.Remove($prop) }
    }
    @($hash.Keys) | Where-Object { $_ -match '^@odata\.' -or $_ -like '_*' } | ForEach-Object { $hash.Remove($_) }
    return $hash
}

$connectorsUri = "https://graph.microsoft.com/v1.0/deviceManagement/mobileThreatDefenseConnectors"
$desiredHash = Get-CleanConnectorHash -Config $config
if ($desiredHash.Count -eq 0) {
    throw "No writable connector properties found in configuration"
}

$result = @{
    DisplayName = "Windows Defender ATP Connector"
    Type        = "mobileThreatDefenseConnector"
    Status      = ""
    Changes     = @()
    FilePath    = (Resolve-Path $ConfigPath).Path
}

Write-Host "`n##[group]Windows Defender ATP Connector"

try {
    $existingConnectors = @((Invoke-MgGraphRequest -Method GET -Uri $connectorsUri).value)
    Write-Host "Found $($existingConnectors.Count) mobileThreatDefenseConnector(s) via Graph"
    $existing = $existingConnectors | Where-Object { $_.microsoftDefenderForEndpointAttachEnabled -eq $true } | Select-Object -First 1
    if (-not $existing -and $existingConnectors.Count -gt 0) {
        $existing = $existingConnectors | Select-Object -First 1
    }
    if ($existing) {
        Write-Host "  Using connector id=$($existing.id) partnerState=$($existing.partnerState) mdeAttach=$($existing.microsoftDefenderForEndpointAttachEnabled)"
        Write-Host "  Connector object type: $($existing.GetType().FullName)"
    }

    $changesObj = if ($existing) {
        New-ChangesObject -Existing $existing -Desired $desiredHash -Keys @($desiredHash.Keys)
    }
    else {
        @{
            Modified       = @($desiredHash.Keys | ForEach-Object { "$_`: (none) -> $(Format-PropertyValue $desiredHash[$_])" })
            ModifiedValues = @{}
        }
    }
    $hasChanges = $changesObj.Modified.Count -gt 0

    if ($existing -and -not $hasChanges) {
        Write-Host "○ Windows Defender ATP Connector - no changes needed"
        Write-Host "  partnerState=$($existing.partnerState)"
        $result.Status = "No changes"
        $planResults.NoChangeCount++
    }
    elseif (-not $existing) {
        $body = @{
            "@odata.type"                         = "#microsoft.graph.mobileThreatDefenseConnector"
            "microsoftDefenderForEndpointAttachEnabled" = $true
            "windowsEnabled"                      = $true
        }
        if ($desiredHash.ContainsKey('microsoftDefenderForEndpointAttachEnabled')) {
            $body.microsoftDefenderForEndpointAttachEnabled = [bool]$desiredHash.microsoftDefenderForEndpointAttachEnabled
        }
        if ($desiredHash.ContainsKey('windowsEnabled')) {
            $body.windowsEnabled = [bool]$desiredHash.windowsEnabled
        }

        if ($PSCmdlet.ShouldProcess("Windows Defender ATP Connector", "Create")) {
            try {
                $created = Invoke-MgGraphRequest -Method POST -Uri $connectorsUri -Body ($body | ConvertTo-Json -Depth 10) -ContentType "application/json"
            }
            catch {
                $detail = $_.Exception.Message
                throw ("Failed to create Defender connector via Graph POST. Ensure Defender for Endpoint is onboarded for this tenant and the Intune-MDE service connection is enabled in the Microsoft Defender portal. Graph error: $detail")
            }

            Write-Host "✓ Created Windows Defender ATP connector" -ForegroundColor Green

            $patchAfterCreate = @{}
            foreach ($key in $desiredHash.Keys) {
                if ($body.ContainsKey($key)) { continue }
                $patchAfterCreate[$key] = $desiredHash[$key]
            }
            if ($patchAfterCreate.Count -gt 0) {
                $patchUri = "$connectorsUri/$($created.id)"
                Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body ($patchAfterCreate | ConvertTo-Json -Depth 10) -ContentType "application/json"
                Write-Host "✓ Applied additional connector settings after create" -ForegroundColor Green
            }

            if (-not (Wait-ForDefenderConnectorPropagation -ConnectorId $created.id -MaxWaitSeconds 180)) {
                Write-Host "##[warning]Connector created but partnerState is not yet available/enabled — EDR deploy may still fail until propagation completes." -ForegroundColor Yellow
            }

            $result.Status = "Created"
            $planResults.WouldCreateCount++
        }
        else {
            Write-Host "[WhatIf] Would create Windows Defender ATP connector"
            foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
            $result.Status = "WouldCreate"
            $result.Changes = $changesObj
            $planResults.WouldCreateCount++
        }
    }
    else {
        $patchBody = @{}
        foreach ($key in $desiredHash.Keys) {
            $currentVal = $null
            if ($existing -is [System.Collections.IDictionary]) {
                if ($existing.Contains($key)) { $currentVal = $existing[$key] }
            }
            elseif ($existing.PSObject.Properties.Name -contains $key) {
                $currentVal = $existing.$key
            }
            if (-not (Compare-PropertyValues -Current $currentVal -New $desiredHash[$key])) {
                $patchBody[$key] = $desiredHash[$key]
            }
        }

        if ($PSCmdlet.ShouldProcess("Windows Defender ATP Connector", "Update")) {
            $patchUri = "$connectorsUri/$($existing.id)"
            Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body ($patchBody | ConvertTo-Json -Depth 10) -ContentType "application/json"
            Write-Host "✓ Updated Windows Defender ATP connector" -ForegroundColor Green
            foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }

            if (-not (Wait-ForDefenderConnectorPropagation -ConnectorId $existing.id -MaxWaitSeconds 180)) {
                throw "Connector PATCH succeeded but partnerState did not reach available/enabled within the wait window"
            }

            $result.Status = "Updated"
            $planResults.WouldUpdateCount++
        }
        else {
            Write-Host "[WhatIf] Would update Windows Defender ATP connector"
            foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
            $result.Status = "WouldUpdate"
            $result.Changes = $changesObj
            $planResults.WouldUpdateCount++
        }
    }
}
catch {
    Write-Host "##[error]Failed to configure Defender connector: $_"
    $result.Status = "Failed: $_"
    $planResults.ErrorCount++
}

$planResults.Results += $result
Write-Host "##[endgroup]"

Save-PlanOutput

if ($planResults.ErrorCount -gt 0) { exit 1 }
