<#
.SYNOPSIS
    Backs up Microsoft Defender for Endpoint device inventory

.DESCRIPTION
    Exports all onboarded devices from the MDE API, attaches associated logon users,
    and saves the results split by OS platform so the web portal can efficiently load
    per-platform subsets without downloading the full list.

    For Android and iOS devices, logonUsers is always empty in MDE.  The script
    enriches those devices via Microsoft Graph using aadDeviceId:
      1. GET /v1.0/devices?$filter=(deviceId eq '{aadDeviceId}')
         → resolves the Entra object ID and operatingSystemVersion
      2. GET /v1.0/devices/{entraId}/registeredOwners
         → resolves the owner's displayName / userPrincipalName / mail
    Both fields are stored alongside the MDE data so the frontend can display them.
    Graph enrichment is best-effort; failure does not abort the backup.
    Requires Device.Read.All application permission on Microsoft Graph.

    Output files under backups/defender-devices/:
        all-devices.json        — every device regardless of platform
        windows-devices.json
        macos-devices.json
        ios-devices.json
        android-devices.json
        other-devices.json      — Linux, network devices, etc.

    Authentication reuses the existing clientId / clientSecret / tenantId variables
    already injected by the backup pipeline, acquiring separate OAuth tokens for the
    WindowsDefenderATP and Microsoft Graph resource scopes (same Entra app registration).

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable detailed debug logging.

.EXAMPLE
    .\Backup-DefenderDevices.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
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

# Standalone execution: initialize logging/dirs if not already done
# (DefenderDevices acquires its own MDE/Graph tokens; Connect-M365Backup is not required)
if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}

if (-not $BackupPath) {
    throw 'BackupPath is required. Either pass it as a parameter or ensure Backup-Common.ps1 has been initialized.'
}

Write-Log '=== Starting Defender for Endpoint Device Backup ===' 'INFO'

# HTTP timeout for all MDE/Graph REST calls (seconds). Prevents indefinite hangs on flaky networks (e.g. act).
$script:HttpTimeoutSec = 120

function Test-IsLikelyHttpTimeout {
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    if ($ex -is [System.Threading.Tasks.TaskCanceledException]) { return $true }
    if ($ex -is [System.OperationCanceledException]) { return $true }
    $msg = $ex.Message
    if ($msg -match '(?i)timeout|timed out') { return $true }
    if ($msg -match '(?i)cancell?ed') { return $true }
    return $false
}

# Invoke-RestMethod -TimeoutSec does not reliably cancel hung TCP connections on Linux
# (pwsh/act runner). Run the call in a thread job so Wait-Job can enforce a wall-clock limit.
function Invoke-RestMethodWithJobTimeout {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,
        [string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [string]$Body,
        [int]$TimeoutSec = $script:HttpTimeoutSec,
        [switch]$SkipHttpErrorCheck,
        [string]$Label
    )

    if (-not $Label) { $Label = $Uri }

    $job = Start-ThreadJob -ScriptBlock {
        param($u, $m, $h, $b, $t, $skip)
        $params = @{
            Uri        = $u
            Method     = $m
            Headers    = $h
            TimeoutSec = $t
        }
        if ($b) { $params.Body = $b }
        if ($skip) { $params.SkipHttpErrorCheck = $true }
        Invoke-RestMethod @params
    } -ArgumentList $Uri, $Method, $Headers, $Body, $TimeoutSec, [bool]$SkipHttpErrorCheck

    # Small grace period so the inner Invoke-RestMethod can surface its own timeout first.
    $completed = Wait-Job -Job $job -Timeout ($TimeoutSec + 5)
    if (-not $completed) {
        Stop-Job  -Job $job -Force -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        Write-Log "HTTP request timed out (${TimeoutSec}s): $Label" 'WARN'
        return $null
    }

    try {
        $result = Receive-Job -Job $job -ErrorAction Stop
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        return $result
    }
    catch {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        throw
    }
}

# ─── Token acquisition via Config365 token API (delegated auth) ────────────────
function Get-TokenFromPortalApi {
    param(
        [string]$Resource,   # 'mde' or 'graph'
        [string]$Label
    )

    $tenantSlug  = $env:TENANT_SLUG
    $tokenApiUrl = if ($env:PORTAL_TOKEN_API_URL) { $env:PORTAL_TOKEN_API_URL } else { 'http://localhost:4322' }
    $internalKey = $env:PORTAL_INTERNAL_KEY

    if (-not $tenantSlug -or -not $internalKey) {
        throw "Token API: TENANT_SLUG and PORTAL_INTERNAL_KEY are required for delegated auth."
    }

    # -SkipHttpErrorCheck prevents Invoke-RestMethod from hanging on Linux when
    # the token API returns a non-2xx response + Connection: close.
    $response = Invoke-RestMethodWithJobTimeout `
        -Uri               "$tokenApiUrl/tenant-auth/token" `
        -Method            POST `
        -Headers           @{ Authorization = "Bearer $internalKey"; 'Content-Type' = 'application/json' } `
        -Body              (ConvertTo-Json @{ tenantSlug = $tenantSlug; resource = $Resource }) `
        -SkipHttpErrorCheck `
        -TimeoutSec        30 `
        -Label             "Token API ($Resource)"

    if (-not $response) {
        if ($Resource -eq 'mde') {
            Write-Log 'MDE token API timed out — skipping MDE backup.' 'WARN'
            return $null
        }
        throw "Token API request timed out for resource '$Resource'."
    }

    if ($response.error) {
        if ($Resource -eq 'mde') {
            # MDE is optional — tenant may not have a Defender for Endpoint license.
            # Treat any token failure as a graceful skip rather than a hard error.
            Write-Log "MDE token unavailable for this tenant ($($response.error)) — no MDE license or consent. Skipping MDE backup." 'WARN'
            return $null
        }
        throw "Token API error for resource '$Resource': $($response.error) — $($response.detail)"
    }
    if (-not $response.accessToken) {
        if ($Resource -eq 'mde') {
            Write-Log "MDE token API returned no access token — skipping MDE backup." 'WARN'
            return $null
        }
        throw "Token API returned no accessToken for resource '$Resource'."
    }

    Write-Log "$Label access token acquired via delegated auth" 'INFO'
    return $response.accessToken
}

# ─── Acquire MDE OAuth token ────────────────────────────────────────────────────
function Get-MdeAccessToken {
    Write-Log 'Acquiring MDE access token (delegated)...' 'INFO'
    return Get-TokenFromPortalApi -Resource 'mde' -Label 'MDE'
}

# ─── Acquire Microsoft Graph OAuth token ────────────────────────────────────────
function Get-GraphAccessToken {
    Write-Log 'Acquiring Microsoft Graph access token (delegated)...' 'INFO'
    return Get-TokenFromPortalApi -Resource 'graph' -Label 'Graph'
}

# ─── Paginated MDE API fetch ────────────────────────────────────────────────────
function Get-AllMdeDevices {
    param(
        [string]$AccessToken,
        [switch]$Debug
    )

    $headers = @{
        Authorization  = "Bearer $AccessToken"
        'Content-Type' = 'application/json'
    }

    $allDevices = [System.Collections.Generic.List[object]]::new()
    $uri        = 'https://api.securitycenter.microsoft.com/api/machines?$top=10000'
    $page       = 0

    Write-Log 'Fetching devices from MDE API...' 'INFO'

    do {
        $page++
        if ($Debug) { Write-Log "Fetching MDE devices page $page`: $uri" 'DEBUG' }

        try {
            $response = Invoke-RestMethodWithJobTimeout `
                -Uri $uri -Method GET -Headers $headers `
                -TimeoutSec $script:HttpTimeoutSec `
                -Label "MDE machines page $page"
        }
        catch {
            throw "MDE API request failed (page $page): $($_.Exception.Message)"
        }

        if (-not $response) {
            if ($page -eq 1) {
                Write-Log 'MDE machines API timed out — tenant may not have MDE provisioned yet. Skipping device backup.' 'WARN'
                return @()
            }
            throw "MDE API request timed out (page $page)"
        }

        $batch = @($response.value)
        foreach ($d in $batch) { $allDevices.Add($d) }

        if ($Debug) { Write-Log "Page $page`: received $($batch.Count) devices (total so far: $($allDevices.Count))" 'DEBUG' }

        $uri = $response.'@odata.nextLink'
    } while ($uri)

    Write-Log "Retrieved $($allDevices.Count) devices across $page page(s)" 'INFO'
    return $allDevices
}

# ─── Fetch Graph enrichment for mobile devices (best-effort) ───────────────────
# Uses aadDeviceId to resolve the Entra device object, then fetches the
# registered owner.  Returns $null on any error so the caller can degrade gracefully.
function Get-DeviceGraphInfo {
    param(
        [string]$AadDeviceId,
        [string]$GraphToken
    )

    if (-not $AadDeviceId -or -not $GraphToken) { return $null }

    $headers = @{ Authorization = "Bearer $GraphToken" }

    try {
        # Step 1 — resolve the Entra device object by aadDeviceId (= Entra's deviceId GUID)
        $filter    = [uri]::EscapeDataString("deviceId eq '$AadDeviceId'")
        $selectDev = 'id,deviceId,operatingSystemVersion,operatingSystem'
        $devUri    = "https://graph.microsoft.com/v1.0/devices?`$filter=$filter&`$select=$selectDev"
        $devResp   = Invoke-RestMethodWithJobTimeout -Uri $devUri -Method GET -Headers $headers -TimeoutSec $script:HttpTimeoutSec -Label "Graph device lookup ($AadDeviceId)"
        if (-not $devResp) { return $null }

        $entraDevice = $devResp.value | Select-Object -First 1
        if (-not $entraDevice) { return $null }

        $result = @{
            operatingSystemVersion = $entraDevice.operatingSystemVersion
            registeredOwner        = $null
        }

        # Step 2 — fetch the registered owner for this Entra device
        $ownerUri  = "https://graph.microsoft.com/v1.0/devices/$($entraDevice.id)/registeredOwners?`$select=id,displayName,userPrincipalName,mail"
        $ownerResp = Invoke-RestMethodWithJobTimeout -Uri $ownerUri -Method GET -Headers $headers -TimeoutSec $script:HttpTimeoutSec -Label "Graph registeredOwners ($AadDeviceId)"
        if (-not $ownerResp) { return $result }

        $firstOwner = $ownerResp.value | Select-Object -First 1
        if ($firstOwner) {
            $result.registeredOwner = @{
                displayName       = $firstOwner.displayName
                userPrincipalName = $firstOwner.userPrincipalName
                mail              = $firstOwner.mail
            }
        }

        return $result
    }
    catch {
        if (Test-IsLikelyHttpTimeout -ErrorRecord $_) {
            Write-Log "Graph device enrichment timed out for aadDeviceId $AadDeviceId : $($_.Exception.Message)" 'WARN'
        }
        # Non-fatal — Graph permission may not be granted or device may not be in Entra
        return $null
    }
}

# ─── Fetch logon users for a device (best-effort) ──────────────────────────────
# Uses Start-ThreadJob + Wait-Job so the timeout is guaranteed even when
# Invoke-RestMethod -TimeoutSec fails to cancel a hung TCP connection on Linux.
function Get-DeviceLogonUsers {
    param(
        [string]$DeviceId,
        [string]$AccessToken
    )

    $uri = "https://api.securitycenter.microsoft.com/api/machines/$DeviceId/logonusers"

    $job = Start-ThreadJob -ScriptBlock {
        param($u, $tok)
        $headers = @{ Authorization = "Bearer $tok" }
        try {
            $r = Invoke-RestMethod -Uri $u -Method GET -Headers $headers -ErrorAction Stop -TimeoutSec 60
            return @($r.value)
        }
        catch { return @() }
    } -ArgumentList $uri, $AccessToken

    $completed = Wait-Job -Job $job -Timeout $script:HttpTimeoutSec
    if (-not $completed) {
        Stop-Job  -Job $job
        Write-Log "MDE logon users timed out ($($script:HttpTimeoutSec)s) for device $DeviceId - skipping" 'WARN'
        Remove-Job -Job $job -Force
        return @()
    }

    $raw = Receive-Job -Job $job
    Remove-Job  -Job $job -Force

    return @($raw) | Where-Object { $_ } | ForEach-Object {
        @{
            accountName       = $_.accountName
            accountDomain     = $_.accountDomain
            userPrincipalName = if ($_.userPrincipalName) { $_.userPrincipalName } elseif ($_.accountDomain -and $_.accountName) { "$($_.accountName)@$($_.accountDomain)" } else { $null }
            emailAddress      = $_.userPrincipalName
            lastSeen          = $_.lastSeen
        }
    }
}

# ─── Normalise a device record for storage ─────────────────────────────────────
function Format-DeviceRecord {
    param(
        $Device,
        $LogonUsers,
        $GraphInfo   = $null,  # optional enrichment from Get-DeviceGraphInfo
        $MamPatchMap = $null   # optional MAM patch map from Get-MamPatchMap
    )

    # Prefer a dotted numeric version. MDE Windows devices often have osVersion
    # empty (or a label like "22H2") and the real build in osBuild (e.g. 22631).
    $graphVersion = if ($GraphInfo) { [string]$GraphInfo.operatingSystemVersion } else { $null }
    $mdeVersion   = if ($null -ne $Device.osVersion) { [string]$Device.osVersion } else { $null }
    $osBuildRaw   = if ($null -ne $Device.osBuild) { [string]$Device.osBuild } else { $null }
    $buildAsNt    = if ($osBuildRaw -match '^\d{5,}') { "10.0.$osBuildRaw" } else { $osBuildRaw }

    $resolvedOsVersion = $null
    foreach ($candidate in @($graphVersion, $mdeVersion, $buildAsNt)) {
        if ($candidate -and ($candidate -match '^\d+(\.\d+)+$')) {
            $resolvedOsVersion = $candidate
            break
        }
    }
    if (-not $resolvedOsVersion) { $resolvedOsVersion = $mdeVersion }

    # Resolve Android security patch level from MAM registration (ISO date string, e.g. "2026-04-05").
    # Matched by azureADDeviceId because MDE computerDnsName ("lale_Android") differs from MAM deviceName ("Samsung SM-F741B").
    $patchVersion = if ($MamPatchMap -and $Device.aadDeviceId -and $MamPatchMap.ContainsKey($Device.aadDeviceId)) {
        $MamPatchMap[$Device.aadDeviceId]
    } else {
        $null
    }

    return @{
        id               = $Device.id
        aadDeviceId      = $Device.aadDeviceId
        computerDnsName  = $Device.computerDnsName
        osPlatform       = $Device.osPlatform
        osVersion        = $resolvedOsVersion
        osBuild          = $Device.osBuild
        patchVersion     = $patchVersion
        lastSeen         = $Device.lastSeen
        firstSeen        = $Device.firstSeen
        riskScore        = $Device.riskScore
        exposureLevel    = $Device.exposureLevel
        healthStatus     = $Device.healthStatus
        onboardingStatus = $Device.onboardingStatus
        rbacGroupName    = $Device.rbacGroupName
        logonUsers       = $LogonUsers
        registeredOwner  = if ($GraphInfo) { $GraphInfo.registeredOwner } else { $null }
    }
}

# ─── Fetch MAM patch levels for Android app-protection devices ─────────────────
# Returns a hashtable keyed on deviceName (= computerDnsName) → patchVersion string.
# Uses the Graph beta MAM endpoint; requires DeviceManagementApps.Read.All.
# Returns an empty hashtable on any error (non-fatal).
function Get-MamPatchMap {
    param([string]$GraphToken)

    if (-not $GraphToken) { return @{} }

    # Fetch all MAM registrations (no $filter/$select — those only work on the base type).
    # Filter client-side to Android records and key by azureADDeviceId (matches MDE aadDeviceId).
    # Multiple records exist per device (one per enrolled app); keep the highest patchVersion.
    $headers = @{ Authorization = "Bearer $GraphToken" }
    $uri = 'https://graph.microsoft.com/beta/deviceAppManagement/managedAppRegistrations?$top=999'

    $map = @{}
    try {
        do {
            $resp = Invoke-RestMethodWithJobTimeout -Uri $uri -Method GET -Headers $headers -TimeoutSec $script:HttpTimeoutSec -Label 'Graph MAM registrations'
            if (-not $resp) { break }
            foreach ($reg in $resp.value) {
                if ($reg.'@odata.type' -like '*androidManagedApp*' -and $reg.azureADDeviceId -and $reg.patchVersion) {
                    # Keep the most recent (highest) patchVersion for each device
                    if (-not $map.ContainsKey($reg.azureADDeviceId) -or $map[$reg.azureADDeviceId] -lt $reg.patchVersion) {
                        $map[$reg.azureADDeviceId] = $reg.patchVersion
                    }
                }
            }
            $uri = $resp.'@odata.nextLink'
        } while ($uri)

        Write-Log "MAM patch map built: $($map.Count) unique Android devices with patchVersion" 'INFO'
    }
    catch {
        Write-Log "MAM patch map fetch failed (DeviceManagementApps.Read.All may not be granted): $_" 'WARN'
    }

    return $map
}

# ─── Platform classifier ────────────────────────────────────────────────────────
function Get-PlatformKey {
    param([string]$OsPlatform)

    switch -Wildcard ($OsPlatform.ToLower()) {
        'windows*'   { return 'windows' }
        'macos*'     { return 'macos' }
        'ios'        { return 'ios' }
        'android'    { return 'android' }
        default      { return 'other' }
    }
}

# ─── Main ───────────────────────────────────────────────────────────────────────
$results = @{ BackedUp = 0; Failed = 0; GraphEnriched = 0 }

try {
    # MDE delegated auth requires Machine.Read delegated permission AND the signed-in
    # service account to have an MDE role (Security Operator or higher).
    # If token acquisition fails (scope not consented, account lacks MDE role, or
    # portal API timeout), skip the backup with a clear warning rather than hanging.
    # MDE delegated auth requires Machine.Read delegated permission AND the signed-in
    # service account to have an MDE role (Security Operator or higher).
    $accessToken = Get-MdeAccessToken

    # Get-MdeAccessToken returns $null when MDE is not licensed/consented — skip gracefully.
    if (-not $accessToken) {
        Write-Log '=== Defender Device Backup Skipped — no MDE license or consent ===' 'WARN'
        return @{ Type = 'DefenderDevices'; Success = $true; BackedUp = 0; GraphEnriched = 0; Failed = 0; Skipped = $true }
    }

    $rawDevices  = Get-AllMdeDevices -AccessToken $accessToken -Debug:$DebugMode

    # Acquire a Graph token for mobile device enrichment.  Best-effort — the backup
    # continues without enrichment if the delegated token lacks Device.Read.All.
    $graphToken = $null
    try {
        $graphToken = Get-GraphAccessToken
    }
    catch {
        Write-Log "Graph token acquisition failed — mobile devices will not be enriched with owner/version data: $_" 'WARN'
    }

    # Fetch Android MAM patch map (best-effort — requires DeviceManagementApps.Read.All)
    $mamPatchMap = @{}
    if ($graphToken) {
        $mamPatchMap = Get-MamPatchMap -GraphToken $graphToken
    }

    Write-Log "Processing $($rawDevices.Count) devices (logon users + Graph enrichment for mobile)..." 'INFO'

    # Platform buckets
    $byPlatform = @{
        windows = [System.Collections.Generic.List[object]]::new()
        macos   = [System.Collections.Generic.List[object]]::new()
        ios     = [System.Collections.Generic.List[object]]::new()
        android = [System.Collections.Generic.List[object]]::new()
        other   = [System.Collections.Generic.List[object]]::new()
    }
    $allFormatted = [System.Collections.Generic.List[object]]::new()

    $i = 0
    foreach ($device in $rawDevices) {
        $i++
        $devLabel = if ($device.computerDnsName) { $device.computerDnsName } else { '<no name>' }
        Write-Log "Device $i / $($rawDevices.Count): $devLabel ($($device.id))" 'INFO'
        if ($DebugMode) { Write-Log "  fetching MDE logon users..." 'DEBUG' }

        try {
            $platformKey = Get-PlatformKey -OsPlatform ($device.osPlatform ?? '')
            # MDE /logonusers only returns data for Windows devices; calling it for
            # iOS/Android/macOS is unnecessary and hangs on Linux (pwsh TCP cancellation
            # is unreliable on non-Windows hosts — even with -TimeoutSec).
            $logonUsers = if ($platformKey -eq 'windows') {
                Get-DeviceLogonUsers -DeviceId $device.id -AccessToken $accessToken
            } else { @() }
            if ($DebugMode) { Write-Log "  logon users retrieved ($($logonUsers.Count) entries); enriching if applicable..." 'DEBUG' }

            # Enrich via Graph. MDE osVersion is null for Android/iOS/macOS and
            # often empty for Windows (build lives in osBuild). Entra's
            # operatingSystemVersion is the dotted value Intune compliance uses.
            $graphInfo = $null
            if ($platformKey -in @('android', 'ios', 'macos', 'windows') -and $device.aadDeviceId -and $graphToken) {
                $graphInfo = Get-DeviceGraphInfo -AadDeviceId $device.aadDeviceId -GraphToken $graphToken
                if ($graphInfo) { $results.GraphEnriched++ }
            }

            $formatted = Format-DeviceRecord -Device $device -LogonUsers $logonUsers -GraphInfo $graphInfo -MamPatchMap $mamPatchMap

            $allFormatted.Add($formatted)
            $byPlatform[$platformKey].Add($formatted)

            $results.BackedUp++
        }
        catch {
            $results.Failed++
            Write-Log "Failed to process device '$($device.computerDnsName)' ($($device.id)): $_" 'WARN'
        }
    }

    # Save all-devices and per-platform files
    Write-Log 'Saving device files...' 'INFO'
    Save-BackupFile -Content $allFormatted -RelativePath 'defender-devices/all-devices.json'

    foreach ($platform in $byPlatform.Keys) {
        $list = $byPlatform[$platform]
        Save-BackupFile -Content $list -RelativePath "defender-devices/$platform-devices.json"
        Write-Log "  $platform-devices.json: $($list.Count) device(s)" 'INFO'
    }

    Write-Log "=== Defender Device Backup Complete === ($($results.BackedUp) backed up, $($results.GraphEnriched) Graph-enriched, $($results.Failed) failed)" 'INFO'
}
catch {
    Write-Log "Defender device backup failed: $_" 'ERROR'
    throw
}

return @{
    Type          = 'DefenderDevices'
    Success       = $true
    BackedUp      = $results.BackedUp
    GraphEnriched = $results.GraphEnriched
    Failed        = $results.Failed
}
