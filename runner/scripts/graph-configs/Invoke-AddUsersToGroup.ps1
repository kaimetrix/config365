<#
.SYNOPSIS
    One-off action: adds or removes Entra users from security groups using a
    pending-folder pattern (one JSON file per group).

.DESCRIPTION
    Scans two folders at the root of the tenant repo:
      pending-group-adds/    — each *.json queues users to ADD to a group
      pending-group-removes/ — each *.json queues users to REMOVE from a group

    Each file must contain:
      {
        "requestedAt":      "2026-05-13T...",
        "requestedBy":      "portal",
        "groupId":          "xxx-yyy-zzz",   (optional — resolved from name if absent)
        "groupDisplayName": "Compliant Users",
        "users": [                            (preferred format)
          { "id": "aaa", "upn": "alice@contoso.com", "displayName": "Alice" }
        ]
        -- OR legacy --
        "userIds": ["aaa", "bbb"]
      }

    After processing all files the script writes a consolidated result summary
    to -OutputPath. The pipeline's cleanup step subtracts only successfully
    processed users from each pending file (via sourceFile), leaving failed
    users and any users queued after Apply started.

    Result file shape:
    {
      "completedAt": "2026-05-13T...",
      "whatIf":      false,
      "actions": [
        {
          "mode":             "add",
          "sourceFile":       "pending-group-adds/Compliant-Users.json",
          "groupId":          "xxx",
          "groupDisplayName": "Compliant Users",
          "requestedAt":      "...",
          "requestedBy":      "portal",
          "totalRequested":   3,
          "added":            2,
          "removed":          0,
          "alreadyMember":    1,
          "notMember":        0,
          "failed":           0,
          "results": [...]
        }
      ]
    }

.PARAMETER TenantDir
    Root of the checked-out tenant repo (contains pending-group-adds/ etc.).

.PARAMETER OutputPath
    Path to write the consolidated result JSON.

.PARAMETER WhatIfMode
    Preview mode — log what would be done without calling the Graph API.

.EXAMPLE
    .\Invoke-AddUsersToGroup.ps1 `
        -TenantDir  "tenant" `
        -OutputPath "tenant/config/maintenance/group-action-last-run.json"

.NOTES
    Required delegated permissions:
      GroupMember.ReadWrite.All  — add/remove members from security groups
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [string]$TenantDir,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ── Import common Graph auth ──────────────────────────────────────────────────

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

# ── Validate ──────────────────────────────────────────────────────────────────

if (-not $TenantDir) { throw 'TenantDir is required.' }

$addDir    = Join-Path $TenantDir 'pending-group-adds'
$removeDir = Join-Path $TenantDir 'pending-group-removes'

$addFiles    = @(Get-ChildItem -Path $addDir    -Filter '*.json' -File -ErrorAction SilentlyContinue)
$removeFiles = @(Get-ChildItem -Path $removeDir -Filter '*.json' -File -ErrorAction SilentlyContinue)

if ($addFiles.Count -eq 0 -and $removeFiles.Count -eq 0) {
    Write-Host '[Invoke-AddUsersToGroup] No pending files found in pending-group-adds/ or pending-group-removes/'
    Write-Host '[Invoke-AddUsersToGroup] Nothing to do.'
    return
}

Write-Host "[Invoke-AddUsersToGroup] Found $($addFiles.Count) add file(s), $($removeFiles.Count) remove file(s)"
Write-Host "[Invoke-AddUsersToGroup] WhatIf: $WhatIfMode"

# ── Connect to Graph (once) ───────────────────────────────────────────────────

Connect-M365Graph | Out-Null

# ── Helper: process one request file ─────────────────────────────────────────

function Invoke-GroupMembership {
    param(
        [string]   $FilePath,
        [string]   $Mode        # 'add' or 'remove'
    )

    $request          = Get-Content $FilePath -Raw | ConvertFrom-Json
    $groupId          = $request.groupId
    $groupDisplayName = if ($request.groupDisplayName) { $request.groupDisplayName } else { $groupId }
    $requestedAt      = if ($request.requestedAt) { $request.requestedAt } else { '' }
    $requestedBy      = if ($request.requestedBy) { $request.requestedBy } else { '' }

    # Support new users[] format { id, upn, displayName } and legacy userIds[] format
    $users = if ($request.users -and @($request.users).Count -gt 0) {
        @($request.users)
    } else {
        @($request.userIds | ForEach-Object { [PSCustomObject]@{ id = $_; upn = $_; displayName = $null } })
    }

    if ($users.Count -eq 0) { Write-Warning "[Invoke-AddUsersToGroup] Skipping $FilePath — no users"; return $null }

    # Resolve groupId from display name if absent
    if (-not $groupId) {
        if (-not $groupDisplayName) { Write-Warning "[Invoke-AddUsersToGroup] Skipping $FilePath — missing both groupId and groupDisplayName"; return $null }
        Write-Host "[Invoke-AddUsersToGroup] groupId absent — resolving from display name '$groupDisplayName'..."
        try {
            $escaped    = $groupDisplayName -replace "'", "''"
            $resolveUri = "https://graph.microsoft.com/v1.0/groups?`$filter=displayName eq '$escaped'&`$select=id,displayName"
            $resolved   = Invoke-MgGraphRequest -Method GET -Uri $resolveUri -OutputType PSObject
            $groupId    = $resolved.value[0].id
            if (-not $groupId) { throw "No group found with displayName '$groupDisplayName'" }
            Write-Host "[Invoke-AddUsersToGroup] Resolved groupId: $groupId"
        } catch {
            Write-Warning "[Invoke-AddUsersToGroup] Skipping $FilePath — could not resolve groupId: $_"
            return $null
        }
    }

    Write-Host "[Invoke-AddUsersToGroup] [$Mode] Group : $groupDisplayName ($groupId)"
    Write-Host "[Invoke-AddUsersToGroup] [$Mode] Users : $($users.Count) requested"

    $results = [System.Collections.Generic.List[hashtable]]::new()
    $added   = 0; $removed = 0; $already = 0; $notMbr = 0; $failed = 0

    foreach ($user in $users) {
        $userId = $user.id
        $upn    = if ($user.upn -and $user.upn -ne $userId) { $user.upn } else { $userId }
        $label  = if ($user.displayName) { "$upn ($($user.displayName))" } else { $upn }

        if ($Mode -eq 'add') {
            $memberUri = "https://graph.microsoft.com/v1.0/directoryObjects/$userId"
            $addUri    = "https://graph.microsoft.com/v1.0/groups/$groupId/members/`$ref"
            $bodyJson  = @{ '@odata.id' = $memberUri } | ConvertTo-Json -Compress

            if ($WhatIfMode) {
                Write-Host "[WhatIf] Would ADD    $label  →  $groupDisplayName"
                $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'whatIf' })
                continue
            }

            try {
                Invoke-MgGraphRequest -Method POST -Uri $addUri -Body $bodyJson -ContentType 'application/json' | Out-Null
                Write-Host "[Invoke-AddUsersToGroup] Added   : $label"
                $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'added' })
                $added++
            }
            catch {
                $msg = "$_"
                if ($msg -match '409|One or more added object references already exist') {
                    Write-Host "[Invoke-AddUsersToGroup] Already : $label"
                    $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'alreadyMember' })
                    $already++
                } else {
                    Write-Warning "[Invoke-AddUsersToGroup] Failed  : $label — $msg"
                    $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'failed'; error = $msg })
                    $failed++
                }
            }

        } else {
            $removeUri = "https://graph.microsoft.com/v1.0/groups/$groupId/members/$userId/`$ref"

            if ($WhatIfMode) {
                Write-Host "[WhatIf] Would REMOVE $label  →  $groupDisplayName"
                $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'whatIf' })
                continue
            }

            try {
                Invoke-MgGraphRequest -Method DELETE -Uri $removeUri | Out-Null
                Write-Host "[Invoke-AddUsersToGroup] Removed : $label"
                $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'removed' })
                $removed++
            }
            catch {
                $msg = "$_"
                if ($msg -match '404|does not exist') {
                    Write-Host "[Invoke-AddUsersToGroup] NotMbr  : $label (not a member)"
                    $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'notMember' })
                    $notMbr++
                } else {
                    Write-Warning "[Invoke-AddUsersToGroup] Failed  : $label — $msg"
                    $results.Add(@{ userId = $userId; upn = $upn; displayName = $user.displayName; status = 'failed'; error = $msg })
                    $failed++
                }
            }
        }
    }

    Write-Host "[Invoke-AddUsersToGroup] [$Mode] Done — Added:$added Removed:$removed AlreadyMember:$already NotMember:$notMbr Failed:$failed"

    $tenantRoot = [System.IO.Path]::GetFullPath($TenantDir).TrimEnd('\', '/')
    $fullPath   = [System.IO.Path]::GetFullPath($FilePath)
    $sourceFile = if ($fullPath.StartsWith($tenantRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $fullPath.Substring($tenantRoot.Length).TrimStart('\', '/').Replace('\', '/')
    } else {
        Split-Path $FilePath -Leaf
    }

    return [ordered]@{
        mode             = $Mode
        sourceFile       = $sourceFile
        groupId          = $groupId
        groupDisplayName = $groupDisplayName
        requestedAt      = $requestedAt
        requestedBy      = $requestedBy
        totalRequested   = $users.Count
        added            = $added
        removed          = $removed
        alreadyMember    = $already
        notMember        = $notMbr
        failed           = $failed
        whatIf           = [bool]$WhatIfMode
        results          = @($results)
    }
}

# ── Process all pending files ─────────────────────────────────────────────────

$actions = [System.Collections.Generic.List[object]]::new()

foreach ($file in $addFiles) {
    $result = Invoke-GroupMembership -FilePath $file.FullName -Mode 'add'
    if ($null -ne $result) { $actions.Add($result) }
}

foreach ($file in $removeFiles) {
    $result = Invoke-GroupMembership -FilePath $file.FullName -Mode 'remove'
    if ($null -ne $result) { $actions.Add($result) }
}

# ── Write consolidated result ─────────────────────────────────────────────────

$summary = [ordered]@{
    completedAt = (Get-Date -Format 'o')
    whatIf      = [bool]$WhatIfMode
    actions     = @($actions)
}

if ($OutputPath) {
    $outputDir = Split-Path $OutputPath -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -Force
    Write-Host "[Invoke-AddUsersToGroup] Result written to: $OutputPath"
}

Write-Host "[Invoke-AddUsersToGroup] All done — $($actions.Count) group action(s) processed"
