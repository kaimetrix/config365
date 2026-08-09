<#
.SYNOPSIS
    Fast diagnostic for Get-ExternalInOutlook using the same path as Backup-Exchange.ps1.
    Writes JSON to config/debug-external-in-outlook-latest.json via debug-exchange pipeline.
#>

param(
    [string]$TenantSlug  = $env:TENANT_SLUG,
    [string]$TenantId    = $env:AZURE_TENANT_ID,
    [string]$TokenApiUrl = $env:PORTAL_TOKEN_API_URL,
    [string]$InternalKey = $env:PORTAL_INTERNAL_KEY,
    [string]$OutputPath  = $env:DEBUG_OUTPUT_PATH,
    [switch]$TryRemediateRoleGroup
)

$ErrorActionPreference = 'Continue'
if (-not $TokenApiUrl) { $TokenApiUrl = 'http://localhost:4322' }

$commonScript = Join-Path $PSScriptRoot '..\common\Connect-M365Graph.ps1'
. $commonScript

function New-ProbeResult {
    param([string]$Name, [bool]$Success, [string]$Detail = '', [object]$Data = $null)
    [PSCustomObject]@{ name = $Name; success = $Success; detail = $Detail; data = $Data; at = (Get-Date).ToUniversalTime().ToString('o') }
}

$results = [System.Collections.Generic.List[object]]::new()
$summary = @{
    tenantSlug = $TenantSlug
    tenantId   = $TenantId
    probes     = $results
    remediated = $false
    winner     = $null
    production = $null
}

Write-Host ''
Write-Host '=================================================='
Write-Host '  ExternalInOutlook Debug Probe (production path)'
Write-Host '=================================================='
Write-Host "  TenantSlug : $TenantSlug"
Write-Host "  TenantId   : $TenantId"

# --- Production connect (same as Backup-Exchange) --------------------------------
Write-Host ''
Write-Host '--- Connect-ExchangeOnlineDelegated (production) ---'
try {
    $env:TENANT_SLUG = $TenantSlug
    $env:AZURE_TENANT_ID = $TenantId
    $env:PORTAL_TOKEN_API_URL = $TokenApiUrl
    $env:PORTAL_INTERNAL_KEY = $InternalKey
    Connect-ExchangeOnlineDelegated
    $upn = $script:ExoDelegatedUserPrincipalName
    $results.Add((New-ProbeResult -Name 'connect_production' -Success $true -Detail "Connected as $upn"))
    Write-Host "  [OK] Connected as $upn"
}
catch {
    $results.Add((New-ProbeResult -Name 'connect_production' -Success $false -Detail $_.Exception.Message))
    Write-Host "  [FAIL] $_"
    if ($OutputPath) {
        $summary | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutputPath -Encoding utf8
    }
    exit 1
}

# --- RBAC membership -------------------------------------------------------------
Write-Host ''
Write-Host '--- Organization Management RBAC ---'
try {
    $isMember = Test-ExchangeOrganizationManagementMember -UserPrincipalName $upn
    $detail = if ($isMember) { "Member of Organization Management" } else { "NOT in Organization Management" }
    Write-Host "  $detail"
    $results.Add((New-ProbeResult -Name 'rbac_org_mgmt' -Success $true -Detail $detail -Data @{ isMember = $isMember }))

    if ($TryRemediateRoleGroup -and -not $isMember) {
        Write-Host '  Attempting Add-RoleGroupMember...'
        $added = Ensure-ExchangeOrganizationManagementRole -UserPrincipalName $upn
        $summary.remediated = [bool]$added
        $isMember = Test-ExchangeOrganizationManagementMember -UserPrincipalName $upn
        $results.Add((New-ProbeResult -Name 'rbac_remediation' -Success $isMember -Detail $(if ($isMember) { 'Added to Organization Management' } else { 'Remediation did not confirm membership' })))
        Write-Host "  After remediation: $(if ($isMember) { 'member' } else { 'still not member' })"
    }
}
catch {
    $results.Add((New-ProbeResult -Name 'rbac_org_mgmt' -Success $false -Detail $_.Exception.Message))
    Write-Host "  [FAIL] $_"
}

# --- Production getter (REST first, same as backup) --------------------------------
Write-Host ''
Write-Host '--- Get-ExternalInOutlookConfiguration (production backup path) ---'
try {
    $config = Get-ExternalInOutlookConfiguration -RestTimeoutSec 20
    if ($config) {
        $summary.production = $config
        $summary.winner = $config.Source
        $results.Add((New-ProbeResult -Name 'production_get' -Success $true -Detail "Enabled=$($config.Enabled) via $($config.Source)" -Data $config))
        Write-Host "  [OK] Enabled=$($config.Enabled) AllowList=$($config.AllowList.Count) via $($config.Source)"
    }
    else {
        $results.Add((New-ProbeResult -Name 'production_get' -Success $false -Detail 'Get-ExternalInOutlookConfiguration returned null'))
        Write-Host '  [FAIL] production getter returned null'
    }
}
catch {
    $results.Add((New-ProbeResult -Name 'production_get' -Success $false -Detail $_.Exception.Message))
    Write-Host "  [FAIL] $_"
}

# --- Control --------------------------------------------------------------------
Write-Host ''
Write-Host '--- Get-OrganizationConfig (control) ---'
try {
    $org = Get-OrganizationConfig -ErrorAction Stop | Select-Object -First 1
    $results.Add((New-ProbeResult -Name 'control_org_config' -Success $true -Detail "MailTipsAllTipsEnabled=$($org.MailTipsAllTipsEnabled)"))
    Write-Host "  [OK] MailTipsAllTipsEnabled=$($org.MailTipsAllTipsEnabled)"
}
catch {
    $results.Add((New-ProbeResult -Name 'control_org_config' -Success $false -Detail $_.Exception.Message))
    Write-Host "  [FAIL] $_"
}

Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '=================================================='
Write-Host '  Probe Summary'
Write-Host '=================================================='
foreach ($p in $results) {
    Write-Host "  [$(if ($p.success) { 'OK' } else { 'FAIL' })] $($p.name): $($p.detail)"
}
Write-Host ''
Write-Host "  Winner: $(if ($summary.winner) { $summary.winner } else { '(none)' })"

if ($OutputPath) {
    $dir = Split-Path -Parent $OutputPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $summary | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutputPath -Encoding utf8
    Write-Host "  JSON: $OutputPath"
}

if ($summary.production) { exit 0 }
exit 1
