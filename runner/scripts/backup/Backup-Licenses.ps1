<#
.SYNOPSIS
    Backs up M365 subscribed SKU (license) information

.DESCRIPTION
    Exports the tenant's subscribed SKUs via Microsoft Graph so that
    Resolve-TenantGroups.ps1 can evaluate license-based dynamic group
    membership rules at deploy time without requiring a live Graph call.

    Output: backups/licenses/subscribed-skus.json
    Shape:  array of { skuId, skuPartNumber, consumedUnits, prepaidUnits, capabilityStatus }

.PARAMETER BackupPath
    The base path where backup files will be stored.

.PARAMETER DebugMode
    Enable detailed debug logging.

.EXAMPLE
    .\Backup-Licenses.ps1 -BackupPath "C:\backups"
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

if (-not $BackupPath) {
    throw 'BackupPath is required. Either pass it as a parameter or ensure Backup-Common.ps1 has been initialized.'
}

# Standalone execution: connect and initialize logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw "Failed to connect to Microsoft Graph" }
}

Write-Log '=== Starting Licenses Backup ===' 'INFO'

try {
    Write-Log 'Retrieving subscribed SKUs...' 'INFO'

    # subscribedSkus does not support $top or pagination — call directly and read .value
    $response = Invoke-GraphRequestWithDebug -Uri 'https://graph.microsoft.com/v1.0/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus' -Method GET
    $skus = @($response.value)

    Write-Log "Found $($skus.Count) subscribed SKU(s)" 'INFO'

    $skuData = $skus | ForEach-Object {
        @{
            skuId            = $_.skuId
            skuPartNumber    = $_.skuPartNumber
            consumedUnits    = $_.consumedUnits
            prepaidUnits     = @{
                enabled   = $_.prepaidUnits?.enabled
                suspended = $_.prepaidUnits?.suspended
                warning   = $_.prepaidUnits?.warning
            }
            capabilityStatus = $_.capabilityStatus
        }
    }

    Save-BackupFile -Content $skuData -RelativePath 'licenses/subscribed-skus.json'

    Write-Log "=== Licenses Backup Complete === ($($skus.Count) SKU(s))" 'INFO'
}
catch {
    Write-Log "Licenses backup failed: $_" 'ERROR'
    throw
}

return @{
    Type     = 'Licenses'
    Success  = $true
    BackedUp = 1
    Failed   = 0
}
