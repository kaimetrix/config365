#Requires -Version 5.1
<#
.SYNOPSIS
    Local diagnostic: fetches Android MAM registrations from Graph to verify patchVersion data.
    Uses 'az login' identity -- no client secret required.
.PARAMETER TenantId
    Optional tenant to query. Defaults to the active az context.
#>
param([string]$TenantId = '')

$ErrorActionPreference = 'Stop'

function Get-ErrorBody {
    param($err)
    if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
    try {
        $stream = $err.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        return $reader.ReadToEnd()
    } catch {}
    return $err.Exception.Message
}

# 1. Acquire Graph token via az CLI
Write-Host ""
Write-Host "[1] Acquiring Graph token via az CLI..." -ForegroundColor Cyan
$azArgs = @('account', 'get-access-token', '--resource', 'https://graph.microsoft.com', '--output', 'json')
if ($TenantId) { $azArgs += @('--tenant', $TenantId) }
$tokenJson = & az @azArgs 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "az CLI failed. Run 'az login' first.`n$tokenJson"; exit 1 }
$graphToken = ($tokenJson | ConvertFrom-Json).accessToken
Write-Host "  OK (starts: $($graphToken.Substring(0,20))...)" -ForegroundColor Green

$headers = @{ Authorization = "Bearer $graphToken" }

# 2. Hit the base endpoint with no filter to see property names on real data
Write-Host ""
Write-Host "[2] Raw managedAppRegistrations (top 3, no filter/select)..." -ForegroundColor Cyan
$baseUri = 'https://graph.microsoft.com/beta/deviceAppManagement/managedAppRegistrations?$top=3'
try {
    $raw = Invoke-RestMethod -Uri $baseUri -Headers $headers -Method GET -ErrorAction Stop
    Write-Host "  Records in page: $($raw.value.Count)" -ForegroundColor Green
    if ($raw.value.Count -gt 0) {
        Write-Host "  Properties on first record:" -ForegroundColor Yellow
        $raw.value[0].PSObject.Properties.Name | ForEach-Object { Write-Host "    $_" }
        Write-Host "  First record JSON:" -ForegroundColor Yellow
        $raw.value[0] | ConvertTo-Json -Depth 3
    }
} catch {
    Write-Host ("  FAILED: " + (Get-ErrorBody $_)) -ForegroundColor Red
}

# 3. Android-specific OData cast with patchVersion select
Write-Host ""
Write-Host "[3] Android cast: /managedAppRegistrations/microsoft.graph.androidManagedAppRegistration" -ForegroundColor Cyan
$androidUri = ('https://graph.microsoft.com/beta/deviceAppManagement/managedAppRegistrations' +
               '/microsoft.graph.androidManagedAppRegistration' +
               '?$select=deviceName,patchVersion,deviceOperatingSystemVersion&$top=20')
try {
    $resp = Invoke-RestMethod -Uri $androidUri -Headers $headers -Method GET -ErrorAction Stop
    $regs = $resp.value
    Write-Host "  Records: $($regs.Count)" -ForegroundColor Green
    if ($regs.Count -eq 0) {
        Write-Host "  No Android MAM registrations found." -ForegroundColor Yellow
    } else {
        $withPatch = @($regs | Where-Object { $_.patchVersion -ne $null -and $_.patchVersion -ne '' })
        $color = if ($withPatch.Count -gt 0) { 'Green' } else { 'Red' }
        Write-Host ("  $($withPatch.Count) / $($regs.Count) have patchVersion.") -ForegroundColor $color
        Write-Host ""
        foreach ($r in $regs) {
            $pv = if ($r.patchVersion) { $r.patchVersion } else { '(null)' }
            $ov = if ($r.deviceOperatingSystemVersion) { $r.deviceOperatingSystemVersion } else { '(null)' }
            Write-Host ("  device={0,-30}  patchVersion={1,-15}  osVersion={2}" -f $r.deviceName, $pv, $ov)
        }
    }
} catch {
    Write-Host ("  FAILED: " + (Get-ErrorBody $_)) -ForegroundColor Red
}

Write-Host ""
