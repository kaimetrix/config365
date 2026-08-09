<#
.SYNOPSIS
    Shared tenant baseline group membership resolution.

.DESCRIPTION
    Single source of truth for which config groups a tenant belongs to:
      - config/tenant-groups.json (direct list)
      - groups-config.json membership.direct (slug match)
      - groups-config.json membership.dynamic (license SKU rules)

    Used by Resolve-TenantGroups.ps1 and Get-GroupExcludedFiles (via Get-ResolvedTenantGroupMembership).
#>

function Get-TenantGroupMembership {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $BaselinePath,

        [Parameter(Mandatory = $true)]
        [string] $TenantRepoPath,

        [string] $TenantSlug = $env:TENANT_SLUG,

        [switch] $Quiet
    )

    $groupsConfigPath = Join-Path $BaselinePath 'groups-config.json'
    if (-not (Test-Path $groupsConfigPath)) {
        if (-not $Quiet) {
            Write-Host "##[section]Get-TenantGroupMembership: No groups-config.json at '$groupsConfigPath'"
        }
        return @()
    }

    $groupsConfig = Get-Content $groupsConfigPath -Raw | ConvertFrom-Json
    if ($groupsConfig.PSObject.Properties['groups'] -and $groupsConfig.groups -is [PSCustomObject]) {
        $groupsConfig = $groupsConfig.groups
    }

    if (-not $Quiet) {
        Write-Host "##[section]Get-TenantGroupMembership: Loaded $(($groupsConfig.PSObject.Properties | Measure-Object).Count) group(s) from groups-config.json"
    }

    $tenantGroupsPath = Join-Path $TenantRepoPath 'config' 'tenant-groups.json'
    $tenantGroups = @()
    if (Test-Path $tenantGroupsPath) {
        try {
            $tenantGroupsData = Get-Content $tenantGroupsPath -Raw | ConvertFrom-Json
            $tenantGroups = @($tenantGroupsData.groups)
            if (-not $Quiet) {
                Write-Host "##[section]Get-TenantGroupMembership: Member group(s) via tenant-groups.json: $($tenantGroups -join ', ')"
            }
        }
        catch {
            Write-Warning "Get-TenantGroupMembership: Could not parse '$tenantGroupsPath': $_"
        }
    }
    elseif (-not $Quiet) {
        Write-Host "##[section]Get-TenantGroupMembership: No tenant-groups.json — using groups-config direct/dynamic rules"
    }

    if (-not [string]::IsNullOrWhiteSpace($TenantSlug)) {
        foreach ($groupName in $groupsConfig.PSObject.Properties.Name) {
            if ($tenantGroups -contains $groupName) { continue }
            $direct = @($groupsConfig.$groupName.membership.direct)
            if ($direct.Count -eq 0) { continue }
            $match = $direct | Where-Object {
                $_ -and ($_.ToString().Trim().ToLowerInvariant() -eq $TenantSlug.Trim().ToLowerInvariant())
            } | Select-Object -First 1
            if ($match) {
                if (-not $Quiet) {
                    Write-Host "  Direct match: '$groupName' — slug '$TenantSlug' listed in membership.direct"
                }
                $tenantGroups += $groupName
            }
        }
    }
    elseif (-not $Quiet) {
        Write-Host "##[section]Get-TenantGroupMembership: TENANT_SLUG empty — skipping membership.direct rules"
    }

    $licensesPath = Join-Path $TenantRepoPath 'backups' 'licenses' 'subscribed-skus.json'
    $tenantSkus = @()
    if (Test-Path $licensesPath) {
        try {
            $tenantSkus = @(Get-Content $licensesPath -Raw | ConvertFrom-Json)
            if (-not $Quiet) {
                Write-Host "##[section]Get-TenantGroupMembership: Loaded $($tenantSkus.Count) subscribed SKU(s) for dynamic rule evaluation"
            }
        }
        catch {
            Write-Warning "Get-TenantGroupMembership: Could not parse '$licensesPath': $_"
        }
    }
    elseif (-not $Quiet) {
        Write-Host "##[section]Get-TenantGroupMembership: No license backup at '$licensesPath' — dynamic rules skipped"
    }

    foreach ($groupName in $groupsConfig.PSObject.Properties.Name) {
        if ($tenantGroups -contains $groupName) { continue }

        $dynamic = @($groupsConfig.$groupName.membership.dynamic)
        if ($dynamic.Count -eq 0) { continue }

        $matched = $false
        foreach ($rule in $dynamic) {
            if ($matched) { break }
            if ($rule.type -eq 'license') {
                $skuPartNumbers = @($rule.skuPartNumbers)
                $hit = $tenantSkus | Where-Object {
                    $skuPartNumbers -contains $_.skuPartNumber -and
                    $_.capabilityStatus -in @('Enabled', 'Warning')
                } | Select-Object -First 1
                if ($hit) {
                    if (-not $Quiet) {
                        Write-Host "  Dynamic match: '$groupName' — license rule matched SKU '$($hit.skuPartNumber)'"
                    }
                    $tenantGroups += $groupName
                    $matched = $true
                }
            }
        }
    }

    if (-not $Quiet -and $tenantSkus.Count -gt 0) {
        Write-Host "##[section]Get-TenantGroupMembership: Resolved member group(s): $($tenantGroups -join ', ')"
    }

    return @($tenantGroups)
}

function Get-ResolvedTenantGroupMembership {
    <#
    .SYNOPSIS
        Returns tenant group membership, preferring the plan-step cache written by Resolve-TenantGroups.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $BaselinePath,

        [Parameter(Mandatory = $true)]
        [string] $TenantRepoPath,

        [string] $TenantSlug = $env:TENANT_SLUG
    )

    if ($env:PLAN_DIR) {
        $cachePath = Join-Path $env:PLAN_DIR 'tenant-groups-resolved.json'
        if (Test-Path $cachePath) {
            try {
                $cached = Get-Content $cachePath -Raw | ConvertFrom-Json
                if ($null -ne $cached.MemberGroups) {
                    Write-Verbose "Get-ResolvedTenantGroupMembership: Using MemberGroups from $cachePath"
                    return @($cached.MemberGroups)
                }
            }
            catch {
                Write-Verbose "Get-ResolvedTenantGroupMembership: Could not read '$cachePath': $_"
            }
        }
    }

    return @(Get-TenantGroupMembership -BaselinePath $BaselinePath -TenantRepoPath $TenantRepoPath -TenantSlug $TenantSlug -Quiet)
}
