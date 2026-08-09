# Debug helper: clear just the iconHash marker in a Win32 app's notes field, without
# touching the actual largeIcon or re-uploading anything. This forces the next
# Configure-WingetApps.ps1 run to see existingIconHash != freshly-computed iconHash and
# re-push the baseline icon — useful for re-exercising the icon-PATCH path (e.g. after the
# "Icon in invalid format" fix) when the baseline source hasn't actually changed, or after
# someone manually edited the icon directly in Intune (which Config365's hash-based change
# detection can't otherwise see, since it only compares against its own last-written hash,
# not the live largeIcon bytes).
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DisplayName,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$scriptRoot = $PSScriptRoot
$common     = Join-Path $scriptRoot '..\common'

. (Join-Path $common 'Connect-M365Graph.ps1')

function Write-DebugLog {
    param([string]$Message)
    Write-Host $Message
}

$moduleHelpersPath = Join-Path $scriptRoot '..\graph-configs\Common-ModuleHelpers.ps1'
. $moduleHelpersPath
Import-RequiredGraphModules -ModuleNames @('Microsoft.Graph.Authentication')

$GRAPH_BASE = 'https://graph.microsoft.com/beta'

Write-DebugLog "=== Clear icon hash debug ==="
Write-DebugLog "DisplayName: $DisplayName"

$context = Ensure-M365GraphConnection
Write-DebugLog "Connected to tenant: $($context.TenantId)"

$safeName = $DisplayName.Replace("'", "''")
$encoded  = [Uri]::EscapeDataString("displayName eq '$safeName'")
$lookup   = Invoke-MgGraphRequest -Method GET -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps?`$filter=$encoded`&`$select=id,displayName,notes"
$existing = $lookup.value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.win32LobApp' } | Select-Object -First 1

if (-not $existing) { throw "No win32LobApp found with displayName '$DisplayName'" }

$appId = $existing.id
Write-DebugLog "Found app: $appId"
Write-DebugLog "Existing notes: $($existing.notes)"

$installHash  = if ($existing.notes -match 'installHash:([^;]+)')  { $Matches[1] } else { '' }
$detectHash   = if ($existing.notes -match 'detectHash:([^;]+)')   { $Matches[1] } else { '' }
$runAsAccount = if ($existing.notes -match 'runAsAccount:([^;]+)') { $Matches[1] } else { 'user' }

$newNotes = "installHash:$installHash;detectHash:$detectHash;runAsAccount:$runAsAccount;iconHash:"
Write-DebugLog "New notes (iconHash cleared): $newNotes"

$body = @{
    '@odata.type' = '#microsoft.graph.win32LobApp'
    notes         = $newNotes
}

$result = @{ AppId = $appId; DisplayName = $DisplayName }
try {
    Invoke-MgGraphRequest -Method PATCH -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body $body | Out-Null
    Write-DebugLog "CLEAR_ICON_HASH_OK"
    $result.Status = 'OK'
} catch {
    Write-DebugLog "CLEAR_ICON_HASH_FAILED: $_"
    $result.Status = 'Failed'
    $result.Error  = $_.ToString()
    if ($OutputPath) { $result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8 }
    throw
}

$verify = Invoke-MgGraphRequest -Method GET -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId`?`$select=id,displayName,notes"
Write-DebugLog "Verify notes: $($verify.notes)"
$result.VerifyNotes = $verify.notes

if ($OutputPath) {
    $result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8
    Write-DebugLog "Wrote: $OutputPath"
}

return $result
