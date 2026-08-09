<#
.SYNOPSIS
    Initializes the backup environment for a per-section backup run.

.DESCRIPTION
    Clears the backup directory (preserving logs), creates all required
    subdirectories, and verifies Microsoft Graph connectivity.

    This script must run BEFORE any individual Backup-*.ps1 scripts when
    running in per-section mode (i.e., from a backup.yml step-per-script
    workflow). It ensures:
      1. A clean backup directory for the current run.
      2. All subdirectories exist before parallel section scripts start.
      3. Credentials are valid early — failing fast before wasting time.

    When Backup-Main.ps1 is used instead (monolithic mode), this script is
    not needed as Backup-Main.ps1 performs these steps itself.

.PARAMETER BackupPath
    The path where backup files will be stored.

.PARAMETER DebugMode
    Enable detailed debug logging.

.EXAMPLE
    .\Backup-Initialize.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
. "$scriptDir\Backup-Common.ps1"

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  M365 Configuration Backup — Initialize" -ForegroundColor Green
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green

if (-not (Test-Path $BackupPath)) {
    New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null
}

Initialize-BackupLogging    -BackupPath $BackupPath -DebugMode:$DebugMode
Clear-BackupDirectory       -BackupPath $BackupPath
Initialize-BackupDirectories -BackupPath $BackupPath

$connected = Connect-M365Backup `
    -TenantId     $env:AZURE_TENANT_ID `
    -ClientId     $env:AZURE_CLIENT_ID `
    -ClientSecret $env:AZURE_CLIENT_SECRET

if (-not $connected) {
    throw "Failed to connect to Microsoft Graph — aborting backup"
}

Write-Log "Backup initialized. Tenant: $script:CurrentTenantId" "INFO"
Write-Host "Initialization complete." -ForegroundColor Green
