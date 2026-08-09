<#
.SYNOPSIS
    Deploys Microsoft Purview Information Protection settings from baseline JSON.

.DESCRIPTION
    Applies sensitivity labels, publishing policies, label policy rules, auto-labeling
    policies, and auto-labeling rules via Security & Compliance PowerShell.

    Processing order: labels (parents first) → label policies → label policy rules
    → auto-label policies → auto-label rules.

.PARAMETER ConfigDirectory
    Path to baseline/information-protection directory.

.NOTES
    Requires Compliance Administrator or Information Protection Administrator on the
    portal-connected delegated account.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigDirectory,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [string]$TenantBaselinePath,

    [Parameter(Mandatory = $false)]
    [string]$TenantRepoPath
)

$ErrorActionPreference = "Stop"

$connectGraphPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
$ipHelpersPath    = Join-Path $PSScriptRoot "..\common\Common-InformationProtectionHelpers.ps1"
if (Test-Path $connectGraphPath) { . $connectGraphPath }
if (Test-Path $ipHelpersPath) { . $ipHelpersPath }

$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$_ignoreDir = Join-Path $PSScriptRoot "..\compare-ignore-fields"
$_commonFields = try { (Get-Content (Join-Path $_ignoreDir "common.json") -Raw | ConvertFrom-Json).fields } catch { @() }
$_ipFields     = try { (Get-Content (Join-Path $_ignoreDir "information-protection.json") -Raw | ConvertFrom-Json).fields } catch { @() }
$script:IgnoreProperties = @($_commonFields) + @($_ipFields)

$script:DeployExcludeProps = @(
    'RunspaceId', 'PSComputerName', 'PSShowComputerName', 'PSObject',
    'Identity', 'Guid', 'ExchangeObjectId', 'DistinguishedName', 'OrganizationId',
    'OrganizationalUnitRoot', 'OriginatingServer', 'ObjectVersion', 'PolicyVersion',
    'WhenChanged', 'WhenCreated', 'WhenChangedUTC', 'WhenCreatedUTC',
    'CreatedBy', 'LastModifiedBy', 'ModifiedBy', 'IsValid', 'ObjectState',
    'DistributionStatus', 'DistributionResults', 'DistributionSyncStatus',
    'Workload', 'Mode', 'Comment', 'PolicyTemplateInfo', 'PolicyRBACScopes',
    'PolicyName', 'PolicyGuid', 'Rules', '_policyName', '_policyGuid'
)

$WhatIfMode = $WhatIfPreference
$allowCreate = ($env:ALLOW_CREATE -ne 'false')
$allowUpdate = ($env:ALLOW_UPDATE -ne 'false')

$planResults = @{
    Service          = "InformationProtection"
    Timestamp        = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    WouldCreateCount = 0
    WouldUpdateCount = 0
    NoChangeCount    = 0
    ErrorCount       = 0
    Results          = @()
}

function Save-PlanOutput {
    if ($OutputPath) {
        $planResults | ConvertTo-Json -Depth 20 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
        Write-Host "Plan saved to: $OutputPath"
    }
}

function Add-PlanResult {
    param(
        [string]$DisplayName,
        [string]$Type,
        [string]$Status,
        [hashtable]$Changes = @{},
        [string]$FilePath = $null
    )
    $entry = @{
        DisplayName = $DisplayName
        Type        = $Type
        Status      = $Status
        Changes     = $Changes
    }
    if ($FilePath) { $entry['FilePath'] = $FilePath }
    $script:planResults.Results += [PSCustomObject]$entry

    switch -Regex ($Status) {
        'WouldCreate|Would Create' { $script:planResults.WouldCreateCount++ }
        'WouldUpdate|Would Update' { $script:planResults.WouldUpdateCount++ }
        'NoChange|No Change|Unchanged' { $script:planResults.NoChangeCount++ }
        'Error|Failed' { $script:planResults.ErrorCount++ }
    }
}

function ConvertTo-ComparableHashtable {
    param(
        [Parameter(Mandatory = $true)] $Policy,
        [string[]]$IgnoreProps = @()
    )
    $result = @{}
    if ($Policy -is [System.Collections.IDictionary]) {
        foreach ($key in $Policy.Keys) {
            if ($key -in $IgnoreProps -or $key -in $script:IgnoreProperties -or $key -in $script:DeployExcludeProps) { continue }
            $result[$key] = $Policy[$key]
        }
    }
    elseif ($null -ne $Policy.PSObject) {
        foreach ($prop in $Policy.PSObject.Properties) {
            if ($prop.MemberType -notin @('NoteProperty', 'Property')) { continue }
            if ($prop.Name -in $IgnoreProps -or $prop.Name -in $script:IgnoreProperties -or $prop.Name -in $script:DeployExcludeProps) { continue }
            if ($prop.Name -like 'PS*') { continue }
            $result[$prop.Name] = $prop.Value
        }
    }
    return $result
}

function Compare-PolicyValues {
    param($Value1, $Value2)
    $isEmpty1 = ($null -eq $Value1) -or ($Value1 -is [string] -and [string]::IsNullOrEmpty($Value1)) -or ($Value1 -is [System.Collections.ICollection] -and $Value1.Count -eq 0)
    $isEmpty2 = ($null -eq $Value2) -or ($Value2 -is [string] -and [string]::IsNullOrEmpty($Value2)) -or ($Value2 -is [System.Collections.ICollection] -and $Value2.Count -eq 0)
    if ($isEmpty1 -and $isEmpty2) { return $true }
    if ($isEmpty1 -or $isEmpty2) { return $false }
    if ($Value1 -is [System.Collections.ICollection] -and $Value2 -is [System.Collections.ICollection]) {
        return (($Value1 | Sort-Object) -join '|') -eq (($Value2 | Sort-Object) -join '|')
    }
    return "$Value1" -eq "$Value2"
}

function Compare-IPPSPolicyProperties {
    param(
        [Parameter(Mandatory = $true)] $ExistingPolicy,
        [Parameter(Mandatory = $true)] $DesiredPolicy,
        [string[]]$AdditionalIgnoreProps = @()
    )
    $result = @{
        IsEquivalent = $true
        Differences  = @{ Modified = @(); ModifiedValues = @{} }
    }
    $existing = ConvertTo-ComparableHashtable -Policy $ExistingPolicy -IgnoreProps $AdditionalIgnoreProps
    $desired  = ConvertTo-ComparableHashtable -Policy $DesiredPolicy  -IgnoreProps $AdditionalIgnoreProps
    $allKeys = @($desired.Keys) | Sort-Object -Unique
    foreach ($key in $allKeys) {
        if (-not (Compare-PolicyValues -Value1 $existing[$key] -Value2 $desired[$key])) {
            $result.Differences.Modified += $key
            $result.Differences.ModifiedValues[$key] = @{
                Existing = "$($existing[$key])"
                Desired  = "$($desired[$key])"
            }
            $result.IsEquivalent = $false
        }
    }
    return $result
}

function Get-DeployParameters {
    param(
        [Parameter(Mandatory = $true)] $Desired,
        [string[]]$AdditionalExclude = @()
    )
    $exclude = @($script:DeployExcludeProps) + @($AdditionalExclude)
    $params = @{}
    if ($Desired -is [System.Collections.IDictionary]) {
        foreach ($key in $Desired.Keys) {
            if ($key -in $exclude) { continue }
            if ($null -ne $Desired[$key]) { $params[$key] = $Desired[$key] }
        }
    }
    else {
        foreach ($prop in $Desired.PSObject.Properties) {
            if ($prop.Name -in $exclude) { continue }
            if ($null -ne $prop.Value) { $params[$prop.Name] = $prop.Value }
        }
    }
    return $params
}

function Resolve-ConfigObject {
    param([Parameter(Mandatory = $true)] $Config)
    $hash = @{}
    if ($Config -is [System.Collections.IDictionary]) {
        foreach ($key in $Config.Keys) { $hash[$key] = $Config[$key] }
    }
    else {
        foreach ($prop in $Config.PSObject.Properties) { $hash[$prop.Name] = $prop.Value }
    }
    return Resolve-Placeholders -ConfigObject $hash
}

function Get-SortedLabelFiles {
    param([System.IO.FileInfo[]]$Files)

    $entries = @()
    foreach ($f in $Files) {
        $cfg = Resolve-ConfigObject -Config (Get-Content $f.FullName -Raw | ConvertFrom-Json)
        $parentRef = $null
        if ($cfg.PSObject.Properties.Name -contains 'ParentId' -and $cfg.ParentId) {
            $parentRef = "$($cfg.ParentId)"
        }
        elseif ($cfg.PSObject.Properties.Name -contains 'Parent' -and $cfg.Parent) {
            $parentRef = "$($cfg.Parent)"
        }
        $entries += [PSCustomObject]@{
            File       = $f
            Name       = if ($cfg.Name) { $cfg.Name } else { $f.BaseName }
            ParentRef  = $parentRef
        }
    }

    $sorted = @()
    $remaining = @($entries)
    $guard = 0
    while ($remaining.Count -gt 0 -and $guard -lt 1000) {
        $guard++
        $ready = @($remaining | Where-Object {
            -not $_.ParentRef -or
            ($sorted.Name -contains $_.ParentRef) -or
            (-not ($remaining.Name -contains $_.ParentRef))
        })
        if ($ready.Count -eq 0) {
            $sorted += $remaining
            break
        }
        $sorted += $ready
        $readyNames = @($ready | ForEach-Object { $_.Name })
        $remaining = @($remaining | Where-Object { $_.Name -notin $readyNames })
    }
    return @($sorted | ForEach-Object { $_.File })
}

function Invoke-LabelDeploy {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File
    )

    $displayName = $File.BaseName
    $desired = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    if ($desired.Name) { $displayName = $desired.Name }

    $existing = $null
    try { $existing = Get-Label -Identity $displayName -ErrorAction Stop } catch { }

    if (-not $existing) {
        if (-not $allowCreate) {
            Add-PlanResult -DisplayName $displayName -Type "Label" -Status "Skipped (ALLOW_CREATE=false)" -FilePath $File.FullName
            return
        }
        $params = Get-DeployParameters -Desired $desired -AdditionalExclude @('Name')
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName $displayName -Type "Label" -Status "WouldCreate" -Changes @{ Action = "Create label" } -FilePath $File.FullName
            return
        }
        if ($PSCmdlet.ShouldProcess($displayName, "Create sensitivity label")) {
            New-Label -Name $displayName @params | Out-Null
            Add-PlanResult -DisplayName $displayName -Type "Label" -Status "Created" -FilePath $File.FullName
        }
        return
    }

    $compare = Compare-IPPSPolicyProperties -ExistingPolicy $existing -DesiredPolicy $desired
    if ($compare.IsEquivalent) {
        Add-PlanResult -DisplayName $displayName -Type "Label" -Status "NoChange" -FilePath $File.FullName
        return
    }

    if (-not $allowUpdate) {
        Add-PlanResult -DisplayName $displayName -Type "Label" -Status "Skipped (ALLOW_UPDATE=false)" -Changes $compare.Differences -FilePath $File.FullName
        return
    }

    $params = Get-DeployParameters -Desired $desired -AdditionalExclude @('Name')
    if ($WhatIfMode) {
        Add-PlanResult -DisplayName $displayName -Type "Label" -Status "WouldUpdate" -Changes $compare.Differences -FilePath $File.FullName
        return
    }
    if ($PSCmdlet.ShouldProcess($displayName, "Update sensitivity label")) {
        Set-Label -Identity $displayName @params | Out-Null
        Add-PlanResult -DisplayName $displayName -Type "Label" -Status "Updated" -Changes $compare.Differences -FilePath $File.FullName
    }
}

function Invoke-LabelPolicyDeploy {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    $displayName = $File.BaseName
    $desired = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    if ($desired.Name) { $displayName = $desired.Name }

    $existing = $null
    try { $existing = Get-LabelPolicy -Identity $displayName -ErrorAction Stop } catch { }

    if (-not $existing) {
        if (-not $allowCreate) {
            Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "Skipped (ALLOW_CREATE=false)" -FilePath $File.FullName
            return
        }
        $params = Get-DeployParameters -Desired $desired
        if (-not $params.ContainsKey('Name')) { $params['Name'] = $displayName }
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "WouldCreate" -FilePath $File.FullName
            return
        }
        if ($PSCmdlet.ShouldProcess($displayName, "Create label policy")) {
            New-LabelPolicy @params | Out-Null
            Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "Created" -FilePath $File.FullName
        }
        return
    }

    $compare = Compare-IPPSPolicyProperties -ExistingPolicy $existing -DesiredPolicy $desired
    if ($compare.IsEquivalent) {
        Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "NoChange" -FilePath $File.FullName
        return
    }

    if (-not $allowUpdate) {
        Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "Skipped (ALLOW_UPDATE=false)" -Changes $compare.Differences -FilePath $File.FullName
        return
    }

    $params = Get-DeployParameters -Desired $desired -AdditionalExclude @('Name')
    if ($WhatIfMode) {
        Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "WouldUpdate" -Changes $compare.Differences -FilePath $File.FullName
        return
    }
    if ($PSCmdlet.ShouldProcess($displayName, "Update label policy")) {
        Set-LabelPolicy -Identity $displayName @params | Out-Null
        Add-PlanResult -DisplayName $displayName -Type "LabelPolicy" -Status "Updated" -Changes $compare.Differences -FilePath $File.FullName
    }
}

function Invoke-RuleSetDeploy {
    param(
        [Parameter(Mandatory = $true)][string]$RuleType,
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][scriptblock]$GetExistingRules,
        [Parameter(Mandatory = $true)][scriptblock]$NewRule,
        [Parameter(Mandatory = $true)][scriptblock]$SetRule
    )

    $payload = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    $policyName = if ($payload.PolicyName) { $payload.PolicyName } else { $File.BaseName -replace '\.rules$', '' }
    $rules = @($payload.Rules)
    if ($rules.Count -eq 0) { return }

    $existingRules = @(& $GetExistingRules $policyName $payload)
    foreach ($desiredRule in $rules) {
        $ruleName = if ($desiredRule.Name) { $desiredRule.Name } else { "$policyName rule" }
        $existing = $existingRules | Where-Object { $_.Name -eq $ruleName } | Select-Object -First 1

        if (-not $existing) {
            if (-not $allowCreate) {
                Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "Skipped (ALLOW_CREATE=false)" -FilePath $File.FullName
                continue
            }
            $params = Get-DeployParameters -Desired $desiredRule
            if ($WhatIfMode) {
                Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "WouldCreate" -FilePath $File.FullName
                continue
            }
            if ($PSCmdlet.ShouldProcess("$policyName / $ruleName", "Create $RuleType")) {
                & $NewRule $params | Out-Null
                Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "Created" -FilePath $File.FullName
            }
            continue
        }

        $compare = Compare-IPPSPolicyProperties -ExistingPolicy $existing -DesiredPolicy $desiredRule
        if ($compare.IsEquivalent) {
            Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "NoChange" -FilePath $File.FullName
            continue
        }

        if (-not $allowUpdate) {
            Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "Skipped (ALLOW_UPDATE=false)" -Changes $compare.Differences -FilePath $File.FullName
            continue
        }

        $params = Get-DeployParameters -Desired $desiredRule
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "WouldUpdate" -Changes $compare.Differences -FilePath $File.FullName
            continue
        }
        if ($PSCmdlet.ShouldProcess("$policyName / $ruleName", "Update $RuleType")) {
            if (-not $params.ContainsKey('Identity')) { $params['Identity'] = $ruleName }
            & $SetRule $params | Out-Null
            Add-PlanResult -DisplayName "$policyName / $ruleName" -Type $RuleType -Status "Updated" -Changes $compare.Differences -FilePath $File.FullName
        }
    }
}

function Invoke-AutoLabelPolicyDeploy {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    $displayName = $File.BaseName
    $desired = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    if ($desired.Name) { $displayName = $desired.Name }

    $existing = $null
    try { $existing = Get-AutoSensitivityLabelPolicy -Identity $displayName -ErrorAction Stop } catch { }

    if (-not $existing) {
        if (-not $allowCreate) {
            Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "Skipped (ALLOW_CREATE=false)" -FilePath $File.FullName
            return
        }
        $params = Get-DeployParameters -Desired $desired
        if (-not $params.ContainsKey('Name')) { $params['Name'] = $displayName }
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "WouldCreate" -FilePath $File.FullName
            return
        }
        if ($PSCmdlet.ShouldProcess($displayName, "Create auto-label policy")) {
            New-AutoSensitivityLabelPolicy @params | Out-Null
            Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "Created" -FilePath $File.FullName
        }
        return
    }

    $compare = Compare-IPPSPolicyProperties -ExistingPolicy $existing -DesiredPolicy $desired
    if ($compare.IsEquivalent) {
        Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "NoChange" -FilePath $File.FullName
        return
    }

    if (-not $allowUpdate) {
        Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "Skipped (ALLOW_UPDATE=false)" -Changes $compare.Differences -FilePath $File.FullName
        return
    }

    $params = Get-DeployParameters -Desired $desired -AdditionalExclude @('Name')
    if ($WhatIfMode) {
        Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "WouldUpdate" -Changes $compare.Differences -FilePath $File.FullName
        return
    }
    if ($PSCmdlet.ShouldProcess($displayName, "Update auto-label policy")) {
        Set-AutoSensitivityLabelPolicy -Identity $displayName @params | Out-Null
        Add-PlanResult -DisplayName $displayName -Type "AutoLabelPolicy" -Status "Updated" -Changes $compare.Differences -FilePath $File.FullName
    }
}

Write-Host "##[section]Configuring Information Protection"

Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Save-PlanOutput
    exit 0
}

try {
    Connect-IPPSSessionDelegated
    Write-Host "Connected to Security & Compliance PowerShell"
}
catch {
    throw "Failed to connect to Security & Compliance PowerShell: $_"
}

$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }

function Get-ScopedFiles {
    param([string]$Subfolder)
    $dir = Join-Path $ConfigDirectory $Subfolder
    if (-not (Test-Path $dir)) { return @() }
    $files = @(Get-ChildItem -Path $dir -Filter "*.json" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike "*.monitor.json" -and $_.Name -notlike "*.config.json" })
    return @(Get-FilteredPolicyFiles -PolicyFiles $files -BaselineRoot $baselineRoot)
}

# 1. Sensitivity labels (parents before sublabels)
$labelDir = Join-Path $ConfigDirectory "sensitivity-labels"
if (Test-Path $labelDir) {
    Write-Host "`n##[section]Processing Sensitivity Labels"
    $labelFiles = @(Get-SortedLabelFiles -Files (Get-ScopedFiles -Subfolder "sensitivity-labels"))
    foreach ($file in $labelFiles) {
        try { Invoke-LabelDeploy -File $file }
        catch {
            Write-Host "##[error]Label '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type "Label" -Status "Error" -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }

    if (-not $WhatIfMode) {
        Write-Host "`n##[section]Ensuring label scope includes groups, sites, and Teams"
        foreach ($file in $labelFiles) {
            $displayName = $file.BaseName
            try {
                $cfg = Get-Content $file.FullName -Raw | ConvertFrom-Json
                if ($cfg.Name) { $displayName = $cfg.Name }
                Update-InformationProtectionLabelContainerScope -Identity $displayName
            }
            catch {
                Write-Host "##[warning]Could not expand scope for '$displayName': $_"
            }
        }
    }
    else {
        foreach ($file in $labelFiles) {
            Write-Host "WhatIf: would expand label scope for '$($file.BaseName)' to include groups and sites"
        }
    }
}

# 2. Label policies
$policyDir = Join-Path $ConfigDirectory "label-policies"
if (Test-Path $policyDir) {
    Write-Host "`n##[section]Processing Label Publishing Policies"
    foreach ($file in (Get-ScopedFiles -Subfolder "label-policies")) {
        try { Invoke-LabelPolicyDeploy -File $file }
        catch {
            Write-Host "##[error]Label policy '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type "LabelPolicy" -Status "Error" -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

# 3. Label policy rules
$rulesDir = Join-Path $ConfigDirectory "label-policy-rules"
if (Test-Path $rulesDir) {
    Write-Host "`n##[section]Processing Label Policy Rules"
    $ruleFiles = @(Get-ScopedFiles -Subfolder "label-policy-rules" | Where-Object { $_.Name -like "*.rules.json" })
    foreach ($file in $ruleFiles) {
        try {
            Invoke-RuleSetDeploy -RuleType "LabelPolicyRule" -File $file `
                -GetExistingRules {
                    param($policyName, $payload)
                    $policyId = if ($payload.PolicyGuid) { $payload.PolicyGuid } else { $policyName }
                    return @(Get-LabelPolicyRule -Policy $policyId -ErrorAction SilentlyContinue)
                } `
                -NewRule { param($p) New-LabelPolicyRule @p } `
                -SetRule { param($p) Set-LabelPolicyRule @p }
        }
        catch {
            Write-Host "##[error]Label policy rules '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type "LabelPolicyRule" -Status "Error" -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

# 4. Auto-label policies
$autoDir = Join-Path $ConfigDirectory "auto-label-policies"
if (Test-Path $autoDir) {
    Write-Host "`n##[section]Processing Auto-Label Policies"
    foreach ($file in (Get-ScopedFiles -Subfolder "auto-label-policies")) {
        try { Invoke-AutoLabelPolicyDeploy -File $file }
        catch {
            Write-Host "##[error]Auto-label policy '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type "AutoLabelPolicy" -Status "Error" -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

# 5. Auto-label rules
$autoRulesDir = Join-Path $ConfigDirectory "auto-label-rules"
if (Test-Path $autoRulesDir) {
    Write-Host "`n##[section]Processing Auto-Label Rules"
    $autoRuleFiles = @(Get-ScopedFiles -Subfolder "auto-label-rules" | Where-Object { $_.Name -like "*.rules.json" })
    foreach ($file in $autoRuleFiles) {
        try {
            Invoke-RuleSetDeploy -RuleType "AutoLabelRule" -File $file `
                -GetExistingRules {
                    param($policyName, $payload)
                    return @(Get-AutoSensitivityLabelRule -Policy $policyName -ErrorAction SilentlyContinue)
                } `
                -NewRule { param($p) New-AutoSensitivityLabelRule @p } `
                -SetRule { param($p) Set-AutoSensitivityLabelRule @p }
        }
        catch {
            Write-Host "##[error]Auto-label rules '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type "AutoLabelRule" -Status "Error" -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

Write-Host "`n##[section]Container Label Support (Groups, Sites, Teams)"
try {
    Initialize-InformationProtectionContainerSupport
}
catch {
    Write-Host "##[error]Container label sync failed: $_"
    Add-PlanResult -DisplayName "ContainerLabelSync" -Type "ContainerSync" -Status "Error" -Changes @{ Message = "$_" }
}

Write-Host "`n##[section]Information Protection Summary"
Write-Host "  Would Create: $($planResults.WouldCreateCount)"
Write-Host "  Would Update: $($planResults.WouldUpdateCount)"
Write-Host "  No Change:    $($planResults.NoChangeCount)"
Write-Host "  Errors:       $($planResults.ErrorCount)"

Save-PlanOutput
