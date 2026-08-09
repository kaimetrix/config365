<#
.SYNOPSIS
    Backs up Microsoft Secure Score data for the tenant.

.DESCRIPTION
    Exports three datasets from the Microsoft Graph Security API:
      - The current Secure Score (score.json)
      - Daily score history (history/YYYY-MM-DD.json) — up to 90 days backfilled from Graph
      - All Secure Score control profiles / recommendations (controls.json)

    Graph retains ~90 days of daily secureScore records. On each run the script
    fetches available history and writes any missing date files (idempotent).
    Local history files are retained for RetentionDays (default 365) so trends
    extend beyond Graph's rolling window once nightly backups accumulate.

    Requires SecurityEvents.Read.All in the delegated token.
    A 403 writes an error marker (error.json) and returns cleanly — use
    continue-on-error: true in the pipeline step.

.PARAMETER BackupPath
    Base path where backup files are stored (the 'backups' folder in the tenant repo).

.PARAMETER DebugMode
    Enable verbose logging.

.PARAMETER DaysBack
    Maximum number of past days to backfill from Graph on first run. Default 90.

.PARAMETER RetentionDays
    Number of days to retain local history files before pruning. Default 365.

.EXAMPLE
    .\Backup-SecureScore.ps1 -BackupPath "C:\repos\tenant-contoso\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [Parameter(Mandatory = $false)]
    [switch]$DebugMode,

    [Parameter(Mandatory = $false)]
    [int]$DaysBack = 90,

    [Parameter(Mandatory = $false)]
    [int]$RetentionDays = 365
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

# Standalone execution: connect and initialise logging/dirs if not already done
if (-not $script:LogFile) {
    Initialize-BackupLogging     -BackupPath $BackupPath -DebugMode:$DebugMode
    Initialize-BackupDirectories -BackupPath $BackupPath
}
if (-not $script:CurrentTenantId) {
    $connected = Connect-M365Backup `
        -TenantId     $env:AZURE_TENANT_ID `
        -ClientId     $env:AZURE_CLIENT_ID `
        -ClientSecret $env:AZURE_CLIENT_SECRET
    if (-not $connected) { throw 'Failed to connect to Microsoft Graph' }
}

Write-Log '=== Starting Secure Score Backup ===' 'INFO'

$outputDir = Join-Path $BackupPath 'secure-score'
$historyDir = Join-Path $outputDir 'history'
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
if (-not (Test-Path $historyDir)) {
    New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
}

$errorFile    = Join-Path $outputDir 'error.json'
$scoreFile    = Join-Path $outputDir 'score.json'
$controlsFile = Join-Path $outputDir 'controls.json'

# ── Helper: handle 403 / licence errors ───────────────────────────────────────

function Write-SecureScoreError {
    param([string]$Detail)
    @{
        error     = 'insufficient_license'
        detail    = $Detail
        updatedAt = (Get-Date -Format 'o')
    } | ConvertTo-Json -Depth 3 | Out-File -FilePath $errorFile -Encoding UTF8 -Force
}

function Clear-SecureScoreError {
    if (Test-Path $errorFile) {
        Remove-Item -Path $errorFile -Force
        Write-Log 'Removed stale secure-score error marker' 'DEBUG'
    }
}

function Get-ScoreDateLabel {
    param([string]$CreatedDateTime)
    try {
        return ([datetimeoffset]::Parse($CreatedDateTime)).UtcDateTime.ToString('yyyy-MM-dd')
    } catch {
        return $null
    }
}

function Write-HistoryFileIfMissing {
    param(
        [object]$Entry,
        [string]$HistoryDir
    )
    $dateLabel = Get-ScoreDateLabel -CreatedDateTime $Entry.createdDateTime
    if (-not $dateLabel) { return $false }

    $historyFile = Join-Path $HistoryDir "$dateLabel.json"
    $currentScore = [double]$Entry.currentScore
    $maxScore     = [double]$Entry.maxScore
    $percent      = if ($maxScore -gt 0) { [math]::Round(($currentScore / $maxScore) * 100, 1) } else { 0.0 }

    if (Test-Path $historyFile) {
        try {
            $existing = Get-Content -Path $historyFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $scoresMatch = (
                "$($existing.date)" -eq $dateLabel -and
                [math]::Abs([double]$existing.currentScore - $currentScore) -lt 0.001 -and
                [math]::Abs([double]$existing.maxScore - $maxScore) -lt 0.001 -and
                "$($existing.createdDateTime)" -eq "$($Entry.createdDateTime)"
            )
            if ($scoresMatch) { return $false }
            Write-Log "History date $dateLabel exists but scores differ — leaving existing file" 'DEBUG'
        } catch {
            Write-Log "History date $dateLabel exists but could not be parsed — leaving existing file" 'DEBUG'
        }
        return $false
    }

    [ordered]@{
        date            = $dateLabel
        currentScore    = $currentScore
        maxScore        = $maxScore
        percent         = $percent
        createdDateTime = $Entry.createdDateTime
        backedUpAt      = (Get-Date -Format 'o')
    } | ConvertTo-Json -Depth 5 | Out-File -FilePath $historyFile -Encoding UTF8 -Force

    Write-Log "History written: $dateLabel ($currentScore / $maxScore)" 'DEBUG'
    return $true
}

# ── 1. Secure Score (current + history backfill) ─────────────────────────────

Write-Log 'Fetching Secure Score history from Graph...' 'INFO'

try {
    $allScores = [System.Collections.Generic.List[object]]::new()
    $nextUri   = "https://graph.microsoft.com/v1.0/security/secureScores?`$top=$DaysBack&`$orderby=createdDateTime%20desc"
    $pageCount = 0
    do {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $nextUri -OutputType PSObject
        $pageCount++
        if ($resp.value) { foreach ($item in $resp.value) { $allScores.Add($item) } }
        $nextUri = $resp.'@odata.nextLink'
    } while ($nextUri)

    Write-Log "Retrieved $($allScores.Count) secure score record(s) ($pageCount page(s))" 'INFO'

    if ($allScores.Count -eq 0) {
        Write-Log 'No Secure Score data returned — tenant may not have it enabled' 'WARN'
        @{
            error     = 'no_data'
            detail    = 'No Secure Score data available for this tenant'
            updatedAt = (Get-Date -Format 'o')
        } | ConvertTo-Json -Depth 3 | Out-File -FilePath $errorFile -Encoding UTF8 -Force
        return @{ Type = 'SecureScore'; Success = $false; BackedUp = 0; Failed = 0; Error = 'no_data' }
    }

    $scoreEntry = $allScores[0]

    $scoreOutput = [ordered]@{
        id                       = $scoreEntry.id
        azureTenantId            = $scoreEntry.azureTenantId
        activeUserCount          = $scoreEntry.activeUserCount
        createdDateTime          = $scoreEntry.createdDateTime
        currentScore             = $scoreEntry.currentScore
        maxScore                 = $scoreEntry.maxScore
        enabledServices          = $scoreEntry.enabledServices
        averageComparativeScores = $scoreEntry.averageComparativeScores
        controlScores            = $scoreEntry.controlScores
        backedUpAt               = (Get-Date -Format 'o')
    }

    $scoreOutput | ConvertTo-Json -Depth 10 | Out-File -FilePath $scoreFile -Encoding UTF8 -Force
    Clear-SecureScoreError
    Write-Log "Secure Score: $($scoreEntry.currentScore) / $($scoreEntry.maxScore)" 'INFO'

    # Write missing daily history files (idempotent — skips existing dates)
    $historyWritten = 0
    foreach ($entry in $allScores) {
        if (Write-HistoryFileIfMissing -Entry $entry -HistoryDir $historyDir) {
            $historyWritten++
        }
    }
    Write-Log "History backfill: $historyWritten new day(s) written, $($allScores.Count) record(s) from Graph" 'INFO'
}
catch {
    $errMsg = "$_"
    if ($errMsg -match '403|Forbidden|Authorization_RequestDenied|InsufficientPrivileges|AccessDenied') {
        Write-Log "Secure Score access denied (SecurityEvents.Read.All required): $errMsg" 'WARN'
        Write-SecureScoreError 'SecurityEvents.Read.All permission required for Secure Score'
        return @{ Type = 'SecureScore'; Success = $false; BackedUp = 0; Failed = 0; Error = 'access_denied' }
    }
    Write-Log "Failed to fetch Secure Score: $errMsg" 'ERROR'
    throw
}

# ── Prune old history files ───────────────────────────────────────────────────

$today  = (Get-Date).ToUniversalTime().Date
$cutoff = $today.AddDays(-$RetentionDays)
Get-ChildItem -Path $historyDir -Filter '????-??-??.json' -File |
    Where-Object {
        try {
            $fileDate = [datetime]::ParseExact($_.BaseName, 'yyyy-MM-dd', $null)
            $fileDate -lt $cutoff
        } catch { $false }
    } |
    ForEach-Object {
        Remove-Item -Path $_.FullName -Force
        Write-Log "Pruned old secure score history: $($_.Name)" 'DEBUG'
    }

# ── 2. Control Profiles (recommendations) ─────────────────────────────────────

Write-Log 'Fetching Secure Score control profiles...' 'INFO'

try {
    $controls = [System.Collections.Generic.List[object]]::new()
    $nextUri  = 'https://graph.microsoft.com/v1.0/security/secureScoreControlProfiles'
    $pageCount = 0
    do {
        $resp = Invoke-MgGraphRequest -Method GET -Uri $nextUri -OutputType PSObject
        $pageCount++
        if ($resp.value) { foreach ($item in $resp.value) { $controls.Add($item) } }
        $nextUri = $resp.'@odata.nextLink'
    } while ($nextUri)

    Write-Log "Retrieved $($controls.Count) control profiles ($pageCount page(s))" 'INFO'

    # Build a lookup of per-control current scores from the score entry.
    # Official controlScore schema: controlName, score, description, controlCategory.
    # No implementationStatus or scoreInPercentage exist in the v1.0 API.
    $controlScoreLookup = @{}
    if ($scoreEntry.controlScores) {
        foreach ($cs in $scoreEntry.controlScores) {
            if ($cs.controlName) {
                $controlScoreLookup[$cs.controlName] = @{
                    score       = $cs.score
                    description = $cs.description  # human-readable text e.g. "0/5 exposed devices"
                }
            }
        }
    }

    $controlsOutput = $controls | ForEach-Object {
        $c     = $_
        $live  = $controlScoreLookup[$c.id]

        # Compute clean status from score data (no implementationStatus field in v1.0 API)
        $computedStatus = if ($null -eq $live -or $null -eq $live.score) {
            'notApplicable'
        } elseif ([double]$live.score -ge [double]$c.maxScore -and [double]$c.maxScore -gt 0) {
            'scored'
        } else {
            'default'
        }

        [ordered]@{
            id                   = $c.id
            title                = $c.title
            controlCategory      = $c.controlCategory      # Identity, Device, Apps, Data, Infrastructure
            service              = $c.service
            maxScore             = $c.maxScore
            currentScore         = if ($live) { $live.score } else { $null }
            computedStatus       = $computedStatus          # scored | default | notApplicable
            statusDescription    = if ($live) { $live.description } else { $null }  # human-readable text
            controlStateUpdates  = $c.controlStateUpdates  # admin overrides: Ignored/ThirdParty/Reviewed
            actionType           = $c.actionType
            actionUrl            = $c.actionUrl
            tier                 = $c.tier                 # Defense, Advanced, etc.
            userImpact           = $c.userImpact
            implementationCost   = $c.implementationCost
            threats              = $c.threats
            remediation          = $c.remediation
            remediationImpact    = $c.remediationImpact
            complianceInformation = $c.complianceInformation
            rank                 = $c.rank
        }
    } | Sort-Object -Property rank

    @{
        backedUpAt = (Get-Date -Format 'o')
        count      = $controlsOutput.Count
        controls   = @($controlsOutput)
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $controlsFile -Encoding UTF8 -Force

    Write-Log "=== Secure Score Backup Complete === ($($controls.Count) controls, $historyWritten history day(s))" 'INFO'

    return @{
        Type     = 'SecureScore'
        Success  = $true
        BackedUp = 1
        Failed   = 0
        Score    = "$($scoreEntry.currentScore)/$($scoreEntry.maxScore)"
        Controls = $controls.Count
        History  = $historyWritten
    }
}
catch {
    $errMsg = "$_"
    if ($errMsg -match '403|Forbidden|Authorization_RequestDenied|InsufficientPrivileges|AccessDenied') {
        Write-Log "Control profiles access denied: $errMsg" 'WARN'
        Write-SecureScoreError 'SecurityEvents.Read.All permission required for Secure Score control profiles'
        return @{ Type = 'SecureScore'; Success = $false; BackedUp = 0; Failed = 0; Error = 'access_denied' }
    }
    Write-Log "Failed to fetch control profiles: $errMsg" 'ERROR'
    throw
}
