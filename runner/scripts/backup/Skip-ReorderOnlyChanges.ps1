<#
.SYNOPSIS
    Un-stages JSON backup files whose only difference from the last commit is
    property ordering — i.e. semantically identical content.

.DESCRIPTION
    Runs after `git add -A <backupPath>/` and before the commit.
    For every staged-modified JSON file under the backup path it:
      1. Reads the working-tree content.
      2. Reads the previously committed content via `git show HEAD:<file>`.
      3. Normalises both by recursively sorting all object keys.
      4. If the normalised forms are identical, un-stages the file with
         `git restore --staged <file>` so it is not included in the commit.

    Added and deleted files are left untouched (only modified files are checked).

.PARAMETER BackupPath
    Relative path to the backup directory (e.g. "backups"). Must match the
    path used in `git add -A <BackupPath>/` earlier in the pipeline.

.EXAMPLE
    .\Skip-ReorderOnlyChanges.ps1 -BackupPath "backups"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BackupPath
)

# ─── Helper: recursively sort all object keys in a PSCustomObject / hashtable ─

function ConvertTo-NormalizedObject {
    param([Parameter(ValueFromPipeline)] $Value)

    process {
        if ($Value -is [System.Collections.IList]) {
            # Array — recurse into each element, preserve order
            return @($Value | ForEach-Object { ConvertTo-NormalizedObject $_ })
        }
        elseif ($Value -is [PSCustomObject]) {
            # Object — sort keys alphabetically then recurse into values
            $sorted = [ordered]@{}
            $Value.PSObject.Properties |
                Sort-Object Name |
                ForEach-Object { $sorted[$_.Name] = ConvertTo-NormalizedObject $_.Value }
            return [PSCustomObject]$sorted
        }
        else {
            return $Value
        }
    }
}

function Get-NormalizedJson {
    param([string]$JsonText)
    try {
        $obj = $JsonText | ConvertFrom-Json -Depth 100
        $normalized = ConvertTo-NormalizedObject $obj
        return $normalized | ConvertTo-Json -Depth 100 -Compress
    }
    catch {
        return $null
    }
}

# ─── Main ─────────────────────────────────────────────────────────────────────

# Collect staged-modified JSON files under the backup path
$stagedFiles = git diff --cached --name-only --diff-filter=M 2>&1 |
    Where-Object { $_ -like "$BackupPath/*.json" -or $_ -like "$BackupPath/**/*.json" }

if (-not $stagedFiles) {
    Write-Host "##[command]No staged modified JSON files under '$BackupPath' to check."
    exit 0
}

$skipped = 0
$kept    = 0

foreach ($file in $stagedFiles) {
    # Read working-tree version
    if (-not (Test-Path $file)) { $kept++; continue }
    $currentContent = Get-Content -Path $file -Raw -Encoding UTF8

    # Read last-committed version (may not exist if this is the very first commit)
    $previousContent = git show "HEAD:$file" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $previousContent) {
        $kept++
        continue
    }

    $currentNorm  = Get-NormalizedJson -JsonText $currentContent
    $previousNorm = Get-NormalizedJson -JsonText ($previousContent -join "`n")

    if ($null -ne $currentNorm -and $null -ne $previousNorm) {
        # JSON parsed successfully — compare semantically (ignores key ordering)
        if ($currentNorm -eq $previousNorm) {
            git restore --staged $file
            Write-Host "##[command]Skipped (reorder-only): $file"
            $skipped++
        }
        else {
            $kept++
        }
    }
    else {
        # JSON parse failed — fall back to raw line comparison (handles BOMs,
        # encoding artifacts, non-JSON content, etc.)
        $normalizeRaw = { param($s) ($s -replace "`r`n", "`n" -replace "`r", "`n").TrimEnd() }
        $curRaw  = & $normalizeRaw $currentContent
        $prevRaw = & $normalizeRaw ($previousContent -join "`n")
        if ($curRaw -eq $prevRaw) {
            git restore --staged $file
            Write-Host "##[command]Skipped (raw-identical): $file"
            $skipped++
        }
        else {
            $kept++
        }
    }
}

Write-Host ""
Write-Host "##[section]Reorder / identical check complete: $skipped file(s) un-staged, $kept file(s) kept."
