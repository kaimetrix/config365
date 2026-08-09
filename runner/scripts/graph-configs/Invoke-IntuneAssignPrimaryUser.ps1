<#
.SYNOPSIS
    Assigns the primary user of an Intune-managed device based on exclusive sign-in history.

.DESCRIPTION
    Reads an intune-primary-user configuration from the baseline repo and/or tenant repo. For each
    managed device in scope the script:
      1. Queries Azure AD Sign-in Logs for sign-in events on the device within the past <exclusiveDays> days.
      2. If exactly one unique user signed in during that window, they become the candidate.
      3. Reads the device's current primary user via the Graph users navigation property.
      4. If the current primary user already matches the candidate, the device is skipped.
      5. Otherwise, removes the existing primary user (if any) and assigns the candidate.

    Scope is controlled by optional targetGroups in the config. If no groups are configured all
    managed devices visible to the service principal are evaluated.

    Tenant config overrides baseline config (matched by the enabled/exclusiveDays fields; the full
    document is merged, with the tenant file winning).

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/intune-primary-user.json (the maintenance/ folder
    checked out from the baseline repo).

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/intune-primary-user.json in the tenant repo.
    If the tenant file is present its values override the baseline file.

.PARAMETER TenantName
    Tenant name used in log messages.

.PARAMETER OutputPath
    Optional path to write a JSON summary of planned/applied changes.

.PARAMETER WhatIfMode
    Show intended assignments without calling the Graph assignment APIs.

.EXAMPLE
    .\Invoke-IntuneAssignPrimaryUser.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "Tenant-repo/config/maintenance" `
        -TenantName        "contoso" `
        -WhatIfMode

.NOTES
    Required permissions (application):
      GroupMember.Read.All                         — resolve Entra group members (when targetGroups used)
      DeviceManagementManagedDevices.ReadWrite.All — read managed device records and assign primary user
      AuditLog.Read.All                            — query Azure AD Sign-in Logs by device ID
      User.Read.All                                — resolve user display names from sign-in log userId
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

Write-Host "`n##[section]Loading Intune primary user configuration"

function Read-PrimaryUserConfigFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return $null }
    $path = Join-Path $Dir 'intune-primary-user.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No intune-primary-user.json found in: $Dir" -ForegroundColor DarkGray
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

$baselineConfig = Read-PrimaryUserConfigFile -Dir $BaselineConfigDir
$tenantConfig   = Read-PrimaryUserConfigFile -Dir $TenantConfigDir

# Tenant file wins; fall back to baseline; if neither exists use built-in defaults
$effectiveConfig = if ($tenantConfig) { $tenantConfig } elseif ($baselineConfig) { $baselineConfig } else { $null }

if (-not $effectiveConfig) {
    Write-Host "No intune-primary-user.json found in baseline or tenant. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        $outputDir = Split-Path -Path $OutputPath -Parent
        if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
        @{ Service = 'IntuneAssignPrimaryUser'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

$enabled      = if ($effectiveConfig.PSObject.Properties['enabled'])      { [bool]$effectiveConfig.enabled }      else { $true }
$exclusiveDays = if ($effectiveConfig.PSObject.Properties['exclusiveDays']) { [int]$effectiveConfig.exclusiveDays } else { 30 }
$targetGroups  = if ($effectiveConfig.PSObject.Properties['targetGroups'])  { @($effectiveConfig.targetGroups) }   else { @() }

Write-Host "  Enabled       : $enabled"
Write-Host "  ExclusiveDays : $exclusiveDays"
Write-Host "  TargetGroups  : $(if ($targetGroups.Count -eq 0) { 'all managed devices' } else { "$($targetGroups.Count) group(s)" })"

if (-not $enabled) {
    Write-Host "Feature is disabled. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        $outputDir = Split-Path -Path $OutputPath -Parent
        if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Path $outputDir -Force | Out-Null }
        @{ Service = 'IntuneAssignPrimaryUser'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Enabled = $false; Results = @() } |
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
# ENUMERATE MANAGED DEVICES IN SCOPE
# ============================================================================

Write-Host "`n##[section]Enumerating managed devices"

$GRAPH_V1   = 'https://graph.microsoft.com/v1.0'
$GRAPH_BETA = 'https://graph.microsoft.com/beta'

# Fields needed from the managed device record
$deviceSelect = 'id,deviceName,azureADDeviceId,managementAgent,operatingSystem'

$managedDevices    = [System.Collections.Generic.List[object]]::new()
$deviceMembersTotal = 0
$notInIntune        = 0

if ($targetGroups.Count -eq 0) {
    # No scope restriction — enumerate Windows/macOS managed devices
    Write-Host "  No targetGroups configured; retrieving all Windows/macOS managed devices..."
    try {
        $osFilter   = [Uri]::EscapeDataString("operatingSystem eq 'Windows' or operatingSystem eq 'macOS'")
        $allDevices = @(Get-AllPages -Uri "$GRAPH_BETA/deviceManagement/managedDevices?`$filter=$osFilter&`$select=$deviceSelect&`$top=999")
        foreach ($d in $allDevices) { $managedDevices.Add($d) }
        Write-Host "  Retrieved $($managedDevices.Count) managed device(s)."
    } catch {
        throw "Failed to retrieve managed devices: $_"
    }
} else {
    # Scope to specified Entra groups
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
            $members       = @(Get-AllPages -Uri "$GRAPH_V1/groups/$tgId/members?`$select=id,displayName,deviceId&`$top=999")
            $deviceMembers = @($members | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.device' -and $_.deviceId })
            Write-Host "    Device members: $($deviceMembers.Count)"
            $deviceMembersTotal += $deviceMembers.Count
        } catch {
            Write-Host "  Warning: Failed to retrieve group members for '$tgName' — skipping." -ForegroundColor Yellow
            continue
        }

        foreach ($entraDevice in $deviceMembers) {
            $azureDeviceId = $entraDevice.deviceId
            try {
                $encoded = [Uri]::EscapeDataString("azureADDeviceId eq '$azureDeviceId'")
                $mdResult = Invoke-GraphRequest -Uri "$GRAPH_BETA/deviceManagement/managedDevices?`$filter=$encoded&`$select=$deviceSelect&`$top=1"
                $md = $mdResult.value | Select-Object -First 1
                if ($md) {
                    $managedDevices.Add($md)
                } else {
                    $notInIntune++
                    Write-Host "    Not Intune-managed: '$($entraDevice.displayName)' (azureADDeviceId: $azureDeviceId)" -ForegroundColor DarkGray
                }
            } catch {
                $notInIntune++
                Write-Host "    Warning: Could not look up Intune device for '$($entraDevice.displayName)' (azureADDeviceId: $azureDeviceId) — $_" -ForegroundColor Yellow
            }
        }
    }
    Write-Host "  Total managed devices in scope: $($managedDevices.Count)"
    if ($notInIntune -gt 0) {
        Write-Host "  ($notInIntune of $deviceMembersTotal Entra device member(s) had no matching Intune managed device — not enrolled or already unenrolled)" -ForegroundColor DarkGray
    }
}

if ($managedDevices.Count -eq 0) {
    Write-Host "No managed devices found in scope. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{
            Service                 = 'IntuneAssignPrimaryUser'
            Timestamp               = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
            TenantName              = $TenantName
            WhatIfMode              = [bool]$WhatIfMode
            EntraDeviceMembersFound = $deviceMembersTotal
            ManagedDevicesMatched   = 0
            Results                 = @()
        } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

# ============================================================================
# RESOLVE EXCLUSION GROUPS
# ============================================================================

# Build a set of azureADDeviceIds (and Entra object IDs) that must be skipped
$excludedAzureDeviceIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

$excludeGroups = @()
if ($effectiveConfig.PSObject.Properties['excludeGroups'] -and $null -ne $effectiveConfig.excludeGroups) {
    $excludeGroups = @($effectiveConfig.excludeGroups)
}

if ($excludeGroups.Count -gt 0) {
    Write-Host "`n  Resolving exclusion groups ($($excludeGroups.Count))..."
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
            Write-Host "  Warning: Failed to resolve exclusion group '$egName' — skipping this exclusion." -ForegroundColor Yellow
            continue
        }
    }

    if (-not $egId) {
        Write-Host "  Warning: Could not resolve exclusion group '$(if ($egName) { $egName } else { 'unknown' })' — skipping." -ForegroundColor Yellow
        continue
    }

    Write-Host "  Exclusion group ID: $egId $(if ($egName) { "($egName)" })"
    try {
        $egMembers = @(Get-AllPages -Uri "$GRAPH_V1/groups/$egId/members?`$select=id,deviceId&`$top=999")
        foreach ($em in $egMembers) {
            if ($em.deviceId) { $excludedAzureDeviceIds.Add($em.deviceId) | Out-Null }
            if ($em.id)       { $excludedAzureDeviceIds.Add($em.id)       | Out-Null }
        }
        Write-Host "    Added $($egMembers.Count) member(s) to exclusion set."
    } catch {
        Write-Host "  Warning: Failed to retrieve members of exclusion group '$egName' — skipping this exclusion." -ForegroundColor Yellow
    }
}

if ($excludedAzureDeviceIds.Count -gt 0) {
    Write-Host "  Total excluded device identifiers: $($excludedAzureDeviceIds.Count)"
}

# ============================================================================
# USER DISPLAY NAME CACHE
# ============================================================================

# Cache userId → displayName to avoid redundant Graph calls
$userCache = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Get-CachedUser {
    param([string]$UserId)
    if ($userCache.ContainsKey($UserId)) { return $userCache[$UserId] }
    try {
        $user = Invoke-GraphRequest -Uri "$GRAPH_V1/users/$UserId`?`$select=id,displayName,userPrincipalName"
        $userCache[$UserId] = $user
        return $user
    } catch {
        Write-Verbose "    Warning: Could not resolve user $UserId : $_"
        $userCache[$UserId] = $null
        return $null
    }
}

function Get-DeviceSignIns {
    param([string]$AzureDeviceId, [string]$CutoffIso)
    $filter = [Uri]::EscapeDataString("deviceDetail/deviceId eq '$AzureDeviceId' and createdDateTime ge $CutoffIso")
    $select = 'userId,userPrincipalName,createdDateTime'
    $uri    = "$GRAPH_BETA/auditLogs/signIns?`$filter=$filter&`$select=$select&`$top=999"
    try {
        return @(Get-AllPages -Uri $uri)
    } catch {
        Write-Host "    Warning: Could not retrieve sign-in logs for device $AzureDeviceId — $_" -ForegroundColor Yellow
        return $null  # $null signals a fetch error (distinct from empty array = no sign-ins)
    }
}

# ============================================================================
# PROCESS DEVICES
# ============================================================================

Write-Host "`n##[section]Processing devices"

$now         = [datetime]::UtcNow
$cutoff      = $now.AddDays(-$exclusiveDays)
$cutoffIso   = $cutoff.ToString('yyyy-MM-ddTHH:mm:ssZ')
$allResults  = [System.Collections.Generic.List[object]]::new()
$assigned    = 0
$skipped     = 0
$errored     = 0

foreach ($device in $managedDevices) {
    $deviceId   = $device.id
    $deviceName = $device.deviceName

    # Skip devices not managed by Intune MDM (e.g. msSense, eas, jamf, configurationManagerClient)
    if ($device.managementAgent -notmatch 'mdm|intune') {
        Write-Host "  SKIP '$deviceName' — managementAgent='$($device.managementAgent)' is not Intune MDM." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedNotMDM'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # Skip non-Windows/macOS devices — primary user assignment is only supported on Windows and macOS
    if ($device.operatingSystem -notmatch '^(Windows|macOS)$') {
        Write-Host "  SKIP '$deviceName' — operatingSystem='$($device.operatingSystem)' does not support primary user assignment." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedUnsupportedOS'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # Skip devices that are members of an exclusion group
    $azureDeviceId = $device.azureADDeviceId
    if ($excludedAzureDeviceIds.Count -gt 0 -and $azureDeviceId -and $excludedAzureDeviceIds.Contains($azureDeviceId)) {
        Write-Host "  SKIP '$deviceName' — in exclusion group." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedExcluded'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # Skip devices with no azureADDeviceId (co-managed / SCCM-only devices that never completed Azure AD registration)
    if (-not $azureDeviceId) {
        Write-Host "  SKIP '$deviceName' — no azureADDeviceId; cannot query sign-in logs." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedNoAzureDeviceId'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # ── Query Azure AD sign-in logs for this device ───────────────────────────
    Write-Host "  Querying sign-in logs for '$deviceName'..." -ForegroundColor DarkGray
    $signIns = Get-DeviceSignIns -AzureDeviceId $azureDeviceId -CutoffIso $cutoffIso

    if ($null -eq $signIns) {
        # Warning already logged inside Get-DeviceSignIns; treat as skip so transient API
        # failures do not fail the pipeline — the device is left unchanged.
        Write-Host "  SKIP '$deviceName' — sign-in log query failed; leaving device unchanged." -ForegroundColor Yellow
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedSignInLogError'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    if ($signIns.Count -eq 0) {
        Write-Host "  SKIP '$deviceName' — no sign-in activity in the past $exclusiveDays day(s)." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedNoRecentSignIn'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # Collect unique user IDs from sign-ins within the lookback window
    $uniqueUserIds = @($signIns | Where-Object { $_.userId } | Select-Object -ExpandProperty userId -Unique)

    if ($uniqueUserIds.Count -ne 1) {
        $plural = if ($uniqueUserIds.Count -eq 0) { 'no users' } else { "$($uniqueUserIds.Count) distinct users" }
        Write-Host "  SKIP '$deviceName' — $plural signed in during the past $exclusiveDays day(s); not exclusive." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'SkippedNotExclusive'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    $candidateUserId = $uniqueUserIds[0]
    $candidateUser   = Get-CachedUser -UserId $candidateUserId
    $candidateUpn    = if ($candidateUser) { $candidateUser.userPrincipalName } else { $candidateUserId }
    $candidateName   = if ($candidateUser) { $candidateUser.displayName }       else { $candidateUserId }

    Write-Host "  '$deviceName' — exclusive user: $candidateName ($candidateUpn)" -ForegroundColor Cyan

    # ── Read current primary user(s) ─────────────────────────────────────────
    $currentPrimaryUsers = @()
    try {
        $usersResult         = Invoke-GraphRequest -Uri "$GRAPH_BETA/deviceManagement/managedDevices/$deviceId/users"
        $currentPrimaryUsers = @($usersResult.value)
    } catch {
        Write-Host "    Warning: Could not retrieve current primary user for '$deviceName' — skipping." -ForegroundColor Yellow
        $errored++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'ErrorReadUsers'; AssignedUser = $null; PreviousUser = $null })
        continue
    }

    # Check whether the candidate is already the primary user
    $currentPrimaryId  = if ($currentPrimaryUsers.Count -gt 0) { $currentPrimaryUsers[0].id } else { $null }
    $currentPrimaryUpn = if ($currentPrimaryUsers.Count -gt 0) { $currentPrimaryUsers[0].userPrincipalName } else { $null }

    if ($currentPrimaryId -and $currentPrimaryId -ieq $candidateUserId) {
        Write-Host "    SKIP '$deviceName' — primary user already set to $candidateUpn." -ForegroundColor DarkGray
        $skipped++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'AlreadyCorrect'; AssignedUser = $candidateUpn; PreviousUser = $currentPrimaryUpn })
        continue
    }

    if ($WhatIfMode) {
        $from = if ($currentPrimaryUpn) { $currentPrimaryUpn } else { '(none)' }
        Write-Host "    WouldAssign: '$deviceName' primary user $from → $candidateUpn" -ForegroundColor Yellow
        $assigned++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'WouldAssign'; AssignedUser = $candidateUpn; PreviousUser = $currentPrimaryUpn })
        continue
    }

    # ── Remove existing primary user(s) ──────────────────────────────────────
    foreach ($existingUser in $currentPrimaryUsers) {
        try {
            Invoke-GraphRequest `
                -Method DELETE `
                -Uri    "$GRAPH_BETA/deviceManagement/managedDevices/$deviceId/users/$($existingUser.id)/`$ref"
            Write-Verbose "    Removed previous primary user: $($existingUser.userPrincipalName)"
        } catch {
            Write-Host "    Warning: Could not remove previous primary user '$($existingUser.userPrincipalName)' from '$deviceName' — $_" -ForegroundColor Yellow
        }
    }

    # ── Assign new primary user ───────────────────────────────────────────────
    try {
        $refBody = @{ '@odata.id' = "$GRAPH_BETA/users/$candidateUserId" }
        Invoke-GraphRequest `
            -Method POST `
            -Uri    "$GRAPH_BETA/deviceManagement/managedDevices/$deviceId/users/`$ref" `
            -Body   $refBody
        $from = if ($currentPrimaryUpn) { $currentPrimaryUpn } else { '(none)' }
        Write-Host "    Assigned: '$deviceName' primary user $from → $candidateUpn" -ForegroundColor Green
        $assigned++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'Assigned'; AssignedUser = $candidateUpn; PreviousUser = $currentPrimaryUpn })
    } catch {
        Write-Host "    Warning: Failed to assign primary user '$candidateUpn' to '$deviceName' — $_" -ForegroundColor Yellow
        $errored++
        $allResults.Add([PSCustomObject]@{ DeviceName = $deviceName; DeviceId = $deviceId; Status = 'ErrorAssign'; AssignedUser = $null; PreviousUser = $currentPrimaryUpn })
    }
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Intune Assign Primary User Summary"

if ($WhatIfMode) {
    Write-Host "  WouldAssign : $assigned"
} else {
    Write-Host "  Assigned    : $assigned"
}
Write-Host "  Skipped     : $skipped"
Write-Host "  Errors      : $errored"

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service                 = 'IntuneAssignPrimaryUser'
        Timestamp               = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        TenantName              = $TenantName
        WhatIfMode              = [bool]$WhatIfMode
        ExclusiveDays           = $exclusiveDays
        EntraDeviceMembersFound = $deviceMembersTotal
        ManagedDevicesMatched   = $managedDevices.Count
        Results                 = @($allResults | ForEach-Object {
            @{
                DeviceName   = $_.DeviceName
                DeviceId     = $_.DeviceId
                Status       = $_.Status
                AssignedUser = $_.AssignedUser
                PreviousUser = $_.PreviousUser
            }
        })
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Summary saved to: $OutputPath"
}

if ($errored -gt 0) { exit 1 }
