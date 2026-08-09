<#
.SYNOPSIS
    Deploys DLP compliance policies and rules from Gitea baseline JSON only.

.DESCRIPTION
    Reads baseline files under:
      information-protection/dlp-policies/*.json
      information-protection/dlp-rules/*.rules.json

    Never creates policies from hardcoded script definitions. If those folders are
    empty (or missing), this script writes an empty WhatIf plan and exits.

    Manual one-off seeding uses .debug/scripts/Update-TenantDlpBaselines.ps1 —
    that path is intentionally not used by the deploy pipeline.
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

$ErrorActionPreference = 'Stop'

$connectGraphPath  = Join-Path $PSScriptRoot '..\common\Connect-M365Graph.ps1'
$ipHelpersPath     = Join-Path $PSScriptRoot '..\common\Common-InformationProtectionHelpers.ps1'
$resolverPath      = Join-Path $PSScriptRoot 'Resolve-Placeholders.ps1'
$ignoreHelpersPath = Join-Path $PSScriptRoot 'Common-IgnoreHelpers.ps1'
$diffHelpersPath   = Join-Path $PSScriptRoot 'Common-DiffHelpers.ps1'

if (Test-Path $connectGraphPath) { . $connectGraphPath }
if (Test-Path $ipHelpersPath) { . $ipHelpersPath }
. $resolverPath
. $ignoreHelpersPath
. $diffHelpersPath

$_ignoreDir = Join-Path $PSScriptRoot '..\compare-ignore-fields'
$_commonFields = try { (Get-Content (Join-Path $_ignoreDir 'common.json') -Raw | ConvertFrom-Json).fields } catch { @() }
# Mode/Comment matter for DLP — do not reuse the IP ignore list that drops them.
$script:IgnoreProperties = @($_commonFields) + @(
    'Guid', 'ImmutableId', 'Id', 'Identity', 'DistinguishedName', 'OrganizationId',
    'WhenChanged', 'WhenCreated', 'WhenChangedUTC', 'WhenCreatedUTC',
    'CreatedBy', 'LastModifiedBy', 'ModifiedBy', 'ManuallyModified',
    'ObjectVersion', 'PolicyVersion', 'RuleVersion',
    'ObjectState', 'ObjectCategory', 'ObjectClass',
    'ExchangeObjectId', 'OrganizationalUnitRoot', 'OriginatingServer',
    'IsValid', 'DistributionStatus', 'DistributionResults', 'DistributionSyncStatus',
    'Workload', 'PolicyTemplateInfo', 'PolicyRBACScopes',
    'ReplicationId', 'MasterIdentity', 'Priority',
    'InternalId', 'ExternalIdentity', 'ExternalDirectoryObjectId',
    'PolicyName', 'PolicyGuid', 'Rules'
)

$script:DeployExcludeProps = @(
    'RunspaceId', 'PSComputerName', 'PSShowComputerName', 'PSObject',
    'Identity', 'Guid', 'ExchangeObjectId', 'DistinguishedName', 'OrganizationId',
    'OrganizationalUnitRoot', 'OriginatingServer', 'ObjectVersion', 'PolicyVersion',
    'WhenChanged', 'WhenCreated', 'WhenChangedUTC', 'WhenCreatedUTC',
    'CreatedBy', 'LastModifiedBy', 'ModifiedBy', 'IsValid', 'ObjectState',
    'DistributionStatus', 'DistributionResults', 'DistributionSyncStatus',
    'Workload', 'PolicyTemplateInfo', 'PolicyRBACScopes',
    'PolicyName', 'PolicyGuid', 'Rules', '_policyName', '_policyGuid',
    'ImmutableId', 'Id', 'ObjectCategory', 'ObjectClass', 'ReplicationId',
    'MasterIdentity', 'Priority', 'InternalId', 'ExternalIdentity',
    'ExternalDirectoryObjectId', 'ManuallyModified', 'RuleVersion'
)

$WhatIfMode = $WhatIfPreference
$allowCreate = ($env:ALLOW_CREATE -ne 'false')
$allowUpdate = ($env:ALLOW_UPDATE -ne 'false')

$planResults = @{
    Service          = 'DlpCompliance'
    Timestamp        = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
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

function Select-SupportedCmdletParameters {
    param(
        [string]$CommandName,
        [hashtable]$Parameters
    )

    $cmd = Get-Command $CommandName -ErrorAction Stop
    $filtered = @{}
    foreach ($key in $Parameters.Keys) {
        if ($cmd.Parameters.ContainsKey($key)) {
            $filtered[$key] = $Parameters[$key]
        }
    }
    return $filtered
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

function Compare-DlpProperties {
    param(
        [Parameter(Mandatory = $true)] $Existing,
        [Parameter(Mandatory = $true)] $Desired
    )
    $result = @{
        IsEquivalent = $true
        Differences  = @{ Modified = @(); ModifiedValues = @{} }
    }
    $existingHash = ConvertTo-ComparableHashtable -Policy $Existing -IgnoreProps $script:IgnoreProperties
    $desiredHash  = ConvertTo-ComparableHashtable -Policy $Desired  -IgnoreProps $script:IgnoreProperties
    foreach ($key in (@($desiredHash.Keys) | Sort-Object -Unique)) {
        if (-not (Compare-PolicyValues -Value1 $existingHash[$key] -Value2 $desiredHash[$key])) {
            $result.Differences.Modified += $key
            $result.Differences.ModifiedValues[$key] = @{
                Existing = "$($existingHash[$key])"
                Desired  = "$($desiredHash[$key])"
            }
            $result.IsEquivalent = $false
        }
    }
    return $result
}

function Get-ScopedFiles {
    param([string]$Subfolder)
    $dir = Join-Path $ConfigDirectory $Subfolder
    if (-not (Test-Path $dir)) { return @() }
    $files = @(Get-ChildItem -Path $dir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '*.monitor.json' -and $_.Name -notlike '*.config.json' })
    return @(Get-FilteredPolicyFiles -PolicyFiles $files -BaselineRoot $baselineRoot)
}

function Invoke-DlpPolicyDeploy {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    $displayName = $File.BaseName
    $desired = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    if ($desired.Name) { $displayName = $desired.Name }

    $existing = $null
    try { $existing = Get-DlpCompliancePolicy -Identity $displayName -ErrorAction SilentlyContinue } catch { }

    if (-not $existing) {
        if (-not $allowCreate) {
            Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'Skipped (ALLOW_CREATE=false)' -FilePath $File.FullName
            return
        }
        $params = Select-SupportedCmdletParameters -CommandName 'New-DlpCompliancePolicy' `
            -Parameters (Get-DeployParameters -Desired $desired)
        if (-not $params.ContainsKey('Name')) { $params['Name'] = $displayName }
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'WouldCreate' -Changes @{ Action = 'Create DLP policy' } -FilePath $File.FullName
            return
        }
        if ($PSCmdlet.ShouldProcess($displayName, 'Create DLP compliance policy')) {
            New-DlpCompliancePolicy @params -Confirm:$false | Out-Null
            Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'Created' -FilePath $File.FullName
        }
        return
    }

    $compare = Compare-DlpProperties -Existing $existing -Desired $desired
    if ($compare.IsEquivalent) {
        Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'NoChange' -FilePath $File.FullName
        return
    }
    if (-not $allowUpdate) {
        Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'Skipped (ALLOW_UPDATE=false)' -Changes $compare.Differences -FilePath $File.FullName
        return
    }
    if ($WhatIfMode) {
        Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'WouldUpdate' -Changes $compare.Differences -FilePath $File.FullName
        return
    }
    if ($PSCmdlet.ShouldProcess($displayName, 'Update DLP compliance policy')) {
        $params = Select-SupportedCmdletParameters -CommandName 'Set-DlpCompliancePolicy' `
            -Parameters (Get-DeployParameters -Desired $desired -AdditionalExclude @('Name'))
        Set-DlpCompliancePolicy -Identity $displayName @params -Confirm:$false | Out-Null
        Add-PlanResult -DisplayName $displayName -Type 'DlpPolicy' -Status 'Updated' -Changes $compare.Differences -FilePath $File.FullName
    }
}

function Invoke-DlpRuleSetDeploy {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    $payload = Resolve-ConfigObject -Config (Get-Content $File.FullName -Raw | ConvertFrom-Json)
    $policyName = if ($payload.PolicyName) { $payload.PolicyName } else { ($File.BaseName -replace '\.rules$', '') }
    $rules = @($payload.Rules)
    if ($rules.Count -eq 0) {
        Write-Host "No rules in $($File.Name) — skipping"
        return
    }

    $existingRules = @()
    try { $existingRules = @(Get-DlpComplianceRule -Policy $policyName -ErrorAction SilentlyContinue) } catch { }
    $existingByName = @{}
    foreach ($r in $existingRules) { $existingByName[$r.Name] = $r }

    foreach ($rule in $rules) {
        $desired = Resolve-ConfigObject -Config $rule
        $ruleName = if ($desired.Name) { $desired.Name } else { $null }
        if (-not $ruleName) {
            Add-PlanResult -DisplayName "$policyName / (unnamed)" -Type 'DlpRule' -Status 'Error' -Changes @{ Message = 'Rule missing Name' } -FilePath $File.FullName
            continue
        }

        $displayName = "$policyName / $ruleName"
        $existing = $existingByName[$ruleName]

        if (-not $existing) {
            if (-not $allowCreate) {
                Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'Skipped (ALLOW_CREATE=false)' -FilePath $File.FullName
                continue
            }
            $params = Select-SupportedCmdletParameters -CommandName 'New-DlpComplianceRule' `
                -Parameters (Get-DeployParameters -Desired $desired)
            $params['Name'] = $ruleName
            $params['Policy'] = $policyName
            if ($WhatIfMode) {
                Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'WouldCreate' -Changes @{ Action = 'Create DLP rule' } -FilePath $File.FullName
                continue
            }
            if ($PSCmdlet.ShouldProcess($displayName, 'Create DLP compliance rule')) {
                New-DlpComplianceRule @params -Confirm:$false | Out-Null
                Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'Created' -FilePath $File.FullName
            }
            continue
        }

        $compare = Compare-DlpProperties -Existing $existing -Desired $desired
        if ($compare.IsEquivalent) {
            Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'NoChange' -FilePath $File.FullName
            continue
        }
        if (-not $allowUpdate) {
            Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'Skipped (ALLOW_UPDATE=false)' -Changes $compare.Differences -FilePath $File.FullName
            continue
        }
        if ($WhatIfMode) {
            Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'WouldUpdate' -Changes $compare.Differences -FilePath $File.FullName
            continue
        }
        if ($PSCmdlet.ShouldProcess($displayName, 'Update DLP compliance rule')) {
            $params = Select-SupportedCmdletParameters -CommandName 'Set-DlpComplianceRule' `
                -Parameters (Get-DeployParameters -Desired $desired -AdditionalExclude @('Name', 'Policy'))
            Set-DlpComplianceRule -Identity $ruleName @params -Confirm:$false | Out-Null
            Add-PlanResult -DisplayName $displayName -Type 'DlpRule' -Status 'Updated' -Changes $compare.Differences -FilePath $File.FullName
        }
    }
}

Write-Host '##[section]Configuring DLP Compliance (baseline JSON only)'

Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Save-PlanOutput
    exit 0
}

$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath 'baseline' } else { Split-Path $ConfigDirectory -Parent }

$policyFiles = @(Get-ScopedFiles -Subfolder 'dlp-policies')
$ruleFiles   = @(Get-ScopedFiles -Subfolder 'dlp-rules' | Where-Object { $_.Name -like '*.rules.json' })

if ($policyFiles.Count -eq 0 -and $ruleFiles.Count -eq 0) {
    Write-Host 'No baseline dlp-policies/ or dlp-rules/ JSON found — nothing to deploy (hardcoded DLP defs are never applied).'
    Save-PlanOutput
    exit 0
}

try {
    Connect-IPPSSessionDelegated
    Write-Host 'Connected to Security & Compliance PowerShell'
}
catch {
    throw "Failed to connect to Security & Compliance PowerShell: $_"
}

if ($policyFiles.Count -gt 0) {
    Write-Host "`n##[section]Processing DLP Policies ($($policyFiles.Count))"
    foreach ($file in $policyFiles) {
        try { Invoke-DlpPolicyDeploy -File $file }
        catch {
            Write-Host "##[error]DLP policy '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type 'DlpPolicy' -Status 'Error' -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

if ($ruleFiles.Count -gt 0) {
    Write-Host "`n##[section]Processing DLP Rules ($($ruleFiles.Count))"
    foreach ($file in $ruleFiles) {
        try { Invoke-DlpRuleSetDeploy -File $file }
        catch {
            Write-Host "##[error]DLP rules '$($file.Name)': $_"
            Add-PlanResult -DisplayName $file.BaseName -Type 'DlpRule' -Status 'Error' -Changes @{ Message = "$_" } -FilePath $file.FullName
        }
    }
}

Write-Host ''
Write-Host "  Would Create: $($planResults.WouldCreateCount)"
Write-Host "  Would Update: $($planResults.WouldUpdateCount)"
Write-Host "  No Change:    $($planResults.NoChangeCount)"
Write-Host "  Errors:       $($planResults.ErrorCount)"

Save-PlanOutput
Write-Host 'Configure-DlpCompliance finished.'
