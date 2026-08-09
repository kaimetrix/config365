<#
.SYNOPSIS
    Resolves the extra baseline content (folders and files) that apply to a tenant
    based on its group memberships and the root groups-config.json.

.DESCRIPTION
    Reads:
      - <BaselinePath>/groups-config.json                        — group definitions and dynamic membership rules
      - <TenantRepoPath>/config/tenant-groups.json               — direct membership list (per-tenant source of truth)
      - <TenantRepoPath>/backups/licenses/subscribed-skus.json   — license data for dynamic rule evaluation (optional)

    Membership is resolved via Get-TenantGroupMembership (shared with Get-GroupExcludedFiles).

    For every group the tenant belongs to, collects:
      - content.folders   → extra baseline directory paths (relative to baseline/)
      - content.filePatterns → glob patterns matched against the baseline checkout

    Outputs a JSON object to stdout:
      {
        "MemberGroups": [ "MSP", "Entra ID P2", ... ],
        "ExtraFolders": [ "baseline/intune/platform-scripts-powershell/MSP", ... ],
        "ExtraFiles":   [ "baseline/intune/platform-scripts-powershell/MSP/Foo.MSP.json", ... ]
      }

    Sets pipeline variables (when running inside Azure DevOps):
      EXTRA_BASELINE_FOLDERS  — JSON-encoded array of extra folder paths
      EXTRA_BASELINE_FILES    — JSON-encoded array of extra individual file paths

.PARAMETER BaselinePath
    Path to the checked-out baseline repository root.

.PARAMETER TenantRepoPath
    Path to the checked-out tenant repository root.

.PARAMETER OutputPath
    Optional path to write the JSON output file.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $BaselinePath,
    [Parameter(Mandatory)][string] $TenantRepoPath,
    [string] $OutputPath,
    [string] $TenantSlug = $env:TENANT_SLUG
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Common-TenantGroups.ps1')

function Write-EmptyTenantGroupsResult {
    param([string] $OutputPath)
    $result = @{
        MemberGroups = @()
        ExtraFolders = @()
        ExtraFiles   = @()
    }
    $json = $result | ConvertTo-Json -Depth 5
    if ($OutputPath) { $json | Set-Content -Path $OutputPath -Encoding UTF8 }
    Write-Host $json
    Write-Host "##vso[task.setvariable variable=EXTRA_BASELINE_FOLDERS]$($result.ExtraFolders | ConvertTo-Json -Compress)"
    Write-Host "##vso[task.setvariable variable=EXTRA_BASELINE_FILES]$($result.ExtraFiles | ConvertTo-Json -Compress)"
}

$groupsConfigPath = Join-Path $BaselinePath 'groups-config.json'
if (-not (Test-Path $groupsConfigPath)) {
    Write-Host "##[section]Resolve-TenantGroups: No groups-config.json found at '$groupsConfigPath' — skipping group resolution"
    Write-EmptyTenantGroupsResult -OutputPath $OutputPath
    return
}

$groupsConfig = Get-Content $groupsConfigPath -Raw | ConvertFrom-Json
if ($groupsConfig.PSObject.Properties['groups'] -and $groupsConfig.groups -is [PSCustomObject]) {
    $groupsConfig = $groupsConfig.groups
}

$tenantGroups = @(Get-TenantGroupMembership -BaselinePath $BaselinePath -TenantRepoPath $TenantRepoPath -TenantSlug $TenantSlug)

# ─── Resolve extra content ────────────────────────────────────────────────────
$extraFolders = [System.Collections.Generic.List[string]]::new()
$extraFiles   = [System.Collections.Generic.List[string]]::new()

foreach ($groupName in $tenantGroups) {
    $groupDef = $groupsConfig.$groupName
    if ($null -eq $groupDef) {
        Write-Warning "Resolve-TenantGroups: Group '$groupName' not found in groups-config.json — skipping"
        continue
    }

    Write-Host "  Processing group: $groupName ($($groupDef.displayName))"

    $folders = @($groupDef.content.folders)
    foreach ($folder in $folders) {
        if ([string]::IsNullOrWhiteSpace($folder)) { continue }
        $fullFolderPath = Join-Path $BaselinePath 'baseline' $folder
        if (Test-Path $fullFolderPath -PathType Container) {
            $normalized = $fullFolderPath.Replace('\', '/')
            if (-not $extraFolders.Contains($normalized)) {
                $extraFolders.Add($normalized)
                Write-Host "    + Extra folder: $normalized"
            }
        }
        else {
            Write-Warning "    Folder '$fullFolderPath' does not exist in baseline checkout — skipping"
        }
    }

    $patterns = @($groupDef.content.filePatterns)
    foreach ($pattern in $patterns) {
        if ([string]::IsNullOrWhiteSpace($pattern)) { continue }

        $baselineContentPath = Join-Path $BaselinePath 'baseline'
        Write-Host "    Searching pattern '$pattern' under '$baselineContentPath'"

        $matchedFiles = Get-ChildItem -Path $baselineContentPath -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $rel = $_.FullName.Replace('\', '/').Replace(($baselineContentPath.Replace('\', '/') + '/'), '')
                $rel -like $pattern
            }

        foreach ($file in $matchedFiles) {
            $normalized = $file.FullName.Replace('\', '/')
            if (-not $extraFiles.Contains($normalized)) {
                $extraFiles.Add($normalized)
                Write-Verbose "    + Extra file: $normalized"
            }
        }
        Write-Host "    Pattern '$pattern' matched $($matchedFiles.Count) file(s)"
    }

    $directFiles = @($groupDef.content.files)
    foreach ($filePath in $directFiles) {
        if ([string]::IsNullOrWhiteSpace($filePath)) { continue }
        $fullPath = (Join-Path $BaselinePath 'baseline' $filePath).Replace('\', '/')
        if ((Test-Path $fullPath -PathType Leaf) -and -not $extraFiles.Contains($fullPath)) {
            $extraFiles.Add($fullPath)
            Write-Verbose "    + Extra file (direct): $fullPath"
        }
        elseif (-not (Test-Path $fullPath -PathType Leaf)) {
            Write-Warning "    Direct file '$fullPath' does not exist in baseline checkout — skipping"
        }
    }
    if ($directFiles.Count -gt 0) {
        Write-Host "    Direct files: $($directFiles.Count) entry(ies) in content.files"
    }
}

# ─── Output results ───────────────────────────────────────────────────────────
$result = @{
    MemberGroups = @($tenantGroups)
    ExtraFolders = @($extraFolders)
    ExtraFiles   = @($extraFiles)
}

$json = $result | ConvertTo-Json -Depth 5
if ($OutputPath) {
    $json | Set-Content -Path $OutputPath -Encoding UTF8
    Write-Host "##[section]Resolve-TenantGroups: Written to $OutputPath"
}

Write-Host $json

$foldersJson = ($result.ExtraFolders | ConvertTo-Json -Compress)
$filesJson   = ($result.ExtraFiles   | ConvertTo-Json -Compress)
Write-Host "##vso[task.setvariable variable=EXTRA_BASELINE_FOLDERS]$foldersJson"
Write-Host "##vso[task.setvariable variable=EXTRA_BASELINE_FILES]$filesJson"

Write-Host "##[section]Resolve-TenantGroups: Member group(s): $($tenantGroups -join ', '); $($extraFolders.Count) extra folder(s), $($extraFiles.Count) extra file(s)"
