<#
.SYNOPSIS
    Backs up Entra ID interactive sign-in logs, backfilling any gaps up to DaysBack days.

.DESCRIPTION
    Sign-ins are stored in daily files (UTC) keyed by each event's createdDateTime.
    On each run the script selects which UTC days to (re)fetch using a time window, not
    file names alone:

      1. Any UTC day in [today-DaysBack, today] with no backup file yet (gap fill).
      2. Any UTC day whose 24h span overlaps [now-RefreshDays, now] — re-fetched so late
         or corrected sign-ins inside that time range are captured on the next run.

    Each day file is rebuilt from Graph for that full UTC day. Entries inside a file are
    bucketed by userId + deviceId + clientAppUsed with firstSignIn/lastSignIn timestamps.
    Files older than RetentionDays are pruned at the end.

    Deduplication key per file: userId + deviceId + clientAppUsed.
    deviceName is resolved from the Entra/Intune device registry by deviceId —
    deviceDetail.displayName in sign-in logs is often stale (e.g. an old hostname
    while deviceId correctly identifies the machine the user is on).
    Per entry the script accumulates: signInCount, firstSignIn, lastSignIn,
    appsAccessed (unique), ipAddresses (unique), locations (city/country + count).

    Requires Entra ID P1 or P2 — the AuditLog.Read.All scope is in the delegated token.
    A 403 writes an error marker file and returns cleanly (use continue-on-error: true).

.PARAMETER BackupPath
    Base path where backup files are stored (the 'backups' folder in the tenant repo).

.PARAMETER DebugMode
    Enable verbose logging.

.PARAMETER DaysBack
    Maximum number of past days to backfill on first run or after a gap. Default 30.

.PARAMETER RetentionDays
    Number of days to retain daily files before pruning. Default 90.

.PARAMETER RefreshDays
    Sliding time window (days back from now, UTC) used to pick which UTC day files to
    re-fetch. Any day whose time range overlaps this window is refreshed. Default 7.

.EXAMPLE
    .\Backup-SignInLogs.ps1 -BackupPath "C:\repos\tenant-contoso\backups"
    # Normal daily run — backs up yesterday, or backfills any gap since last run.

.EXAMPLE
    .\Backup-SignInLogs.ps1 -BackupPath "C:\repos\tenant-contoso\backups" -DaysBack 90
    # Deep bootstrap — backfills up to 90 days (Graph retains ~30 days for P1).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [Parameter(Mandatory = $false)]
    [switch]$DebugMode,

    [Parameter(Mandatory = $false)]
    [int]$DaysBack = 30,

    [Parameter(Mandatory = $false)]
    [int]$RetentionDays = 90,

    [Parameter(Mandatory = $false)]
    [int]$RefreshDays = 7
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

if (-not $BackupPath) {
    throw 'BackupPath is required. Either pass it as a parameter or ensure Backup-Common.ps1 has been initialized.'
}

# Standalone execution: connect and initialise logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging     -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw 'Failed to connect to Microsoft Graph' }
}

Write-Log '=== Starting Sign-In Logs Backup ===' 'INFO'

# ── Output directory ──────────────────────────────────────────────────────────

$signInLogsDir = Join-Path $BackupPath 'signin-logs'
if (-not (Test-Path $signInLogsDir)) {
    New-Item -ItemType Directory -Path $signInLogsDir -Force | Out-Null
}

$errorFile = Join-Path $signInLogsDir 'error.json'

# ── Determine which dates to back up ─────────────────────────────────────────
# Scan every date in the DaysBack window and collect any that are missing a file.
# This handles first-run bootstrapping, daily catch-up, and mid-week gaps equally:
#   - First run / no files: all DaysBack dates are added.
#   - Daily run, fully caught up: no missing files → nothing to do.
#   - Gap (e.g. weekend): only the missing dates are added.
# We never look further back than DaysBack to avoid fetching data past Graph's
# retention window.

$nowUtc      = (Get-Date).ToUniversalTime()
$today       = $nowUtc.Date
$windowStart = $today.AddDays(-$DaysBack)
$refreshSince = $nowUtc.AddDays(-$RefreshDays)

# Log the state of existing backups for diagnostics
$existingFiles = @(Get-ChildItem -Path $signInLogsDir -Filter '????-??-??.json' -File |
    Where-Object {
        try { [datetime]::ParseExact($_.BaseName, 'yyyy-MM-dd', $null) | Out-Null; $true }
        catch { $false }
    } | Sort-Object BaseName)

if ($existingFiles.Count -gt 0) {
    $oldest = $existingFiles[0].BaseName
    $newest = $existingFiles[-1].BaseName
    Write-Log "Existing backups in window: $($existingFiles.Count) file(s), $oldest → $newest" 'INFO'
} else {
    Write-Log "No existing sign-in backups found — will backfill last $DaysBack days" 'INFO'
}

# Collect UTC days to (re)fetch:
#   - missing files through today (sign-ins can land in today's file)
#   - any day whose [00:00, 24:00) UTC overlaps [refreshSince, nowUtc]
function Test-UtcDayOverlapsWindow {
    param([datetime]$Day, [datetime]$RangeStart, [datetime]$RangeEnd)
    $dayStart = $Day.Date
    $dayEnd   = $dayStart.AddDays(1)
    return ($dayEnd -gt $RangeStart) -and ($dayStart -lt $RangeEnd)
}

$dateSet = [System.Collections.Generic.HashSet[datetime]]::new()
for ($d = $windowStart; $d -le $today; $d = $d.AddDays(1)) {
    $label = $d.ToString('yyyy-MM-dd')
    $missing = -not (Test-Path (Join-Path $signInLogsDir "$label.json"))
    $inRefreshWindow = Test-UtcDayOverlapsWindow -Day $d -RangeStart $refreshSince -RangeEnd $nowUtc
    if ($missing -or $inRefreshWindow) {
        [void]$dateSet.Add($d)
    }
}
$datesToBackup = @($dateSet | Sort-Object)

if ($datesToBackup.Count -eq 0) {
    Write-Log 'No UTC days overlap the backup/refresh window — nothing to back up' 'INFO'
    Write-Log '=== Sign-In Logs Backup Complete ===' 'INFO'
    return @{ Type = 'SignInLogs'; Success = $true; BackedUp = 0; Failed = 0; Skipped = 0 }
}

Write-Log "Refresh window: $($refreshSince.ToString('o')) → $($nowUtc.ToString('o'))" 'INFO'
Write-Log "Dates to back up: $($datesToBackup.Count) ($($datesToBackup[0].ToString('yyyy-MM-dd')) → $($datesToBackup[-1].ToString('yyyy-MM-dd')))" 'INFO'

# ── Device registry (deviceId → canonical hostname) ───────────────────────────
# Sign-in deviceDetail.displayName is frequently stale; deviceId is authoritative.

function Test-SignInDeviceId {
    param([string]$Id)
    if ([string]::IsNullOrWhiteSpace($Id)) { return $false }
    if ($Id -eq '00000000-0000-0000-0000-000000000000') { return $false }
    return $true
}

function Get-SignInDeviceRegistry {
    param([string]$BasePath)
    $nameMap = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
    $devices = [System.Collections.Generic.List[hashtable]]::new()

    $intuneFile = Join-Path $BasePath 'intune/managed-devices.json'
    if (Test-Path $intuneFile) {
        try {
            foreach ($d in @(Get-Content $intuneFile -Raw | ConvertFrom-Json)) {
                $id = [string]$d.azureADDeviceId
                $name = [string]$d.deviceName
                if ((Test-SignInDeviceId $id) -and $name -and -not $nameMap.ContainsKey($id)) {
                    $nameMap[$id] = $name
                }
            }
            Write-Log "Device registry: $($nameMap.Count) name(s) from intune/managed-devices.json" 'INFO'
        } catch {
            Write-Log "Could not read intune/managed-devices.json for device names: $_" 'WARN'
        }
    }

    try {
        $uri = 'https://graph.microsoft.com/v1.0/devices?$select=deviceId,displayName,approximateLastSignInDateTime&$top=999'
        $pageCount = 0
        do {
            $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
            $pageCount++
            foreach ($d in @($resp.value)) {
                $id = [string]$d.deviceId
                $name = [string]$d.displayName
                $activity = ConvertTo-SignInIsoTimestamp ([string]($d.approximateLastSignInDateTime ?? ''))
                if ((Test-SignInDeviceId $id) -and $name) {
                    $nameMap[$id] = $name
                    $devices.Add([ordered]@{
                        deviceId                       = $id
                        displayName                    = $name
                        approximateLastSignInDateTime  = $activity
                    })
                }
            }
            $uri = $resp.'@odata.nextLink'
        } while ($uri)
        Write-Log "Device registry: $($nameMap.Count) name(s), $($devices.Count) Entra device(s) with activity ($pageCount page(s))" 'INFO'
    } catch {
        Write-Log "Could not load Entra device registry: $_" 'WARN'
    }

    return @{
        NameMap  = $nameMap
        Devices  = $devices
    }
}

function Export-SignInDeviceRegistry {
    param(
        [string]$SignInLogsDir,
        [System.Collections.Generic.List[hashtable]]$Devices
    )
    if ($null -eq $Devices -or $Devices.Count -eq 0) { return }

    $output = [ordered]@{
        exportedAt = (Get-Date -Format 'o')
        devices    = @($Devices | Sort-Object { $_.displayName })
    }
    $registryFile = Join-Path $SignInLogsDir 'device-registry.json'
    $output | ConvertTo-Json -Depth 5 -Compress:$false | Out-File -FilePath $registryFile -Encoding UTF8 -Force
    Write-Log "Written: $registryFile ($($Devices.Count) device(s))" 'INFO'
}

function Resolve-SignInDeviceName {
    param(
        [string]$DeviceId,
        [string]$RawDisplayName,
        [System.Collections.Generic.Dictionary[string, string]]$Registry
    )
    if ((Test-SignInDeviceId $DeviceId) -and $Registry.ContainsKey($DeviceId)) {
        return $Registry[$DeviceId]
    }
    return $RawDisplayName
}

function ConvertTo-SignInIsoTimestamp {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    try {
        return ([datetimeoffset]::Parse($Value)).UtcDateTime.ToString('o')
    } catch {
        try {
            return ([datetime]::Parse($Value)).ToUniversalTime().ToString('o')
        } catch {
            return $Value
        }
    }
}

$deviceRegistry = Get-SignInDeviceRegistry -BasePath $BackupPath
$deviceNameMap  = $deviceRegistry.NameMap

# ── Per-date fetch / dedup / write ────────────────────────────────────────────

$backedUp = 0
$failed   = 0

foreach ($targetDay in $datesToBackup) {
    $dateLabel   = $targetDay.ToString('yyyy-MM-dd')
    $filterStart = $targetDay.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $filterEnd   = $targetDay.AddDays(1).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $outputFile  = Join-Path $signInLogsDir "$dateLabel.json"

    Write-Log "Fetching sign-ins for $dateLabel ($filterStart to $filterEnd)" 'INFO'

    # ── Fetch ──────────────────────────────────────────────────────────────────

    $filter = "createdDateTime ge $filterStart " +
              "and createdDateTime lt $filterEnd " +
              "and isInteractive eq true " +
              "and status/errorCode eq 0"

    # Use -OutputType PSObject so nested complex types (deviceDetail, location)
    # are returned as PSCustomObject with real properties. The default Hashtable
    # output causes $obj?.property to silently return '' on PSCustomObject.
    # $select is also omitted: the signIn endpoint silently empties deviceDetail
    # when $select is specified (known Graph beta behaviour).
    $rawSignIns = $null
    try {
        $rawSignIns = [System.Collections.Generic.List[object]]::new()
        $nextUri = "https://graph.microsoft.com/beta/auditLogs/signIns" +
                   "?`$filter=$([Uri]::EscapeDataString($filter))&`$top=999"
        $pageCount = 0
        do {
            $resp = Invoke-MgGraphRequest -Method GET -Uri $nextUri -OutputType PSObject
            $pageCount++
            if ($resp.value) { foreach ($item in $resp.value) { $rawSignIns.Add($item) } }
            $nextUri = $resp.'@odata.nextLink'
        } while ($nextUri)
        Write-Log "Retrieved $($rawSignIns.Count) raw sign-in events for $dateLabel ($pageCount page(s))" 'INFO'
    }
    catch {
        $errMsg = "$_"
        if ($errMsg -match '403|Forbidden|Authorization_RequestDenied|InsufficientPrivileges') {
            Write-Log "Sign-in log access denied (Entra P1/P2 required): $errMsg" 'WARN'
            @{
                error     = 'insufficient_license'
                detail    = 'AuditLog.Read.All requires Entra ID P1 or P2'
                date      = $dateLabel
                updatedAt = (Get-Date -Format 'o')
            } | ConvertTo-Json -Depth 3 | Out-File -FilePath $errorFile -Encoding UTF8 -Force
            return @{ Type = 'SignInLogs'; Success = $false; BackedUp = $backedUp; Failed = 0; Skipped = 0 }
        }
        Write-Log "Failed to fetch sign-ins for $dateLabel`: $errMsg" 'ERROR'
        $failed++
        continue
    }

    # ── Deduplication ──────────────────────────────────────────────────────────
    # Key: userId + deviceId (or displayName when no id) + clientAppUsed

    $buckets = [System.Collections.Generic.Dictionary[string, hashtable]]::new()

    foreach ($signIn in $rawSignIns) {
        $userId      = $signIn.userId             ?? ''
        $upn         = $signIn.userPrincipalName  ?? ''
        $displayName = $signIn.userDisplayName    ?? ''
        $clientApp   = $signIn.clientAppUsed      ?? 'unknown'
        $appName     = $signIn.appDisplayName     ?? ''
        $ipAddress   = $signIn.ipAddress          ?? ''
        $createdAt   = ConvertTo-SignInIsoTimestamp ([string]($signIn.createdDateTime ?? ''))

        $dd          = $signIn.deviceDetail
        $rawDeviceId = [string]($dd.deviceId)
        $deviceId    = if (Test-SignInDeviceId $rawDeviceId) { $rawDeviceId } else { '' }
        $deviceName  = Resolve-SignInDeviceName -DeviceId $deviceId -RawDisplayName ([string]($dd.displayName)) -Registry $deviceNameMap
        $osRaw       = [string]($dd.operatingSystem)
        $browserRaw  = [string]($dd.browser)
        $isCompliant = $dd.isCompliant    # may be $null for unmanaged devices
        $isManaged   = if ($null -ne $dd.isManaged) { [bool]$dd.isManaged } else { $false }
        $trustType   = [string]($dd.trustType)

        $loc     = $signIn.location
        $city    = [string]($loc.city)
        $state   = [string]($loc.state)
        $country = [string]($loc.countryOrRegion)

        $deviceKey = if ($deviceId) { $deviceId } else { $deviceName }
        $bucketKey = "$userId|$deviceKey|$clientApp"

        if (-not $buckets.ContainsKey($bucketKey)) {
            $buckets[$bucketKey] = @{
                userId            = $userId
                userPrincipalName = $upn
                userDisplayName   = $displayName
                deviceId          = $deviceId
                deviceName        = $deviceName
                operatingSystem   = $osRaw
                isCompliant       = $isCompliant
                isManaged         = $isManaged
                trustType         = $trustType
                clientAppUsed     = $clientApp
                browser           = $browserRaw
                appsAccessed      = [System.Collections.Generic.List[string]]::new()
                ipAddresses       = [System.Collections.Generic.List[string]]::new()
                _locationMap      = [System.Collections.Generic.Dictionary[string, int]]::new()
                signInCount       = 0
                firstSignIn       = $createdAt
                lastSignIn        = $createdAt
            }
        }

        $b = $buckets[$bucketKey]
        $b.signInCount++

        if ($appName -and -not $b.appsAccessed.Contains($appName)) { $b.appsAccessed.Add($appName) }
        if ($ipAddress -and -not $b.ipAddresses.Contains($ipAddress)) { $b.ipAddresses.Add($ipAddress) }

        $locKey = "$city|$country"
        if ($city -or $country) {
            if ($b._locationMap.ContainsKey($locKey)) { $b._locationMap[$locKey]++ }
            else { $b._locationMap[$locKey] = 1 }
        }

        if ($createdAt -and $createdAt -lt $b.firstSignIn) { $b.firstSignIn = $createdAt }
        if ($createdAt -and $createdAt -gt $b.lastSignIn)  { $b.lastSignIn  = $createdAt }
        if ($deviceName) { $b.deviceName = $deviceName }

        # isCompliant: false wins; null only if all are null
        if ($null -ne $isCompliant) {
            if ($null -eq $b.isCompliant) { $b.isCompliant = $isCompliant }
            elseif (-not $isCompliant)    { $b.isCompliant = $false }
        }
    }

    # ── Serialise ──────────────────────────────────────────────────────────────

    $exportedAt = (Get-Date -Format 'o')

    $entries = $buckets.Values | ForEach-Object {
        $b = $_
        $locations = $b._locationMap.GetEnumerator() | ForEach-Object {
            $parts = $_.Key -split '\|'
            @{
                city            = $parts[0]
                countryOrRegion = if ($parts.Count -gt 1) { $parts[1] } else { '' }
                signInCount     = $_.Value
            }
        } | Sort-Object -Property signInCount -Descending

        [ordered]@{
            userId            = $b.userId
            userPrincipalName = $b.userPrincipalName
            userDisplayName   = $b.userDisplayName
            deviceId          = $b.deviceId
            deviceName        = $b.deviceName
            operatingSystem   = $b.operatingSystem
            isCompliant       = $b.isCompliant
            isManaged         = $b.isManaged
            trustType         = $b.trustType
            clientAppUsed     = $b.clientAppUsed
            browser           = $b.browser
            appsAccessed      = @($b.appsAccessed)
            ipAddresses       = @($b.ipAddresses)
            locations         = @($locations)
            signInCount       = $b.signInCount
            firstSignIn       = $b.firstSignIn
            lastSignIn        = $b.lastSignIn
        }
    } | Sort-Object -Property userPrincipalName, deviceName, clientAppUsed

    $output = [ordered]@{
        date           = $dateLabel
        exportedAt     = $exportedAt
        windowStartUtc = $filterStart
        windowEndUtc   = $filterEnd
        totalSignIns   = $rawSignIns.Count
        uniqueEntries  = ($entries | Measure-Object).Count
        entries        = @($entries)
    }

    Write-Log "Deduplicated to $($output.uniqueEntries) unique user/device/client entries" 'INFO'
    $output | ConvertTo-Json -Depth 10 -Compress:$false | Out-File -FilePath $outputFile -Encoding UTF8 -Force
    Write-Log "Written: $outputFile" 'INFO'
    $backedUp++
}

# ── Pruning ───────────────────────────────────────────────────────────────────

$cutoff = $today.AddDays(-$RetentionDays)
Get-ChildItem -Path $signInLogsDir -Filter '????-??-??.json' -File |
    Where-Object {
        try {
            $fileDate = [datetime]::ParseExact($_.BaseName, 'yyyy-MM-dd', $null)
            $fileDate -lt $cutoff
        } catch { $false }
    } |
    ForEach-Object {
        Remove-Item -Path $_.FullName -Force
        Write-Log "Pruned old sign-in log: $($_.Name)" 'DEBUG'
    }

Export-SignInDeviceRegistry -SignInLogsDir $signInLogsDir -Devices $deviceRegistry.Devices

Write-Log "=== Sign-In Logs Backup Complete === (backed up $backedUp day(s), $failed failed)" 'INFO'

return @{
    Type     = 'SignInLogs'
    Success  = ($failed -eq 0)
    BackedUp = $backedUp
    Failed   = $failed
}
