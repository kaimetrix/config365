<#
.SYNOPSIS
    Backs up Enterprise Applications (app registrations and tracked external service principals) from Entra ID

.DESCRIPTION
    This script backs up two categories of enterprise applications:
    - Tenant-owned app registrations: All applications registered in this tenant
      (the apps managed via Configure-EnterpriseApps.ps1)
    - Tracked external service principals: Microsoft-owned apps that have been consented
      to in this tenant (e.g. PIN Reset service, SSPR, etc.) — tracked by well-known appId

    App registrations are exported in parallel batches (Invoke-ParallelBatch).
    External SPs are a fixed small list and remain sequential.

    Each registration is saved as an individual JSON file under:
      enterprise-apps/registrations/<displayName>.json
    Each external SP is saved under:
      enterprise-apps/external-sps/<displayName>.json

.PARAMETER BackupPath
    The base path where backup files will be stored

.PARAMETER ParallelThrottle
    Maximum number of concurrent export batches (default: 5).
    Override via env var BACKUP_PARALLEL_JOBS.

.EXAMPLE
    .\Backup-EnterpriseApps.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [switch]$DebugMode,

    [Parameter(Mandatory=$false)]
    [int]$ParallelThrottle = $(
        if ($env:BACKUP_PARALLEL_JOBS) { [int]$env:BACKUP_PARALLEL_JOBS } else { 5 }
    )
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
    if (-not $connected) { throw "Failed to connect to Microsoft Graph — aborting backup" }
}

Write-Log "=== Starting Enterprise Applications Backup (ParallelThrottle=$ParallelThrottle) ===" "INFO"

$registrationsBackedUp = 0
$registrationsFailed   = 0
$externalSpsBackedUp   = 0
$externalSpsFailed     = 0

# Shared state for parallel batches
$SharedVars = @{
    ScriptDir        = $scriptDir
    BackupPath       = $script:BackupPath
    DebugMode        = [bool]$script:DebugMode
    TenantId         = "$script:CurrentTenantId"
    LogFile          = "$script:LogFile"
    GroupCache       = $script:GroupCache.Clone()
    FilterCache      = if ($script:FilterCache) { $script:FilterCache.Clone() } else { @{} }
    NamedLocationCache = $script:NamedLocationCache.Clone()
}

# ============================================================
# SECTION 1 — Tenant-owned App Registrations
# The $select fields mean the list response already carries all needed data;
# no per-item GET is required. Batches still authenticate so that
# Convert-IdsToPlaceholders can perform live group lookups if needed.
# ============================================================

Write-Log "Backing up tenant-owned app registrations..." "INFO"

try {
    $selectFields = "id,appId,displayName,description,signInAudience,web,requiredResourceAccess,tags,createdDateTime"
    $apps = Get-AllGraphResults -Uri "https://graph.microsoft.com/v1.0/applications?`$select=$selectFields" -Description "app registrations"

    Write-Log "Found $($apps.Count) app registration(s)" "INFO"

    $batchOut = Invoke-ParallelBatch -Items @($apps) -ThrottleLimit $ParallelThrottle -SharedVars $SharedVars -Process {
        $batch = $_
        $sv = $using:SharedVars
        . "$($sv.ScriptDir)\Backup-Common.ps1"
        $script:BackupPath         = $sv.BackupPath
        $script:DebugMode          = $sv.DebugMode
        $script:CurrentTenantId    = $sv.TenantId
        $script:LogFile            = $sv.LogFile
        $script:GroupCache         = $sv.GroupCache
        $script:FilterCache        = $sv.FilterCache
        $script:NamedLocationCache = $sv.NamedLocationCache
        Connect-M365Backup | Out-Null

        foreach ($app in $batch) {
            try {
                $fileName = Get-SafeFileName -Name $app.displayName

                $appData = @{
                    displayName            = $app.displayName
                    appId                  = $app.appId
                    description            = $app.description
                    signInAudience         = $app.signInAudience
                    web                    = $app.web
                    requiredResourceAccess = $app.requiredResourceAccess
                    tags                   = $app.tags
                }

                Save-BackupFile -Content $appData -RelativePath "enterprise-apps/registrations/$fileName.json"
                Write-Log "Saved registration: $($app.displayName)" "DEBUG"
                [PSCustomObject]@{ Success = $true; Name = $app.displayName }
            }
            catch {
                Write-Log "Failed to backup registration '$($app.displayName)': $_" "WARN"
                [PSCustomObject]@{ Success = $false; Name = $app.displayName; Error = "$_" }
            }
        }
    }

    $succeeded = @($batchOut | Where-Object { $_ -and $_.Success })
    $failed    = @($batchOut | Where-Object { $_ -and -not $_.Success })
    $registrationsBackedUp = $succeeded.Count
    $registrationsFailed   = $failed.Count
}
catch {
    Write-Log "Failed to retrieve app registrations: $_" "ERROR"
}

Write-Log "App Registrations: Backed up $registrationsBackedUp, Failed $registrationsFailed" "INFO"

# ============================================================
# SECTION 2 — Tracked External Service Principals
# Microsoft-owned apps that require admin consent in the tenant.
# Add new well-known appIds here as they become relevant.
# ============================================================

$trackedExternalApps = @(
    @{ DisplayName = "Microsoft Pin Reset Service Production"; AppId = "b8456c59-1230-44c7-a4a2-99b085333e84" },
    @{ DisplayName = "Microsoft Pin Reset Client Production";  AppId = "9115dd05-fad5-4f9c-acc7-305d08b1b04e" }
)

Write-Log "Checking $($trackedExternalApps.Count) tracked external service principal(s)..." "INFO"

foreach ($tracked in $trackedExternalApps) {
    try {
        $uri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$($tracked.AppId)'&`$select=id,appId,displayName,description,servicePrincipalType,accountEnabled,tags"
        $response = Invoke-GraphRequestWithDebug -Uri $uri -Method GET

        $spData = @{
            displayName          = $tracked.DisplayName
            appId                = $tracked.AppId
            expectedDisplayName  = $tracked.DisplayName
            registered           = $false
            servicePrincipalId   = $null
            accountEnabled       = $null
            tags                 = $null
        }

        if ($response.value -and $response.value.Count -gt 0) {
            $sp = $response.value[0]
            $spData.registered        = $true
            $spData.servicePrincipalId = $sp.id
            $spData.accountEnabled    = $sp.accountEnabled
            $spData.tags              = $sp.tags
            Write-Log "External SP present: $($tracked.DisplayName) ($($sp.id))" "DEBUG"
        }
        else {
            Write-Log "External SP NOT registered: $($tracked.DisplayName)" "INFO"
        }

        $fileName = Get-SafeFileName -Name $tracked.DisplayName
        Save-BackupFile -Content $spData -RelativePath "enterprise-apps/external-sps/$fileName.json"
        $externalSpsBackedUp++
    }
    catch {
        $externalSpsFailed++
        Write-Log "Failed to check external SP '$($tracked.DisplayName)': $_" "WARN"
    }
}

Write-Log "External SPs: Checked $externalSpsBackedUp, Failed $externalSpsFailed" "INFO"
Write-Log "=== Enterprise Applications Backup Complete ===" "INFO"

# Return summary
return @{
    Type = "EnterpriseApps"
    Success = ($registrationsFailed -eq 0 -and $externalSpsFailed -eq 0)
    Registrations = @{
        BackedUp = $registrationsBackedUp
        Failed   = $registrationsFailed
    }
    ExternalServicePrincipals = @{
        BackedUp = $externalSpsBackedUp
        Failed   = $externalSpsFailed
    }
    TotalBackedUp = $registrationsBackedUp + $externalSpsBackedUp
    TotalFailed   = $registrationsFailed + $externalSpsFailed
}
