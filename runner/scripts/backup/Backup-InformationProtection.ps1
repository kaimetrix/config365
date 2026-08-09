<#
.SYNOPSIS
    Backs up Microsoft Purview Information Protection settings.

.DESCRIPTION
    Exports sensitivity labels, publishing (label) policies, label policy rules,
    auto-labeling policies, and auto-labeling rules via Security & Compliance
    PowerShell (Connect-IPPSSession).

    Requires the portal-connected account to hold Compliance Administrator or
    Information Protection Administrator role.

.PARAMETER BackupPath
    Base path where backup files will be stored.

.NOTES
    Paths written under information-protection/ mirror baseline layout.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath,

    [Parameter(Mandatory = $false)]
    [switch]$DebugMode
)

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

$connectGraphPath = Join-Path $scriptDir "..\common\Connect-M365Graph.ps1"
$ipHelpersPath    = Join-Path $scriptDir "..\common\Common-InformationProtectionHelpers.ps1"
if (Test-Path $connectGraphPath) { . $connectGraphPath }
if (Test-Path $ipHelpersPath) { . $ipHelpersPath }

if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

Write-Log "=== Starting Information Protection Backup ===" "INFO"

$results = @{
    SensitivityLabels   = @{ BackedUp = 0; Failed = 0; Skipped = 0 }
    LabelPolicies       = @{ BackedUp = 0; Failed = 0 }
    LabelPolicyRules    = @{ BackedUp = 0; Failed = 0 }
    AutoLabelPolicies   = @{ BackedUp = 0; Failed = 0 }
    AutoLabelRules      = @{ BackedUp = 0; Failed = 0 }
    DlpPolicies         = @{ BackedUp = 0; Failed = 0 }
    DlpRules            = @{ BackedUp = 0; Failed = 0 }
}

function ConvertTo-BackupHash {
    param([Parameter(Mandatory = $true)] $Item)

    if ($null -eq $Item) { return @{} }

    $skipProps = @(
        'RunspaceId', 'PSComputerName', 'PSShowComputerName', 'PSObject',
        'PSTypeNames', 'BaseObject', 'Members', 'Properties', 'Methods'
    )

    $hash = @{}
    foreach ($prop in $Item.PSObject.Properties) {
        if ($prop.Name -in $skipProps) { continue }
        if ($prop.Name -like 'PS*') { continue }
        $hash[$prop.Name] = $prop.Value
    }
    return $hash
}

function Save-InformationProtectionItem {
    param(
        [Parameter(Mandatory = $true)] $Item,
        [Parameter(Mandatory = $true)][string]$Category,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $fileName = Get-SafeFileName -Name $Name
    $relativePath = "information-protection/$Category/$fileName.json"
    $content = ConvertTo-BackupHash -Item $Item
    Save-BackupFile -Content $content -RelativePath $relativePath
}

try {
    Connect-IPPSSessionDelegated
    Write-Log "Connected to Security & Compliance PowerShell" "INFO"
}
catch {
    Write-Log "Failed to connect to Security & Compliance PowerShell: $_" "ERROR"
    throw
}

#region Sensitivity Labels

try {
    Write-Log "Backing up sensitivity labels..." "INFO"
    $labelParams = @{ ErrorAction = 'Stop' }
    if (Get-Command Get-Label -ErrorAction SilentlyContinue) {
        $cmd = Get-Command Get-Label
        if ($cmd.Parameters.ContainsKey('IncludeDetailedLabelActions')) {
            $labelParams['IncludeDetailedLabelActions'] = $true
        }
        if ($cmd.Parameters.ContainsKey('SkipValidations')) {
            $labelParams['SkipValidations'] = $true
        }
    }
    $labels = @(Get-Label @labelParams)
    Write-Log "Found $($labels.Count) sensitivity labels" "INFO"

    foreach ($label in $labels) {
        try {
            if (-not (Test-IsManagedInformationProtectionLabel -Label $label)) {
                $results.SensitivityLabels.Skipped++
                Write-Log "Skipped built-in/read-only label: $($label.Name)" "DEBUG"
                continue
            }
            Save-InformationProtectionItem -Item $label -Category "sensitivity-labels" -Name $label.Name
            $results.SensitivityLabels.BackedUp++
            Write-Log "Saved sensitivity label: $($label.Name)" "DEBUG"
        }
        catch {
            $results.SensitivityLabels.Failed++
            Write-Log "Failed to backup label '$($label.Name)': $_" "WARN"
        }
    }
}
catch {
    Write-Log "Sensitivity label backup failed: $_" "ERROR"
}

#endregion

#region Label Policies (Publishing)

$labelPolicies = @()
try {
    Write-Log "Backing up label publishing policies..." "INFO"
    $labelPolicies = @(Get-LabelPolicy -ErrorAction Stop)
    Write-Log "Found $($labelPolicies.Count) label policies" "INFO"

    foreach ($policy in $labelPolicies) {
        try {
            Save-InformationProtectionItem -Item $policy -Category "label-policies" -Name $policy.Name
            $results.LabelPolicies.BackedUp++
            Write-Log "Saved label policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.LabelPolicies.Failed++
            Write-Log "Failed to backup label policy '$($policy.Name)': $_" "WARN"
        }
    }
}
catch {
    Write-Log "Label policy backup failed: $_" "ERROR"
}

#endregion

#region Label Policy Rules

try {
    Write-Log "Backing up label policy rules..." "INFO"
    foreach ($policy in $labelPolicies) {
        try {
            $policyId = if ($policy.Guid) { $policy.Guid } else { $policy.ExchangeObjectId }
            if (-not $policyId) { continue }

            $rules = @(Get-LabelPolicyRule -Policy $policyId -ErrorAction Stop)
            if ($rules.Count -eq 0) { continue }

            $fileName = Get-SafeFileName -Name $policy.Name
            $payload = @{
                PolicyName = $policy.Name
                PolicyGuid = "$policyId"
                Rules      = @($rules | ForEach-Object { ConvertTo-BackupHash -Item $_ })
            }
            Save-BackupFile -Content $payload -RelativePath "information-protection/label-policy-rules/$fileName.rules.json"
            $results.LabelPolicyRules.BackedUp++
            Write-Log "Saved $($rules.Count) rule(s) for label policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.LabelPolicyRules.Failed++
            Write-Log "Failed to backup rules for label policy '$($policy.Name)': $_" "WARN"
        }
    }
}
catch {
    Write-Log "Label policy rules backup failed: $_" "ERROR"
}

#endregion

#region Auto-Label Policies

$autoLabelPolicies = @()
try {
    Write-Log "Backing up auto-labeling policies..." "INFO"
    $autoLabelPolicies = @(Get-AutoSensitivityLabelPolicy -ErrorAction Stop)
    Write-Log "Found $($autoLabelPolicies.Count) auto-label policies" "INFO"

    foreach ($policy in $autoLabelPolicies) {
        try {
            Save-InformationProtectionItem -Item $policy -Category "auto-label-policies" -Name $policy.Name
            $results.AutoLabelPolicies.BackedUp++
            Write-Log "Saved auto-label policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.AutoLabelPolicies.Failed++
            Write-Log "Failed to backup auto-label policy '$($policy.Name)': $_" "WARN"
        }
    }
}
catch {
    Write-Log "Auto-label policy backup failed: $_" "ERROR"
}

#endregion

#region Auto-Label Rules

try {
    Write-Log "Backing up auto-labeling rules..." "INFO"
    foreach ($policy in $autoLabelPolicies) {
        try {
            $rules = @(Get-AutoSensitivityLabelRule -Policy $policy.Name -ErrorAction Stop)
            if ($rules.Count -eq 0) { continue }

            $fileName = Get-SafeFileName -Name $policy.Name
            $payload = @{
                PolicyName = $policy.Name
                PolicyGuid = if ($policy.Guid) { "$($policy.Guid)" } else { $null }
                Rules      = @($rules | ForEach-Object { ConvertTo-BackupHash -Item $_ })
            }
            Save-BackupFile -Content $payload -RelativePath "information-protection/auto-label-rules/$fileName.rules.json"
            $results.AutoLabelRules.BackedUp++
            Write-Log "Saved $($rules.Count) rule(s) for auto-label policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.AutoLabelRules.Failed++
            Write-Log "Failed to backup rules for auto-label policy '$($policy.Name)': $_" "WARN"
        }
    }
}
catch {
    Write-Log "Auto-label rules backup failed: $_" "ERROR"
}

#endregion

#region DLP Policies

$dlpPolicies = @()
try {
    Write-Log "Backing up DLP compliance policies..." "INFO"
    if (Get-Command Get-DlpCompliancePolicy -ErrorAction SilentlyContinue) {
        $dlpPolicies = @(Get-DlpCompliancePolicy -ErrorAction Stop | Where-Object {
            $_.Name -like 'DLP - *'
        })
        Write-Log "Found $($dlpPolicies.Count) DLP policies" "INFO"

        foreach ($policy in $dlpPolicies) {
            try {
                Save-InformationProtectionItem -Item $policy -Category "dlp-policies" -Name $policy.Name
                $results.DlpPolicies.BackedUp++
                Write-Log "Saved DLP policy: $($policy.Name)" "DEBUG"
            }
            catch {
                $results.DlpPolicies.Failed++
                Write-Log "Failed to backup DLP policy '$($policy.Name)': $_" "WARN"
            }
        }
    }
    else {
        Write-Log "Get-DlpCompliancePolicy not available; skipping DLP policy backup" "WARN"
    }
}
catch {
    Write-Log "DLP policy backup failed: $_" "ERROR"
}

#endregion

#region DLP Rules

try {
    Write-Log "Backing up DLP compliance rules..." "INFO"
    if (Get-Command Get-DlpComplianceRule -ErrorAction SilentlyContinue) {
        foreach ($policy in $dlpPolicies) {
            try {
                $rules = @(Get-DlpComplianceRule -Policy $policy.Name -ErrorAction Stop)
                if ($rules.Count -eq 0) { continue }

                $fileName = Get-SafeFileName -Name $policy.Name
                $payload = @{
                    PolicyName = $policy.Name
                    PolicyGuid = if ($policy.Guid) { "$($policy.Guid)" } else { $null }
                    Rules      = @($rules | ForEach-Object { ConvertTo-BackupHash -Item $_ })
                }
                Save-BackupFile -Content $payload -RelativePath "information-protection/dlp-rules/$fileName.rules.json"
                $results.DlpRules.BackedUp++
                Write-Log "Saved $($rules.Count) DLP rule(s) for policy: $($policy.Name)" "DEBUG"
            }
            catch {
                $results.DlpRules.Failed++
                Write-Log "Failed to backup DLP rules for '$($policy.Name)': $_" "WARN"
            }
        }
    }
    else {
        Write-Log "Get-DlpComplianceRule not available; skipping DLP rule backup" "WARN"
    }
}
catch {
    Write-Log "DLP rule backup failed: $_" "ERROR"
}

#endregion

$totalBackedUp = $results.SensitivityLabels.BackedUp +
    $results.LabelPolicies.BackedUp +
    $results.LabelPolicyRules.BackedUp +
    $results.AutoLabelPolicies.BackedUp +
    $results.AutoLabelRules.BackedUp +
    $results.DlpPolicies.BackedUp +
    $results.DlpRules.BackedUp

$totalFailed = $results.SensitivityLabels.Failed +
    $results.LabelPolicies.Failed +
    $results.LabelPolicyRules.Failed +
    $results.AutoLabelPolicies.Failed +
    $results.AutoLabelRules.Failed +
    $results.DlpPolicies.Failed +
    $results.DlpRules.Failed

Write-Log "Information Protection backup complete: $totalBackedUp backed up, $totalFailed failed" "INFO"

return @{
    Success       = ($totalFailed -eq 0)
    TotalBackedUp = $totalBackedUp
    TotalFailed   = $totalFailed
    Results       = $results
}
