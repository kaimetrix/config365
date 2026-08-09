<#
.SYNOPSIS
    Configures Consent and Permissions settings via Microsoft Graph API

.DESCRIPTION
    Applies consent and permissions configuration from JSON files:
    - Authorization Policy (User consent settings)
    - Admin Consent Request Policy (Admin consent workflow)
    - Permission Classifications (Low/Medium/High risk permissions)

.PARAMETER ConfigDirectory
    Path to the directory containing consent permissions JSON files

.PARAMETER OutputPath
    Path to save the plan/results JSON file for pipeline summary

.EXAMPLE
    .\Configure-ConsentPermissions.ps1 -ConfigDirectory "baseline/entra-id-consentpermissions"

.EXAMPLE
    .\Configure-ConsentPermissions.ps1 -ConfigDirectory "baseline/entra-id-consentpermissions" -WhatIf -OutputPath "plan.json"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$ConfigDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantBaselinePath,
    
    [Parameter(Mandatory=$false)]
    [string]$TenantRepoPath  # Path to tenant's own repo (for .baseline-ignore)
)

$ErrorActionPreference = "Stop"

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# Import shared diff helpers
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

Write-Host "##[section]Configuring Consent and Permissions"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Initialize plan tracking early for summary output (even on errors)
$planResults = @{
    Service = "ConsentPermissions"
    Timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    WouldCreateCount = 0
    WouldUpdateCount = 0
    NoChangeCount = 0
    ErrorCount = 0
    Results = @()
}

# Helper function to save plan output
function Save-PlanOutput {
    if ($OutputPath) {
        $script:planResults | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
        Write-Host "Plan saved to: $OutputPath"
    }
}

# Validate parameters
if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Save-PlanOutput
    exit 0
}

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph
try {
    $context = Ensure-M365GraphConnection
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

#region Configure Authorization Policy (User Consent Settings)
$authzPolicyPath = Join-Path $ConfigDirectory "policies\authorization-policy.json"
if (Test-Path $authzPolicyPath) {
    Write-Host "`n##[group]Configuring Authorization Policy (User Consent Settings)..."
    
    $result = @{
        DisplayName = "Authorization Policy"
        Type = "ConsentPolicy"
        Status = ""
        Changes = @{}
        FilePath = $authzPolicyPath
    }
    try {
        $authzMonitorCfg = Get-MonitorConfig -BaselineFilePath $authzPolicyPath

        # Load the baseline file into a dedicated variable - the prior implementation
        # referenced an undefined $config here, leaving $updatePayload empty so every
        # WhatIf reported "No changes" regardless of actual drift.
        $authzConfig = Get-Content $authzPolicyPath -Raw | ConvertFrom-Json

        # Fetch live policy via explicit bearer token — avoids relying on process-global
        # Get-MgContext which can return stale/wrong-tenant state on shared runners.
        $graphToken = Get-M365GraphAccessToken
        $currentUri = "https://graph.microsoft.com/v1.0/policies/authorizationPolicy"
        $currentPolicy = $null
        try {
            $currentPolicy = Invoke-M365GraphRest -Uri $currentUri -AccessToken $graphToken
            Write-Host "  Retrieved current Authorization Policy for comparison (bearer token)"
            Write-Host "  TENANT_SLUG=$($env:TENANT_SLUG); AZURE_TENANT_ID=$($env:AZURE_TENANT_ID); allowInvitesFrom (live): $($currentPolicy.allowInvitesFrom); allowInvitesFrom (baseline): $($authzConfig.allowInvitesFrom)"
        }
        catch {
            Write-Host "  ##[warning]Could not retrieve current policy for comparison: $_"
        }
        
        # Build update payload - only include writable properties
        $updatePayload = @{}
        
        # Common writable properties
        $writableProps = @(
            'allowInvitesFrom',
            'allowedToSignUpEmailBasedSubscriptions',
            'allowedToUseSSPR',
            'allowEmailVerifiedUsersToJoinOrganization',
            'blockMsolPowerShell',
            'guestUserRoleId',
            'allowUserConsentForRiskyApps',
            'description',
            'displayName'
        )

        foreach ($prop in $writableProps) {
            if ($null -ne $authzConfig.$prop) {
                $updatePayload[$prop] = $authzConfig.$prop
            }
        }

        # Handle defaultUserRolePermissions if present
        if ($authzConfig.defaultUserRolePermissions) {
            $defaultPerms = @{}
            if ($null -ne $authzConfig.defaultUserRolePermissions.allowedToCreateApps) {
                $defaultPerms['allowedToCreateApps'] = $authzConfig.defaultUserRolePermissions.allowedToCreateApps
            }
            if ($null -ne $authzConfig.defaultUserRolePermissions.allowedToCreateSecurityGroups) {
                $defaultPerms['allowedToCreateSecurityGroups'] = $authzConfig.defaultUserRolePermissions.allowedToCreateSecurityGroups
            }
            if ($null -ne $authzConfig.defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice) {
                $defaultPerms['allowedToReadBitlockerKeysForOwnedDevice'] = $authzConfig.defaultUserRolePermissions.allowedToReadBitlockerKeysForOwnedDevice
            }
            if ($null -ne $authzConfig.defaultUserRolePermissions.allowedToReadOtherUsers) {
                $defaultPerms['allowedToReadOtherUsers'] = $authzConfig.defaultUserRolePermissions.allowedToReadOtherUsers
            }
            if ($null -ne $authzConfig.defaultUserRolePermissions.allowedToCreateTenants) {
                $defaultPerms['allowedToCreateTenants'] = $authzConfig.defaultUserRolePermissions.allowedToCreateTenants
            }
            if ($null -ne $authzConfig.defaultUserRolePermissions.permissionGrantPoliciesAssigned) {
                # API requires an array. Backup/tenant returns array even when baseline
                # author wrote it as a single string, so always normalise to array form.
                $policyValue = $authzConfig.defaultUserRolePermissions.permissionGrantPoliciesAssigned
                if ($policyValue -is [string]) {
                    $defaultPerms['permissionGrantPoliciesAssigned'] = @($policyValue)
                }
                elseif ($policyValue -is [System.Collections.IList]) {
                    $defaultPerms['permissionGrantPoliciesAssigned'] = @($policyValue)
                }
                else {
                    $defaultPerms['permissionGrantPoliciesAssigned'] = @($policyValue)
                }
            }
            if ($defaultPerms.Count -gt 0) {
                $updatePayload['defaultUserRolePermissions'] = $defaultPerms
            }
        }
        
        # Apply field-monitor filter if sidecar is present
        $authzMonitorConfig = $null
        if ($authzMonitorCfg) {
            $authzMonitorConfig = @{}
            if ($authzMonitorCfg.Include) { $authzMonitorConfig['Include'] = @($authzMonitorCfg.Include) }
            if ($authzMonitorCfg.Exclude) { $authzMonitorConfig['Exclude'] = @($authzMonitorCfg.Exclude) }
            if ($authzMonitorConfig.Count -eq 0) { $authzMonitorConfig = $null }
        }
        $compareAuthzPayload = if ($authzMonitorConfig) { Apply-MonitorFilter -PolicyObject $updatePayload -MonitorConfig $authzMonitorConfig } else { $updatePayload }

        # Compare settings to detect changes
        $hasChanges = $false
        $changesObj = @{ Modified = @(); ModifiedValues = @{} }
        if ($currentPolicy) {
            $changesObj = New-ChangesObject -Existing $currentPolicy -Desired $compareAuthzPayload -Keys @($compareAuthzPayload.Keys)
            $hasChanges = $changesObj.Modified.Count -gt 0
        }
        else {
            $hasChanges = $true
            $changesObj = @{ Modified = @("(Unable to compare - treating as update)"); ModifiedValues = @{} }
        }
        
        if ($hasChanges) {
            if ($PSCmdlet.ShouldProcess("Authorization Policy", "Update")) {
                $patchAuthzPayload = if ($authzMonitorConfig) { Apply-MonitorFilter -PolicyObject $updatePayload -MonitorConfig $authzMonitorConfig } else { $updatePayload }
                Invoke-M365GraphRest -Uri $currentUri -Method PATCH -AccessToken $graphToken -Body ($patchAuthzPayload | ConvertTo-Json -Depth 10)
                Write-Host "✓ Authorization Policy configured"
                $result.Status = "Updated"
                $planResults.WouldUpdateCount++
            }
            else {
                Write-Host "[WhatIf] Would update Authorization Policy"
                foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
                $result.Status  = "WouldUpdate"
                $result.Changes = $changesObj
                $planResults.WouldUpdateCount++
            }
        }
        else {
            Write-Host "○ Authorization Policy - no changes needed"
            $result.Status = "No changes"
            $planResults.NoChangeCount++
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Authorization Policy: $_"
        $result.Status = "Failed: $_"
        $planResults.ErrorCount++
    }
    
    $planResults.Results += $result
    Write-Host "##[endgroup]"
}
#endregion

#region Configure Admin Consent Request Policy
$adminConsentPath = Join-Path $ConfigDirectory "policies\admin-consent-request-policy.json"
if (Test-Path $adminConsentPath) {
    Write-Host "`n##[group]Configuring Admin Consent Request Policy..."
    
    $result = @{
        DisplayName = "Admin Consent Request Policy"
        Type = "ConsentPolicy"
        Status = ""
        Changes = @{}
        FilePath = $adminConsentPath
    }
    try {
        $adminConsentMonitorCfg = Get-MonitorConfig -BaselineFilePath $adminConsentPath

        # Load the baseline file into a dedicated variable - same fix as the Authz
        # section: previous code dereferenced an undefined $config.
        $adminConsentConfig = Get-Content $adminConsentPath -Raw | ConvertFrom-Json

        # Get current policy for comparison
        $uri = "https://graph.microsoft.com/v1.0/policies/adminConsentRequestPolicy"
        $currentPolicy = $null
        try {
            $currentPolicy = Invoke-MgGraphRequest -Uri $uri -Method GET
        }
        catch {
            Write-Host "  Could not retrieve current policy for comparison"
        }
        
        # Build update payload
        $updatePayload = @{}

        if ($null -ne $adminConsentConfig.isEnabled) {
            $updatePayload['isEnabled'] = $adminConsentConfig.isEnabled
        }
        if ($null -ne $adminConsentConfig.notifyReviewers) {
            $updatePayload['notifyReviewers'] = $adminConsentConfig.notifyReviewers
        }
        if ($null -ne $adminConsentConfig.remindersEnabled) {
            $updatePayload['remindersEnabled'] = $adminConsentConfig.remindersEnabled
        }
        if ($null -ne $adminConsentConfig.requestDurationInDays) {
            $updatePayload['requestDurationInDays'] = $adminConsentConfig.requestDurationInDays
        }
        if ($null -ne $adminConsentConfig.reviewers) {
            # Normalize reviewers identically on BOTH sides of the compare.
            #
            # Graph always returns each live reviewer with `queryRoot: null`
            # (even when not set), while baseline JSON often emits the key as
            # null too — but the previous normaliser stripped queryRoot from
            # the desired payload when null, leaving the live side with a
            # `queryRoot` key and the desired side without one. The array
            # branch of Compare-PropertyValues serialises each element to
            # canonical JSON and matches by string equality, so an absent
            # key vs `queryRoot:null` made every reviewer look different and
            # triggered "Will Update" on every WhatIf for tenants that
            # already matched the baseline.
            #
            # Fix: always emit all three reviewer keys with $null preserved,
            # and apply the SAME normalisation to the live policy before
            # passing it to New-ChangesObject so the canonical-JSON array
            # compare lines up byte-for-byte when nothing has changed.
            $reviewers = @()
            foreach ($r in $adminConsentConfig.reviewers) {
                $reviewers += @{
                    query     = $r.query
                    queryType = $r.queryType
                    queryRoot = $r.queryRoot
                }
            }
            $updatePayload['reviewers'] = $reviewers
        }

        # Apply field-monitor filter if sidecar is present
        $adminConsentMonitorConfig = $null
        if ($adminConsentMonitorCfg) {
            $adminConsentMonitorConfig = @{}
            if ($adminConsentMonitorCfg.Include) { $adminConsentMonitorConfig['Include'] = @($adminConsentMonitorCfg.Include) }
            if ($adminConsentMonitorCfg.Exclude) { $adminConsentMonitorConfig['Exclude'] = @($adminConsentMonitorCfg.Exclude) }
            if ($adminConsentMonitorConfig.Count -eq 0) { $adminConsentMonitorConfig = $null }
        }
        $compareAdminPayload = if ($adminConsentMonitorConfig) { Apply-MonitorFilter -PolicyObject $updatePayload -MonitorConfig $adminConsentMonitorConfig } else { $updatePayload }

        # Build a compare-only view of the live policy with reviewers
        # normalised the same way as the desired payload. We shallow-copy
        # the top-level keys so the PUT merge path below still sees the
        # untouched $currentPolicy. See the long comment above for why this
        # symmetric normalisation is required.
        $currentForCompare = $currentPolicy
        if ($currentPolicy -and $currentPolicy.reviewers) {
            $currentForCompare = @{}
            if ($currentPolicy -is [System.Collections.IDictionary]) {
                foreach ($k in @($currentPolicy.Keys)) { $currentForCompare[$k] = $currentPolicy[$k] }
            }
            elseif ($null -ne $currentPolicy.PSObject) {
                foreach ($p in $currentPolicy.PSObject.Properties) { $currentForCompare[$p.Name] = $p.Value }
            }
            $normalizedLiveReviewers = @()
            foreach ($r in $currentPolicy.reviewers) {
                $normalizedLiveReviewers += @{
                    query     = $r.query
                    queryType = $r.queryType
                    queryRoot = $r.queryRoot
                }
            }
            $currentForCompare['reviewers'] = $normalizedLiveReviewers
        }

        # Compare settings to detect changes
        $hasChanges = $false
        $changesObj = @{ Modified = @(); ModifiedValues = @{} }
        if ($currentPolicy) {
            $changesObj = New-ChangesObject -Existing $currentForCompare -Desired $compareAdminPayload -Keys @($compareAdminPayload.Keys)
            $hasChanges = $changesObj.Modified.Count -gt 0
        }
        else {
            $hasChanges = $true
            $changesObj = @{ Modified = @("(Unable to compare - treating as update)"); ModifiedValues = @{} }
        }
        
        if ($hasChanges) {
            if ($PSCmdlet.ShouldProcess("Admin Consent Request Policy", "Update")) {
                # PUT requires complete object — merge monitored fields into current policy when filter is active
                $putPayload = if ($adminConsentMonitorConfig -and $currentPolicy) {
                    $merged = $currentPolicy | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
                    $filtered = Apply-MonitorFilter -PolicyObject $updatePayload -MonitorConfig $adminConsentMonitorConfig
                    foreach ($k in $filtered.Keys) { $merged[$k] = $filtered[$k] }
                    $merged
                } else { $updatePayload }
                Invoke-MgGraphRequest -Uri $uri -Method PUT -Body ($putPayload | ConvertTo-Json -Depth 10) -ContentType "application/json"
                Write-Host "✓ Admin Consent Request Policy configured"
                $result.Status = "Updated"
                $planResults.WouldUpdateCount++
            }
            else {
                Write-Host "[WhatIf] Would update Admin Consent Request Policy"
                foreach ($change in $changesObj.Modified) { Write-Host "  - $change" }
                $result.Status  = "WouldUpdate"
                $result.Changes = $changesObj
                $planResults.WouldUpdateCount++
            }
        }
        else {
            Write-Host "○ Admin Consent Request Policy - no changes needed"
            $result.Status = "No changes"
            $planResults.NoChangeCount++
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Admin Consent Request Policy: $_"
        $result.Status = "Failed: $_"
        $planResults.ErrorCount++
    }
    
    $planResults.Results += $result
    Write-Host "##[endgroup]"
}
#endregion

#region Configure Permission Classifications
$classificationDir = Join-Path $ConfigDirectory "permissionClassifications"
if (Test-Path $classificationDir) {
    Write-Host "`n##[group]Configuring Permission Classifications..."
    
    try {
        # Get Microsoft Graph service principal
        $graphAppId = "00000003-0000-0000-c000-000000000000"
        $spUri = "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '$graphAppId'"
        $spResponse = Invoke-MgGraphRequest -Uri $spUri -Method GET
        
        if ($spResponse.value -and $spResponse.value.Count -gt 0) {
            $graphSpId = $spResponse.value[0].id
            Write-Host "Found Microsoft Graph service principal: $graphSpId"
            
            # Get existing classifications to compare
            $existingUri = "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/delegatedPermissionClassifications"
            $existingClassifications = Invoke-MgGraphRequest -Uri $existingUri -Method GET
            $existingPermissionIds = @{}
            foreach ($existing in $existingClassifications.value) {
                $existingPermissionIds[$existing.permissionId] = $existing.id
            }
            
            # Process each classification level file
            $classificationFiles = Get-ChildItem -Path $classificationDir -Filter "*.json" -File
            # Filter out ignored files based on .baseline-ignore
            # Use the baseline folder root so patterns like "consent-permissions/file.json" work correctly
            $baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
            $classificationFiles = @(Get-FilteredPolicyFiles -PolicyFiles $classificationFiles -BaselineRoot $baselineRoot)
            $classificationFiles = @(Get-GroupExcludedFiles -Files $classificationFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
            
            foreach ($file in $classificationFiles) {
                $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
                $level = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
                
                Write-Host "Processing $level classifications..."
                
                if ($config.permissions) {
                    foreach ($perm in $config.permissions) {
                        $permissionId = $perm.permissionId
                        $permissionName = $perm.permissionName
                        
                        $result = @{
                            DisplayName = "$permissionName ($level)"
                            Type = "PermissionClassification"
                            Status = ""
                            Changes = @{}
                        }
                        
                        if ($existingPermissionIds.ContainsKey($permissionId)) {
                            Write-Host "  ○ Skipping $permissionName (already exists)" -ForegroundColor Gray
                            $result.Status = "No changes"
                            $planResults.NoChangeCount++
                        }
                        else {
                            if ($PSCmdlet.ShouldProcess("$permissionName ($level)", "Add classification")) {
                                $createPayload = @{
                                    permissionId = $permissionId
                                    permissionName = $permissionName
                                    classification = $level
                                }
                                
                                $createUri = "https://graph.microsoft.com/v1.0/servicePrincipals/$graphSpId/delegatedPermissionClassifications"
                                Invoke-MgGraphRequest -Uri $createUri -Method POST -Body ($createPayload | ConvertTo-Json) -ContentType "application/json"
                                Write-Host "  ✓ Added $permissionName as $level"
                                $result.Status = "Created"
                                $planResults.WouldCreateCount++
                            }
                            else {
                                Write-Host "  [WhatIf] Would add $permissionName as $level"
                                $result.Status = "WouldCreate"
                                $planResults.WouldCreateCount++
                            }
                        }
                        
                        $result['FilePath'] = $file.FullName
                        $planResults.Results += $result
                    }
                }
            }
            
            Write-Host "✓ Permission Classifications configured"
        }
        else {
            Write-Host "##[warning]Microsoft Graph service principal not found"
            $result = @{
                DisplayName = "Permission Classifications"
                Type = "PermissionClassification"
                Status = "Failed: Microsoft Graph service principal not found"
                Changes = @{}
            }
            $planResults.Results += $result
            $planResults.ErrorCount++
        }
    }
    catch {
        Write-Host "##[warning]Failed to configure Permission Classifications: $_"
        $result = @{
            DisplayName = "Permission Classifications"
            Type = "PermissionClassification"
            Status = "Failed: $_"
            Changes = @{}
        }
        $planResults.Results += $result
        $planResults.ErrorCount++
    }
    
    Write-Host "##[endgroup]"
}
#endregion

# Output plan summary
Save-PlanOutput

Write-Host "`n##[section]Consent and Permissions Configuration Complete"

