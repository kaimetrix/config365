<#
.SYNOPSIS
    Creates and manages Intune Group Policy Configurations via Microsoft Graph API

.DESCRIPTION
    Handles "Administrative templates" and "Imported Administrative templates (Preview)"
    policies in Intune (groupPolicyConfigurations).

    Each baseline JSON file contains the policy metadata plus an embedded
    'definitionValues' array. Each definitionValue includes a 'definition' sub-object
    that carries enough information to resolve the correct definition ID in any tenant:

        definition.admxFileName  - present for IMPORTED ADMX definitions.
                                   The module looks up the definition ID by querying
                                   the uploaded ADMX file's groupPolicyDefinitions, matching
                                   on policyName + classType.
                                   If absent, definition.id is used directly (built-in
                                   ADMX definitions have consistent IDs across tenants).
        definition.policyName    - policy name inside the ADMX (e.g. "EnableFeatureX")
        definition.classType     - "machine" or "user"

    Definition IDs are resolved via the top-level groupPolicyDefinitions endpoint
    (filtered to admxIngested), not via the per-file navigation property. This makes
    the module independent of the ADMX upload order and avoids BadRequest errors that
    occur when the navigation property is queried before the backend finishes indexing.

    This module is called by the main Configure-Intune.ps1 orchestrator.

.PARAMETER PolicyConfigs
    Array of policy configuration objects to process

.PARAMETER WhatIfMode
    Show what would be changed without making changes

.NOTES
    API: https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations
    Required permission: DeviceManagementConfiguration.ReadWrite.All
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$false)]
    [array]$PolicyConfigs = @(),

    [Parameter(Mandatory=$false)]
    [switch]$WhatIfMode
)

# Always load helpers (required when called from orchestrator with & operator)
$helpersPath = Join-Path $PSScriptRoot "Configure-Intune-Helpers.ps1"
. $helpersPath

# Load common ignore helpers for protection marker support
$ignoreHelpersPath = Join-Path $PSScriptRoot "..\Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

$gpcBaseUri = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyConfigurations"

# ============================================================================
# GROUP POLICY CONFIGURATION HELPERS
# ============================================================================

function Get-AllGroupPolicyConfigurations {
    <#
    .SYNOPSIS
        Returns all Group Policy Configurations from the tenant (cached).
    #>
    if ($script:PolicyCache.ContainsKey("group-policy-configurations")) {
        return $script:PolicyCache["group-policy-configurations"]
    }

    Write-Verbose "  Fetching all Group Policy Configurations from tenant..."
    $all = @()
    $uri = $gpcBaseUri
    do {
        $response = Invoke-MgGraphRequest -Method GET -Uri $uri
        $all += $response.value
        $uri = $response.'@odata.nextLink'
    } while ($uri)

    $script:PolicyCache["group-policy-configurations"] = $all
    Write-Verbose "  Found $($all.Count) Group Policy Configuration(s) in tenant"
    return $all
}

# Tenant-specific definition cache. Populated from the top-level
# /groupPolicyDefinitions endpoint (which DOES contain custom ADMX-ingested
# definitions, despite earlier assumptions to the contrary — confirmed via probe).
#
# Tenant definition GUIDs are tenant-specific and must NOT be reused from the
# baseline JSON (which was exported from a different tenant). We match on stable
# identifiers from the ADMX/ADML: displayName + classType, scoped by the ADMX
# namespace (first categoryPath segment) so we don't collide with same-named
# settings from unrelated ADMX files.
#
# Note on namespace drift: the baseline categoryPath may use the ADMX *file name*
# (e.g. "Winget-AutoUpdate-Configurator") while the tenant categoryPath uses the
# ADMX XML *displayName* (e.g. "Winget-AutoUpdate-aaS"). We use the uploaded ADMX
# file's `displayName` from /groupPolicyUploadedDefinitionFiles as the authoritative
# tenant-side namespace when an admxFileName hint is available.
$script:AllDefinitionsCache         = $null
$script:UploadedFilesIndexByFileName = $null

function Normalize-GpoCategoryPath {
    param([string]$Path)
    if (-not $Path) { return '' }
    return ($Path.Trim('\') -replace '\\', '/').ToLowerInvariant()
}

function Get-AllGroupPolicyDefinitions {
    <#
    .SYNOPSIS
        Returns all groupPolicyDefinitions from the tenant (built-in + admxIngested),
        cached. Custom uploaded ADMX definitions ARE included here.
    #>
    if ($null -ne $script:AllDefinitionsCache) { return $script:AllDefinitionsCache }

    Write-Host "  Fetching all groupPolicyDefinitions from tenant..." -ForegroundColor Cyan
    $uri  = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions"
    $all  = @()
    $page = 0
    do {
        $r    = Invoke-MgGraphRequest -Method GET -Uri $uri
        $all += @($r.value)
        $page++
        $uri  = $r.'@odata.nextLink'
    } while ($uri)
    Write-Host "  Loaded $($all.Count) definition(s) across $page page(s)" -ForegroundColor Cyan

    $script:AllDefinitionsCache = $all
    return $all
}

function Get-UploadedFileByFileName {
    <#
    .SYNOPSIS
        Returns the uploaded ADMX file record (with displayName, targetNamespace, etc.)
        matching the given file name, or $null.
    #>
    param([string]$FileName)

    if (-not $FileName) { return $null }

    if ($null -eq $script:UploadedFilesIndexByFileName) {
        $script:UploadedFilesIndexByFileName = @{}
        try {
            $uri = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyUploadedDefinitionFiles"
            $all = @()
            do {
                $r = Invoke-MgGraphRequest -Method GET -Uri $uri
                $all += @($r.value)
                $uri = $r.'@odata.nextLink'
            } while ($uri)
            foreach ($f in $all) {
                if ($f.fileName) { $script:UploadedFilesIndexByFileName[$f.fileName.ToLowerInvariant()] = $f }
            }
        }
        catch {
            Write-Host "  [!] Failed to fetch uploaded ADMX file index: $_" -ForegroundColor Yellow
        }
    }

    $key = $FileName.ToLowerInvariant()
    if ($script:UploadedFilesIndexByFileName.ContainsKey($key)) {
        return $script:UploadedFilesIndexByFileName[$key]
    }
    return $null
}

function Get-PresentationsForDefinition {
    <#
    .SYNOPSIS
        Returns the presentations array for a definition (lazy-fetched via
        /groupPolicyDefinitions/{id}/presentations when not already present).
    #>
    param([Parameter(Mandatory=$true)]$Definition)

    $existing = if ($Definition -is [hashtable]) { $Definition['presentations'] } else { $Definition.presentations }
    if ($existing) { return @($existing) }

    $defId = if ($Definition -is [hashtable]) { $Definition['id'] } else { $Definition.id }
    if (-not $defId) { return @() }

    try {
        $r = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions/$defId/presentations"
        $arr = @($r.value)
        if ($Definition -is [hashtable]) { $Definition['presentations'] = $arr }
        return $arr
    }
    catch {
        Write-Host "  [!] Failed to fetch presentations for definition $defId : $(($_.ToString() -split [Environment]::NewLine)[0])" -ForegroundColor Yellow
        return @()
    }
}

function Resolve-DefinitionId {
    <#
    .SYNOPSIS
        Resolves the tenant-specific Graph API definition for a baseline definitionValue.
    .DESCRIPTION
        Lookup strategy (first match wins):
          1. policyName + classType (when baseline carries policyName).
          2. displayName + classType, scoped by ADMX namespace.
             Namespace candidates (in order):
                a. uploaded ADMX file's `displayName` (most accurate target-side namespace)
                b. baseline categoryPath first segment (source-side namespace; tolerates drift)
          3. displayName + classType anywhere (last-resort; warns on ambiguity).
    .RETURNS
        Definition object with tenant-specific id + presentations, or $null on failure.
    #>
    param(
        [Parameter(Mandatory=$true)]
        $DefinitionEntry    # The 'definition' sub-object from the baseline JSON
    )

    $policyName   = if ($DefinitionEntry -is [hashtable]) { $DefinitionEntry['policyName']   } else { $DefinitionEntry.policyName   }
    $classType    = if ($DefinitionEntry -is [hashtable]) { $DefinitionEntry['classType']    } else { $DefinitionEntry.classType    }
    $displayName  = if ($DefinitionEntry -is [hashtable]) { $DefinitionEntry['displayName']  } else { $DefinitionEntry.displayName  }
    $catPath      = if ($DefinitionEntry -is [hashtable]) { $DefinitionEntry['categoryPath'] } else { $DefinitionEntry.categoryPath }
    $admxFileName = if ($DefinitionEntry -is [hashtable]) { $DefinitionEntry['admxFileName'] } else { $DefinitionEntry.admxFileName }

    if (-not $classType) {
        Write-Host "  ##[error]definition is missing 'classType' - cannot resolve" -ForegroundColor Red
        return $null
    }

    $allDefs = Get-AllGroupPolicyDefinitions

    # Strategy 1: policyName + classType
    if ($policyName) {
        $m1 = @($allDefs | Where-Object {
            $_.policyName -ieq $policyName -and $_.classType -ieq $classType
        }) | Select-Object -First 1
        if ($m1) { return $m1 }
    }

    if (-not $displayName) {
        Write-Host "  ##[error]definition is missing displayName and policyName lookup failed - cannot resolve" -ForegroundColor Red
        return $null
    }

    # Build the list of namespace prefix candidates (lowercase, no leading backslash)
    $candidates = @()
    if ($admxFileName) {
        $uf = Get-UploadedFileByFileName -FileName $admxFileName
        if ($uf -and $uf.displayName) {
            $candidates += $uf.displayName.ToString().ToLowerInvariant()
        }
    }
    if ($catPath) {
        $first = ($catPath -split '\\' | Where-Object { $_ } | Select-Object -First 1)
        if ($first) {
            $fl = $first.ToLowerInvariant()
            if ($candidates -notcontains $fl) { $candidates += $fl }
        }
    }

    # Strategy 2: displayName + classType, scoped by each namespace candidate
    foreach ($ns in $candidates) {
        $m2 = @($allDefs | Where-Object {
            $_.displayName -ieq $displayName -and
            $_.classType   -ieq $classType   -and
            (($_.categoryPath -replace '^\\','').ToLowerInvariant() -like "$ns*")
        })
        if ($m2.Count -ge 1) {
            if ($m2.Count -gt 1) {
                Write-Host "  [!] Multiple matches for '$displayName' under namespace '$ns' - taking first" -ForegroundColor Yellow
            }
            return $m2[0]
        }
    }

    # Strategy 3: displayName + classType anywhere (last resort)
    $m3 = @($allDefs | Where-Object {
        $_.displayName -ieq $displayName -and $_.classType -ieq $classType
    })
    if ($m3.Count -eq 1) {
        Write-Host "  [!] Resolved '$displayName' without namespace scope (unique displayName match)" -ForegroundColor Yellow
        return $m3[0]
    }
    elseif ($m3.Count -gt 1) {
        # Disambiguation failure — graceful: the caller (Build-DefinitionValueBody) returns $null
        # which skips the setting and continues with the rest of the batch. Logged as warning,
        # not error, because the script does not exit failure for this case.
        Write-Host "  ##[warning]'$displayName' (classType '$classType') matches $($m3.Count) definitions; namespace candidates '$($candidates -join ',')' did not match any. Cannot disambiguate — skipping." -ForegroundColor Yellow
        return $null
    }

    # Definition not in tenant ADMX. Common cause: the baseline GPC references a setting that
    # was deprecated/removed in a newer ADMX revision (e.g. WAUaaS dropped "Reinstall on Policy
    # Update" / ReinstallOnRefresh). The caller skips and the rest of the batch still applies,
    # so this is a warning, not an error.
    Write-Host "  ##[warning]No tenant definition found for displayName='$displayName' classType='$classType' (namespace candidates: '$($candidates -join ',')') — skipping setting" -ForegroundColor Yellow
    return $null
}

function Get-ExistingDefinitionValues {
    <#
    .SYNOPSIS
        Fetches all definitionValues for an existing Group Policy Configuration,
        with definition metadata and presentationValues from the per-DV endpoint.
    .DESCRIPTION
        Shallow $expand=presentationValues returns empty arrays for admxIngested policies
        (Graph quirk). Mirrors Backup-Intune.ps1: list with $expand=definition, then GET
        /definitionValues/{dvId}/presentationValues?$expand=presentation for each.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId
    )

    $all = @()
    $uri = "$gpcBaseUri/$PolicyId/definitionValues?`$expand=definition"
    do {
        $r   = Invoke-MgGraphRequest -Method GET -Uri $uri
        $all += $r.value
        $uri  = $r.'@odata.nextLink'
    } while ($uri)

    $enriched = @()
    foreach ($dv in $all) {
        $dvId = if ($dv -is [hashtable]) { $dv['id'] } else { $dv.id }
        $pvList = @()
        if ($dvId) {
            try {
                $pvUri = "$gpcBaseUri/$PolicyId/definitionValues/$dvId/presentationValues?`$expand=presentation"
                do {
                    $pvResp = Invoke-MgGraphRequest -Method GET -Uri $pvUri
                    if ($pvResp.value) { $pvList += @($pvResp.value) }
                    $pvUri = $pvResp.'@odata.nextLink'
                } while ($pvUri)
            }
            catch {
                Write-Verbose "  presentationValues fetch failed for dv $dvId : $_"
            }
        }

        if ($dv -is [hashtable]) {
            $entry = @{}
            foreach ($k in $dv.Keys) {
                if ($k -eq 'presentationValues') { continue }
                $entry[$k] = $dv[$k]
            }
            $entry['presentationValues'] = $pvList
            $enriched += $entry
        }
        else {
            $enriched += [PSCustomObject]@{
                id                   = $dv.id
                enabled              = $dv.enabled
                definition           = $dv.definition
                presentationValues   = $pvList
                configurationType    = $dv.configurationType
                createdDateTime      = $dv.createdDateTime
                lastModifiedDateTime = $dv.lastModifiedDateTime
            }
        }
    }

    return $enriched
}

function Get-GpcBaselineConfigsForAdmxFile {
    <#
    .SYNOPSIS
        Returns baseline GPC policy configs that reference a given uploaded ADMX file.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$AdmxFileName,
        [array]$AllPolicyConfigs = @(),
        [string]$UploadedAdmxDisplayName
    )

    $gpcConfigs = @($AllPolicyConfigs | Where-Object { $_._policyType -eq 'group-policy-configurations' })
    $result     = @()
    $admxStem   = [System.IO.Path]::GetFileNameWithoutExtension($AdmxFileName)
    $namespaceCandidates = @($UploadedAdmxDisplayName, $admxStem) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($gpc in $gpcConfigs) {
        $match = $false
        foreach ($dv in @($gpc.definitionValues)) {
            if (-not $dv) { continue }
            $def = if ($dv -is [hashtable]) { $dv['definition'] } else { $dv.definition }
            if (-not $def) { continue }

            $admxFn = if ($def -is [hashtable]) { $def['admxFileName'] } else { $def.admxFileName }
            if ($admxFn -and $admxFn -ieq $AdmxFileName) {
                $match = $true
                break
            }

            $cat = if ($def -is [hashtable]) { $def['categoryPath'] } else { $def.categoryPath }
            if ($cat) {
                $first = ($cat -split '\\' | Where-Object { $_ } | Select-Object -First 1)
                foreach ($cand in $namespaceCandidates) {
                    if ($first -and $first -ieq $cand) {
                        $match = $true
                        break
                    }
                }
                if (-not $match -and $admxStem -and ($cat -match [regex]::Escape($admxStem))) {
                    $match = $true
                }
                if (-not $match -and $admxStem -match '(?i)winget.*autoupdate' -and ($cat -match '(?i)winget-autoupdate')) {
                    $match = $true
                }
            }
            if ($match) { break }
        }
        if ($match) { $result += $gpc }
    }

    return $result
}

function Get-TenantGpcsReferencingAdmx {
    <#
    .SYNOPSIS
        Finds tenant GPCs that still have definitionValues tied to an uploaded ADMX namespace.
        Used when baseline JSON category paths differ from the live tenant (e.g. after partial migration).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$AdmxFileName,
        [string]$UploadedAdmxDisplayName
    )

    $admxStem = [System.IO.Path]::GetFileNameWithoutExtension($AdmxFileName)
    $patterns = @($UploadedAdmxDisplayName, $admxStem) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    # After ADMX revision/namespace change, tenant DVs may use aaS paths while baseline JSON still says Configurator.
    if ($admxStem -match '(?i)winget.*autoupdate') {
        $patterns += '(?i)winget-autoupdate'
    }
    $matched  = @()

    foreach ($gpc in Get-AllGroupPolicyConfigurations) {
        $dvs = Get-ExistingDefinitionValues -PolicyId $gpc.id
        $usesAdmx = $false
        foreach ($dv in $dvs) {
            $def = if ($dv -is [hashtable]) { $dv['definition'] } else { $dv.definition }
            if (-not $def) { continue }
            $cat = if ($def -is [hashtable]) { $def['categoryPath'] } else { $def.categoryPath }
            if (-not $cat) { continue }
            foreach ($pat in $patterns) {
                if ($pat -match '^\(\?') {
                    if ($cat -match $pat) { $usesAdmx = $true; break }
                }
                elseif ($cat -match [regex]::Escape($pat)) {
                    $usesAdmx = $true
                    break
                }
            }
            if ($usesAdmx) { break }
        }
        if ($usesAdmx) { $matched += $gpc }
    }

    return $matched
}

function Wait-GroupPolicyConfigurationsCleared {
    <#
    .SYNOPSIS
        Polls until the given GPCs have zero definitionValues (backend can lag after updateDefinitionValues).
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$PolicyIds,
        [int]$TimeoutSecs = 120,
        [int]$PollSeconds = 5
    )

    if ($PolicyIds.Count -eq 0) { return }

    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    while ((Get-Date) -lt $deadline) {
        $pending = @()
        foreach ($policyId in $PolicyIds) {
            $count = @(Get-ExistingDefinitionValues -PolicyId $policyId).Count
            if ($count -gt 0) { $pending += $policyId }
        }
        if ($pending.Count -eq 0) {
            Write-Host "  GPC definitionValues cleared (verified on $($PolicyIds.Count) GPC(s))" -ForegroundColor DarkGray
            return
        }
        Write-Host "  Waiting for GPC backend to release ADMX lock ($($pending.Count) GPC(s) still have definitionValues)..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $PollSeconds
    }

    throw "Timed out after ${TimeoutSecs}s waiting for GPC definitionValues to clear (ids: $($PolicyIds -join ', '))"
}

function Clear-GroupPolicyConfigurationsForAdmx {
    <#
    .SYNOPSIS
        Step 1 of ADMX strict replace: remove all definitionValues from tenant GPCs
        that depend on the ADMX file (configurations must be cleared before ADMX DELETE).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$AdmxFileName,
        [array]$AllPolicyConfigs = @(),
        [string]$UploadedAdmxDisplayName,
        [switch]$WhatIf,
        # Strict replace: DELETE the GPC resource (not just definitionValues). Step 4 recreates from baseline.
        [switch]$RemoveGpcShell
    )

    $baselineGpcs = Get-GpcBaselineConfigsForAdmxFile -AdmxFileName $AdmxFileName `
        -AllPolicyConfigs $AllPolicyConfigs -UploadedAdmxDisplayName $UploadedAdmxDisplayName

    $tenantGpcsToClear = @()
    if ($baselineGpcs.Count -gt 0) {
        foreach ($gpcBaseline in $baselineGpcs) {
            $gpcName = if ($gpcBaseline.displayName) { $gpcBaseline.displayName.Trim() } else { $gpcBaseline.name.Trim() }
            $tenantGpc = Get-AllGroupPolicyConfigurations | Where-Object { $_.displayName.Trim() -ieq $gpcName } | Select-Object -First 1
            if ($tenantGpc) { $tenantGpcsToClear += $tenantGpc }
        }
    }
    else {
        Write-Host "  No baseline GPC match for '$AdmxFileName' — scanning tenant for GPCs still using this ADMX..." -ForegroundColor DarkGray
        $tenantGpcsToClear = @(Get-TenantGpcsReferencingAdmx -AdmxFileName $AdmxFileName -UploadedAdmxDisplayName $UploadedAdmxDisplayName)
    }

    if ($tenantGpcsToClear.Count -eq 0) {
        Write-Host "  No tenant GPC definitionValues reference ADMX '$AdmxFileName' — nothing to clear" -ForegroundColor DarkGray
        return
    }

    if ($RemoveGpcShell) {
        # Any remaining imported-template GPC can block ADMX DELETE — scan the full tenant.
        $scanPatterns = @($UploadedAdmxDisplayName, [System.IO.Path]::GetFileNameWithoutExtension($AdmxFileName)) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        if ($AdmxFileName -match '(?i)winget.*autoupdate') { $scanPatterns += '(?i)winget-autoupdate' }

        foreach ($gpc in Get-AllGroupPolicyConfigurations) {
            if ($tenantGpcsToClear.id -contains $gpc.id) { continue }
            $dvs = Get-ExistingDefinitionValues -PolicyId $gpc.id
            $remove = $false
            foreach ($dv in $dvs) {
                $def = if ($dv -is [hashtable]) { $dv['definition'] } else { $dv.definition }
                if (-not $def) { continue }
                $pType = if ($def -is [hashtable]) { $def['policyType'] } else { $def.policyType }
                if ($pType -eq 'admxIngested') { $remove = $true; break }
                $cat = if ($def -is [hashtable]) { $def['categoryPath'] } else { $def.categoryPath }
                if (-not $cat) { continue }
                foreach ($pat in $scanPatterns) {
                    if ($pat -match '^\(\?') { if ($cat -match $pat) { $remove = $true; break } }
                    elseif ($cat -match [regex]::Escape($pat)) { $remove = $true; break }
                }
                if ($remove) { break }
            }
            if ($remove) { $tenantGpcsToClear += $gpc }
        }
        $tenantGpcsToClear = @($tenantGpcsToClear | Sort-Object -Property id -Unique)

        Write-Host "  Removing $($tenantGpcsToClear.Count) tenant GPC profile(s) before ADMX replace (will recreate from baseline)..." -ForegroundColor Cyan
        foreach ($tenantGpc in $tenantGpcsToClear) {
            $gpcName = $tenantGpc.displayName.Trim()
            if ($WhatIf) {
                Write-Host "    [WhatIf] Would DELETE GPC '$gpcName' (id: $($tenantGpc.id))" -ForegroundColor DarkCyan
                continue
            }
            Write-Host "    DELETE GPC '$gpcName' (id: $($tenantGpc.id))..."
            Invoke-GraphApiWrite -Method DELETE -Uri "$gpcBaseUri/$($tenantGpc.id)"
            $script:PolicyCache.Remove("group-policy-configurations")
        }
        return
    }

    Write-Host "  Clearing definitionValues from $($tenantGpcsToClear.Count) tenant GPC(s) before ADMX replace..." -ForegroundColor Cyan

    foreach ($tenantGpc in $tenantGpcsToClear) {
        $gpcName = $tenantGpc.displayName.Trim()

        $existingDvs = Get-ExistingDefinitionValues -PolicyId $tenantGpc.id
        $deletedIds    = @($existingDvs | ForEach-Object {
            if ($_ -is [hashtable]) { $_['id'] } else { $_.id }
        } | Where-Object { $_ })

        if ($deletedIds.Count -eq 0) {
            Write-Host "    GPC '$gpcName' has no definitionValues — already clear" -ForegroundColor DarkGray
            continue
        }

        Write-Host "    Clearing $($deletedIds.Count) setting(s) from GPC '$gpcName' (id: $($tenantGpc.id))..."

        if ($WhatIf) {
            Write-Host "    [WhatIf] Would delete $($deletedIds.Count) definitionValue(s)" -ForegroundColor DarkCyan
            continue
        }

        Invoke-UpdateDefinitionValues -PolicyId $tenantGpc.id -DeletedIds $deletedIds
        $script:PolicyCache.Remove("group-policy-configurations")
    }

    $clearedIds = @($tenantGpcsToClear | ForEach-Object { $_.id } | Where-Object { $_ })
    Wait-GroupPolicyConfigurationsCleared -PolicyIds $clearedIds

    # Clear any additional tenant GPCs discovered after the first pass (e.g. second profile still referencing ADMX).
    $remaining = @(Get-TenantGpcsReferencingAdmx -AdmxFileName $AdmxFileName -UploadedAdmxDisplayName $UploadedAdmxDisplayName |
        Where-Object { $clearedIds -notcontains $_.id })
    foreach ($extraGpc in $remaining) {
        $gpcName = $extraGpc.displayName.Trim()
        $existingDvs = Get-ExistingDefinitionValues -PolicyId $extraGpc.id
        $deletedIds = @($existingDvs | ForEach-Object { if ($_ -is [hashtable]) { $_['id'] } else { $_.id } } | Where-Object { $_ })
        if ($deletedIds.Count -eq 0) { continue }
        Write-Host "  Clearing $($deletedIds.Count) additional setting(s) from GPC '$gpcName'..." -ForegroundColor Cyan
        if (-not $WhatIf) {
            Invoke-UpdateDefinitionValues -PolicyId $extraGpc.id -DeletedIds $deletedIds
            $script:PolicyCache.Remove("group-policy-configurations")
            $clearedIds += $extraGpc.id
        }
    }
    if ($remaining.Count -gt 0 -and -not $WhatIf) {
        Wait-GroupPolicyConfigurationsCleared -PolicyIds $clearedIds
    }
}

function ConvertTo-DefinitionValueKey {
    <#
    .SYNOPSIS
        Returns a canonical key for a definitionValue used in comparison.
        Prefers identifiers that are stable across tenants:
          1. policyName + classType (always stable - ADMX policy name)
          2. displayName + classType (stable across tenants; categoryPath is NOT used
             because baseline exports often use a different ADMX namespace segment than
             the live tenant, e.g. Configurator vs aaS for WinGet-AutoUpdate)
          3. raw definition.id GUID (last-resort; only stable within one tenant)
    #>
    param($DefinitionValue)

    $def       = if ($DefinitionValue -is [hashtable]) { $DefinitionValue['definition'] } else { $DefinitionValue.definition }
    if ($null -eq $def) { return $null }

    $policyName  = if ($def -is [hashtable]) { $def['policyName']   } else { $def.policyName   }
    $classType   = if ($def -is [hashtable]) { $def['classType']    } else { $def.classType    }
    $defId       = if ($def -is [hashtable]) { $def['id']           } else { $def.id           }
    $displayName = if ($def -is [hashtable]) { $def['displayName']  } else { $def.displayName  }

    if ($policyName -and $classType) {
        return "name|$($classType.ToString().ToLower())|$($policyName.ToString().ToLower())"
    }
    if ($displayName -and $classType) {
        return "dn|$($classType.ToString().ToLower())|$($displayName.ToString().ToLower())"
    }
    return $defId
}

function Get-ComparableDesiredDefinitionValues {
    <#
    .SYNOPSIS
        Filters baseline definitionValues to those that exist in the tenant ADMX catalog.
        Skips deprecated/removed settings still present in baseline JSON (e.g. Reinstall on Policy Update).
    #>
    param(
        [array]$DesiredValues,
        [string]$PolicyId
    )

    if (-not $PolicyId -or $DesiredValues.Count -eq 0) {
        return $DesiredValues
    }

    $filtered = @()
    foreach ($dv in $DesiredValues) {
        $def = if ($dv -is [hashtable]) { $dv['definition'] } else { $dv.definition }
        if (-not $def) { continue }

        $displayName = if ($def -is [hashtable]) { $def['displayName'] } else { $def.displayName }
        $resolved    = Resolve-DefinitionId -DefinitionEntry $def
        if (-not $resolved) {
            Write-Host "  [i] Baseline setting '$displayName' not in tenant ADMX — excluded from compare" -ForegroundColor DarkGray
            continue
        }
        $filtered += $dv
    }
    return $filtered
}

function Get-NormalizedPresentationValuesFingerprint {
    <#
    .SYNOPSIS
        Builds a comparable fingerprint for presentationValues (value/values only, sorted).
    #>
    param($PresentationValues)

    if ($null -eq $PresentationValues) { return '[]' }

    $items = @()
    if ($PresentationValues -is [System.Collections.IEnumerable] -and $PresentationValues -isnot [string]) {
        $items = @($PresentationValues | Where-Object { $_ })
    }
    elseif ($PresentationValues) {
        $items = @($PresentationValues)
    }

    if ($items.Count -eq 0) { return '[]' }

    $fingerprints = foreach ($pv in $items) {
        $type   = if ($pv -is [hashtable]) { $pv['@odata.type'] } else { $pv.'@odata.type' }
        $value  = if ($pv -is [hashtable]) { $pv['value'] } else { $pv.value }
        $values = if ($pv -is [hashtable]) { $pv['values'] } else { $pv.values }
        $vs     = if ($values) { @($values | Sort-Object) } else { @() }
        [PSCustomObject]@{
            t  = [string]$type
            v  = [string]$value
            vs = ($vs -join '|')
        }
    }

    return ($fingerprints | Sort-Object { "$($_.t)|$($_.v)|$($_.vs)" } | ConvertTo-Json -Compress)
}

function Merge-GpcPlanChangeDetails {
    <#
    .SYNOPSIS
        Merges metadata and definitionValue diffs into a single Changes object for WhatIf JSON.
    #>
    param(
        $MetadataDiff,
        $DefinitionValuesDiff
    )

    $out = @{
        Added          = @()
        Removed        = @()
        Modified       = @()
        ModifiedValues = @{}
    }

    if ($MetadataDiff) {
        if ($MetadataDiff.Added)          { $out.Added    += @($MetadataDiff.Added) }
        if ($MetadataDiff.Removed)        { $out.Removed  += @($MetadataDiff.Removed) }
        if ($MetadataDiff.Modified)       { $out.Modified += @($MetadataDiff.Modified) }
        if ($MetadataDiff.ModifiedValues) { $out.ModifiedValues = $MetadataDiff.ModifiedValues }
    }

    if ($DefinitionValuesDiff) {
        foreach ($key in @($DefinitionValuesDiff.Added)) {
            $label = ($key -split '\|')[-1]
            $out.Added += "Setting: $label (in baseline, not deployed in tenant)"
        }
        foreach ($key in @($DefinitionValuesDiff.Removed)) {
            $label = ($key -split '\|')[-1]
            $out.Removed += "Setting: $label (in tenant, not in baseline)"
        }
        foreach ($entry in @($DefinitionValuesDiff.Modified)) {
            if ($entry -match '^[^:]+:\s*(.+)') {
                $out.Modified += $Matches[1]
            }
            else {
                $out.Modified += $entry
            }
        }
    }

    return $out
}

function Compare-GroupPolicyDefinitionValues {
    <#
    .SYNOPSIS
        Compares desired definitionValues (from baseline) against existing ones (from API).
    .RETURNS
        Hashtable with: IsEquivalent, Added, Removed, Modified arrays.
    #>
    param(
        [array]$DesiredValues,
        [array]$ExistingValues
    )

    $result = @{
        IsEquivalent = $true
        Added        = @()
        Removed      = @()
        Modified     = @()
    }

    # Build lookup maps by canonical key
    $desiredMap  = @{}
    $existingMap = @{}

    foreach ($dv in $DesiredValues) {
        $key = ConvertTo-DefinitionValueKey -DefinitionValue $dv
        if ($key) { $desiredMap[$key] = $dv }
    }
    foreach ($dv in $ExistingValues) {
        $key = ConvertTo-DefinitionValueKey -DefinitionValue $dv
        if ($key) { $existingMap[$key] = $dv }
    }

    # Added
    foreach ($key in $desiredMap.Keys) {
        if (-not $existingMap.ContainsKey($key)) {
            $result.Added += $key
            $result.IsEquivalent = $false
        }
    }

    # Removed
    foreach ($key in $existingMap.Keys) {
        if (-not $desiredMap.ContainsKey($key)) {
            $result.Removed += $key
            $result.IsEquivalent = $false
        }
    }

    # Modified (enabled flag or presentationValues changed)
    foreach ($key in $desiredMap.Keys) {
        if (-not $existingMap.ContainsKey($key)) { continue }  # already in Added

        $desired  = $desiredMap[$key]
        $existing = $existingMap[$key]

        $desiredEnabled  = if ($desired  -is [hashtable]) { $desired['enabled']  } else { $desired.enabled  }
        $existingEnabled = if ($existing -is [hashtable]) { $existing['enabled'] } else { $existing.enabled }

        if ($desiredEnabled -ne $existingEnabled) {
            $result.Modified += "${key}: enabled $existingEnabled → $desiredEnabled"
            $result.IsEquivalent = $false
            continue
        }

        # Compare presentationValues by semantic value (ignore tenant-specific bind URLs and ids)
        $desiredPV  = if ($desired  -is [hashtable]) { $desired['presentationValues']  } else { $desired.presentationValues  }
        $existingPV = if ($existing -is [hashtable]) { $existing['presentationValues'] } else { $existing.presentationValues }

        $desiredFP  = Get-NormalizedPresentationValuesFingerprint -PresentationValues $desiredPV
        $existingFP = Get-NormalizedPresentationValuesFingerprint -PresentationValues $existingPV

        # Baseline exports often have presentationValues:null while the tenant has real values
        # (export gap). When enabled flags already match, do not treat missing baseline PVs as drift.
        if ($desiredFP -eq '[]' -and $existingFP -ne '[]') {
            continue
        }

        if ($desiredFP -ne $existingFP) {
            $label = ($key -split '\|')[-1]
            $result.Modified += "${key}: presentationValues changed ($label)"
            $result.IsEquivalent = $false
        }
    }

    return $result
}

function Build-DefinitionValueBody {
    <#
    .SYNOPSIS
        Builds a definitionValue entry for updateDefinitionValues (added/updated arrays).
    .RETURNS
        Hashtable ready for JSON serialisation, or $null on resolution failure.
    #>
    param(
        [Parameter(Mandatory=$true)]
        $DesiredValue,      # The definitionValue entry from baseline JSON

        [Parameter(Mandatory=$true)]
        [string]$PolicyId,

        [string]$DefinitionValueId   # Required for 'updated' array entries
    )

    $enabled         = if ($DesiredValue -is [hashtable]) { $DesiredValue['enabled']         } else { $DesiredValue.enabled         }
    $definition      = if ($DesiredValue -is [hashtable]) { $DesiredValue['definition']      } else { $DesiredValue.definition      }
    $presentationValues = if ($DesiredValue -is [hashtable]) { $DesiredValue['presentationValues'] } else { $DesiredValue.presentationValues }

    if ($null -eq $definition) {
        Write-Host "  ##[error]definitionValue is missing 'definition' sub-object" -ForegroundColor Red
        return $null
    }

    $resolved = Resolve-DefinitionId -DefinitionEntry $definition
    if (-not $resolved) {
        return $null
    }

    $tenantDefId   = if ($resolved -is [hashtable]) { $resolved['id'] }            else { $resolved.id }
    $resolvedName  = if ($resolved -is [hashtable]) { $resolved['displayName'] }   else { $resolved.displayName }
    $effEnabled    = if ($null -ne $enabled) { [bool]$enabled } else { $true }
    $pvArray       = @($presentationValues | Where-Object { $_ })

    # Sanity check: enabled=true settings whose ADMX definition has presentations
    # MUST carry presentationValues (especially when any presentation is required).
    # Our baseline often has presentationValues:null because the original export
    # lost the user-entered values. Sending the batch with such a setting fails
    # the whole updateDefinitionValues call with a generic 400 from the GroupPolicy
    # Admin Service. Skip these settings with a warning so the rest of the batch
    # still applies.
    if ($effEnabled -and $pvArray.Count -eq 0) {
        $tenantPres = @(Get-PresentationsForDefinition -Definition $resolved)
        if ($tenantPres.Count -gt 0) {
            $requiredCount = @($tenantPres | Where-Object { $_.required -eq $true }).Count
            $types         = @($tenantPres | ForEach-Object { ($_.'@odata.type' -replace '#microsoft.graph.groupPolicyPresentation','') -replace '#microsoft.graph.','' }) -join ', '
            Write-Host "  ##[warning]Skipping enabled setting '$resolvedName' - definition has $($tenantPres.Count) presentation(s) [$types] (required=$requiredCount) but baseline has no presentationValues" -ForegroundColor Yellow
            return $null
        }
    }

    $body = @{
        enabled                = $effEnabled
        "definition@odata.bind" = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('$tenantDefId')"
    }

    if ($DefinitionValueId) {
        $body['id'] = $DefinitionValueId
    }

    if ($pvArray.Count -gt 0) {
        $body['presentationValues'] = @(Resolve-PresentationValues -PresentationValues $pvArray -ResolvedDefinition $resolved)
    }
    else {
        $body['presentationValues'] = @()
    }

    return $body
}

function Resolve-PresentationValues {
    <#
    .SYNOPSIS
        Translates source-tenant presentation@odata.bind URLs to target-tenant URLs.
    .DESCRIPTION
        Each baseline presentationValue carries a bind URL of the form
            .../groupPolicyDefinitions('{srcDefId}')/presentations('{srcPresId}')
        Both GUIDs are source-tenant-specific.

        Since the baseline does NOT capture source-tenant presentation labels, we use
        positional matching: presentationValues[i] maps to the target definition's
        presentations[i]. This is safe because ADMX presentations are emitted in a
        stable order by the ADMX/ADML file (the same order both tenants see).
    .RETURNS
        Array of presentationValue hashtables ready for the update body.
    #>
    param(
        [Parameter(Mandatory=$true)][array]$PresentationValues,
        [Parameter(Mandatory=$true)]$ResolvedDefinition
    )

    $tenantDefId   = if ($ResolvedDefinition -is [hashtable]) { $ResolvedDefinition['id'] } else { $ResolvedDefinition.id }
    $tenantPresArr = @(Get-PresentationsForDefinition -Definition $ResolvedDefinition)

    $out = @()
    for ($i = 0; $i -lt $PresentationValues.Count; $i++) {
        $src = $PresentationValues[$i]
        if ($null -eq $src) { continue }

        # Clone via JSON round-trip so we can safely mutate the bind URL
        $clone = $src | ConvertTo-Json -Depth 15 -Compress | ConvertFrom-Json -AsHashtable

        $targetPid = $null
        if ($i -lt $tenantPresArr.Count) {
            $p2 = $tenantPresArr[$i]
            $targetPid = if ($p2 -is [hashtable]) { $p2['id'] } else { $p2.id }
        }

        if ($targetPid) {
            $clone['presentation@odata.bind'] = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions('$tenantDefId')/presentations('$targetPid')"
        }
        else {
            Write-Host "  ##[warning]No target presentation at index $i for definition '$tenantDefId' (tenant has $($tenantPresArr.Count)) - leaving original bind URL" -ForegroundColor Yellow
        }

        $out += $clone
    }
    return $out
}

function Clear-GpoDefinitionCaches {
    $script:AllDefinitionsCache          = $null
    $script:UploadedFilesIndexByFileName = $null
}

function Invoke-UpdateDefinitionValuesPhase {
    <#
    .SYNOPSIS
        Internal: issues one updateDefinitionValues call for a single operation phase
        (added | updated | deletedIds). Retries on transient failures.
    #>
    param(
        [Parameter(Mandatory=$true)][string]$PolicyId,
        [array]$Added      = @(),
        [array]$Updated    = @(),
        [array]$DeletedIds = @(),
        [Parameter(Mandatory=$true)][string]$PhaseLabel,
        [int]$MaxAttempts  = 3,
        [int]$RetrySecs    = 20
    )

    if ($Added.Count -eq 0 -and $Updated.Count -eq 0 -and $DeletedIds.Count -eq 0) { return }

    $uri = "$gpcBaseUri/$PolicyId/updateDefinitionValues"

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $body = @{
            added      = @($Added)
            updated    = @($Updated)
            deletedIds = @($DeletedIds)
        } | ConvertTo-Json -Depth 15

        if ($env:DEBUG_UPDATE_DEF_VALUES -eq '1' -or $VerbosePreference -ne 'SilentlyContinue') {
            Write-Host "  [debug] $PhaseLabel body ($([System.Text.Encoding]::UTF8.GetByteCount($body)) bytes):" -ForegroundColor DarkCyan
            Write-Host $body -ForegroundColor DarkGray
        }

        try {
            Invoke-GraphApiWrite -Method POST -Uri $uri -Body $body
            return
        }
        catch {
            if ($attempt -ge $MaxAttempts) {
                Write-Host "  [!] $PhaseLabel body that failed ($([System.Text.Encoding]::UTF8.GetByteCount($body)) bytes):" -ForegroundColor Red
                Write-Host $body -ForegroundColor DarkRed
                throw
            }
            Write-Host "  $PhaseLabel failed (attempt $attempt/$MaxAttempts) - clearing definition cache, retrying in ${RetrySecs}s..." -ForegroundColor DarkCyan
            Clear-GpoDefinitionCaches
            Start-Sleep $RetrySecs
        }
    }
}

function Invoke-UpdateDefinitionValues {
    <#
    .SYNOPSIS
        Applies definitionValue changes by mirroring the Intune portal flow.
    .DESCRIPTION
        The GroupPolicyAdminService backend rejects payloads that mix delete with add/update
        operations — captured HARs show the portal NEVER sends deletes alongside adds in a
        single call. It performs deletes first, then adds, then updates, each as a separate
        POST. We replicate that ordering here. Each phase still goes to /updateDefinitionValues
        with the standard { added, updated, deletedIds } envelope.
    #>
    param(
        [Parameter(Mandatory=$true)][string]$PolicyId,
        [array]$Added      = @(),
        [array]$Updated    = @(),
        [array]$DeletedIds = @(),
        [int]$MaxAttempts  = 3,
        [int]$RetrySecs    = 20
    )

    if ($Added.Count -eq 0 -and $Updated.Count -eq 0 -and $DeletedIds.Count -eq 0) { return }

    if ($DeletedIds.Count -gt 0) {
        Invoke-UpdateDefinitionValuesPhase -PolicyId $PolicyId `
            -DeletedIds $DeletedIds `
            -PhaseLabel "updateDefinitionValues[deletes=$($DeletedIds.Count)]" `
            -MaxAttempts $MaxAttempts -RetrySecs $RetrySecs
    }

    if ($Added.Count -gt 0) {
        Invoke-UpdateDefinitionValuesPhase -PolicyId $PolicyId `
            -Added $Added `
            -PhaseLabel "updateDefinitionValues[adds=$($Added.Count)]" `
            -MaxAttempts $MaxAttempts -RetrySecs $RetrySecs
    }

    if ($Updated.Count -gt 0) {
        Invoke-UpdateDefinitionValuesPhase -PolicyId $PolicyId `
            -Updated $Updated `
            -PhaseLabel "updateDefinitionValues[updates=$($Updated.Count)]" `
            -MaxAttempts $MaxAttempts -RetrySecs $RetrySecs
    }
}

function Sync-DefinitionValues {
    <#
    .SYNOPSIS
        Synchronises definitionValues for an existing Group Policy Configuration.
    .DESCRIPTION
        Compares desired vs existing and issues a single updateDefinitionValues call.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PolicyId,

        [Parameter(Mandatory=$true)]
        [array]$DesiredValues,

        [Parameter(Mandatory=$true)]
        [string]$DisplayName,

        [switch]$WhatIf
    )

    $existingValues = Get-ExistingDefinitionValues -PolicyId $PolicyId
    $diff = Compare-GroupPolicyDefinitionValues -DesiredValues $DesiredValues -ExistingValues $existingValues

    if ($diff.IsEquivalent) {
        Write-Host "  definitionValues: no changes needed ($($existingValues.Count) setting(s))"
        return $diff
    }

    Write-Host "  definitionValues: $($diff.Added.Count) to add, $($diff.Removed.Count) to remove, $($diff.Modified.Count) to update"
    foreach ($a in $diff.Added)    { Write-Host "    + $a" }
    foreach ($r in $diff.Removed)  { Write-Host "    - $r" }
    foreach ($m in $diff.Modified) { Write-Host "    ~ $m" }

    if ($WhatIf) { return $diff }

    # Build lookup maps
    $existingMap = @{}
    foreach ($dv in $existingValues) {
        $key = ConvertTo-DefinitionValueKey -DefinitionValue $dv
        if ($key) { $existingMap[$key] = $dv }
    }

    $desiredMap = @{}
    foreach ($dv in $DesiredValues) {
        $key = ConvertTo-DefinitionValueKey -DefinitionValue $dv
        if ($key) { $desiredMap[$key] = $dv }
    }

    if ($diff.Added.Count -gt 0 -or $diff.Removed.Count -gt 0 -or $diff.Modified.Count -gt 0) {
        $added = @(); $updated = @(); $deletedIds = @()

        foreach ($key in $diff.Removed) {
            $existingDV = $existingMap[$key]
            $dvId = if ($existingDV -is [hashtable]) { $existingDV['id'] } else { $existingDV.id }
            if ($dvId) { $deletedIds += $dvId }
        }
        # Build-DefinitionValueBody returns $null when it cannot construct a sendable
        # entry (unresolvable definition OR enabled+missing-required-presentationValues).
        # The specific reason is already logged inside Build-DefinitionValueBody; here
        # we just track the count so the rest of the batch can still apply.
        $skipped = @()
        foreach ($key in $diff.Added) {
            $body = Build-DefinitionValueBody -DesiredValue $desiredMap[$key] -PolicyId $PolicyId
            if (-not $body) { $skipped += $key; continue }
            $added += $body
        }
        foreach ($modEntry in $diff.Modified) {
            $key = ($modEntry -split ':')[0].Trim()
            $existingDV = $existingMap[$key]
            $desiredDV  = $desiredMap[$key]
            if (-not $existingDV -or -not $desiredDV) { continue }
            $dvId = if ($existingDV -is [hashtable]) { $existingDV['id'] } else { $existingDV.id }
            if (-not $dvId) { continue }
            $body = Build-DefinitionValueBody -DesiredValue $desiredDV -PolicyId $PolicyId -DefinitionValueId $dvId
            if (-not $body) { $skipped += $key; continue }
            $updated += $body
        }

        if ($skipped.Count -gt 0) {
            Write-Host "  ##[warning]Skipped $($skipped.Count) unresolvable setting(s): $($skipped -join '; ')" -ForegroundColor Yellow
        }

        if ($added.Count -eq 0 -and $updated.Count -eq 0 -and $deletedIds.Count -eq 0) {
            Write-Host "  No applyable changes after resolution - nothing to send" -ForegroundColor Yellow
            return $diff
        }

        Write-Host "  Applying definitionValues via updateDefinitionValues (added=$($added.Count), updated=$($updated.Count), deleted=$($deletedIds.Count))..."
        Write-Host "  (split into separate phases to match Intune portal flow: deletes → adds → updates)" -ForegroundColor DarkGray
        Invoke-UpdateDefinitionValues -PolicyId $PolicyId -Added $added -Updated $updated -DeletedIds $deletedIds
    }

    return $diff
}

function Repair-GroupPolicyConfigPayload {
    <#
    .SYNOPSIS
        Strips metadata and internal fields from a Group Policy Configuration payload
        before sending to the Graph API.
    #>
    param(
        [Parameter(Mandatory=$true)]
        $Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable

    $propsToRemove = @(
        'id', 'createdDateTime', 'lastModifiedDateTime', 'version',
        '@odata.context', '@odata.type',
        '_sourceFile', '_sourcePath', '_policyType', '_assignments', '_monitorConfig',
        # definitionValues are managed separately via the sub-resource
        'definitionValues'
    )
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) { $json.Remove($prop) }
    }

    # Ensure roleScopeTagIds is always a string array
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -isnot [System.Collections.IList]) {
            $json['roleScopeTagIds'] = @($tagIds.ToString())
        }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }

    # Remove nulls
    $keysToRemove = @($json.Keys | Where-Object { $null -eq $json[$_] })
    foreach ($k in $keysToRemove) { $json.Remove($k) }

    return $json
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-GroupPolicyConfigurations {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )

    $results = @()

    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }

        Write-Host "`n##[group]Processing [group-policy-configurations]: $displayName"

        if ($global:AdmxReplacementRequired -and -not $global:AdmxReplacementSucceeded) {
            Write-Host "  ##[warning]Skipping GPC definitionValues sync — ADMX replacement did not complete." -ForegroundColor Yellow
            Write-Host "##[endgroup]"
            $results += @{
                DisplayName = $displayName
                PolicyType  = "group-policy-configurations"
                Status      = "Skipped"
                Error       = "ADMX replacement did not complete"
            }
            continue
        }

        try {
            # Extract embedded definitionValues before touching the config
            $desiredDefinitionValues = @()
            if ($policyConfig.definitionValues) {
                $desiredDefinitionValues = @($policyConfig.definitionValues)
            }

            # ----------------------------------------------------------------
            # Check if configuration already exists (match by displayName)
            # ----------------------------------------------------------------
            $allConfigs     = Get-AllGroupPolicyConfigurations
            $existingConfig = $allConfigs | Where-Object { $_.displayName.Trim() -ieq $displayName } | Select-Object -First 1

            $action     = "Create"
            $hasChanges = $true
            $changeDetails = $null

            if ($existingConfig) {
                # Protection marker check
                if (Test-ResourceProtected -Description $existingConfig.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  [!] Protected: policy has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType  = "group-policy-configurations"
                        Status      = "Protected"
                        Changes     = @()
                    }
                    Write-Host "##[endgroup]"
                    continue
                }

                # Compare metadata (displayName, description, roleScopeTagIds)
                $metaIgnore = @('assignments', 'definitionValues', 'policyConfigurationIngestionType')
                $comparison = Compare-PolicyConfigurations `
                    -ExistingPolicy $existingConfig `
                    -DesiredPolicy  $policyConfig   `
                    -IgnoreProperties $metaIgnore   `
                    -ReturnDetails

                # Compare definitionValues separately (filter baseline entries absent from tenant ADMX)
                $comparableDesired = Get-ComparableDesiredDefinitionValues `
                    -DesiredValues $desiredDefinitionValues `
                    -PolicyId $existingConfig.id
                $existingDVs = Get-ExistingDefinitionValues -PolicyId $existingConfig.id
                $dvDiff      = Compare-GroupPolicyDefinitionValues `
                    -DesiredValues $comparableDesired `
                    -ExistingValues $existingDVs

                if ($comparison.IsEquivalent -and $dvDiff.IsEquivalent) {
                    $action     = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Policy exists - no changes needed"
                }
                else {
                    $merged = Merge-GpcPlanChangeDetails `
                        -MetadataDiff $comparison.Differences `
                        -DefinitionValuesDiff $dvDiff
                    $hasMeaningfulChanges = ($merged.Added.Count + $merged.Removed.Count + $merged.Modified.Count) -gt 0

                    if (-not $hasMeaningfulChanges) {
                        $action     = "NoChange"
                        $hasChanges = $false
                        Write-Host "  Policy exists - no meaningful changes (metadata/settings equivalent after normalization)"
                    }
                    else {
                        $action        = "Update"
                        $changeDetails = $merged
                        Write-Host "  Policy exists - changes detected, will update"

                        if ($comparison.Differences.Added.Count -gt 0)    { Write-Host "    Metadata added: $($comparison.Differences.Added -join ', ')" }
                        if ($comparison.Differences.Removed.Count -gt 0)  { Write-Host "    Metadata removed: $($comparison.Differences.Removed -join ', ')" }
                        if ($comparison.Differences.Modified.Count -gt 0) { Write-Host "    Metadata modified: $($comparison.Differences.Modified -join ', ')" }
                        if ($dvDiff.Added.Count -gt 0)    { Write-Host "    Settings added: $($dvDiff.Added -join ', ')" }
                        if ($dvDiff.Removed.Count -gt 0)  { Write-Host "    Settings removed: $($dvDiff.Removed -join ', ')" }
                        if ($dvDiff.Modified.Count -gt 0) { Write-Host "    Settings modified: $($dvDiff.Modified -join ', ')" }
                    }
                }
            }
            else {
                Write-Host "  Policy does not exist - will be created"
            }

            Write-Host "  Type: Group Policy Configuration  |  Settings: $($desiredDefinitionValues.Count)"

            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }

            # ----------------------------------------------------------------
            # WhatIf branch
            # ----------------------------------------------------------------
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create"   { "WouldCreate" }
                    "Update"   { "WouldUpdate" }
                    "NoChange" { "No changes"  }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"

                if ($existingConfig -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingConfig.id -PolicyType "group-policy-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) {
                        $whatIfStatus  = "WouldSyncAssignments"
                        $changeDetails = $assignSync.Changes
                    }
                }

                $resultEntry = @{ DisplayName = $displayName; PolicyType = "group-policy-configurations"; Status = $whatIfStatus }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                Write-Host "##[endgroup]"
                continue
            }

            # ----------------------------------------------------------------
            # No content changes — still sync assignments
            # ----------------------------------------------------------------
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingConfig.id -PolicyType "group-policy-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    PolicyType  = "group-policy-configurations"
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingConfig.id
                }
                Write-Host "##[endgroup]"
                continue
            }

            # ----------------------------------------------------------------
            # Build metadata payload (definitionValues managed separately)
            # ----------------------------------------------------------------
            $repairedConfig = Repair-GroupPolicyConfigPayload -Payload $policyConfig
            $jsonBody        = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 10

            $policyId = $null

            if ($action -eq "Create") {
                $response = Invoke-GraphApiWrite -Method POST -Uri $gpcBaseUri -Body $jsonBody
                $policyId = $response.id
                Write-Host "  [+] Group Policy Configuration created: $displayName (ID: $policyId)"

                # Invalidate cache
                $script:PolicyCache.Remove("group-policy-configurations")

                # Apply all definitionValues via batch updateDefinitionValues action.
                # Build-DefinitionValueBody logs and returns $null when it cannot resolve
                # a setting (missing tenant definition OR enabled-with-missing-required-
                # presentationValues). Skipping keeps the rest of the batch deployable.
                if ($desiredDefinitionValues.Count -gt 0) {
                    $added   = @()
                    $skipped = @()
                    foreach ($dv in $desiredDefinitionValues) {
                        $b = Build-DefinitionValueBody -DesiredValue $dv -PolicyId $policyId
                        if (-not $b) {
                            $skipName = if ($dv.definition) {
                                if ($dv.definition -is [hashtable]) { $dv.definition['displayName'] } else { $dv.definition.displayName }
                            } else { '<unknown>' }
                            $skipped += $skipName
                            continue
                        }
                        $added += $b
                    }

                    if ($skipped.Count -gt 0) {
                        Write-Host "  ##[warning]Skipped $($skipped.Count) of $($desiredDefinitionValues.Count) setting(s): $($skipped -join '; ')" -ForegroundColor Yellow
                    }

                    if ($added.Count -gt 0) {
                        Write-Host "  Applying $($added.Count) setting(s) via updateDefinitionValues..."
                        Invoke-UpdateDefinitionValues -PolicyId $policyId -Added $added
                    } else {
                        Write-Host "  ##[warning]No settings could be resolved - GPC created with no definitionValues" -ForegroundColor Yellow
                    }
                }
            }
            else {
                # PATCH metadata
                $patchUri = "$gpcBaseUri/$($existingConfig.id)"
                Invoke-GraphApiWrite -Method PATCH -Uri $patchUri -Body $jsonBody
                $policyId = $existingConfig.id
                Write-Host "  [~] Group Policy Configuration metadata updated: $displayName"

                # Invalidate cache
                $script:PolicyCache.Remove("group-policy-configurations")

                # Sync definitionValues
                Sync-DefinitionValues -PolicyId $policyId -DesiredValues $desiredDefinitionValues -DisplayName $displayName | Out-Null
            }

            # Sync assignments (Configure-Intune-Helpers now knows about group-policy-configurations)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "group-policy-configurations" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }

            $results += @{
                DisplayName = $displayName
                PolicyType  = "group-policy-configurations"
                Status      = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId    = $policyId
            }
        }
        catch {
            Write-Host "  ✗ Failed to process Group Policy Configuration '$displayName': $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process Group Policy Configuration: $displayName"
            Write-Host "##[error]Error: $_"

            $results += @{
                DisplayName = $displayName
                PolicyType  = "group-policy-configurations"
                Status      = "Failed"
                Error       = $_.ToString()
            }
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }

    return $results
}

# ============================================================================
# ENTRY POINT (skipped when dot-sourced — e.g. from Configure-Intune-ADMXFiles.ps1)
# ============================================================================

if ($MyInvocation.InvocationName -ne '.') {
    $gpcPolicies = @($PolicyConfigs | Where-Object { $_._policyType -eq "group-policy-configurations" })

    if ($gpcPolicies.Count -eq 0) {
        Write-Host "No Group Policy Configurations to process"
        return @()
    }

    Write-Host "`n##[section]Processing Group Policy Configurations ($($gpcPolicies.Count) configuration(s))"

    $results = Invoke-GroupPolicyConfigurations -Policies $gpcPolicies -WhatIf:$WhatIfMode

    return $results
}
