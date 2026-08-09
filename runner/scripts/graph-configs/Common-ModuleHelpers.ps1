<#
.SYNOPSIS
    Shared module-loading helper for all configure scripts.

.DESCRIPTION
    Provides Import-RequiredGraphModules, which installs and imports Microsoft Graph
    PowerShell modules while temporarily suppressing $WhatIfPreference.

    Module loading must always run regardless of the calling script's WhatIf mode —
    the modules are required for the rest of the script to execute. The function
    suppresses $WhatIfPreference locally so that Update-TypeData calls made internally
    by the Graph modules during Import-Module do not produce "What if: Performing the
    operation 'Update TypeData'" noise.

    IMPORTANT: Do NOT pass -WhatIf:$false explicitly to Import-Module or Install-Module
    here. The agent's PS7 build of Import-Module does not declare a -WhatIf parameter;
    passing it explicitly causes NamedParameterNotFound which propagates as
    NamedParameterNotFound,Configure-<Script>.ps1. Setting $WhatIfPreference = $false
    locally is sufficient — cmdlets that have SupportsShouldProcess will honour the
    preference variable; cmdlets that don't have it will ignore WhatIf entirely.

    Usage — replace the standard module-import loop in each Configure-*.ps1 with:

        $moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
        . $moduleHelpersPath

        $requiredModules = @(
            "Microsoft.Graph.Authentication",
            "Microsoft.Graph.DeviceManagement"
        )
        Import-RequiredGraphModules -ModuleNames $requiredModules
#>

function Import-RequiredGraphModules {
    param(
        [string[]]$ModuleNames
    )

    $savedWhatIf = $WhatIfPreference
    $WhatIfPreference = $false

    try {
        Write-Host "`nChecking required PowerShell modules..."
        foreach ($module in $ModuleNames) {
            if (-not (Get-Module -ListAvailable -Name $module)) {
                Write-Host "Installing module: $module"
                Install-Module -Name $module -Force -AllowClobber -Scope CurrentUser
            }
            Import-Module $module -ErrorAction Stop
            Write-Host "  Loaded: $module"
        }
    }
    finally {
        $WhatIfPreference = $savedWhatIf
    }
}

<#
.SYNOPSIS
    Polls Graph until Security Defaults reports the expected isEnabled value.

.DESCRIPTION
    Graph can lag after PATCH — CA policy creates fail with "Security Defaults is enabled"
    if we proceed before propagation completes. Call after changing Security Defaults,
    or before Conditional Access apply when baseline expects them disabled.
#>
function Wait-ForSecurityDefaultsPropagation {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$ExpectedEnabled,

        [int]$MaxWaitSeconds = 90,
        [int]$IntervalSeconds = 5
    )

    $sdUri = "https://graph.microsoft.com/v1.0/policies/identitySecurityDefaultsEnforcementPolicy"
    $maxAttempts = [Math]::Max(1, [Math]::Ceiling($MaxWaitSeconds / $IntervalSeconds))

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $sdPolicy = Invoke-MgGraphRequest -Method GET -Uri $sdUri -ErrorAction Stop
        $actualEnabled = [bool]$sdPolicy.isEnabled

        if ($actualEnabled -eq $ExpectedEnabled) {
            if ($attempt -gt 1) {
                Write-Host "✓ Security Defaults propagation confirmed (isEnabled=$ExpectedEnabled) after ~$(($attempt - 1) * $IntervalSeconds)s" -ForegroundColor Green
            }
            return $true
        }

        if ($attempt -lt $maxAttempts) {
            Write-Host "Waiting for Security Defaults propagation (expected isEnabled=$ExpectedEnabled, Graph reports isEnabled=$actualEnabled) — attempt $attempt/$maxAttempts..."
            Start-Sleep -Seconds $IntervalSeconds
        }
    }

    return $false
}

<#
.SYNOPSIS
    Polls Graph until the Defender connector partnerState is available or enabled.

.DESCRIPTION
    Intune EDR policies require an active connector. Call after POST/PATCH on
    mobileThreatDefenseConnector so downstream Intune deploy steps do not fail.
#>
function Wait-ForDefenderConnectorPropagation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConnectorId,

        [int]$MaxWaitSeconds = 120,
        [int]$IntervalSeconds = 5
    )

    $uri = "https://graph.microsoft.com/v1.0/deviceManagement/mobileThreatDefenseConnectors/$ConnectorId"
    $maxAttempts = [Math]::Max(1, [Math]::Ceiling($MaxWaitSeconds / $IntervalSeconds))

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $connector = Invoke-MgGraphRequest -Method GET -Uri $uri -ErrorAction Stop
        $state = [string]$connector.partnerState

        if ($state -eq 'available' -or $state -eq 'enabled') {
            if ($attempt -gt 1) {
                Write-Host "✓ Defender connector propagation confirmed (partnerState=$state) after ~$(($attempt - 1) * $IntervalSeconds)s" -ForegroundColor Green
            }
            return $true
        }

        if ($attempt -lt $maxAttempts) {
            Write-Host "Waiting for Defender connector propagation (partnerState=$state) — attempt $attempt/$maxAttempts..."
            Start-Sleep -Seconds $IntervalSeconds
        }
    }

    return $false
}

function Escape-ODataString {
    param([string]$Value)
    return $Value.Replace("'", "''")
}

<#
.SYNOPSIS
    Finds an Entra group by display name using Graph advanced query with search fallback.
#>
function Find-MgGroupByDisplayName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DisplayName,
        [switch]$TeamsOnly
    )

    $name = $DisplayName.Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }

    $safeName = Escape-ODataString $name
    $filter = if ($TeamsOnly) {
        "displayName eq '$safeName' and resourceProvisioningOptions/Any(x:x eq 'Team')"
    } else {
        "displayName eq '$safeName'"
    }

    $groups = @()
    try {
        $groups = @(Get-MgGroup -Filter $filter -ConsistencyLevel eventual -CountVariable _ -All -ErrorAction Stop)
    }
    catch {
        Write-Verbose "Graph filter lookup failed for '$name': $_"
    }

    if ($groups.Count -eq 0) {
        try {
            $searchTerm = Escape-ODataString $name
            $groups = @(Get-MgGroup -Search "DisplayName:$searchTerm" -ConsistencyLevel eventual -All -ErrorAction Stop |
                Where-Object { $_.DisplayName -ieq $name })
        }
        catch {
            Write-Verbose "Graph search lookup failed for '$name': $_"
        }
    }

    if ($groups.Count -gt 1) {
        Write-Warning "Multiple groups match display name '$name'; using first exact case-insensitive match"
        $exact = $groups | Where-Object { $_.DisplayName -ieq $name } | Select-Object -First 1
        if ($exact) { return $exact }
    }

    if ($groups.Count -ge 1) {
        return $groups[0]
    }
    return $null
}
