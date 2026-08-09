<#
.SYNOPSIS
    Deploys Exchange Online IRM and OME configuration from baseline JSON (one file per property).

.DESCRIPTION
    Reads baseline files under:
      exchange/aip-service/ServiceEnabled.json              → Enable-AipService / Disable-AipService
      exchange/aip-service/configuration/{Property}.json    → reference (LicensingIntranetDistributionPointUrl)
      exchange/aip-service/_apply-licensing-location-to-irm.json → Set-IRMConfiguration -LicensingLocation
      exchange/irm-configuration/{PropertyName}.json          → Set-IRMConfiguration
      exchange/ome-configuration/{PropertyName}.json          → Set-OMEConfiguration
      exchange/ome-configuration/_policy-identity.json      (OME identity only; not deployed)

.PARAMETER ConfigDirectory
    Path to baseline exchange folder (e.g. baseline/baseline/exchange)

.PARAMETER OutputPath
    Optional path to save plan/results JSON for the deploy pipeline

.EXAMPLE
    .\Configure-ExchangeMessageEncryption.ps1 -ConfigDirectory "baseline/baseline/exchange" -WhatIf -OutputPath "exchange-message-encryption-plan.json"
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

$connectGraphPath = Join-Path $PSScriptRoot '..\common\Connect-M365Graph.ps1'
$resolverPath     = Join-Path $PSScriptRoot 'Resolve-Placeholders.ps1'
$ignoreHelpersPath = Join-Path $PSScriptRoot 'Common-IgnoreHelpers.ps1'
$diffHelpersPath  = Join-Path $PSScriptRoot 'Common-DiffHelpers.ps1'
$settingsPath     = Join-Path $PSScriptRoot 'Exchange-MessageEncryption-Settings.ps1'

if (Test-Path $connectGraphPath) { . $connectGraphPath }
. $resolverPath
. $ignoreHelpersPath
. $diffHelpersPath
. $settingsPath

Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

$baselineRoot = if ($TenantBaselinePath) {
    Join-Path $TenantBaselinePath 'baseline'
} else {
    Split-Path $ConfigDirectory -Parent
}

function Get-MessageEncryptionConfigHash {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    $configHash = Get-Content $FilePath -Raw | ConvertFrom-Json |
        ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable
    Resolve-Placeholders -ConfigObject $configHash
}

function Get-CmdletParamsFromPropertyFile {
    param([hashtable]$ConfigHash)

    $params = @{}
    foreach ($key in $ConfigHash.Keys) {
        if ($key -notlike '_*') {
            $params[$key] = $ConfigHash[$key]
        }
    }
    return $params
}

function Get-MessageEncryptionPropertyFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Subfolder,
        [Parameter(Mandatory = $true)][string]$SettingType
    )

    $dir = Join-Path $ConfigDirectory $Subfolder
    if (-not (Test-Path $dir)) { return @() }

    $files = @(Get-ChildItem -Path $dir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '_*' })
    $files = @(Get-FilteredPolicyFiles -PolicyFiles $files -BaselineRoot $baselineRoot)

    foreach ($file in $files) {
        [PSCustomObject]@{
            File         = $file
            RelativePath = "$Subfolder/$($file.Name)".Replace('\', '/')
            SettingType  = $SettingType
            PropertyName = $file.BaseName
        }
    }
}

function Resolve-OmeIdentityFromBaseline {
    $identityFile = Join-Path $ConfigDirectory 'ome-configuration/_policy-identity.json'
    if (Test-Path $identityFile) {
        try {
            $hash = Get-MessageEncryptionConfigHash -FilePath $identityFile
            if ($hash.ContainsKey('Identity') -and -not [string]::IsNullOrWhiteSpace("$($hash['Identity'])")) {
                return "$($hash['Identity'])"
            }
        }
        catch {
            Write-Host "##[warning]Could not read _policy-identity.json: $_"
        }
    }
    return 'OME Configuration'
}

function Test-ExchangeBaselineFileActive {
    param([Parameter(Mandatory = $true)][string]$FilePath)

    if (-not (Test-Path $FilePath)) { return $false }
    $files = @(Get-FilteredPolicyFiles -PolicyFiles @((Get-Item -LiteralPath $FilePath)) -BaselineRoot $baselineRoot)
    return $files.Count -gt 0
}

function Set-AipServiceActivationFromBaseline {
    $sourceFile = Join-Path $ConfigDirectory 'aip-service/ServiceEnabled.json'
    if (-not (Test-ExchangeBaselineFileActive -FilePath $sourceFile)) { return $null }

    Write-Host '##[group]Processing AipService/ServiceEnabled'
    try {
        $configHash = Get-MessageEncryptionConfigHash -FilePath $sourceFile
        if (-not $configHash.ContainsKey('Enabled')) {
            Write-Host '##[warning]ServiceEnabled.json missing Enabled property — skipping'
            return @{ Name = 'ServiceEnabled'; Type = 'AipService'; Status = 'Skipped'; Changes = $null; FilePath = $sourceFile }
        }

        $desiredEnabled = [bool]$configHash['Enabled']
        $currentEnabled = Get-AipServiceEnabledState

        if ($desiredEnabled -eq $currentEnabled) {
            Write-Host "✓ AIP service activation is up to date (Enabled=$currentEnabled)"
            return @{ Name = 'ServiceEnabled'; Type = 'AipService'; Status = 'No changes'; Changes = $null; FilePath = $sourceFile }
        }

        $changesObj = @{
            Added    = @()
            Removed  = @()
            Modified = @("Enabled: $currentEnabled → $desiredEnabled")
        }
        $action = if ($desiredEnabled) { 'Enable-AipService' } else { 'Disable-AipService' }

        if ($PSCmdlet.ShouldProcess('AIP Service', $action)) {
            if ($desiredEnabled) { Enable-AipService -ErrorAction Stop }
            else { Disable-AipService -ErrorAction Stop }
            Write-Host "✓ Updated AIP service activation (Enabled=$desiredEnabled)"
            return @{ Name = 'ServiceEnabled'; Type = 'AipService'; Status = 'Updated'; Changes = $changesObj; FilePath = $sourceFile }
        }

        Write-Host "[WhatIf] Would run $action"
        return @{ Name = 'ServiceEnabled'; Type = 'AipService'; Status = 'Would UPDATE'; Changes = $changesObj; FilePath = $sourceFile }
    }
    finally {
        Write-Host '##[endgroup]'
    }
}

function Invoke-IrmLicensingLocationFromAipBaseline {
    $applyFile = Join-Path $ConfigDirectory 'aip-service/_apply-licensing-location-to-irm.json'
    if (-not (Test-ExchangeBaselineFileActive -FilePath $applyFile)) { return $null }

    Write-Host '##[group]Processing AipLicensingLocationSync'
    try {
        $applyHash = Get-MessageEncryptionConfigHash -FilePath $applyFile
        if (-not $applyHash.ContainsKey('Enabled') -or -not [bool]$applyHash['Enabled']) {
            Write-Host 'AIP licensing location sync disabled in baseline — skipping'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Skipped'; Changes = $null; FilePath = $applyFile }
        }

        $urlFile = Join-Path $ConfigDirectory 'aip-service/configuration/LicensingIntranetDistributionPointUrl.json'
        if (-not (Test-Path $urlFile)) {
            Write-Host '##[warning]Missing aip-service/configuration/LicensingIntranetDistributionPointUrl.json — skipping IRM licensing sync'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Skipped'; Changes = $null; FilePath = $applyFile }
        }

        $urlHash = Get-MessageEncryptionConfigHash -FilePath $urlFile
        if (-not $urlHash.ContainsKey('LicensingIntranetDistributionPointUrl')) {
            Write-Host '##[warning]LicensingIntranetDistributionPointUrl.json missing URL property — skipping'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Skipped'; Changes = $null; FilePath = $applyFile }
        }

        $desiredUrl = "$($urlHash['LicensingIntranetDistributionPointUrl'])".Trim()
        if ([string]::IsNullOrWhiteSpace($desiredUrl)) {
            Write-Host '##[warning]LicensingIntranetDistributionPointUrl is empty — skipping'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Skipped'; Changes = $null; FilePath = $applyFile }
        }

        $irm = Get-IRMConfiguration -ErrorAction Stop
        $currentLocation = Get-ExchangeMessageEncryptionPropertyValue -Object $irm -PropertyName 'LicensingLocation'
        $desiredLocation = @($desiredUrl)

        if (Compare-PropertyValues -Current $currentLocation -New $desiredLocation) {
            Write-Host '✓ IRM LicensingLocation already matches AIP licensing URL'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'No changes'; Changes = $null; FilePath = $applyFile }
        }

        $changesObj = @{
            Added    = @()
            Removed  = @()
            Modified = @("LicensingLocation: $currentLocation → $desiredLocation")
        }

        if ($PSCmdlet.ShouldProcess('IRM LicensingLocation', "Set-IRMConfiguration -LicensingLocation '$desiredUrl'")) {
            Set-IRMConfiguration -LicensingLocation $desiredLocation -Confirm:$false -ErrorAction Stop
            Write-Host '✓ Updated IRM LicensingLocation from AIP configuration URL'
            return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Updated'; Changes = $changesObj; FilePath = $applyFile }
        }

        Write-Host "[WhatIf] Would set IRM LicensingLocation to '$desiredUrl'"
        return @{ Name = 'ApplyLicensingLocationToIrm'; Type = 'AipLicensingLocationSync'; Status = 'Would UPDATE'; Changes = $changesObj; FilePath = $applyFile }
    }
    finally {
        Write-Host '##[endgroup]'
    }
}

function Set-ExchangeMessageEncryptionProperty {
    param(
        [Parameter(Mandatory = $true)]$Item,
        $ExistingObject,
        [string]$OmeIdentity = ''
    )

    $propertyName = $Item.PropertyName
    $settingType  = $Item.SettingType
    $sourceFile   = $Item.File.FullName

    Write-Host "##[group]Processing $settingType/$propertyName"

    try {
        $configHash = Get-MessageEncryptionConfigHash -FilePath $sourceFile
        $params = Get-CmdletParamsFromPropertyFile -ConfigHash $configHash

        if ($params.Count -eq 0) {
            Write-Host "##[warning]No deployable properties in $($Item.RelativePath) — skipping"
            return @{ Name = $propertyName; Type = $settingType; Status = 'Skipped'; Changes = $null; FilePath = $sourceFile }
        }

        if ($params.Count -gt 1) {
            Write-Host "##[warning]Expected one property per file; using keys: $($params.Keys -join ', ')"
        }

        $propKey = @($params.Keys | Where-Object { $_ -ne 'Identity' })[0]
        if (-not $propKey) {
            Write-Host "##[warning]No property key found in $($Item.RelativePath) — skipping"
            return @{ Name = $propertyName; Type = $settingType; Status = 'Skipped'; Changes = $null; FilePath = $sourceFile }
        }

        $desiredValue = $params[$propKey]
        $currentValue = Get-ExchangeMessageEncryptionPropertyValue -Object $ExistingObject -PropertyName $propKey

        if (Compare-PropertyValues -Current $currentValue -New $desiredValue) {
            Write-Host "✓ $settingType '$propKey' is up to date"
            return @{ Name = $propertyName; Type = $settingType; Status = 'No changes'; Changes = $null; FilePath = $sourceFile }
        }

        $changesObj = @{
            Added    = @()
            Removed  = @()
            Modified = @("$propKey`: $currentValue → $desiredValue")
        }

        if ($settingType -eq 'OmeConfiguration') {
            $setParams = @{ Identity = $OmeIdentity; $propKey = $desiredValue }
            $label = "Set-OMEConfiguration -Identity '$OmeIdentity' -$propKey"
        }
        else {
            $setParams = @{ $propKey = $desiredValue }
            $label = "Set-IRMConfiguration -$propKey"
        }

        if ($PSCmdlet.ShouldProcess($propertyName, $label)) {
            if ($settingType -eq 'OmeConfiguration') {
                Set-OMEConfiguration @setParams -Confirm:$false -ErrorAction Stop
            }
            else {
                Set-IRMConfiguration @setParams -Confirm:$false -ErrorAction Stop
            }
            Write-Host "✓ Updated $settingType setting: $propKey"
            return @{ Name = $propertyName; Type = $settingType; Status = 'Updated'; Changes = $changesObj; FilePath = $sourceFile }
        }

        Write-Host "[WhatIf] Would update $settingType setting: $propKey"
        foreach ($mod in $changesObj.Modified) { Write-Host "  ~ $mod" }
        return @{ Name = $propertyName; Type = $settingType; Status = 'Would UPDATE'; Changes = $changesObj; FilePath = $sourceFile }
    }
    finally {
        Write-Host '##[endgroup]'
    }
}

Write-Host '##[section]Configuring Exchange Message Encryption (AIP/IRM/OME)'

if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Write-Host 'Skipping Exchange message encryption — no baseline exchange folder'
    exit 0
}

$irmFiles = @(Get-MessageEncryptionPropertyFiles -Subfolder 'irm-configuration' -SettingType 'IrmConfiguration')
$omeFiles = @(Get-MessageEncryptionPropertyFiles -Subfolder 'ome-configuration' -SettingType 'OmeConfiguration')
$allFiles = @($irmFiles) + @($omeFiles)
$hasAipServiceBaseline = Test-ExchangeBaselineFileActive -FilePath (Join-Path $ConfigDirectory 'aip-service/ServiceEnabled.json')
$hasAipLicensingSync = Test-ExchangeBaselineFileActive -FilePath (Join-Path $ConfigDirectory 'aip-service/_apply-licensing-location-to-irm.json')

if ($allFiles.Count -eq 0 -and -not $hasAipServiceBaseline -and -not $hasAipLicensingSync) {
    Write-Host 'No AIP/IRM/OME baseline files found — skipping'
    if ($OutputPath) {
        @{
            Service          = 'Exchange'
            Timestamp        = (Get-Date -Format 'o')
            TotalPolicies    = 0
            CreatedCount     = 0
            UpdatedCount     = 0
            NoChangeCount    = 0
            WouldCreateCount = 0
            WouldUpdateCount = 0
            ErrorCount       = 0
            Results          = @()
        } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Found $($allFiles.Count) IRM/OME setting(s) to process"
foreach ($item in $allFiles) {
    Write-Host "  - $($item.RelativePath)"
}
if ($hasAipServiceBaseline) { Write-Host '  - aip-service/ServiceEnabled.json' }
if ($hasAipLicensingSync) { Write-Host '  - aip-service/_apply-licensing-location-to-irm.json' }

$script:meResults = @()
$script:meCreatedCount = 0
$script:meUpdatedCount = 0
$script:meNoChangeCount = 0
$script:meWouldCreateCount = 0
$script:meWouldUpdateCount = 0
$script:meErrorCount = 0

function Register-MessageEncryptionResult {
    param([hashtable]$Result)

    if (-not $Result) { return }
    switch -Regex ($Result.Status) {
        '^Created$'       { $script:meCreatedCount++ }
        '^Updated$'       { $script:meUpdatedCount++ }
        '^No changes$'    { $script:meNoChangeCount++ }
        '^Would CREATE$'  { $script:meWouldCreateCount++ }
        '^Would UPDATE$'  { $script:meWouldUpdateCount++ }
        '^Error|^Failed'  { $script:meErrorCount++ }
    }
    $script:meResults += [PSCustomObject]@{
        DisplayName = $Result.Name
        Type        = $Result.Type
        Status      = $Result.Status
        Changes     = $Result.Changes
        FilePath    = $Result.FilePath
    }
}

try {
    if ($hasAipServiceBaseline -or $hasAipLicensingSync) {
        Connect-AipServiceDelegated | Out-Null
    }

    try {
        Register-MessageEncryptionResult -Result (Set-AipServiceActivationFromBaseline)
    }
    catch {
        $script:meErrorCount++
        Write-Host "##[error]Failed to process AIP service activation: $_"
        $script:meResults += [PSCustomObject]@{
            DisplayName = 'ServiceEnabled'
            Type        = 'AipService'
            Status      = "Failed: $_"
            FilePath    = (Join-Path $ConfigDirectory 'aip-service/ServiceEnabled.json')
        }
    }

    if ($allFiles.Count -gt 0 -or $hasAipLicensingSync) {
        Connect-ExchangeOnlineDelegated | Out-Null
        Write-Host 'Connected to Exchange Online.'
    }

    if ($hasAipLicensingSync) {
        try {
            Register-MessageEncryptionResult -Result (Invoke-IrmLicensingLocationFromAipBaseline)
        }
        catch {
            $script:meErrorCount++
            Write-Host "##[error]Failed to sync IRM LicensingLocation from AIP baseline: $_"
            $script:meResults += [PSCustomObject]@{
                DisplayName = 'ApplyLicensingLocationToIrm'
                Type        = 'AipLicensingLocationSync'
                Status      = "Failed: $_"
                FilePath    = (Join-Path $ConfigDirectory 'aip-service/_apply-licensing-location-to-irm.json')
            }
        }
    }
}
catch {
    Write-Host "##[error]Failed to connect for message encryption deploy: $_"
    throw
}

try {
    $irmExisting = $null
    if ($irmFiles.Count -gt 0) {
        $irmExisting = Get-IRMConfiguration -ErrorAction Stop
    }

    foreach ($item in $irmFiles) {
        try {
            $result = Set-ExchangeMessageEncryptionProperty -Item $item -ExistingObject $irmExisting -OmeIdentity ''
            Register-MessageEncryptionResult -Result $result
            if ($result.Status -eq 'Updated' -and $irmExisting) {
                $irmExisting = Get-IRMConfiguration -ErrorAction Stop
            }
        }
        catch {
            $script:meErrorCount++
            Write-Host "##[error]Failed to process $($item.RelativePath): $_"
            $script:meResults += [PSCustomObject]@{
                DisplayName = $item.PropertyName
                Type        = $item.SettingType
                Status      = "Failed: $_"
                FilePath    = $item.File.FullName
            }
        }
    }

    $omeIdentity = Resolve-OmeIdentityFromBaseline
    $omeExisting = $null
    if ($omeFiles.Count -gt 0) {
        Connect-ExchangeOnlineDelegated | Out-Null
        $omeConfigs = @(Get-OmeConfigurationObjects)
        $omeExisting = @($omeConfigs | Where-Object { "$($_.Identity)" -eq $omeIdentity } | Select-Object -First 1)[0]
        if (-not $omeExisting) {
            $omeIdentity = Resolve-OmeConfigurationIdentity -OmeConfigurations $omeConfigs
            $omeExisting = @($omeConfigs | Where-Object { "$($_.Identity)" -eq $omeIdentity } | Select-Object -First 1)[0]
        }
        if (-not $omeExisting) {
            throw "Could not resolve OME configuration for identity '$omeIdentity'"
        }
        Write-Host "Using OME identity: $omeIdentity"
    }

    foreach ($item in $omeFiles) {
        try {
            $result = Set-ExchangeMessageEncryptionProperty -Item $item -ExistingObject $omeExisting -OmeIdentity $omeIdentity
            Register-MessageEncryptionResult -Result $result
            if ($result.Status -eq 'Updated') {
                $omeExisting = @(Get-OmeConfigurationObjects -Identity $omeIdentity | Select-Object -First 1)[0]
            }
        }
        catch {
            $script:meErrorCount++
            Write-Host "##[error]Failed to process $($item.RelativePath): $_"
            $script:meResults += [PSCustomObject]@{
                DisplayName = $item.PropertyName
                Type        = $item.SettingType
                Status      = "Failed: $_"
                FilePath    = $item.File.FullName
            }
        }
    }
}
finally {
    if (Get-Command Disconnect-M365Connections -ErrorAction SilentlyContinue) {
        Disconnect-M365Connections
    }
}

Write-Host "`n##[section]Summary"
Write-Host "Total settings processed: $($allFiles.Count + $(if ($hasAipServiceBaseline) { 1 } else { 0 }) + $(if ($hasAipLicensingSync) { 1 } else { 0 }))"
if ($WhatIfPreference) {
    Write-Host "  → Would UPDATE: $($script:meWouldUpdateCount)"
    Write-Host "  ○ No changes needed: $($script:meNoChangeCount)"
}
else {
    Write-Host "  ✓ Updated: $($script:meUpdatedCount)"
    Write-Host "  ○ No changes: $($script:meNoChangeCount)"
}
if ($script:meErrorCount -gt 0) {
    Write-Host "  ✗ Failed: $($script:meErrorCount)"
}

if ($OutputPath) {
    @{
        Service          = 'Exchange'
        Timestamp        = (Get-Date -Format 'o')
        TotalPolicies    = ($allFiles.Count + $(if ($hasAipServiceBaseline) { 1 } else { 0 }) + $(if ($hasAipLicensingSync) { 1 } else { 0 }))
        CreatedCount     = $script:meCreatedCount
        UpdatedCount     = $script:meUpdatedCount
        NoChangeCount    = $script:meNoChangeCount
        WouldCreateCount = $script:meWouldCreateCount
        WouldUpdateCount = $script:meWouldUpdateCount
        ErrorCount       = $script:meErrorCount
        Results          = $script:meResults
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Plan summary saved to: $OutputPath"
}

if ($script:meErrorCount -gt 0) {
    exit 1
}
