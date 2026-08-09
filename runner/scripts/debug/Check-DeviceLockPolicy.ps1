# Debug helper: check whether Settings Catalog policies matching "DeviceLock"
# currently exist live in Intune, and look for delete audit events explaining
# a backup diff that showed one (and its assignment file) as deleted.
[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
$scriptRoot = $PSScriptRoot
$common     = Join-Path $scriptRoot '..\common'

. (Join-Path $common 'Connect-M365Graph.ps1')

$moduleHelpersPath = Join-Path $scriptRoot '..\graph-configs\Common-ModuleHelpers.ps1'
. $moduleHelpersPath
Import-RequiredGraphModules -ModuleNames @('Microsoft.Graph.Authentication')

$GRAPH_BASE = 'https://graph.microsoft.com/beta'
$result = @{}

$context = Ensure-M365GraphConnection
Write-Host "Connected to tenant: $($context.TenantId)"
$result.TenantId = $context.TenantId

Write-Host "`n=== Live Settings Catalog policies matching 'DeviceLock' ==="
$all = @()
$uri = "$GRAPH_BASE/deviceManagement/configurationPolicies?`$select=id,name,createdDateTime,lastModifiedDateTime"
while ($uri) {
    $page = Invoke-MgGraphRequest -Method GET -Uri $uri
    $all += $page.value
    $uri = $page.'@odata.nextLink'
}
$deviceLockMatches = @($all | Where-Object { $_.name -like '*DeviceLock*' })
foreach ($m in $deviceLockMatches) { Write-Host "  [$($m.id)] $($m.name) created=$($m.createdDateTime) modified=$($m.lastModifiedDateTime)" }
if (-not $deviceLockMatches) { Write-Host "  (none found live matching 'DeviceLock')" }
Write-Host "Total settings catalog policies live: $($all.Count)"
$result.TotalSettingsCatalogPolicies = $all.Count
$result.LiveDeviceLockMatches = $deviceLockMatches

Write-Host "`n=== Audit log: deviceManagement auditEvents (last 3 days), scanning for DeviceLock ==="
$since = (Get-Date).AddDays(-3).ToString('yyyy-MM-ddTHH:mm:ssZ')
$result.AuditQueryError = $null
try {
    $auditUri = "$GRAPH_BASE/deviceManagement/auditEvents?`$filter=activityDateTime ge $since&`$orderby=activityDateTime desc&`$top=999"
    $auditAll = @()
    while ($auditUri) {
        $page = Invoke-MgGraphRequest -Method GET -Uri $auditUri
        $auditAll += $page.value
        $auditUri = $page.'@odata.nextLink'
    }
    Write-Host "Total audit events in window: $($auditAll.Count)"
    $result.TotalAuditEventsInWindow = $auditAll.Count
    $hits = @($auditAll | Where-Object {
        $_.displayName -like '*DeviceLock*' -or
        ($_.resources | Where-Object { $_.displayName -like '*DeviceLock*' })
    })
    foreach ($h in $hits) {
        Write-Host "  [$($h.activityDateTime)] actor=$($h.actor.userPrincipalName) activity=$($h.activity) op=$($h.activityOperationType) result=$($h.activityResult) component=$($h.componentName)"
        Write-Host "    displayName: $($h.displayName)"
        foreach ($r in $h.resources) { Write-Host "    resource: $($r.displayName) [$($r.resourceId)]" }
    }
    if (-not $hits) { Write-Host "  (no DeviceLock-related audit events found in the last 3 days)" }
    $result.DeviceLockAuditHits = $hits
} catch {
    Write-Host "  Audit query failed (may lack permission): $_"
    $result.AuditQueryError = "$_"
}

if ($OutputPath) {
    $result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputPath -Encoding UTF8
    Write-Host "`nWrote: $OutputPath"
}
