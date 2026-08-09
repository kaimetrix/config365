<#
.SYNOPSIS
    Post-processing step that translates all raw GUIDs in exported backup JSON files to named placeholders.

.DESCRIPTION
    This script runs AFTER all individual backup steps have completed. Because each pipeline step
    runs in an isolated PowerShell session, the group/location/filter caches are empty during
    individual backup steps and raw GUIDs end up in the exported files.

    This script loads all ID caches once, builds a flat GUID→placeholder lookup, then does a
    literal string replace on every exported JSON file:
      - Group IDs       → {{GROUP:displayName}}
      - Named locations → {{LOCATION:displayName}}
      - Intune filters  → {{FILTER:displayName}}
      - Tenant ID       → {{TENANTID}}
      - Exchange org    → {{exchangeOrgName}}

    GUIDs that are not in any cache (role template IDs, app IDs, SP IDs, deleted objects)
    are left as-is. No JSON parsing is performed — files are treated as raw text so the
    original formatting is always preserved.

.PARAMETER BackupPath
    The base directory containing all exported backup JSON files.

.PARAMETER DebugMode
    Enable verbose debug logging.

.EXAMPLE
    .\Resolve-BackupPlaceholders.ps1 -BackupPath "C:\backups"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,

    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

$ErrorActionPreference = "Stop"

# Load common module
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
. "$scriptDir\Backup-Common.ps1"

# Initialize logging (append to existing backup log if present)
$script:BackupPath = $BackupPath
$script:DebugMode  = $DebugMode

$logsDir = Join-Path $BackupPath "logs"
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
$existingLog = Get-ChildItem -Path $logsDir -Filter "backup-*.log" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($existingLog) {
    $script:LogFile = $existingLog.FullName
} else {
    $script:LogFile = Join-Path $logsDir "backup-$(Get-Date -Format 'yyyy-MM-dd_HHmmss').log"
}

Write-Log "=== Starting Placeholder Resolution ===" "INFO"
Write-Log "Backup path: $BackupPath" "INFO"

# Connect to Microsoft Graph
$connected = Connect-M365Backup
if (-not $connected) {
    Write-Log "Failed to connect to Microsoft Graph. Aborting placeholder resolution." "ERROR"
    throw "Connection failed"
}

# ============================================================
# Build all caches in a single session
# ============================================================

Write-Host "##[section]Building ID caches for placeholder resolution..."

Initialize-GroupCache | Out-Null
Write-Log "Group cache ready: $($script:GroupCache.Count) groups loaded" "INFO"

Initialize-NamedLocationCache | Out-Null
Write-Log "Named location cache ready: $($script:NamedLocationCache.Count) locations loaded" "INFO"

$script:FilterCache = @{}
try {
    $filters = Get-AllGraphResults -Uri "https://graph.microsoft.com/beta/deviceManagement/assignmentFilters" -Description "assignment filters"
    foreach ($filter in $filters) {
        $script:FilterCache[$filter.id] = $filter.displayName
    }
    Write-Log "Filter cache ready: $($script:FilterCache.Count) filters loaded" "INFO"
}
catch {
    Write-Log "Failed to build filter cache (continuing without filter translation): $_" "WARN"
}

# ============================================================
# Build a flat GUID → placeholder replacement map
# ============================================================

# Use an ordered dictionary so longer/more-specific entries don't accidentally
# shadow shorter ones (all GUIDs are the same length, so order doesn't matter
# for correctness, but ordered keeps logging deterministic).
$replacements = [ordered]@{}

if ($script:CurrentTenantId) {
    $replacements[$script:CurrentTenantId] = '{{TENANTID}}'
}
if ($env:EXCHANGE_ORG_NAME) {
    $replacements[$env:EXCHANGE_ORG_NAME] = '{{exchangeOrgName}}'
}
foreach ($kv in $script:GroupCache.GetEnumerator()) {
    $replacements[$kv.Key] = "{{GROUP:$($kv.Value)}}"
}
foreach ($kv in $script:NamedLocationCache.GetEnumerator()) {
    $replacements[$kv.Key] = "{{LOCATION:$($kv.Value)}}"
}
foreach ($kv in $script:FilterCache.GetEnumerator()) {
    $replacements[$kv.Key] = "{{FILTER:$($kv.Value)}}"
}

Write-Log "Replacement map: $($replacements.Count) entries total" "INFO"
Write-Host "##[section]All caches ready — scanning JSON files..."

# ============================================================
# Scan and translate all exported JSON files
# ============================================================

$jsonFiles = Get-ChildItem -Path $BackupPath -Recurse -Filter "*.json" |
    Where-Object { $_.Name -ne "backup-manifest.json" }

Write-Log "Found $($jsonFiles.Count) JSON files to process" "INFO"

$filesUpdated   = 0
$filesUnchanged = 0
$filesFailed    = 0

foreach ($file in $jsonFiles) {
    try {
        $content = Get-Content $file.FullName -Raw -Encoding UTF8
        $updated = $content

        # Literal string replace for each GUID — no JSON parsing, no reformatting.
        # GUIDs from Graph API are always lowercase so case-sensitive Replace() is fine.
        foreach ($kv in $replacements.GetEnumerator()) {
            $updated = $updated.Replace($kv.Key, $kv.Value)
        }

        if ($updated -ne $content) {
            $updated | Set-Content $file.FullName -Encoding UTF8 -NoNewline
            $filesUpdated++
            Write-Log "Updated: $($file.Name)" "DEBUG"
        }
        else {
            $filesUnchanged++
        }
    }
    catch {
        $filesFailed++
        Write-Log "Failed to process '$($file.FullName)': $_" "WARN"
    }
}

Write-Log "=== Placeholder Resolution Complete ===" "INFO"
Write-Log "Files updated:   $filesUpdated" "INFO"
Write-Log "Files unchanged: $filesUnchanged" "INFO"
if ($filesFailed -gt 0) {
    Write-Log "Files failed:    $filesFailed" "WARN"
    Write-Host "##vso[task.logissue type=warning]$filesFailed file(s) could not be processed during placeholder resolution"
}
Write-Host "##[section]Placeholder resolution complete: $filesUpdated updated, $filesUnchanged unchanged"

return @{
    FilesUpdated    = $filesUpdated
    FilesUnchanged  = $filesUnchanged
    FilesFailed     = $filesFailed
    GroupsCached    = $script:GroupCache.Count
    LocationsCached = $script:NamedLocationCache.Count
    FiltersCached   = $script:FilterCache.Count
}
