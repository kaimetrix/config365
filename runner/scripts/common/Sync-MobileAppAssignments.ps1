function Test-MobileAppAssignmentsMatch {
    <#
    .SYNOPSIS
        Returns $true when live Intune assignments already match baseline config.

    .DESCRIPTION
        Compares normalized group/intent sets from Graph against baseline config.
        Used as the sole source of truth for assignment drift (not app notes).
    #>
    param(
        [array]$ExistingAssignments,
        [array]$ConfigAssignments,
        [bool]$AvailableForAllUsers
    )

    function Get-NormalizedAssignmentKeys {
        param([array]$Items)
        @($Items | ForEach-Object {
            $name = [string]$_.groupName
            if ([string]::IsNullOrWhiteSpace($name)) { return }
            $intent = [string]($_.intent ?? 'required')
            if ($intent -eq 'exclude') { $intent = 'required' }
            "$($name.Trim().ToLowerInvariant())|$intent"
        } | Where-Object { $_ } | Sort-Object)
    }

    $desired = [System.Collections.Generic.List[object]]::new()
    foreach ($asgn in @($ConfigAssignments)) {
        $groupName = [string]$asgn.groupName
        if ([string]::IsNullOrWhiteSpace($groupName)) { continue }
        $desired.Add([PSCustomObject]@{
            groupName = $groupName.Trim()
            intent    = [string]($asgn.intent ?? 'required')
        })
    }
    if ($AvailableForAllUsers) {
        $desired.Add([PSCustomObject]@{ groupName = 'All Users'; intent = 'available' })
    }

    $existingKeys = Get-NormalizedAssignmentKeys -Items $ExistingAssignments
    $desiredKeys  = Get-NormalizedAssignmentKeys -Items $desired
    return (($existingKeys -join ';') -eq ($desiredKeys -join ';'))
}

function Sync-MobileAppAssignments {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GraphBase,
        [Parameter(Mandatory = $true)]
        [string]$AppId,
        [Parameter(Mandatory = $true)]
        [scriptblock]$InvokeGraph,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ResolveGroupId,
        [array]$ConfigAssignments,
        [bool]$AvailableForAllUsers
    )

    $desired = [System.Collections.Generic.List[hashtable]]::new()
    $skipped = [System.Collections.Generic.List[string]]::new()
    if ($ConfigAssignments) {
        foreach ($asgn in @($ConfigAssignments)) {
            $groupId = & $ResolveGroupId $asgn.groupName ($asgn.groupId ?? $null)
            if (-not $groupId) {
                $msg = "Skipping assignment (group not resolved): $($asgn.groupName)"
                Write-Host "    $msg" -ForegroundColor Yellow
                $skipped.Add([string]$asgn.groupName)
                continue
            }
            $intent = $asgn.intent ?? 'required'
            if ($intent -eq 'exclude') {
                $target = @{ '@odata.type' = '#microsoft.graph.exclusionGroupAssignmentTarget'; groupId = $groupId }
                $desired.Add(@{ '@odata.type' = '#microsoft.graph.mobileAppAssignment'; intent = 'required'; target = $target })
            } else {
                $target = @{ '@odata.type' = '#microsoft.graph.groupAssignmentTarget'; groupId = $groupId }
                $desired.Add(@{ '@odata.type' = '#microsoft.graph.mobileAppAssignment'; intent = $intent; target = $target })
            }
        }
    }

    if ($AvailableForAllUsers) {
        $desired.Add(@{
            '@odata.type' = '#microsoft.graph.mobileAppAssignment'
            intent        = 'available'
            target        = @{ '@odata.type' = '#microsoft.graph.allLicensedUsersAssignmentTarget' }
        })
    }

    $baseUri = "$GraphBase/deviceAppManagement/mobileApps/$AppId/assignments"
    $existing = & $InvokeGraph 'GET' $baseUri $null
    foreach ($a in @($existing.value)) {
        & $InvokeGraph 'DELETE' "$baseUri/$($a.id)" $null | Out-Null
    }

    if ($desired.Count -gt 0) {
        & $InvokeGraph 'POST' "$GraphBase/deviceAppManagement/mobileApps/$AppId/assign" @{
            mobileAppAssignments = $desired.ToArray()
        } | Out-Null
        Write-Host "    Applied $($desired.Count) assignment(s)"
    } else {
        Write-Host "    Cleared all assignments"
    }

    $configuredGroups = @($ConfigAssignments | Where-Object { $_.groupName -and [string]$_.groupName.Trim() }).Count
    if ($skipped.Count -gt 0 -and $configuredGroups -gt 0 -and $desired.Count -eq 0) {
        throw "No assignments applied — Entra group(s) not found: $($skipped -join ', '). Deploy groups first (Configure-BaselineGroups.ps1)."
    }
}
