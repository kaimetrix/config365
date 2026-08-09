<#
.SYNOPSIS
    Diagnose sign-in deviceDetail.displayName vs deviceId mismatches for a user.
    Writes JSON to config/debug-signin-device-probe-latest.json.
#>

param(
    [string]$TenantSlug  = $env:TENANT_SLUG,
    [string]$TenantId    = $env:AZURE_TENANT_ID,
    [string]$ClientId    = $env:AZURE_CLIENT_ID,
    [string]$ClientSecret = $env:AZURE_CLIENT_SECRET,
    [string]$UserUpn     = $env:DEBUG_USER_UPN,
    [string]$BackupPath  = '',
    [string]$OutputPath  = $env:DEBUG_OUTPUT_PATH,
    [int]$DaysBack       = 7
)

$ErrorActionPreference = 'Continue'

$commonScript = Join-Path $PSScriptRoot '..\common\Connect-M365Graph.ps1'
. $commonScript

function Test-DeviceId([string]$Id) {
    if ([string]::IsNullOrWhiteSpace($Id)) { return $false }
    if ($Id -eq '00000000-0000-0000-0000-000000000000') { return $false }
    return $true
}

function Get-DeviceNameMap {
    param([string]$BasePath)
    $map = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)

    if ($BasePath) {
        $intuneFile = Join-Path $BasePath 'intune/managed-devices.json'
        if (Test-Path $intuneFile) {
            foreach ($d in @(Get-Content $intuneFile -Raw | ConvertFrom-Json)) {
                $id = [string]$d.azureADDeviceId
                $name = [string]$d.deviceName
                if ((Test-DeviceId $id) -and $name) { $map[$id] = $name }
            }
        }
    }

    try {
        $uri = 'https://graph.microsoft.com/v1.0/devices?$select=deviceId,displayName&$top=999'
        do {
            $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
            foreach ($d in @($resp.value)) {
                $id = [string]$d.deviceId
                $name = [string]$d.displayName
                if ((Test-DeviceId $id) -and $name) { $map[$id] = $name }
            }
            $uri = $resp.'@odata.nextLink'
        } while ($uri)
    } catch {
        Write-Warning "Entra device registry: $_"
    }

    return $map
}

Write-Host ''
Write-Host '=================================================='
Write-Host '  Sign-In Device Probe'
Write-Host '=================================================='
Write-Host "  Tenant : $TenantSlug ($TenantId)"
Write-Host "  User   : $UserUpn"
Write-Host "  Days   : $DaysBack"

$connected = Connect-M365Graph -TenantId $TenantId -ClientId $ClientId -ClientSecret $ClientSecret
if (-not $connected) {
    Write-Error 'Failed to connect to Microsoft Graph'
    exit 1
}

$cutoff = (Get-Date).ToUniversalTime().AddDays(-$DaysBack).ToString('yyyy-MM-ddTHH:mm:ssZ')
$filter = "createdDateTime ge $cutoff and userPrincipalName eq '$UserUpn' and status/errorCode eq 0"
$uri = "https://graph.microsoft.com/beta/auditLogs/signIns?`$filter=$([Uri]::EscapeDataString($filter))&`$top=999"

$signIns = [System.Collections.Generic.List[object]]::new()
do {
    $resp = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
    if ($resp.value) { foreach ($item in $resp.value) { $signIns.Add($item) } }
    $uri = $resp.'@odata.nextLink'
} while ($uri)

Write-Host "  Retrieved $($signIns.Count) sign-in(s)"

$deviceMap = Get-DeviceNameMap -BasePath $BackupPath

$groups = @{}
foreach ($si in $signIns) {
    $dd = $si.deviceDetail
    $rawId = [string]$dd.deviceId
    $deviceId = if (Test-DeviceId $rawId) { $rawId } else { '' }
    $rawName = [string]$dd.displayName
    $canonical = if ($deviceId -and $deviceMap.ContainsKey($deviceId)) { $deviceMap[$deviceId] } else { '' }
    $key = "$deviceId|$rawName|$($si.clientAppUsed)"
    if (-not $groups.ContainsKey($key)) {
        $groups[$key] = @{
            deviceId           = $deviceId
            signInDisplayName  = $rawName
            registryName       = $canonical
            nameMismatch       = [bool]($canonical -and $rawName -and ($canonical -ne $rawName))
            clientAppUsed      = [string]$si.clientAppUsed
            appDisplayName     = [string]$si.appDisplayName
            isInteractive      = [bool]$si.isInteractive
            isCompliant        = $dd.isCompliant
            trustType          = [string]$dd.trustType
            signInCount        = 0
            firstSignIn        = [string]$si.createdDateTime
            lastSignIn         = [string]$si.createdDateTime
        }
    }
    $g = $groups[$key]
    $g.signInCount++
    $ts = [string]$si.createdDateTime
    if ($ts -lt $g.firstSignIn) { $g.firstSignIn = $ts }
    if ($ts -gt $g.lastSignIn)  { $g.lastSignIn  = $ts }
}

$userDevices = @()
try {
    $mdFilter = [Uri]::EscapeDataString("userPrincipalName eq '$UserUpn'")
    $mdUri = "https://graph.microsoft.com/beta/deviceManagement/managedDevices?`$filter=$mdFilter&`$select=deviceName,azureADDeviceId,lastSyncDateTime,complianceState"
    $mdResp = Invoke-MgGraphRequest -Method GET -Uri $mdUri -OutputType PSObject
    foreach ($d in @($mdResp.value)) {
        $id = [string]$d.azureADDeviceId
        $userDevices += @{
            deviceName       = [string]$d.deviceName
            azureADDeviceId  = $id
            registryName     = if ($id -and $deviceMap.ContainsKey($id)) { $deviceMap[$id] } else { '' }
            lastSyncDateTime = [string]$d.lastSyncDateTime
            complianceState  = [string]$d.complianceState
        }
    }
} catch {
    Write-Warning "Intune managed devices: $_"
}

$backupSamples = @()
if ($BackupPath) {
    $signInDir = Join-Path $BackupPath 'signin-logs'
    if (Test-Path $signInDir) {
        Get-ChildItem -Path $signInDir -Filter '????-??-??.json' -File |
            Sort-Object BaseName -Descending |
            Select-Object -First 7 |
            ForEach-Object {
                try {
                    $day = Get-Content $_.FullName -Raw | ConvertFrom-Json
                    foreach ($e in @($day.entries)) {
                        if ($e.userPrincipalName -ne $UserUpn) { continue }
                        $canonical = ''
                        if ((Test-DeviceId ([string]$e.deviceId)) -and $deviceMap.ContainsKey([string]$e.deviceId)) {
                            $canonical = $deviceMap[[string]$e.deviceId]
                        }
                        $backupSamples += @{
                            backupDate        = $_.BaseName
                            deviceId          = [string]$e.deviceId
                            backupDeviceName  = [string]$e.deviceName
                            registryName      = $canonical
                            nameMismatch      = [bool]($canonical -and $e.deviceName -and ($canonical -ne $e.deviceName))
                            clientAppUsed     = [string]$e.clientAppUsed
                            appsAccessed      = @($e.appsAccessed)
                            signInCount       = [int]$e.signInCount
                            lastSignIn        = [string]$e.lastSignIn
                        }
                    }
                } catch { }
            }
    }
}

$mismatches = @($groups.Values | Where-Object { $_.nameMismatch })

$liveDeviceIds = @($groups.Values | ForEach-Object { $_.deviceId } | Where-Object { $_ } | Select-Object -Unique)
$backupDeviceIds = @($backupSamples | ForEach-Object { $_.deviceId } | Where-Object { $_ } | Select-Object -Unique)
$missingFromBackup = @($liveDeviceIds | Where-Object { $_ -notin $backupDeviceIds })

$summary = @{
    tenantSlug       = $TenantSlug
    tenantId         = $TenantId
    userUpn          = $UserUpn
    probedAt         = (Get-Date).ToUniversalTime().ToString('o')
    daysBack         = $DaysBack
    totalSignIns     = $signIns.Count
    uniqueDeviceKeys = $groups.Count
    mismatchCount    = $mismatches.Count
    liveDeviceIds    = @($liveDeviceIds)
    backupDeviceIds  = @($backupDeviceIds)
    missingFromBackup = @($missingFromBackup)
    intuneDevices    = @($userDevices)
    signInGroups     = @($groups.Values | Sort-Object -Property lastSignIn -Descending)
    backupSamples    = @($backupSamples)
    diagnosis        = if ($missingFromBackup.Count -gt 0) {
        "Live sign-ins include deviceId(s) not yet in sign-in backup files: $($missingFromBackup -join ', '). Backup runs through yesterday only; newer devices appear after the next backup."
    } elseif ($mismatches.Count -gt 0) {
        'Sign-in deviceDetail.displayName differs from Entra/Intune registry for the same deviceId. Resolve names by deviceId.'
    } else {
        'Live sign-in deviceId and displayName match registry. Check backup date range if portal view differs.'
    }
}

Write-Host ''
Write-Host "  Sign-in groups : $($groups.Count)"
Write-Host "  Name mismatches: $($mismatches.Count)"
Write-Host "  Missing from backup deviceIds: $($missingFromBackup -join ', ')"
foreach ($m in $mismatches) {
    Write-Host "    deviceId=$($m.deviceId) signIn='$($m.signInDisplayName)' registry='$($m.registryName)' ($($m.signInCount)x $($m.appDisplayName))"
}
Write-Host ''
Write-Host "  Intune devices for user:"
foreach ($d in $userDevices) {
    Write-Host "    $($d.deviceName)  id=$($d.azureADDeviceId)  lastSync=$($d.lastSyncDateTime)"
}

if ($OutputPath) {
    $dir = Split-Path $OutputPath -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $summary | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutputPath -Encoding utf8
    Write-Host "  Wrote: $OutputPath"
}
