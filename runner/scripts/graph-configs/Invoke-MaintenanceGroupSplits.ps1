<#
.SYNOPSIS
    Splits an Entra group's members into child groups based on configured percentages.

.DESCRIPTION
    Reads a maintenance configuration from the baseline repo and/or tenant repo. For each
    configured group split, the script:
      1. Retrieves all members of the source group.
      2. Ensures each target group exists in Entra (creates it if absent, writes back the
         resolved groupId to the tenant config).
      3. Rebalances membership with minimal moves: existing correct assignments are kept;
         only devices that need to change groups (stale removals, overflow, unassigned) are
         moved. Devices removed from the source group are removed from all child groups.
      4. Applies Graph member additions and removals in batches.

    Supports -WhatIfMode to preview all changes without writing to Graph or Git.

.PARAMETER BaselineConfigDir
    Path to the directory containing baseline/group-splits.json (the maintenance/ folder
    checked out from the baseline repo).

.PARAMETER TenantConfigDir
    Path to the directory containing config/maintenance/group-splits.json in the tenant repo.
    If both baseline and tenant configs are present, tenant entries override baseline entries
    that share the same split id.

.PARAMETER TenantName
    The tenant name — used in log messages and when writing back resolved group IDs.

.PARAMETER OutputPath
    Optional path for a JSON summary of planned/applied changes (used by the pipeline to
    publish a combined plan artifact).

.PARAMETER WhatIfMode
    Preview intended changes without calling any Graph write operations.

.EXAMPLE
    .\Invoke-MaintenanceGroupSplits.ps1 `
        -BaselineConfigDir "baseline/maintenance" `
        -TenantConfigDir   "Tenant-repo/config/maintenance" `
        -TenantName        "contoso" `
        -WhatIfMode

.NOTES
    Required Microsoft Graph permissions:
      GroupMember.ReadWrite.All  (read + manage group membership)
      Group.ReadWrite.All        (create groups when they don't exist)

    Required PowerShell modules: Microsoft.Graph.Authentication, Microsoft.Graph.Groups
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $false)]
    [string]$BaselineConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantConfigDir,

    [Parameter(Mandatory = $false)]
    [string]$TenantName = '',

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ============================================================================
# CONSTANTS
# ============================================================================

$GRAPH_BASE      = 'https://graph.microsoft.com/v1.0'
$GRAPH_BETA      = 'https://graph.microsoft.com/beta'
$BATCH_ADD_SIZE  = 20   # Graph batch add limit per request

$NEW_GROUP_MAX_WAIT_SECONDS  = 60  # max seconds to wait for a newly created group to be reachable
$NEW_GROUP_POLL_INTERVAL_SECONDS = 5

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

# ============================================================================
# GRAPH HELPER FUNCTIONS
# ============================================================================

function Invoke-GraphRequest {
    param(
        [string]$Method = 'GET',
        [string]$Uri,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )
    # Use the SDK's own request cmdlet rather than manually extracting a bearer token.
    # (Get-MgContext).AuthContext.AccessToken / Get-MgAccessToken are NOT reliable ways to
    # get a raw token in current Microsoft.Graph.Authentication versions — Get-MgContext
    # does not expose an AuthContext/AccessToken property and Get-MgAccessToken is not
    # exported at all in the installed SDK version. Invoke-MgGraphRequest uses the SDK's
    # internal auth provider (populated by Connect-MgGraph) directly, so no token
    # extraction is needed.
    $params = @{ Uri = $Uri; Method = $Method; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    return Invoke-MgGraphRequest @params
}

function Get-AllPages {
    param([string]$Uri)
    $results = [System.Collections.Generic.List[object]]::new()
    $next    = $Uri
    while ($next) {
        $page = Invoke-GraphRequest -Uri $next
        if ($page.value) { $results.AddRange($page.value) }
        $next = $page.'@odata.nextLink'
    }
    return $results
}

# ============================================================================
# AUTHENTICATION
# ============================================================================

$requiredModules = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Groups')
Write-Host "`nChecking required PowerShell modules..."
foreach ($module in $requiredModules) {
    if (-not (Get-Module -ListAvailable -Name $module)) {
        Write-Host "  Installing module: $module"
        Install-Module -Name $module -Force -AllowClobber -Scope CurrentUser
    }
    Import-Module $module -ErrorAction SilentlyContinue
    Write-Host "  Loaded: $module"
}

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# LOAD AND MERGE CONFIGURATION
# ============================================================================

Write-Host "`n##[section]Loading maintenance configuration"

function Read-GroupSplitsFile {
    param([string]$Dir)
    if (-not $Dir -or -not (Test-Path $Dir)) { return @() }
    $path = Join-Path $Dir 'group-splits.json'
    if (-not (Test-Path $path)) {
        Write-Host "  No group-splits.json found in: $Dir" -ForegroundColor DarkGray
        return @()
    }
    try {
        $parsed = Get-Content $path -Raw | ConvertFrom-Json
        $splits = @($parsed.groupSplits)
        Write-Host "  Loaded $($splits.Count) split(s) from: $path"
        return $splits
    } catch {
        Write-Host "  Warning: Failed to parse $path — $_" -ForegroundColor Yellow
        return @()
    }
}

$baselineSplits = Read-GroupSplitsFile -Dir $BaselineConfigDir
$tenantSplits   = Read-GroupSplitsFile -Dir $TenantConfigDir

# Merge: baseline provides defaults; tenant entries with the same id override them
$splitMap = [ordered]@{}
foreach ($s in $baselineSplits) { if ($s.id) { $splitMap[$s.id] = $s } }
foreach ($s in $tenantSplits)   { if ($s.id) { $splitMap[$s.id] = $s } }

$allSplits = @($splitMap.Values)

if ($allSplits.Count -eq 0) {
    Write-Host "No group split rules found. Nothing to do." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{ Service = 'MaintenanceGroupSplits'; Timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); WhatIfMode = [bool]$WhatIfMode; Results = @() } |
            ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Total group split rules to process: $($allSplits.Count)"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

function Resolve-GroupById {
    param([string]$GroupId)
    try {
        return Invoke-GraphRequest -Uri "$GRAPH_BASE/groups/$GroupId`?`$select=id,displayName"
    } catch {
        return $null
    }
}

function Find-GroupByName {
    param([string]$DisplayName)
    $encoded = [Uri]::EscapeDataString("displayName eq '$DisplayName'")
    $result  = Invoke-GraphRequest -Uri "$GRAPH_BASE/groups?`$filter=$encoded&`$select=id,displayName"
    return $result.value | Select-Object -First 1
}

function Get-GroupMembers {
    param([string]$GroupId)
    $sel = 'id,displayName,deviceId,trustType,approximateLastSignInDateTime,operatingSystem,isManaged,assignedLicenses,signInActivity'
    return @(Get-AllPages -Uri "$GRAPH_BASE/groups/$GroupId/members?`$select=$sel&`$top=999")
}

function Test-FilterRule {
    <#
    .SYNOPSIS
        Evaluates a single filter rule against a member object.
        Returns $true if the member matches, $false otherwise.
        Null/missing properties are treated as non-matching.
    #>
    param(
        [object]$Member,
        [object]$Rule
    )

    $field    = $Rule.field
    $operator = $Rule.operator
    $value    = $Rule.value
    $now      = [datetime]::UtcNow

    switch ($field) {

        'trustType' {
            $actual = $Member.trustType
            if ($null -eq $actual) { return $false }
            if ($operator -eq 'eq')  { return ($actual -ieq $value) }
            if ($operator -eq 'neq') { return ($actual -ine $value) }
            return $false
        }

        'lastActivity' {
            $actual = $Member.approximateLastSignInDateTime
            if ($null -eq $actual) { return $false }
            $days = [int]$value
            $cutoff = $now.AddDays(-$days)
            $dt = [datetime]$actual
            if ($operator -eq 'withinDays')    { return ($dt -ge $cutoff) }
            if ($operator -eq 'notWithinDays') { return ($dt -lt $cutoff) }
            return $false
        }

        'osType' {
            $actual = $Member.operatingSystem
            if ($null -eq $actual) { return $false }
            if ($operator -eq 'eq')  { return ($actual -ieq $value) }
            if ($operator -eq 'neq') { return ($actual -ine $value) }
            return $false
        }

        'mdmManaged' {
            $actual = $Member.isManaged
            # null treated as false (device not known to be managed)
            $actualBool = ($null -ne $actual) -and ([bool]$actual -eq $true)
            $valueBool  = ($value -eq $true) -or ($value -ieq 'true')
            if ($operator -in 'eq','withinDays')    { return ($actualBool -eq $valueBool) }
            if ($operator -in 'neq','notWithinDays') { return ($actualBool -ne $valueBool) }
            return $false
        }

        'lastSignIn' {
            # Requires AuditLog.Read.All — signInActivity may be null
            $activity = $Member.signInActivity
            if ($null -eq $activity) {
                Write-Verbose "  [filter] lastSignIn: signInActivity is null (AuditLog.Read.All may not be granted) — skipping member"
                return $false
            }
            $lastSignIn = $activity.lastSignInDateTime
            if ($null -eq $lastSignIn) { return $false }
            $days   = [int]$value
            $cutoff = $now.AddDays(-$days)
            $dt     = [datetime]$lastSignIn
            if ($operator -eq 'withinDays')    { return ($dt -ge $cutoff) }
            if ($operator -eq 'notWithinDays') { return ($dt -lt $cutoff) }
            return $false
        }

        'hasLicense' {
            $licenses  = $Member.assignedLicenses
            $hasLic    = ($null -ne $licenses) -and ($licenses.Count -gt 0)
            $valueBool = ($value -eq $true) -or ($value -ieq 'true')
            if ($operator -in 'eq','withinDays')    { return ($hasLic -eq $valueBool) }
            if ($operator -in 'neq','notWithinDays') { return ($hasLic -ne $valueBool) }
            return $false
        }

        default {
            Write-Verbose "  [filter] Unknown filter field '$field' — skipping"
            return $false
        }
    }
}

function Test-FilterGroup {
    <#
    .SYNOPSIS
        Evaluates all rules in a filter group against a member.
        group.operator ('and'|'or') determines how rules are combined.
    #>
    param(
        [object]$Member,
        [object]$Group
    )

    $op    = if ($Group.operator) { $Group.operator } else { 'and' }
    $rules = @($Group.rules)

    if ($rules.Count -eq 0) { return $true }

    foreach ($rule in $rules) {
        $match = Test-FilterRule -Member $Member -Rule $rule
        if ($op -eq 'or'  -and $match)  { return $true  }
        if ($op -eq 'and' -and -not $match) { return $false }
    }

    return ($op -eq 'and')
}

function Invoke-MemberFilters {
    <#
    .SYNOPSIS
        Filters a list of members according to a MemberFilters config object.
        filters.groupOperator ('and'|'or') determines how groups are combined.
    #>
    param(
        [object[]]$Members,
        [object]$Filters
    )

    $groupOp = if ($Filters.groupOperator) { $Filters.groupOperator } else { 'and' }
    $groups  = @($Filters.groups)

    if ($groups.Count -eq 0) { return $Members }

    $passed = [System.Collections.Generic.List[object]]::new()

    foreach ($member in $Members) {
        $memberMatch = $null

        foreach ($group in $groups) {
            $groupMatch = Test-FilterGroup -Member $member -Group $group

            if ($groupOp -eq 'or') {
                if ($groupMatch) { $memberMatch = $true; break }
                $memberMatch = $false
            } else {
                # and
                if (-not $groupMatch) { $memberMatch = $false; break }
                $memberMatch = $true
            }
        }

        if ($memberMatch) { $passed.Add($member) }
    }

    return @($passed)
}

function Ensure-Group {
    param(
        [string]$DisplayName,
        [string]$ExistingGroupId
    )

    if ($ExistingGroupId) {
        $existing = Resolve-GroupById -GroupId $ExistingGroupId
        if ($existing) { return $existing }
        Write-Host "    Stored groupId $ExistingGroupId is invalid; searching by name..." -ForegroundColor Yellow
    }

    $existing = Find-GroupByName -DisplayName $DisplayName
    if ($existing) {
        Write-Host "    Found existing group '$DisplayName' ($($existing.id))"
        return $existing
    }

    if ($WhatIfMode) {
        Write-Host "    WouldCreate group: '$DisplayName'" -ForegroundColor Green
        return [PSCustomObject]@{ id = "would-create-$([System.Guid]::NewGuid())"; displayName = $DisplayName }
    }

    Write-Host "    Creating group: '$DisplayName'" -ForegroundColor Green
    $body = @{
        displayName     = $DisplayName
        mailEnabled     = $false
        mailNickname    = ($DisplayName -replace '[^a-zA-Z0-9]', '') + (Get-Random -Maximum 9999)
        securityEnabled = $true
    }
    $created = Invoke-GraphRequest -Method POST -Uri "$GRAPH_BASE/groups" -Body $body
    Write-Host "    Created group '$DisplayName' with ID: $($created.id)"
    # Poll until the group is reachable (Entra ID eventual consistency)
    $waited = 0
    while ($waited -lt $NEW_GROUP_MAX_WAIT_SECONDS) {
        Start-Sleep -Seconds $NEW_GROUP_POLL_INTERVAL_SECONDS
        $waited += $NEW_GROUP_POLL_INTERVAL_SECONDS
        $check = Resolve-GroupById -GroupId $created.id
        if ($check) {
            Write-Host "    Group '$DisplayName' is now reachable (waited ${waited}s)" -ForegroundColor DarkGray
            return $check
        }
        Write-Host "    Waiting for group replication... (${waited}s elapsed)" -ForegroundColor DarkGray
    }
    Write-Host "    Warning: Group '$DisplayName' not reachable after ${waited}s — proceeding anyway" -ForegroundColor Yellow
    return $created
}

function Add-GroupMembers {
    param([string]$GroupId, [string[]]$MemberIds)
    if (-not $MemberIds -or $MemberIds.Count -eq 0) { return }
    # Graph supports up to 20 members per PATCH request
    for ($i = 0; $i -lt $MemberIds.Count; $i += $BATCH_ADD_SIZE) {
        $batch = $MemberIds[$i..([Math]::Min($i + $BATCH_ADD_SIZE - 1, $MemberIds.Count - 1))]
        $refs  = $batch | ForEach-Object { "https://graph.microsoft.com/v1.0/directoryObjects/$_" }
        Invoke-GraphRequest -Method PATCH -Uri "$GRAPH_BASE/groups/$GroupId" -Body @{
            'members@odata.bind' = @($refs)
        } | Out-Null
        Write-Host "    Added $($batch.Count) member(s) to group $GroupId"
    }
}

function Remove-GroupMember {
    param([string]$GroupId, [string]$MemberId)
    Invoke-GraphRequest -Method DELETE -Uri "$GRAPH_BASE/groups/$GroupId/members/$MemberId/`$ref" | Out-Null
}

# ============================================================================
# REBALANCE FUNCTION
# ============================================================================

function Invoke-GroupSplitRebalance {
    param(
        [object]$Split,
        [ref]$ResolvedGroupIds   # hashtable: splitId -> array of resolved target groupIds (for writeback)
    )

    $splitId   = $Split.id
    $splitName = if ($Split.displayName) { $Split.displayName.Trim() } else { $splitId }
    if ($Split.sourceGroupName) { $Split.sourceGroupName = $Split.sourceGroupName.Trim() }

    Write-Host "`n--- Split: $splitName ---" -ForegroundColor Cyan

    # ── Resolve source group ──────────────────────────────────────────────────
    $sourceId = $Split.sourceGroupId
    if (-not $sourceId) {
        if (-not $Split.sourceGroupName) {
            Write-Host "  ERROR: Split '$splitId' has no sourceGroupId or sourceGroupName — skipping." -ForegroundColor Red
            return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Error'; Error = 'No source group configured' }
        }
        Write-Host "  Resolving source group by name: $($Split.sourceGroupName)"
        $sourceGroup = Find-GroupByName -DisplayName $Split.sourceGroupName
        if (-not $sourceGroup) {
            Write-Host "  ERROR: Source group '$($Split.sourceGroupName)' not found." -ForegroundColor Red
            return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Error'; Error = "Source group '$($Split.sourceGroupName)' not found" }
        }
        $sourceId = $sourceGroup.id
    }

    Write-Host "  Source group ID: $sourceId"

    # ── Get source group membership ───────────────────────────────────────────
    Write-Host "  Fetching source group members..."
    $sourceMembers = Get-GroupMembers -GroupId $sourceId
    Write-Host "  Source members (total): $($sourceMembers.Count)"

    # ── Apply member filters (if configured) ─────────────────────────────────
    if ($Split.PSObject.Properties['filters'] -and $null -ne $Split.filters -and @($Split.filters.groups).Count -gt 0) {
        $beforeFilter = $sourceMembers.Count
        $sourceMembers = Invoke-MemberFilters -Members $sourceMembers -Filters $Split.filters
        Write-Host "  Member filters applied: $beforeFilter → $($sourceMembers.Count) members after filtering"
    }

    $sourceMemberIds = @($sourceMembers | Select-Object -ExpandProperty id)
    $sourceMemberSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$sourceMemberIds, [System.StringComparer]::OrdinalIgnoreCase)
    Write-Host "  Source members (after filters): $($sourceMemberIds.Count)"

    # ── Resolve and ensure target groups ─────────────────────────────────────
    $targetGroups = @($Split.targetGroups)
    if (-not $targetGroups -or $targetGroups.Count -eq 0) {
        Write-Host "  WARNING: Split '$splitId' has no target groups — skipping." -ForegroundColor Yellow
        return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Skipped'; Error = 'No target groups configured' }
    }

    $totalPct = ($targetGroups | Measure-Object -Property percentage -Sum).Sum
    if ($totalPct -gt 100) {
        Write-Host "  ERROR: Target percentages sum to $totalPct%% (> 100%%) — skipping." -ForegroundColor Red
        return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Error'; Error = "Percentages sum to $totalPct%% (> 100%%)" }
    }

    $resolvedTargets = [System.Collections.Generic.List[hashtable]]::new()
    $resolvedIds     = [System.Collections.Generic.List[string]]::new()

    foreach ($tg in $targetGroups) {
        if ($tg.name) { $tg.name = $tg.name.Trim() }
        $grp = Ensure-Group -DisplayName $tg.name -ExistingGroupId $tg.groupId
        if (-not $grp) {
            Write-Host "  ERROR: Could not resolve/create target group '$($tg.name)' — skipping split." -ForegroundColor Red
            return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Error'; Error = "Could not resolve target group '$($tg.name)'" }
        }
        $target = [int][Math]::Floor($sourceMemberIds.Count * $tg.percentage / 100)
        $resolvedTargets.Add(@{
            GroupId     = $grp.id
            Name        = $tg.name
            Percentage  = $tg.percentage
            TargetCount = $target
        })
        $resolvedIds.Add($grp.id)
        Write-Host "  Target: '$($tg.name)' ($($tg.percentage)%%) → $target of $($sourceMemberIds.Count) members"
    }

    $ResolvedGroupIds.Value[$splitId] = $resolvedIds.ToArray()

    # ── Get current membership of each target group ───────────────────────────
    Write-Host "  Fetching current child group memberships..."
    $childCurrentMembers = @{}  # groupId -> [string[]] memberIds currently in that group
    foreach ($tg in $resolvedTargets) {
        if ($WhatIfMode -and $tg.GroupId -like 'would-create-*') {
            $childCurrentMembers[$tg.GroupId] = @()
            continue
        }
        $members = Get-GroupMembers -GroupId $tg.GroupId
        $childCurrentMembers[$tg.GroupId] = @($members | Select-Object -ExpandProperty id)
    }

    # ── Determine assignments ─────────────────────────────────────────────────
    # All child group assignments indexed by member ID
    $memberCurrentGroup = @{}  # memberId -> groupId (which target group it currently belongs to, first match wins)
    foreach ($tg in $resolvedTargets) {
        foreach ($mId in $childCurrentMembers[$tg.GroupId]) {
            if (-not $memberCurrentGroup.ContainsKey($mId)) {
                $memberCurrentGroup[$mId] = $tg.GroupId
            }
        }
    }

    # ── Step 1: Remove members no longer in the source group ─────────────────
    $toRemove = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new()
    foreach ($tg in $resolvedTargets) {
        $removeList = [System.Collections.Generic.List[string]]::new()
        foreach ($mId in $childCurrentMembers[$tg.GroupId]) {
            if (-not $sourceMemberSet.Contains($mId)) {
                $removeList.Add($mId)
            }
        }
        if ($removeList.Count -gt 0) {
            $toRemove[$tg.GroupId] = $removeList
            Write-Host "  Will remove $($removeList.Count) stale member(s) from '$($tg.Name)'"
        }
    }

    # ── Step 2: Calculate current valid membership per target ─────────────────
    # "valid" = still in source group
    $childValidMembers = @{}
    foreach ($tg in $resolvedTargets) {
        $valid = @($childCurrentMembers[$tg.GroupId] | Where-Object { $sourceMemberSet.Contains($_) })
        $childValidMembers[$tg.GroupId] = [System.Collections.Generic.List[string]]::new([string[]]$valid)
    }

    # ── Step 3: Identify overflow and deficit ─────────────────────────────────
    $excessPool = [System.Collections.Generic.List[string]]::new()
    $assignedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($tg in $resolvedTargets) {
        $currentValid = $childValidMembers[$tg.GroupId]
        $target       = $tg.TargetCount

        if ($currentValid.Count -gt $target) {
            # Over-filled: keep the first targetCount, move the rest to the excess pool
            $excess = $currentValid[$target..($currentValid.Count - 1)]
            foreach ($eId in $excess) { $excessPool.Add($eId) }
            # Trim to target
            while ($childValidMembers[$tg.GroupId].Count -gt $target) {
                $childValidMembers[$tg.GroupId].RemoveAt($childValidMembers[$tg.GroupId].Count - 1)
            }
        }

        foreach ($mId in $childValidMembers[$tg.GroupId]) { $assignedSet.Add($mId) | Out-Null }
    }

    # ── Step 4: Collect unassigned source members ─────────────────────────────
    $unassigned = [System.Collections.Generic.List[string]]::new()
    foreach ($mId in $sourceMemberIds) {
        if (-not $assignedSet.Contains($mId)) { $unassigned.Add($mId) }
    }

    # Merge unassigned + excess as the pool to distribute
    $pool = [System.Collections.Generic.List[string]]::new([string[]]$unassigned.ToArray())
    foreach ($eId in $excessPool) { $pool.Add($eId) }

    # ── Step 5: Fill under-filled target groups from pool ─────────────────────
    $toAdd = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new()
    $toAddFromTarget = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new()

    foreach ($tg in $resolvedTargets) {
        $currentValid  = $childValidMembers[$tg.GroupId]
        $needed        = $tg.TargetCount - $currentValid.Count
        $addList       = [System.Collections.Generic.List[string]]::new()
        $removeFromExcess = [System.Collections.Generic.List[string]]::new()

        while ($needed -gt 0 -and $pool.Count -gt 0) {
            $memberId = $pool[0]
            $pool.RemoveAt(0)
            $addList.Add($memberId)
            $currentValid.Add($memberId)
            $needed--
        }

        if ($addList.Count -gt 0) {
            # Determine which adds are genuinely new (not already in this group)
            $existingInGroup = [System.Collections.Generic.HashSet[string]]::new([string[]]$childCurrentMembers[$tg.GroupId], [System.StringComparer]::OrdinalIgnoreCase)
            $newAdds = @($addList | Where-Object { -not $existingInGroup.Contains($_) })
            if ($newAdds.Count -gt 0) {
                $toAdd[$tg.GroupId] = [System.Collections.Generic.List[string]]::new([string[]]$newAdds)
                Write-Host "  Will add $($newAdds.Count) member(s) to '$($tg.Name)'"
            }
        }
    }

    # Also compute removals for overflow (members that were previously in this group but are now in excess)
    foreach ($tg in $resolvedTargets) {
        $finalMembers   = [System.Collections.Generic.HashSet[string]]::new([string[]]$childValidMembers[$tg.GroupId], [System.StringComparer]::OrdinalIgnoreCase)
        $currentInGroup = $childCurrentMembers[$tg.GroupId]
        $removeOverflow = @($currentInGroup | Where-Object { $sourceMemberSet.Contains($_) -and -not $finalMembers.Contains($_) })
        if ($removeOverflow.Count -gt 0) {
            if (-not $toRemove.ContainsKey($tg.GroupId)) { $toRemove[$tg.GroupId] = [System.Collections.Generic.List[string]]::new() }
            foreach ($rId in $removeOverflow) { $toRemove[$tg.GroupId].Add($rId) }
            Write-Host "  Will remove $($removeOverflow.Count) overflow member(s) from '$($tg.Name)'"
        }
    }

    # ── Calculate totals ──────────────────────────────────────────────────────
    $totalAdds    = ($toAdd.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum ?? 0
    $totalRemoves = ($toRemove.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum ?? 0

    if ($totalAdds -eq 0 -and $totalRemoves -eq 0) {
        Write-Host "  No changes needed for '$splitName'" -ForegroundColor DarkGray
        return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'NoChanges'; Adds = 0; Removes = 0 }
    }

    Write-Host "  Changes: +$totalAdds additions, -$totalRemoves removals"

    if ($WhatIfMode) {
        foreach ($tg in $resolvedTargets) {
            $adds    = if ($toAdd.ContainsKey($tg.GroupId))    { $toAdd[$tg.GroupId].Count }    else { 0 }
            $removes = if ($toRemove.ContainsKey($tg.GroupId)) { $toRemove[$tg.GroupId].Count } else { 0 }
            if ($adds -gt 0 -or $removes -gt 0) {
                $final = $childValidMembers[$tg.GroupId].Count
                Write-Host "    WouldUpdate '$($tg.Name)': +$adds / -$removes  →  $final/$($tg.TargetCount) members ($($tg.Percentage)%%)" -ForegroundColor Yellow
            } else {
                Write-Host "    No change '$($tg.Name)': $($childValidMembers[$tg.GroupId].Count)/$($tg.TargetCount) members ($($tg.Percentage)%%)" -ForegroundColor DarkGray
            }
        }
        return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'WouldUpdate'; Adds = $totalAdds; Removes = $totalRemoves }
    }

    # ── Apply removes first, then adds ───────────────────────────────────────
    foreach ($tg in $resolvedTargets) {
        if ($toRemove.ContainsKey($tg.GroupId) -and $toRemove[$tg.GroupId].Count -gt 0) {
            Write-Host "  Removing $($toRemove[$tg.GroupId].Count) member(s) from '$($tg.Name)'..." -ForegroundColor DarkGray
            foreach ($mId in $toRemove[$tg.GroupId]) {
                try {
                    Remove-GroupMember -GroupId $tg.GroupId -MemberId $mId
                } catch {
                    Write-Host "    Warning: Failed to remove member $mId from $($tg.GroupId): $_" -ForegroundColor Yellow
                }
            }
        }
        if ($toAdd.ContainsKey($tg.GroupId) -and $toAdd[$tg.GroupId].Count -gt 0) {
            Write-Host "  Adding $($toAdd[$tg.GroupId].Count) member(s) to '$($tg.Name)'..." -ForegroundColor DarkGray
            try {
                Add-GroupMembers -GroupId $tg.GroupId -MemberIds $toAdd[$tg.GroupId].ToArray()
            } catch {
                Write-Host "    Warning: Failed to add members to $($tg.GroupId): $_" -ForegroundColor Yellow
            }
        }
    }

    Write-Host "  '$splitName' rebalanced successfully" -ForegroundColor Green
    return [PSCustomObject]@{ SplitId = $splitId; SplitName = $splitName; Status = 'Updated'; Adds = $totalAdds; Removes = $totalRemoves }
}

# ============================================================================
# WRITE-BACK RESOLVED GROUP IDs
# ============================================================================

function Write-BackResolvedGroupIds {
    param(
        [string]$TenantConfigDir,
        [hashtable]$ResolvedGroupIds,
        [object[]]$AllSplits
    )
    if (-not $TenantConfigDir -or -not (Test-Path $TenantConfigDir)) { return }
    $path = Join-Path $TenantConfigDir 'group-splits.json'

    # Build current config (read from disk if exists, else start fresh)
    if (Test-Path $path) {
        $config = Get-Content $path -Raw | ConvertFrom-Json
        if (-not $config.groupSplits) { $config | Add-Member -NotePropertyName 'groupSplits' -NotePropertyValue @() -Force }
    } else {
        $config = [PSCustomObject]@{ groupSplits = @() }
    }

    $changed = $false

    foreach ($split in $AllSplits) {
        if (-not $ResolvedGroupIds.ContainsKey($split.id)) { continue }
        $resolvedIds = $ResolvedGroupIds[$split.id]
        if (-not $resolvedIds) { continue }

        # Find or add this split in the tenant config
        $existing = $config.groupSplits | Where-Object { $_.id -eq $split.id } | Select-Object -First 1
        if (-not $existing) {
            $config.groupSplits += $split
            $existing = $config.groupSplits | Where-Object { $_.id -eq $split.id } | Select-Object -First 1
        }

        for ($i = 0; $i -lt @($existing.targetGroups).Count; $i++) {
            if ($i -lt $resolvedIds.Count -and $resolvedIds[$i] -and -not ($resolvedIds[$i] -like 'would-create-*')) {
                if ($existing.targetGroups[$i].groupId -ne $resolvedIds[$i]) {
                    $existing.targetGroups[$i].groupId = $resolvedIds[$i]
                    $changed = $true
                }
            }
        }
    }

    if ($changed) {
        New-Item -ItemType Directory -Path $TenantConfigDir -Force | Out-Null
        $config | ConvertTo-Json -Depth 20 | Out-File -FilePath $path -Encoding UTF8 -WhatIf:$false
        Write-Host "`n  Resolved group IDs written back to: $path" -ForegroundColor DarkGray
    }
}

# ============================================================================
# MAIN PROCESSING LOOP
# ============================================================================

Write-Host "`n##[section]Processing group split rules"

$allResults      = [System.Collections.Generic.List[object]]::new()
$resolvedGroupIds = @{}   # splitId -> string[] of resolved target group IDs

foreach ($split in $allSplits) {
    try {
        $result = Invoke-GroupSplitRebalance -Split $split -ResolvedGroupIds ([ref]$resolvedGroupIds)
        $allResults.Add($result)
    } catch {
        Write-Host "##[error]Failed to process split '$($split.id)': $_" -ForegroundColor Red
        $allResults.Add([PSCustomObject]@{
            SplitId   = $split.id
            SplitName = $split.displayName ?? $split.id
            Status    = 'Error'
            Error     = $_.ToString()
        })
    }
}

# Write back resolved group IDs to tenant config (so the UI can persist them)
if (-not $WhatIfMode -and $resolvedGroupIds.Count -gt 0) {
    Write-BackResolvedGroupIds -TenantConfigDir $TenantConfigDir -ResolvedGroupIds $resolvedGroupIds -AllSplits $allSplits
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Maintenance Group Splits Summary"

$updated   = @($allResults | Where-Object { $_.Status -eq 'Updated' }).Count
$wouldUpd  = @($allResults | Where-Object { $_.Status -eq 'WouldUpdate' }).Count
$noChange  = @($allResults | Where-Object { $_.Status -eq 'NoChanges' }).Count
$skipped   = @($allResults | Where-Object { $_.Status -eq 'Skipped' }).Count
$errCount  = @($allResults | Where-Object { $_.Status -eq 'Error' }).Count

if ($WhatIfMode) {
    Write-Host "  WouldUpdate : $wouldUpd"
    Write-Host "  No changes  : $noChange"
} else {
    Write-Host "  Updated     : $updated"
    Write-Host "  No changes  : $noChange"
}
Write-Host "  Skipped     : $skipped"
Write-Host "  Errors      : $errCount"

if ($errCount -gt 0) {
    $allResults | Where-Object { $_.Status -eq 'Error' } | ForEach-Object {
        Write-Host "  Failed: $($_.SplitName) - $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service     = 'MaintenanceGroupSplits'
        Timestamp   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        TenantName  = $TenantName
        WhatIfMode  = [bool]$WhatIfMode
        Results     = @($allResults | ForEach-Object {
            @{
                SplitId   = $_.SplitId
                SplitName = $_.SplitName
                Status    = $_.Status
                Adds      = $_.Adds
                Removes   = $_.Removes
                Error     = $_.Error
            }
        })
    }
    $outputDir = Split-Path -Path $OutputPath -Parent
    if (-not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Summary saved to: $OutputPath"
}

if ($errCount -gt 0) { exit 1 }
