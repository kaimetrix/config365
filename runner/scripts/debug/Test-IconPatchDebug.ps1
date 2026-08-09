# Debug helper: PATCH a single Win32 app's largeIcon via Graph and verify Graph accepts it.
# Used to verify the "Icon in invalid format" fix (indexed/palette PNG -> truecolor+alpha
# normalization in common/Get-Win32AppIconForIntune.ps1) against a real tenant app without
# waiting for a full hash-based Configure-WingetApps.ps1 change-detection cycle.
#
# Uses Invoke-MgGraphRequest (the SDK's own request cmdlet) rather than a manually-fetched
# bearer token. In this environment's installed Microsoft.Graph.Authentication version
# (2.38.1), Get-MgContext does NOT expose an AuthContext/AccessToken property and
# Get-MgAccessToken is not exported at all — so the "(Get-MgContext).AuthContext.AccessToken /
# Get-MgAccessToken" pattern used elsewhere in this codebase cannot reliably produce a token.
# Invoke-MgGraphRequest sidesteps that entirely: it uses the SDK's own internal auth provider
# (populated by Connect-MgGraph -AccessToken) so no raw token needs to be extracted.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AppId,

    [Parameter(Mandatory = $true)]
    [string]$IconPath,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$scriptRoot = $PSScriptRoot
$common     = Join-Path $scriptRoot '..\common'

. (Join-Path $common 'Connect-M365Graph.ps1')
. (Join-Path $common 'Get-Win32AppIconForIntune.ps1')

function Write-DebugLog {
    param([string]$Message)
    Write-Host $Message
}

$moduleHelpersPath = Join-Path $scriptRoot '..\graph-configs\Common-ModuleHelpers.ps1'
. $moduleHelpersPath
Import-RequiredGraphModules -ModuleNames @('Microsoft.Graph.Authentication')

if (-not (Test-Path -LiteralPath $IconPath)) { throw "Icon file not found: $IconPath" }

$GRAPH_BASE = 'https://graph.microsoft.com/beta'

Write-DebugLog "=== Icon patch debug ==="
Write-DebugLog "AppId: $AppId"
Write-DebugLog "IconPath: $IconPath"

$context = Ensure-M365GraphConnection
Write-DebugLog "Connected to tenant: $($context.TenantId)"

$existing = Invoke-MgGraphRequest -Method GET -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$AppId`?`$select=id,displayName,notes"
Write-DebugLog "Existing app: $($existing.displayName)"
Write-DebugLog "Existing notes: $($existing.notes)"

# Preserve installHash/detectHash/runAsAccount from the app's current notes — only iconHash
# should change here, exactly matching what Configure-WingetApps.ps1 would legitimately write
# for an icon-only update. Avoids corrupting the pipeline's change-detection state.
$installHash  = if ($existing.notes -match 'installHash:([^;]+)')  { $Matches[1] } else { '' }
$detectHash   = if ($existing.notes -match 'detectHash:([^;]+)')   { $Matches[1] } else { '' }
$runAsAccount = if ($existing.notes -match 'runAsAccount:([^;]+)') { $Matches[1] } else { 'user' }
$newIconHash  = Get-Win32AppIconHash -IconPath $IconPath

$iconHashtable = Get-Win32AppIconMimeContentHashtable -IconPath $IconPath
$body = @{
    '@odata.type' = '#microsoft.graph.win32LobApp'
    largeIcon     = $iconHashtable
    notes         = "installHash:$installHash;detectHash:$detectHash;runAsAccount:$runAsAccount;iconHash:$newIconHash"
}

Write-DebugLog "Sending PATCH with largeIcon.type=$($iconHashtable.type), $($iconHashtable.value.Length) base64 chars..."

$result = @{ AppId = $AppId; IconPath = $IconPath }
try {
    Invoke-MgGraphRequest -Method PATCH -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$AppId" -Body $body | Out-Null
    Write-DebugLog "ICON_PATCH_DEBUG_OK"
    $result.Status = 'OK'
} catch {
    Write-DebugLog "ICON_PATCH_DEBUG_FAILED: $_"
    $result.Status = 'Failed'
    $result.Error  = $_.ToString()
    if ($OutputPath) { $result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8 }
    throw
}

$verify = Invoke-MgGraphRequest -Method GET -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$AppId`?`$select=id,displayName,largeIcon,notes"
Write-DebugLog "Verify: displayName=$($verify.displayName) largeIcon.type=$($verify.largeIcon.type) notes=$($verify.notes)"
$result.VerifyDisplayName  = $verify.displayName
$result.VerifyLargeIconType = $verify.largeIcon.type
$result.VerifyNotes        = $verify.notes

if ($OutputPath) {
    $result | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding UTF8
    Write-DebugLog "Wrote: $OutputPath"
}

return $result
