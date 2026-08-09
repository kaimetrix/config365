<#
.SYNOPSIS
    Restores backup files that went missing this run only because their item
    failed to fetch from Graph — not because it was actually deleted.

.DESCRIPTION
    The backup pipeline wipes the `backups/` tree clean at the start of every
    run and regenerates it from scratch, then stages/commits whatever differs
    (`git add -A backups/`). If a single item fails to fetch (transient
    Graph/Intune 5xx, throttling, a flaky sub-resource call, etc.) its backup
    file is simply never (re)written this run — which is indistinguishable,
    from git's point of view, from that item having been genuinely deleted
    from the tenant. Left unchecked, a one-off transient API error becomes a
    permanent "deleted" entry in the tenant's backup history.

    Each `Backup-*.ps1` script calls `Add-BackupItemFailure` (Backup-Common.ps1)
    when a per-item fetch fails, appending a JSON-Lines record to
    $env:BACKUP_FAILURES_FILE with the backup-relative path(s) that item would
    have written. This script reads that file and, for every recorded path
    that is currently staged as deleted (i.e. it existed in the previous
    commit but wasn't rewritten this run), restores it from HEAD — undoing
    the staged deletion so the previous known-good copy is kept instead.

    Genuine deletions (the item's list/fetch succeeded and it's simply gone)
    are completely unaffected: this only ever touches paths that were
    explicitly reported as failed this run.

    Run this after `git add -A <BackupPath>/` and before the commit — same
    convention as Skip-ReorderOnlyChanges.ps1, and safe to run either before
    or after it.

.PARAMETER BackupPath
    Relative path to the backup directory (e.g. "backups"). Must match the
    path used in `git add -A <BackupPath>/` earlier in the pipeline.

.PARAMETER FailuresFile
    Path to the JSON-Lines file written by Add-BackupItemFailure. Defaults to
    $env:BACKUP_FAILURES_FILE.

.EXAMPLE
    .\Protect-FailedBackupItems.ps1 -BackupPath "backups"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [string]$FailuresFile = $env:BACKUP_FAILURES_FILE
)

if (-not $FailuresFile -or -not (Test-Path $FailuresFile)) {
    Write-Host "##[command]No backup item failures recorded this run — nothing to protect."
    exit 0
}

$lines = @(Get-Content -Path $FailuresFile -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
if (-not $lines) {
    Write-Host "##[command]Failures file is empty — nothing to protect."
    exit 0
}

# Parse JSON-Lines, skipping any malformed line rather than failing the whole run
# (e.g. a rare interleaved write from two parallel batch workers).
$failures = @()
foreach ($line in $lines) {
    try { $failures += ($line | ConvertFrom-Json) }
    catch { Write-Host "##[warning]Skipping malformed backup-failure record: $line" }
}

if (-not $failures) {
    Write-Host "##[command]No parseable backup item failures — nothing to protect."
    exit 0
}

# De-duplicate paths (an item can fail more than once across retries/extensions)
$uniquePaths = @($failures | ForEach-Object { $_.Path } | Where-Object { $_ } | Sort-Object -Unique)
Write-Host "##[section]Checking $($uniquePaths.Count) path(s) reported as failed this run..."

# Staged deletions relative to the repo root (git add -A already ran)
$stagedDeleted = @(git diff --cached --name-only --diff-filter=D 2>&1)

$protected = 0
$skipped   = 0

foreach ($relPath in $uniquePaths) {
    $repoPath = ("$BackupPath/$relPath") -replace '\\', '/'

    if ($stagedDeleted -notcontains $repoPath) {
        # Not staged as deleted — either it was written successfully after all
        # (e.g. a retry inside the script succeeded), it never existed before
        # (genuinely new item, nothing to protect), or it's still present
        # unchanged. Nothing to do.
        $skipped++
        continue
    }

    # Confirm it actually existed in the previous commit before "restoring" it
    git show "HEAD:$repoPath" *>$null
    if ($LASTEXITCODE -ne 0) {
        $skipped++
        continue
    }

    # Restores the file in the working tree AND the index to match HEAD,
    # undoing the staged deletion in one step.
    git checkout HEAD -- "$repoPath" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $reason = ($failures | Where-Object { $_.Path -eq $relPath } | Select-Object -First 1).Reason
        Write-Host "##[warning]Protected from false deletion (fetch failed this run): $repoPath"
        if ($reason) { Write-Host "  Reason: $reason" }
        $protected++
    }
    else {
        Write-Host "##[warning]Could not restore '$repoPath' from HEAD — leaving as staged deletion."
        $skipped++
    }
}

Write-Host ""
Write-Host "##[section]Failed-item protection complete: $protected file(s) restored, $skipped path(s) needed no action."
