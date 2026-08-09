<#
.SYNOPSIS
    Resolves tenant variable values and writes a cache file for deploy/plan steps.

.DESCRIPTION
    Reads baseline variables.json, group membership, and tenant config/variables.json.
    Writes JSON output:
      { "Variables": { "Name": "value", ... } }

.PARAMETER BaselinePath
    Path to the checked-out baseline repository root.

.PARAMETER TenantRepoPath
    Path to the checked-out tenant repository root.

.PARAMETER OutputPath
    Optional path to write the JSON output file (typically under PLAN_DIR).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $BaselinePath,
    [Parameter(Mandatory)][string] $TenantRepoPath,
    [string] $OutputPath,
    [string] $TenantSlug = $env:TENANT_SLUG
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common-Variables.ps1')

function Write-EmptyTenantVariablesResult {
    param([string] $OutputPath)
    $result = @{ Variables = @{} }
    $json = $result | ConvertTo-Json -Depth 5
    if ($OutputPath) { $json | Set-Content -Path $OutputPath -Encoding UTF8 }
    Write-Host $json
}

try {
    $variables = Get-TenantVariables -BaselinePath $BaselinePath -TenantRepoPath $TenantRepoPath -TenantSlug $TenantSlug
}
catch {
    Write-Warning "Resolve-Variables: Failed to resolve tenant variables: $_"
    Write-EmptyTenantVariablesResult -OutputPath $OutputPath
    return
}

$result = @{ Variables = $variables }
$json = $result | ConvertTo-Json -Depth 5
if ($OutputPath) {
    $json | Set-Content -Path $OutputPath -Encoding UTF8
    Write-Host "##[section]Resolve-Variables: Wrote $($variables.Count) variable(s) to '$OutputPath'"
}
Write-Host $json
