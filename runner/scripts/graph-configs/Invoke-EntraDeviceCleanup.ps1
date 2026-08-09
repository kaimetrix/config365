<#
.SYNOPSIS
    Removes stale Entra ID device objects that have not signed in within a configurable window.

.DESCRIPTION
    Reads an entra-device-cleanup configuration from the baseline repo and/or tenant repo. For each
    Entra ID device in scope the script:
      1. Evaluates approximateLastSignInDateTime against the configured inactiveDays threshold.
      2. Checks whether the device belongs to any excludeGroups and skips it if so.
      3. Deletes the stale Entra device object via DELETE /v1.0/devices/{id}.

    This targets Entra ID device registrations only — Intune managed device records (if any) are
    not touched here; Intune has its own native inactive-device cleanup.

    Scope is controlled by optional targetGroups in the config. If no groups are configured, all
    Entra ID devices visible to the service principal are evaluated.

    Tenant config overrides baseline config (the tenant file wins; both files are merged with the
    tenant values taking precedence on shared properties).

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/entra-device-cleanup.json (the maintenance/ folder
    checked out from the baseline repo).

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/entra-device-cleanup.json in the tenant
    repo.  If the tenant file is present its values override the baseline file.

.PARAMETER TenantName
    Tenant name used in log messages.

.PARAMETER OutputPath
    Optional path to write a JSON summary of planned/applied deletions.

.PARAMETER WhatIfMode
    Show which devices would be deleted without calling the Graph delete API.

.EXAMPLE
    .\Invoke-EntraDeviceCleanup.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "Tenant-repo/config/maintenance" `
        -TenantName        "contoso" `
        -WhatIfMode

.NOTES
    Required permissions (application):
      Device.ReadWrite.All     — read all Entra device objects and delete stale ones
      GroupMember.Read.All     — resolve Entra group members (when targetGroups/excludeGroups used)
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [string]$BaselineConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantName = '',

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

# ============================================================================
# GRAPH HELPERS
# ============================================================================

function Invoke-GraphRequest {
    param(
        [string]$Method = 'GET',
        [string]$Uri,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )
    # Use the SDK's own request cmdlet rather than manually extracting a bearer token.
    # (Get-MgContext).AuthContext.AccessToken / Get-MgAccessToken are NOT reliable ways to
    # get a raw token in current Microsoft.Graph.Authentication versions — Get-MgContext
    # does not expose an AuthContext/AccessToken property and Get-MgAccessToken is not
    # exported at all in the installed SDK version. Invoke-MgGraphRequest uses the SDK's
    # internal auth provider (populated by Connect-MgGraph) directly, so no token
    # extraction is needed.
    $params = @{ Uri = $Uri; Method = $Method; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    return Invoke-MgGraphRequest @params
}

function Get-AllPages {
    param([string]$Uri)
    $results = [System.Collections.Generic.List[object]]::new()
    $next    = $Uri
    while ($next) {
        $page = Invoke-GraphRequest -Uri $next
        if ($page.value) { $results.AddRange($page.value) }
        $next = $page.'@odata.nextLink'
    }
    return $results
}

# ============================================================================
# LOAD AND MERGE CONFIGURATION
# ============================================================================

Write-Host "`n##[section]Loading Entra device cleanup configuration"

function Read-EntraDeviceCleanupConfigFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return $null }
    $path = Join-Path $Dir 'entra-device-cleanup.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No entra-device-cleanup.json found in: $Dir" -ForegroundColor DarkGray
        return $null
    }
    try {
        $parsed = Get-Content $path -Raw | ConvertFrom-Json
        Write-Host "  Loaded config from: $path"
        return $parsed
    } catch {
        Write-Host "  Warning: Failed to parse $path — $_" -ForegroundColor Yellow
        return $null
    }
}

$baselineConfig = Read-EntraDeviceCleanupConfigFile -Dir $BaselineConfigDir
$tenantConfig   = Read-EntraDeviceCleanupConfigFile -Dir $TenantConfigDir

# Tenant file wins; fall back to baseline; if neither exists use built-in defaults
$effectiveConfig = if ($tenantConfig) { $tenantConfig } elseif ($baselineConfig) { $baselineConfig } else { $null }

if (-not $effectiveConfig) {
    Write-Host "No entra-device-cleanup.json found in baseline or tenant. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        $outputDir = Split-Path -Path $OutputPath -Parent
        if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
        @{ Service = 'EntraDeviceCleanup'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

$enabled      = if ($effectiveConfig.PSObject.Properties['enabled'])      { [bool]$effectiveConfig.enabled }      else { $true }
$inactiveDays = if ($effectiveConfig.PSObject.Properties['inactiveDays']) { [int]$effectiveConfig.inactiveDays }  else { 90 }
$targetGroups = if ($effectiveConfig.PSObject.Properties['targetGroups'])  { @($effectiveConfig.targetGroups) }   else { @() }
$excludeGroups = if ($effectiveConfig.PSObject.Properties['excludeGroups']) { @($effectiveConfig.excludeGroups) } else { @() }

Write-Host "  Enabled       : $enabled"
Write-Host "  InactiveDays  : $inactiveDays"
Write-Host "  TargetGroups  : $(if ($targetGroups.Count -eq 0) { 'all Entra ID devices' } else { "$($targetGroups.Count) group(s)" })"
Write-Host "  ExcludeGroups : $($excludeGroups.Count) group(s)"

if (-not $enabled) {
    Write-Host "Feature is disabled. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        $outputDir = Split-Path -Path $OutputPath -Parent
        if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
        @{ Service = 'EntraDeviceCleanup'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Enabled = $false; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

if ($OutputPath) {
    $outputDir = Split-Path -Path $OutputPath -Parent
    if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
}

# ============================================================================
# GRAPH AUTHENTICATION
# ============================================================================

Write-Host "`nChecking required PowerShell modules..."
$requiredModules = @('Microsoft.Graph.Authentication')
foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "  Installing module: $module"
        Install-Module -Name $module -Force -AllowClobber -Scope CurrentUser
    }
    Import-Module $module -ErrorAction SilentlyContinue
    Write-Host "  Loaded: $module"
}

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to Graph tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# COMPUTE INACTIVITY CUTOFF
# ============================================================================

$cutoffDate = (Get-Date).ToUniversalTime().AddDays(-$inactiveDays)
Write-Host "`n  Inactivity cutoff: $($cutoffDate.ToString('yyyy-MM-ddTHH:mm:ssZ')) ($inactiveDays days ago)"

$GRAPH_V1     = 'https://graph.microsoft.com/v1.0'
$deviceSelect = 'id,displayName,deviceId,approximateLastSignInDateTime,operatingSystem,trustType,managementType,isManaged'

# ============================================================================
# ENUMERATE ENTRA DEVICES IN SCOPE
# ============================================================================

Write-Host "`n##[section]Enumerating Entra ID devices"

$candidateDevices = [System.Collections.Generic.List[object]]::new()

if ($targetGroups.Count -eq 0) {
    Write-Host "  No targetGroups configured; retrieving all Entra ID devices..."
    try {
        $allDevices = @(Get-AllPages -Uri "$GRAPH_V1/devices?`$select=$deviceSelect&`$top=999")
        foreach ($d in $allDevices) { $candidateDevices.Add($d) }
        Write-Host "  Retrieved $($candidateDevices.Count) Entra device(s)."
    } catch {
        throw "Failed to retrieve Entra devices: $_"
    }
} else {
    foreach ($tg in $targetGroups) {
        $tgId   = if ($tg.PSObject.Properties['groupId']   -and $tg.groupId)   { $tg.groupId.Trim() }   else { $null }
        $tgName = if ($tg.PSObject.Properties['groupName'] -and $tg.groupName) { $tg.groupName.Trim() } else { $null }

        if (-not $tgId -and $tgName) {
            Write-Host "  Resolving group by name: $tgName"
            try {
                $encoded = [Uri]::EscapeDataString("displayName eq '$tgName'")
                $found   = Invoke-GraphRequest -Uri "$GRAPH_V1/groups?`$filter=$encoded&`$select=id,displayName"
                $tgId    = $found.value | Select-Object -First 1 -ExpandProperty id
            } catch {
                Write-Host "  Warning: Failed to resolve group '$tgName' — skipping." -ForegroundColor Yellow
                continue
            }
        }

        if (-not $tgId) {
            Write-Host "  Warning: Could not resolve group '$(if ($tgName) { $tgName } else { 'unknown' })' — skipping." -ForegroundColor Yellow
            continue
        }

        Write-Host "  Retrieving device members of group: $(if ($tgName) { $tgName } else { $tgId })"
        try {
            $members       = @(Get-AllPages -Uri "$GRAPH_V1/groups/$tgId/members?`$select=$deviceSelect&`$top=999")
            $deviceMembers = @($members | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.device' })
            Write-Host "    Device members found: $($deviceMembers.Count)"
            foreach ($dm in $deviceMembers) { $candidateDevices.Add($dm) }
        } catch {
            Write-Host "  Warning: Failed to retrieve group members for '$tgName' — skipping." -ForegroundColor Yellow
            continue
        }
    }

    # Deduplicate by Entra object id
    $seen      = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $deduped   = [System.Collections.Generic.List[object]]::new()
    foreach ($d in $candidateDevices) {
        if ($d.id -and $seen.Add($d.id)) { $deduped.Add($d) }
    }
    $candidateDevices = $deduped
    Write-Host "  Total unique devices in scope: $($candidateDevices.Count)"
}

# ============================================================================
# RESOLVE EXCLUSION GROUPS
# ============================================================================

$excludedIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

if ($excludeGroups.Count -gt 0) {
    Write-Host "`n  Resolving $($excludeGroups.Count) exclusion group(s)..."
}

foreach ($eg in $excludeGroups) {
    $egId   = if ($eg.PSObject.Properties['groupId']   -and $eg.groupId)   { $eg.groupId.Trim() }   else { $null }
    $egName = if ($eg.PSObject.Properties['groupName'] -and $eg.groupName) { $eg.groupName.Trim() } else { $null }

    if (-not $egId -and $egName) {
        Write-Host "  Resolving exclusion group by name: $egName"
        try {
            $encoded = [Uri]::EscapeDataString("displayName eq '$egName'")
            $found   = Invoke-GraphRequest -Uri "$GRAPH_V1/groups?`$filter=$encoded&`$select=id,displayName"
            $egId    = $found.value | Select-Object -First 1 -ExpandProperty id
        } catch {
            Write-Host "  Warning: Failed to resolve exclusion group '$egName' — skipping." -ForegroundColor Yellow
            continue
        }
    }

    if (-not $egId) {
        Write-Host "  Warning: Could not resolve exclusion group '$(if ($egName) { $egName } else { 'unknown' })' — skipping." -ForegroundColor Yellow
        continue
    }

    Write-Host "  Exclusion group ID: $egId $(if ($egName) { "($egName)" })"
    try {
        $egMembers = @(Get-AllPages -Uri "$GRAPH_V1/groups/$egId/members?`$select=id&`$top=999")
        foreach ($em in $egMembers) {
            if ($em.id) { $excludedIds.Add($em.id) | Out-Null }
        }
        Write-Host "    Added $($egMembers.Count) member(s) to exclusion set."
    } catch {
        Write-Host "  Warning: Failed to retrieve members of exclusion group '$egName' — skipping." -ForegroundColor Yellow
    }
}

if ($excludedIds.Count -gt 0) {
    Write-Host "  Total excluded device IDs: $($excludedIds.Count)"
}

# ============================================================================
# FILTER TO INACTIVE DEVICES
# ============================================================================

Write-Host "`n##[section]Filtering inactive devices"

$staleDevices = [System.Collections.Generic.List[object]]::new()
$skippedNoDate = 0
$skippedActive = 0
$skippedExcluded = 0

foreach ($device in $candidateDevices) {
    # Skip devices in exclusion groups
    if ($device.id -and $excludedIds.Contains($device.id)) {
        $skippedExcluded++
        Write-Verbose "  Excluded: '$($device.displayName)' (in exclusion group)"
        continue
    }

    $lastSignIn = $device.approximateLastSignInDateTime
    if (-not $lastSignIn) {
        # Devices that have never signed in are treated as stale
        $staleDevices.Add($device)
        Write-Verbose "  Stale (no sign-in date): '$($device.displayName)'"
        continue
    }

    try {
        $lastSignInDate = [datetime]::Parse($lastSignIn).ToUniversalTime()
    } catch {
        $skippedNoDate++
        Write-Host "  Warning: Could not parse lastSignInDate '$lastSignIn' for '$($device.displayName)' — skipping." -ForegroundColor Yellow
        continue
    }

    if ($lastSignInDate -lt $cutoffDate) {
        $staleDevices.Add($device)
        Write-Verbose "  Stale: '$($device.displayName)' (last sign-in: $($lastSignInDate.ToString('yyyy-MM-dd')))"
    } else {
        $skippedActive++
    }
}

Write-Host "  Candidate devices evaluated : $($candidateDevices.Count)"
Write-Host "  Stale (to delete)           : $($staleDevices.Count)"
Write-Host "  Active (skipped)            : $skippedActive"
Write-Host "  Excluded (skipped)          : $skippedExcluded"
if ($skippedNoDate -gt 0) { Write-Host "  Unparseable date (skipped)  : $skippedNoDate" -ForegroundColor Yellow }

if ($staleDevices.Count -eq 0) {
    Write-Host "`nNo stale devices found. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{
            Service          = 'EntraDeviceCleanup'
            Timestamp        = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
            TenantName       = $TenantName
            WhatIfMode       = [bool]$WhatIfMode
            InactiveDays     = $inactiveDays
            CutoffDate       = $cutoffDate.ToString('yyyy-MM-ddTHH:mm:ssZ')
            CandidatesTotal  = $candidateDevices.Count
            StaleCount       = 0
            DeletedCount     = 0
            Results          = @()
        } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

# ============================================================================
# DELETE STALE DEVICES
# ============================================================================

Write-Host "`n##[section]$(if ($WhatIfMode) { 'WhatIf: Would delete' } else { 'Deleting' }) $($staleDevices.Count) stale Entra device(s)"

$results = [System.Collections.Generic.List[object]]::new()
$deletedCount = 0
$failedCount  = 0

foreach ($device in $staleDevices) {
    $deviceName   = if ($device.displayName) { $device.displayName } else { $device.id }
    $lastSignInRaw = if ($device.approximateLastSignInDateTime) { $device.approximateLastSignInDateTime } else { 'never' }

    $result = @{
        DeviceId          = $device.id
        DeviceName        = $deviceName
        EntraDeviceId     = $device.deviceId
        OS                = $device.operatingSystem
        TrustType         = $device.trustType
        LastSignIn        = $lastSignInRaw
        Action            = if ($WhatIfMode) { 'WouldDelete' } else { 'Pending' }
        Error             = $null
    }

    if ($WhatIfMode) {
        Write-Host "  [WhatIf] Would delete: '$deviceName' (last sign-in: $lastSignInRaw)"
        $result.Action = 'WouldDelete'
    } else {
        Write-Host "  Deleting: '$deviceName' (last sign-in: $lastSignInRaw)" -ForegroundColor Yellow
        try {
            Invoke-GraphRequest -Method 'DELETE' -Uri "$GRAPH_V1/devices/$($device.id)"
            $result.Action = 'Deleted'
            $deletedCount++
            Write-Host "    Deleted: '$deviceName'" -ForegroundColor Green
        } catch {
            $result.Action = 'Failed'
            $result.Error  = $_.ToString()
            $failedCount++
            Write-Host "    Failed to delete '$deviceName': $_" -ForegroundColor Red
        }
    }

    $results.Add($result)
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Summary"
if ($WhatIfMode) {
    Write-Host "  WhatIf mode — no devices were deleted."
    Write-Host "  Would have deleted: $($staleDevices.Count) device(s)"
} else {
    Write-Host "  Deleted : $deletedCount"
    Write-Host "  Failed  : $failedCount"
}

if ($OutputPath) {
    @{
        Service         = 'EntraDeviceCleanup'
        Timestamp       = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        TenantName      = $TenantName
        WhatIfMode      = [bool]$WhatIfMode
        InactiveDays    = $inactiveDays
        CutoffDate      = $cutoffDate.ToString('yyyy-MM-ddTHH:mm:ssZ')
        CandidatesTotal = $candidateDevices.Count
        StaleCount      = $staleDevices.Count
        DeletedCount    = if ($WhatIfMode) { 0 } else { $deletedCount }
        FailedCount     = if ($WhatIfMode) { 0 } else { $failedCount }
        Results         = @($results)
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "  Output written to: $OutputPath"
}
