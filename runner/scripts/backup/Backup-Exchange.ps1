<#
.SYNOPSIS
    Backs up Exchange Online configurations

.DESCRIPTION
    This script backs up Exchange Online configurations including:
    - Transport Rules (Mail Flow Rules)
    - Anti-Spam Policies (Hosted Content Filter Policies)
    - Anti-Phishing Policies
    - Malware Filter Policies
    - Organization Configuration (includes MailTips, AuditDisabled, OrganizationCustomization)
    - OWA Mailbox Policies
    - ExternalInOutlook settings
    - Mailbox audit status (Resource/PF/Discovery mailboxes)
    - Inbound Connectors
    - Outbound Connectors

.PARAMETER BackupPath
    The base path where backup files will be stored

.PARAMETER ExchangeOrgName
    The Exchange organization name (e.g., "contoso.onmicrosoft.com")
    Can also be set via EXCHANGE_ORG_NAME environment variable

.EXAMPLE
    .\Backup-Exchange.ps1 -BackupPath "C:\backups" -ExchangeOrgName "contoso.onmicrosoft.com"

.NOTES
    Requires ExchangeOnlineManagement module
    Requires certificate-based authentication configured in variable group
    Requires Exchange Administrator role assigned to the service principal
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupPath,
    
    [Parameter(Mandatory=$false)]
    [string]$ExchangeOrgName,
    
    [Parameter(Mandatory=$false)]
    [switch]$DebugMode
)

# Load common module if not already loaded
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not (Get-Command "Write-Log" -ErrorAction SilentlyContinue)) {
    . "$scriptDir\Backup-Common.ps1"
}

# Load Connect-M365Graph helpers (provides Connect-ExchangeOnlineDelegated)
$connectGraphPath = Join-Path $scriptDir "..\common\Connect-M365Graph.ps1"
if (Test-Path $connectGraphPath) { . $connectGraphPath }

# Initialize if needed
if (-not $script:BackupPath) {
    $script:BackupPath = $BackupPath
    $script:DebugMode = $DebugMode
}

Write-Log "=== Starting Exchange Online Backup ===" "INFO"

# Results tracking
$results = @{
    TransportRules = @{ BackedUp = 0; Failed = 0 }
    AntiSpamPolicies = @{ BackedUp = 0; Failed = 0 }
    AntiPhishPolicies = @{ BackedUp = 0; Failed = 0 }
    MalwareFilterPolicies = @{ BackedUp = 0; Failed = 0 }
    OrganizationConfig = @{ BackedUp = 0; Failed = 0 }
    OwaMailboxPolicies = @{ BackedUp = 0; Failed = 0 }
    ExternalInOutlook = @{ BackedUp = 0; Failed = 0 }
    MailboxAuditStatus = @{ BackedUp = 0; Failed = 0 }
    InboundConnectors = @{ BackedUp = 0; Failed = 0 }
    OutboundConnectors = @{ BackedUp = 0; Failed = 0 }
}

#region Authentication

Write-Log "Connecting to Exchange Online..." "INFO"

try {
    Connect-ExchangeOnlineDelegated
    Write-Log "Connected to Exchange Online via delegated auth" "INFO"
}
catch {
    Write-Log "Failed to connect to Exchange Online: $_" "ERROR"
    throw
}

#endregion

#region ExternalInOutlook (run early — right after EXO connect)

function Backup-ExternalInOutlookSettings {
    $exoVer = (Get-Module ExchangeOnlineManagement -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1).Version
    Write-Log "Backing up ExternalInOutlook (Set-ExternalInOutlook); ExchangeOnlineManagement $exoVer" "INFO"

    $maxAttempts = 3
    $lastError = $null

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            if ($attempt -gt 1) {
                Write-Log "ExternalInOutlook retry attempt $attempt of $maxAttempts..." "INFO"
            }

            $config = Get-ExternalInOutlookConfiguration
            if (-not $config) {
                throw "Get-ExternalInOutlook and adminApi InvokeCommand both returned no configuration."
            }

            $externalBackup = @{
                Enabled   = [bool]$config.Enabled
                AllowList = @($config.AllowList | Where-Object { $_ })
            }
            Save-BackupFile -Content $externalBackup -RelativePath "exchange/external-in-outlook.json"
            $script:ExchangeBackupResults.ExternalInOutlook.BackedUp = 1

            Write-Log "ExternalInOutlook backed up via $($config.Source) (Enabled=$($externalBackup.Enabled)) -> exchange/external-in-outlook.json" "INFO"
            Write-Host "##[section]ExternalInOutlook: Enabled=$($externalBackup.Enabled) -> exchange/external-in-outlook.json (via $($config.Source))"
            return
        }
        catch {
            $lastError = $_
            if ($attempt -lt $maxAttempts) {
                Write-Log "ExternalInOutlook attempt $attempt failed: $_ - retrying in 10s" "WARN"
                Start-Sleep -Seconds 10
            }
        }
    }

    $script:ExchangeBackupResults.ExternalInOutlook.Failed = 1
    Write-Log "Failed to backup ExternalInOutlook after $maxAttempts attempts: $lastError" "ERROR"
    Write-Host "##[error]ExternalInOutlook backup failed: $lastError"
    Write-Host "##[error]Microsoft Exchange returned an error for Get-ExternalInOutlook (other Exchange backups may still succeed)."
    Write-Host "##[error]Test manually in EXO PowerShell: Connect-ExchangeOnline; Get-ExternalInOutlook"
    Write-Host "##[error]Ensure the portal-connected user is in Exchange Organization Management (Connect-ExchangeOnlineDelegated tries to add automatically)."
}

$script:ExchangeBackupResults = $results
try {
    Backup-ExternalInOutlookSettings
}
catch {
    $results.ExternalInOutlook.Failed = 1
    Write-Log "Unexpected error in ExternalInOutlook backup: $_" "ERROR"
}

#endregion

#region Helper Functions

function Save-ExchangeItem {
    param(
        [Parameter(Mandatory=$true)]
        $Item,
        
        [Parameter(Mandatory=$true)]
        [string]$Category,
        
        [Parameter(Mandatory=$true)]
        [string]$Name
    )
    
    $fileName = Get-SafeFileName -Name $Name
    $relativePath = "exchange/$Category/$fileName.json"
    
    # Convert to a clean object for JSON serialization
    $itemHash = @{}
    foreach ($prop in $Item.PSObject.Properties) {
        # Skip certain properties that are not useful for backup
        if ($prop.Name -notin @('RunspaceId', 'PSComputerName', 'PSShowComputerName')) {
            $itemHash[$prop.Name] = $prop.Value
        }
    }
    
    Save-BackupFile -Content $itemHash -RelativePath $relativePath
}

#endregion

#region Transport Rules (Mail Flow Rules)

try {
    Write-Log "Backing up Transport Rules..." "INFO"
    
    $transportRules = Get-TransportRule -ErrorAction Stop
    
    Write-Log "Found $($transportRules.Count) transport rules" "INFO"
    
    foreach ($rule in $transportRules) {
        try {
            Save-ExchangeItem -Item $rule -Category "transport-rules" -Name $rule.Name
            $results.TransportRules.BackedUp++
            Write-Log "Saved transport rule: $($rule.Name)" "DEBUG"
        }
        catch {
            $results.TransportRules.Failed++
            Write-Log "Failed to backup transport rule '$($rule.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Transport Rules: Backed up $($results.TransportRules.BackedUp), Failed $($results.TransportRules.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Transport Rules: $_" "ERROR"
}

#endregion

#region Anti-Spam Policies (Hosted Content Filter Policies)

try {
    Write-Log "Backing up Anti-Spam Policies..." "INFO"
    
    $antiSpamPolicies = Get-HostedContentFilterPolicy -ErrorAction Stop
    
    Write-Log "Found $($antiSpamPolicies.Count) anti-spam policies" "INFO"
    
    foreach ($policy in $antiSpamPolicies) {
        try {
            Save-ExchangeItem -Item $policy -Category "anti-spam-policies" -Name $policy.Name
            $results.AntiSpamPolicies.BackedUp++
            Write-Log "Saved anti-spam policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.AntiSpamPolicies.Failed++
            Write-Log "Failed to backup anti-spam policy '$($policy.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Anti-Spam Policies: Backed up $($results.AntiSpamPolicies.BackedUp), Failed $($results.AntiSpamPolicies.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Anti-Spam Policies: $_" "ERROR"
}

#endregion

#region Anti-Phishing Policies

try {
    Write-Log "Backing up Anti-Phishing Policies..." "INFO"
    
    $antiPhishPolicies = Get-AntiPhishPolicy -ErrorAction Stop
    
    Write-Log "Found $($antiPhishPolicies.Count) anti-phishing policies" "INFO"
    
    foreach ($policy in $antiPhishPolicies) {
        try {
            Save-ExchangeItem -Item $policy -Category "anti-phishing-policies" -Name $policy.Name
            $results.AntiPhishPolicies.BackedUp++
            Write-Log "Saved anti-phishing policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.AntiPhishPolicies.Failed++
            Write-Log "Failed to backup anti-phishing policy '$($policy.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Anti-Phishing Policies: Backed up $($results.AntiPhishPolicies.BackedUp), Failed $($results.AntiPhishPolicies.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Anti-Phishing Policies: $_" "ERROR"
}

#endregion

#region Malware Filter Policies

try {
    Write-Log "Backing up Malware Filter Policies..." "INFO"
    
    $malwarePolicies = Get-MalwareFilterPolicy -ErrorAction Stop
    
    Write-Log "Found $($malwarePolicies.Count) malware filter policies" "INFO"
    
    foreach ($policy in $malwarePolicies) {
        try {
            Save-ExchangeItem -Item $policy -Category "malware-filter-policies" -Name $policy.Name
            $results.MalwareFilterPolicies.BackedUp++
            Write-Log "Saved malware filter policy: $($policy.Name)" "DEBUG"
        }
        catch {
            $results.MalwareFilterPolicies.Failed++
            Write-Log "Failed to backup malware filter policy '$($policy.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Malware Filter Policies: Backed up $($results.MalwareFilterPolicies.BackedUp), Failed $($results.MalwareFilterPolicies.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Malware Filter Policies: $_" "ERROR"
}

#endregion

#region Organization Configuration

try {
    Write-Log "Backing up Organization Configuration..." "INFO"
    
    $orgConfig = Get-OrganizationConfig -ErrorAction Stop
    
    # Select relevant properties for backup (not everything is useful/deployable)
    $orgConfigBackup = @{
        DisplayName = $orgConfig.DisplayName
        DefaultPublicFolderMailbox = $orgConfig.DefaultPublicFolderMailbox
        MailTipsAllTipsEnabled = $orgConfig.MailTipsAllTipsEnabled
        MailTipsExternalRecipientsTipsEnabled = $orgConfig.MailTipsExternalRecipientsTipsEnabled
        MailTipsGroupMetricsEnabled = $orgConfig.MailTipsGroupMetricsEnabled
        MailTipsLargeAudienceThreshold = $orgConfig.MailTipsLargeAudienceThreshold
        MailTipsMailboxSourcedTipsEnabled = $orgConfig.MailTipsMailboxSourcedTipsEnabled
        AuditDisabled = $orgConfig.AuditDisabled
        PublicFoldersEnabled = $orgConfig.PublicFoldersEnabled
        AutoExpandingArchive = $orgConfig.AutoExpandingArchive
        BookingsEnabled = $orgConfig.BookingsEnabled
        BookingsPaymentsEnabled = $orgConfig.BookingsPaymentsEnabled
        BookingsSocialSharingRestricted = $orgConfig.BookingsSocialSharingRestricted
        ConnectorsEnabled = $orgConfig.ConnectorsEnabled
        ConnectorsEnabledForOutlook = $orgConfig.ConnectorsEnabledForOutlook
        ConnectorsEnabledForSharepoint = $orgConfig.ConnectorsEnabledForSharepoint
        ConnectorsEnabledForTeams = $orgConfig.ConnectorsEnabledForTeams
        ConnectorsEnabledForYammer = $orgConfig.ConnectorsEnabledForYammer
        DirectReportsGroupAutoCreationEnabled = $orgConfig.DirectReportsGroupAutoCreationEnabled
        DistributionGroupDefaultOU = $orgConfig.DistributionGroupDefaultOU
        DistributionGroupNameBlockedWordsList = $orgConfig.DistributionGroupNameBlockedWordsList
        DistributionGroupNamingPolicy = $orgConfig.DistributionGroupNamingPolicy
        ElcProcessingDisabled = $orgConfig.ElcProcessingDisabled
        EndUserDLUpgradeFlowsDisabled = $orgConfig.EndUserDLUpgradeFlowsDisabled
        EwsAllowEntourage = $orgConfig.EwsAllowEntourage
        EwsAllowMacOutlook = $orgConfig.EwsAllowMacOutlook
        EwsAllowOutlook = $orgConfig.EwsAllowOutlook
        EwsApplicationAccessPolicy = $orgConfig.EwsApplicationAccessPolicy
        EwsEnabled = $orgConfig.EwsEnabled
        FocusedInboxOn = $orgConfig.FocusedInboxOn
        HierarchicalAddressBookRoot = $orgConfig.HierarchicalAddressBookRoot
        IPListBlocked = $orgConfig.IPListBlocked
        LeanPopoutEnabled = $orgConfig.LeanPopoutEnabled
        LinkPreviewEnabled = $orgConfig.LinkPreviewEnabled
        MailboxDataEncryptionEnabled = $orgConfig.MailboxDataEncryptionEnabled
        MessageRemindersEnabled = $orgConfig.MessageRemindersEnabled
        MobileAppEducationEnabled = $orgConfig.MobileAppEducationEnabled
        OAuth2ClientProfileEnabled = $orgConfig.OAuth2ClientProfileEnabled
        OutlookGifPickerDisabled = $orgConfig.OutlookGifPickerDisabled
        OutlookMobileGCCRestrictionsEnabled = $orgConfig.OutlookMobileGCCRestrictionsEnabled
        OutlookPayEnabled = $orgConfig.OutlookPayEnabled
        PublicComputersDetectionEnabled = $orgConfig.PublicComputersDetectionEnabled
        ReadTrackingEnabled = $orgConfig.ReadTrackingEnabled
        RemotePublicFolderMailboxes = $orgConfig.RemotePublicFolderMailboxes
        SiteMailboxCreationURL = $orgConfig.SiteMailboxCreationURL
        SmtpActionableMessagesEnabled = $orgConfig.SmtpActionableMessagesEnabled
        UnblockUnsafeSenderPromptEnabled = $orgConfig.UnblockUnsafeSenderPromptEnabled
        WebPushNotificationsDisabled = $orgConfig.WebPushNotificationsDisabled
        WebSuggestedRepliesDisabled = $orgConfig.WebSuggestedRepliesDisabled
    }
    
    foreach ($prop in $orgConfigBackup.Keys) {
        $singlePropBackup = @{ $prop = $orgConfigBackup[$prop] }
        Save-BackupFile -Content $singlePropBackup -RelativePath "exchange/organization-config/$prop.json"
    }
    $results.OrganizationConfig.BackedUp = $orgConfigBackup.Keys.Count

    Write-Log "Organization Configuration backed up ($($results.OrganizationConfig.BackedUp) settings under exchange/organization-config/)" "INFO"
    Write-Log "  MailTipsAllTipsEnabled=$($orgConfig.MailTipsAllTipsEnabled)" "INFO"
    Write-Log "  MailTipsExternalRecipientsTipsEnabled=$($orgConfig.MailTipsExternalRecipientsTipsEnabled)" "INFO"
    Write-Log "  MailTipsGroupMetricsEnabled=$($orgConfig.MailTipsGroupMetricsEnabled)" "INFO"
    Write-Log "  MailTipsLargeAudienceThreshold=$($orgConfig.MailTipsLargeAudienceThreshold)" "INFO"
    Write-Log "  AuditDisabled=$($orgConfig.AuditDisabled)" "INFO"

    $customizationEnabled = $true
    if ($null -ne $orgConfig.IsDehydrated) {
        $customizationEnabled = -not [bool]$orgConfig.IsDehydrated
    }
    Save-BackupFile -Content @{ Enabled = $customizationEnabled } -RelativePath "exchange/organization-config/OrganizationCustomization.json"
    Write-Log "  OrganizationCustomization Enabled=$customizationEnabled" "INFO"
}
catch {
    $results.OrganizationConfig.Failed = 1
    Write-Log "Failed to backup Organization Configuration: $_" "ERROR"
    Write-Host "##[error]Organization Configuration backup failed: $_"
}

#endregion

#region OWA Mailbox Policies

try {
    Write-Log "Backing up OWA Mailbox Policies..." "INFO"

    $owaPolicies = Get-OwaMailboxPolicy -ErrorAction Stop

    Write-Log "Found $($owaPolicies.Count) OWA mailbox policies" "INFO"

    foreach ($policy in $owaPolicies) {
        try {
            $owaBackup = @{
                Identity = $policy.Identity
                Name = $policy.Name
                AdditionalStorageProvidersAvailable = $policy.AdditionalStorageProvidersAvailable
                ActiveSyncEnabled = $policy.ActiveSyncEnabled
                ChangePasswordEnabled = $policy.ChangePasswordEnabled
                DefaultTheme = $policy.DefaultTheme
                ExternalImageProxyEnabled = $policy.ExternalImageProxyEnabled
                InstantMessagingEnabled = $policy.InstantMessagingEnabled
                NbcOptionsEnabled = $policy.NbcOptionsEnabled
                PhoneticSupportEnabled = $policy.PhoneticSupportEnabled
                PlacesEnabled = $policy.PlacesEnabled
                RecoverDeletedItemsEnabled = $policy.RecoverDeletedItemsEnabled
                TextMessagingEnabled = $policy.TextMessagingEnabled
                ThemeSelectionEnabled = $policy.ThemeSelectionEnabled
                UMIntegrationEnabled = $policy.UMIntegrationEnabled
                WacExternalServicesEnabled = $policy.WacExternalServicesEnabled
                WacOMEXEnabled = $policy.WacOMEXEnabled
                WebPartsFrameOptionsType = $policy.WebPartsFrameOptionsType
            }

            $fileName = Get-SafeFileName -Name $policy.Identity
            $settingCount = 0
            foreach ($prop in $owaBackup.Keys) {
                if ($prop -in @('Identity', 'Name')) { continue }
                Save-BackupFile -Content @{ $prop = $owaBackup[$prop] } -RelativePath "exchange/owa-policies/$fileName/$prop.json"
                $settingCount++
            }
            $results.OwaMailboxPolicies.BackedUp += $settingCount
            Write-Log "Saved OWA mailbox policy: $($policy.Identity) ($settingCount settings)" "DEBUG"
        }
        catch {
            $results.OwaMailboxPolicies.Failed++
            Write-Log "Failed to backup OWA mailbox policy '$($policy.Identity)': $_" "WARN"
        }
    }

    Write-Log "OWA Mailbox Policies: Backed up $($results.OwaMailboxPolicies.BackedUp), Failed $($results.OwaMailboxPolicies.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve OWA Mailbox Policies: $_" "ERROR"
    Write-Host "##[error]OWA Mailbox Policies backup failed: $_"
}

#endregion

#region Mailbox Audit Status

try {
    Write-Log "Backing up mailbox audit status for all mailboxes..." "INFO"

    $mailboxes = @(Get-Mailbox -ResultSize Unlimited -ErrorAction Stop)

    $auditStatus = foreach ($mbx in $mailboxes) {
        @{
            Name = $mbx.Name
            RecipientTypeDetails = [string]$mbx.RecipientTypeDetails
            AuditEnabled = $mbx.AuditEnabled
        }
    }

    Save-BackupFile -Content @($auditStatus) -RelativePath "exchange/mailbox-audit-status.json"
    $results.MailboxAuditStatus.BackedUp = @($auditStatus).Count

    $needsAudit = @($auditStatus | Where-Object { -not $_.AuditEnabled }).Count
    Write-Log "Mailbox audit status backed up ($($results.MailboxAuditStatus.BackedUp) mailboxes, $needsAudit without AuditEnabled)" "INFO"
}
catch {
    $results.MailboxAuditStatus.Failed = 1
    Write-Log "Failed to backup mailbox audit status: $_" "ERROR"
    Write-Host "##[error]Mailbox audit status backup failed: $_"
}

#endregion

#region Inbound Connectors

try {
    Write-Log "Backing up Inbound Connectors..." "INFO"
    
    $inboundConnectors = Get-InboundConnector -ErrorAction Stop
    
    Write-Log "Found $($inboundConnectors.Count) inbound connectors" "INFO"
    
    foreach ($connector in $inboundConnectors) {
        try {
            Save-ExchangeItem -Item $connector -Category "connectors/inbound" -Name $connector.Name
            $results.InboundConnectors.BackedUp++
            Write-Log "Saved inbound connector: $($connector.Name)" "DEBUG"
        }
        catch {
            $results.InboundConnectors.Failed++
            Write-Log "Failed to backup inbound connector '$($connector.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Inbound Connectors: Backed up $($results.InboundConnectors.BackedUp), Failed $($results.InboundConnectors.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Inbound Connectors: $_" "ERROR"
}

#endregion

#region Outbound Connectors

try {
    Write-Log "Backing up Outbound Connectors..." "INFO"
    
    $outboundConnectors = Get-OutboundConnector -ErrorAction Stop
    
    Write-Log "Found $($outboundConnectors.Count) outbound connectors" "INFO"
    
    foreach ($connector in $outboundConnectors) {
        try {
            Save-ExchangeItem -Item $connector -Category "connectors/outbound" -Name $connector.Name
            $results.OutboundConnectors.BackedUp++
            Write-Log "Saved outbound connector: $($connector.Name)" "DEBUG"
        }
        catch {
            $results.OutboundConnectors.Failed++
            Write-Log "Failed to backup outbound connector '$($connector.Name)': $_" "WARN"
        }
    }
    
    Write-Log "Outbound Connectors: Backed up $($results.OutboundConnectors.BackedUp), Failed $($results.OutboundConnectors.Failed)" "INFO"
}
catch {
    Write-Log "Failed to retrieve Outbound Connectors: $_" "ERROR"
}

#endregion

#region Cleanup

Write-Log "Disconnecting from Exchange Online..." "DEBUG"
Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue

#endregion

#region Summary

Write-Log "=== Exchange Online Backup Complete ===" "INFO"

$totalBackedUp = 0
$totalFailed = 0

foreach ($category in $results.Keys) {
    $totalBackedUp += $results[$category].BackedUp
    $totalFailed += $results[$category].Failed
}

Write-Log "Total items backed up: $totalBackedUp" "INFO"
Write-Log "Total items failed: $totalFailed" "INFO"

if ($results.ExternalInOutlook.Failed -gt 0) {
    Write-Host "##[error]ExternalInOutlook was NOT backed up - exchange/external-in-outlook.json is missing."
    Write-Host "##[error]See ExternalInOutlook errors above (often a Microsoft Exchange server-side error on Get-ExternalInOutlook for this tenant)."
}

# Return summary
$summary = @{
    Type = "Exchange"
    Success = ($totalFailed -eq 0)
    TotalBackedUp = $totalBackedUp
    TotalFailed = $totalFailed
    Details = $results
}

if ($results.ExternalInOutlook.Failed -gt 0) {
    # Fail the Exchange backup step in Gitea Actions so the error is visible (step uses continue-on-error).
    $summary | Out-Null
    exit 1
}

return $summary

#endregion

