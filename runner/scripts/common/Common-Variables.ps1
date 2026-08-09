<#
.SYNOPSIS
    Resolves tenant variable values from baseline variables.json, group overrides, and tenant overrides.

.DESCRIPTION
    Precedence (lowest to highest):
      1. default (from baseline variables.json)
      2. groups.{GroupName} for each baseline group the tenant belongs to (groups-config declaration order)
      3. tenant config/variables.json override

    Returns a hashtable: Name -> resolved string value.
#>

. (Join-Path $PSScriptRoot 'Common-TenantGroups.ps1')

function Get-BaselineVariableDefinitions {
    param([string] $BaselinePath)

    $variablesConfigPath = Join-Path $BaselinePath 'variables.json'
    if (-not (Test-Path $variablesConfigPath)) {
        return $null
    }

    try {
        $raw = Get-Content $variablesConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "Get-TenantVariables: Could not parse '$variablesConfigPath': $_"
        return $null
    }

    if ($raw.PSObject.Properties['variables'] -and $raw.variables -is [PSCustomObject]) {
        return $raw.variables
    }

    return $raw
}

function Get-BaselineGroupOrder {
    param([string] $BaselinePath)

    $groupsConfigPath = Join-Path $BaselinePath 'groups-config.json'
    if (-not (Test-Path $groupsConfigPath)) {
        return @()
    }

    try {
        $groupsConfig = Get-Content $groupsConfigPath -Raw | ConvertFrom-Json
        if ($groupsConfig.PSObject.Properties['groups'] -and $groupsConfig.groups -is [PSCustomObject]) {
            $groupsConfig = $groupsConfig.groups
        }
        return @($groupsConfig.PSObject.Properties.Name)
    }
    catch {
        Write-Warning "Get-TenantVariables: Could not parse '$groupsConfigPath': $_"
        return @()
    }
}

function Get-TenantVariableOverrides {
    param([string] $TenantRepoPath)

    $tenantVarsPath = Join-Path $TenantRepoPath 'config' 'variables.json'
    if (-not (Test-Path $tenantVarsPath)) {
        return @{}
    }

    try {
        $raw = Get-Content $tenantVarsPath -Raw | ConvertFrom-Json
        $overrides = @{}
        $source = $raw
        if ($raw.PSObject.Properties['variables'] -and $raw.variables -is [PSCustomObject]) {
            $source = $raw.variables
        }
        foreach ($name in $source.PSObject.Properties.Name) {
            $value = $source.$name
            if ($null -ne $value) {
                $overrides[$name] = [string]$value
            }
        }
        return $overrides
    }
    catch {
        Write-Warning "Get-TenantVariables: Could not parse '$tenantVarsPath': $_"
        return @{}
    }
}

function Get-TenantVariables {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string] $BaselinePath,

        [Parameter(Mandatory = $true)]
        [string] $TenantRepoPath,

        [string] $TenantSlug = $env:TENANT_SLUG,

        [switch] $Quiet
    )

    $resolved = @{}
    $definitions = Get-BaselineVariableDefinitions -BaselinePath $BaselinePath
    $groupOrder = Get-BaselineGroupOrder -BaselinePath $BaselinePath
    $memberGroups = @(Get-ResolvedTenantGroupMembership -BaselinePath $BaselinePath -TenantRepoPath $TenantRepoPath -TenantSlug $TenantSlug)
    $memberSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($groupName in $memberGroups) {
        [void]$memberSet.Add($groupName)
    }

    if ($definitions) {
        foreach ($varName in $definitions.PSObject.Properties.Name) {
            $def = $definitions.$varName
            $value = ''
            if ($null -ne $def.default) {
                $value = [string]$def.default
            }

            foreach ($groupName in $groupOrder) {
                if (-not $memberSet.Contains($groupName)) { continue }
                if (-not $def.groups) { continue }
                if (-not ($def.groups.PSObject.Properties.Name -contains $groupName)) { continue }
                $groupValue = $def.groups.$groupName
                if ($null -ne $groupValue -and [string]$groupValue.Trim() -ne '') {
                    $value = [string]$groupValue
                    if (-not $Quiet) {
                        Write-Verbose "Get-TenantVariables: '$varName' group override from '$groupName' -> '$value'"
                    }
                }
            }

            if ([string]$value.Trim() -ne '') {
                $resolved[$varName] = $value
            }
        }
    }

    $tenantOverrides = Get-TenantVariableOverrides -TenantRepoPath $TenantRepoPath
    foreach ($name in $tenantOverrides.Keys) {
        $overrideValue = $tenantOverrides[$name]
        if ($null -ne $overrideValue -and [string]$overrideValue.Trim() -ne '') {
            $resolved[$name] = [string]$overrideValue
            if (-not $Quiet) {
                Write-Verbose "Get-TenantVariables: '$name' tenant override -> '$overrideValue'"
            }
        }
    }

    if (-not $Quiet) {
        Write-Host "##[section]Get-TenantVariables: Resolved $($resolved.Count) variable(s)"
    }

    return $resolved
}

function Get-ResolvedTenantVariables {
    <#
    .SYNOPSIS
        Returns tenant variables, preferring the plan-step cache written by Resolve-Variables.
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
        $cachePath = Join-Path $env:PLAN_DIR 'tenant-variables-resolved.json'
        if (Test-Path $cachePath) {
            try {
                $cached = Get-Content $cachePath -Raw | ConvertFrom-Json
                if ($cached.Variables) {
                    $resolved = @{}
                    foreach ($name in $cached.Variables.PSObject.Properties.Name) {
                        $value = $cached.Variables.$name
                        if ($null -ne $value -and [string]$value.Trim() -ne '') {
                            $resolved[$name] = [string]$value
                        }
                    }
                    Write-Verbose "Get-ResolvedTenantVariables: Using Variables from $cachePath"
                    return $resolved
                }
            }
            catch {
                Write-Verbose "Get-ResolvedTenantVariables: Could not read '$cachePath': $_"
            }
        }
    }

    return Get-TenantVariables -BaselinePath $BaselinePath -TenantRepoPath $TenantRepoPath -TenantSlug $TenantSlug -Quiet
}
