<#
.SYNOPSIS
    Removes stale .baseline-apply-* scope files from the tenant repository.

.DESCRIPTION
    Reads a baseline-apply-cleanup configuration from the baseline repo and/or tenant repo.
    When enabled, deletes .baseline-apply-<RunId> files at the tenant repo root that are
    older than the configured retentionDays threshold.

    These files are written by the deploy plan job and only consumed by the matching apply
    job for the same run ID. Older files are safe to remove.

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/baseline-apply-cleanup.json.

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/baseline-apply-cleanup.json in the
    tenant repo. If present, its values override the baseline file.

.PARAMETER TenantRepoPath
    Path to the tenant repository root where .baseline-apply-* files live.

.PARAMETER OutputPath
    Optional path to write a JSON summary of removed (or would-remove) files.

.PARAMETER WhatIfMode
    List files that would be removed without running git rm.

.EXAMPLE
    .\Invoke-BaselineApplyCleanup.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "tenant/config/maintenance" `
        -TenantRepoPath    "tenant" `
        -WhatIfMode
#>

param(
    [Parameter(Mandatory = $false)]
    [string]$BaselineConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantConfigDir,

    [Parameter(Mandatory = $true)]
    [string]$TenantRepoPath,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'

function Write-OutputSummary {
    param(
        [hashtable]$Summary
    )
    if (-not $OutputPath) { return }
    $outputDir = Split-Path -Path $OutputPath -Parent
    if ($outputDir -and -not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    $Summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8
}

function Read-BaselineApplyCleanupConfigFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return $null }
    $path = Join-Path $Dir 'baseline-apply-cleanup.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No baseline-apply-cleanup.json found in: $Dir" -ForegroundColor DarkGray
        return $null
    }
    try {
        $parsed = Get-Content $path -Raw | ConvertFrom-Json
        Write-Host "  Loaded config from: $path"
        return $parsed
    } catch {
        Write-Host "  Warning: Failed to parse $path - $_" -ForegroundColor Yellow
        return $null
    }
}

function Get-ScopeFileCommitDate {
    param(
        [string]$RepoPath,
        [string]$FileName
    )
    $gitDate = & git -C $RepoPath log -1 --format=%cI -- $FileName 2>$null
    if ($LASTEXITCODE -eq 0 -and $gitDate) {
        return [DateTime]::Parse($gitDate).ToUniversalTime()
    }
    $fullPath = Join-Path $RepoPath $FileName
    if (Test-Path $fullPath) {
        return (Get-Item $fullPath).LastWriteTimeUtc
    }
    return $null
}

Write-Host ""
Write-Host "##[section]Loading baseline apply cleanup configuration"

$baselineConfig = Read-BaselineApplyCleanupConfigFile -Dir $BaselineConfigDir
$tenantConfig   = Read-BaselineApplyCleanupConfigFile -Dir $TenantConfigDir

$effectiveConfig = if ($tenantConfig) { $tenantConfig } elseif ($baselineConfig) { $baselineConfig } else { $null }

if (-not $effectiveConfig) {
    Write-Host "No baseline-apply-cleanup.json found in baseline or tenant. Nothing to do." -ForegroundColor DarkGray
    Write-OutputSummary @{
        Service      = 'BaselineApplyCleanup'
        Timestamp    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        WhatIfMode   = [bool]$WhatIfMode
        Enabled      = $false
        RemovedCount = 0
        Removed      = @()
    }
    exit 0
}

$enabled       = if ($null -ne $effectiveConfig.enabled)       { [bool]$effectiveConfig.enabled }       else { $false }
$retentionDays = if ($null -ne $effectiveConfig.retentionDays) { [int]$effectiveConfig.retentionDays } else { 30 }

Write-Host "  Enabled       : $enabled"
Write-Host "  RetentionDays : $retentionDays"

if (-not $enabled) {
    Write-Host "Feature is disabled. Nothing to do." -ForegroundColor DarkGray
    Write-OutputSummary @{
        Service       = 'BaselineApplyCleanup'
        Timestamp     = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        WhatIfMode    = [bool]$WhatIfMode
        Enabled       = $false
        RetentionDays = $retentionDays
        RemovedCount  = 0
        Removed       = @()
    }
    exit 0
}

if (-not (Test-Path $TenantRepoPath)) {
    throw "Tenant repo path not found: $TenantRepoPath"
}

$cutoffDate   = (Get-Date).ToUniversalTime().AddDays(-$retentionDays)
$currentRunId = $env:GITEA_RUN_ID
$removedFiles = @()

Write-Host ""
Write-Host "##[section]Scanning for stale .baseline-apply-* files"
Write-Host "  Tenant repo   : $TenantRepoPath"
Write-Host "  Cutoff (UTC)  : $($cutoffDate.ToString('yyyy-MM-dd HH:mm:ss'))"
if ($currentRunId) {
    Write-Host "  Current run ID: $currentRunId (will be preserved)"
}

$scopeFiles = @(Get-ChildItem -Path $TenantRepoPath -Filter '.baseline-apply-*' -File -Force -ErrorAction SilentlyContinue)
if ($scopeFiles.Count -eq 0) {
    Write-Host "  No .baseline-apply-* files found." -ForegroundColor DarkGray
    Write-OutputSummary @{
        Service       = 'BaselineApplyCleanup'
        Timestamp     = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        WhatIfMode    = [bool]$WhatIfMode
        Enabled       = $true
        RetentionDays = $retentionDays
        RemovedCount  = 0
        Removed       = @()
    }
    exit 0
}

Write-Host "  Found $($scopeFiles.Count) scope file(s)"

foreach ($scopeFile in $scopeFiles) {
    $fileName = $scopeFile.Name
    $runId = $null

    if ($fileName -match '^\.baseline-apply-(.+)$') {
        $runId = $Matches[1]
        if ($currentRunId -and $runId -eq $currentRunId) {
            Write-Host "  Skipping current run scope file: $fileName" -ForegroundColor DarkGray
            continue
        }
    }

    $commitDate = Get-ScopeFileCommitDate -RepoPath $TenantRepoPath -FileName $fileName
    if (-not $commitDate) {
        Write-Host "  Skipping $fileName - could not determine age" -ForegroundColor Yellow
        continue
    }

    if ($commitDate -ge $cutoffDate) {
        Write-Host "  Keeping $fileName (committed $($commitDate.ToString('yyyy-MM-dd')))" -ForegroundColor DarkGray
        continue
    }

    $entry = [ordered]@{
        File        = $fileName
        CommittedAt = $commitDate.ToString('yyyy-MM-dd HH:mm:ss')
        RunId       = $runId
        Action      = if ($WhatIfMode) { 'WouldRemove' } else { 'Removed' }
    }

    if ($WhatIfMode) {
        Write-Host "  [WhatIf] Would remove: $fileName (committed $($commitDate.ToString('yyyy-MM-dd')))" -ForegroundColor Yellow
    } else {
        Write-Host "  Removing: $fileName (committed $($commitDate.ToString('yyyy-MM-dd')))" -ForegroundColor Cyan
        & git -C $TenantRepoPath rm -- $fileName
        if ($LASTEXITCODE -ne 0) {
            throw "git rm failed for $fileName (exit code $LASTEXITCODE)"
        }
    }

    $removedFiles += [pscustomobject]$entry
}

Write-Host ""
Write-Host "##[section]Baseline apply cleanup complete"
Write-Host "  $(if ($WhatIfMode) { 'Would remove' } else { 'Removed' }): $($removedFiles.Count) file(s)"

Write-OutputSummary @{
    Service       = 'BaselineApplyCleanup'
    Timestamp     = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    WhatIfMode    = [bool]$WhatIfMode
    Enabled       = $true
    RetentionDays = $retentionDays
    RemovedCount  = $removedFiles.Count
    Removed       = $removedFiles
}

exit 0
