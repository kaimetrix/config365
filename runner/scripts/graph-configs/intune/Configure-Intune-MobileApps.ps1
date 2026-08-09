<#
.SYNOPSIS
    Creates and manages Intune Mobile Apps via Microsoft Graph API
    
.DESCRIPTION
    Handles mobile app deployment including WinGet apps, Store apps, web apps, and Microsoft 365 suite apps.
    Excludes MSI installers and LOB apps that require content uploads.
    This module is called by the main Configure-Intune.ps1 orchestrator.
    
.PARAMETER PolicyConfigs
    Array of policy configuration objects to process
    
.PARAMETER WhatIf
    Show what would be changed without making changes
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [array]$PolicyConfigs,
    
    [Parameter(Mandatory=$false)]
    [switch]$WhatIfMode
)

# Always load helpers (required when called from orchestrator with & operator)
$helpersPath = Join-Path $PSScriptRoot "Configure-Intune-Helpers.ps1"
. $helpersPath

# Load common ignore helpers for protection marker support
$ignoreHelpersPath = Join-Path $PSScriptRoot "..\Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

# ============================================================================
# MOBILE APP SPECIFIC REPAIR FUNCTION
# ============================================================================

function Wait-MobileAppPublished {
    param(
        [string]$AppId,
        [string]$DisplayName,
        [int]$MaxRetries = 30,
        [int]$RetryDelaySec = 10
    )
    $appUri = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/$AppId"
    for ($i = 1; $i -le $MaxRetries; $i++) {
        $app = Invoke-MgGraphRequest -Method GET -Uri $appUri
        if ($app.publishingState -eq 'published') {
            Write-Host "  [i] App published (check $i)" -ForegroundColor DarkGray
            return $true
        }
        Write-Host "  [.] Waiting for publish... ($i/$MaxRetries, state: $($app.publishingState))" -ForegroundColor DarkGray
        Start-Sleep -Seconds $RetryDelaySec
    }
    Write-Host "##[warning]App '$DisplayName' did not reach published state after $($MaxRetries * $RetryDelaySec)s — assignments skipped" -ForegroundColor Yellow
    return $false
}

# ============================================================================

function Repair-MobileAppPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    # Clone the object by converting to JSON and back (as PSObject, not hashtable)
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    
    # Remove metadata properties that should not be sent to the API
    $propsToRemove = @(
        'id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
        'version', '@odata.context',
        '_sourceFile', '_policyType', '_assignments', '_settings',
        'publishingState', 'uploadState', 'isAssigned',
        'dependentAppCount', 'supersedingAppCount', 'supersededAppCount',
        'committedContentVersion', 'size', 'manifestHash'
    )
    foreach ($prop in $propsToRemove) {
        if ($json.PSObject.Properties.Name -contains $prop) {
            $json.PSObject.Properties.Remove($prop)
        }
    }
    
    # Fix roleScopeTagIds - should always be an array of strings
    if ($json.PSObject.Properties.Name -contains 'roleScopeTagIds') {
        $tagIds = $json.roleScopeTagIds
        if ($null -eq $tagIds -or $tagIds.Count -eq 0) {
            $json.roleScopeTagIds = @("0")
        }
        elseif ($tagIds -is [string]) {
            if ($tagIds -match ',') {
                $json.roleScopeTagIds = @($tagIds -split ',' | ForEach-Object { $_.Trim() })
            }
            else {
                $json.roleScopeTagIds = @($tagIds)
            }
        }
        elseif ($tagIds -isnot [System.Collections.IList]) {
            $json.roleScopeTagIds = @($tagIds.ToString())
        }
    }
    
    # Ensure @odata.type is present
    if (-not ($json.PSObject.Properties.Name -contains '@odata.type')) {
        Write-Warning "Mobile app missing @odata.type - this may cause deployment issues"
    }
    
    # Handle app-type specific properties
    $appType = $json.'@odata.type'
    
    switch ($appType) {
        { $_ -in @('#microsoft.graph.officeSuiteApp', '#microsoft.graph.macOSOfficeSuiteApp') } {
            # Fix productIds - must be an array
            if ($json.PSObject.Properties.Name -contains 'productIds') {
                if ($json.productIds -is [string]) {
                    $json.productIds = @($json.productIds)
                }
                elseif ($null -eq $json.productIds) {
                    $json.productIds = @()
                }
            }
            
            # Fix localesToInstall - must be an array
            if ($json.PSObject.Properties.Name -contains 'localesToInstall') {
                if ($json.localesToInstall -is [string]) {
                    if ($json.localesToInstall) {
                        $json.localesToInstall = @($json.localesToInstall)
                    }
                    else {
                        $json.localesToInstall = @()
                    }
                }
                elseif ($null -eq $json.localesToInstall) {
                    $json.localesToInstall = @()
                }
            }
            
            # Fix excludedApps for Windows Office Suite - must have all properties as boolean
            if ($appType -eq '#microsoft.graph.officeSuiteApp') {
                Write-Verbose "    Repairing excludedApps for Office Suite app..."
                
                # List of all possible excluded apps
                $allExcludedApps = @('access', 'bing', 'excel', 'groove', 'infoPath', 'lync', 
                                     'oneDrive', 'oneNote', 'outlook', 'powerPoint', 'publisher', 
                                     'sharePointDesigner', 'teams', 'visio', 'word')
                
                # Get or create excludedApps as PSObject
                if ($null -eq $json.excludedApps) {
                    Write-Verbose "      excludedApps was null, creating new PSCustomObject..."
                    $json.excludedApps = [PSCustomObject]@{}
                }
                
                # Get existing properties
                $existingProps = @($json.excludedApps.PSObject.Properties.Name)
                Write-Verbose "      Initial excludedApps properties: $($existingProps -join ', ')"
                
                # Ensure all apps have boolean values (convert null to false)
                $changedCount = 0
                foreach ($app in $allExcludedApps) {
                    if ($existingProps -notcontains $app) {
                        # Property doesn't exist, add it
                        $json.excludedApps | Add-Member -NotePropertyName $app -NotePropertyValue $false -Force
                        $changedCount++
                        Write-Verbose "        Added $app = false (was missing)"
                    }
                    elseif ($null -eq $json.excludedApps.$app) {
                        # Property exists but is null
                        $json.excludedApps.$app = $false
                        $changedCount++
                        Write-Verbose "        Set $app = false (was null)"
                    }
                    elseif ($json.excludedApps.$app -isnot [bool]) {
                        # Property exists but wrong type
                        $originalValue = $json.excludedApps.$app
                        $json.excludedApps.$app = [bool]$json.excludedApps.$app
                        $changedCount++
                        Write-Verbose "        Converted $app from $($originalValue.GetType().Name) to Boolean"
                    }
                }
                Write-Verbose "      Fixed $changedCount excludedApps properties"
                Write-Verbose "      Final excludedApps properties count: $(@($json.excludedApps.PSObject.Properties).Count)"
            }
            
            # Ensure boolean properties are actually boolean
            $boolProps = @('autoAcceptEula', 'useSharedComputerActivation', 'shouldUninstallOlderVersionsOfOffice')
            foreach ($prop in $boolProps) {
                if (($json.PSObject.Properties.Name -contains $prop) -and $json.$prop -isnot [bool]) {
                    $json.$prop = [bool]$json.$prop
                }
            }
        }
        '#microsoft.graph.iosStoreApp' {
            # Ensure applicableDeviceType is present for iOS apps
            if ($null -eq $json.applicableDeviceType) {
                $json.applicableDeviceType = [PSCustomObject]@{
                    iPad = $true
                    iPhoneAndIPod = $true
                }
            }
        }
        '#microsoft.graph.winGetApp' {
            # Ensure installExperience is present for WinGet apps
            if ($null -eq $json.installExperience) {
                $json.installExperience = [PSCustomObject]@{
                    runAsAccount = "system"
                }
            }
        }
    }
    
    # Remove null values from PSObject
    $propsToRemove = @()
    foreach ($prop in $json.PSObject.Properties) {
        if ($null -eq $prop.Value) {
            $propsToRemove += $prop.Name
        }
    }
    foreach ($propName in $propsToRemove) {
        $json.PSObject.Properties.Remove($propName)
    }
    
    return $json
}

# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-MobileApps {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps"
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { $policyConfig.name.Trim() }
        $appType = $policyConfig.'@odata.type'
        
        Write-Host "`n##[group]Processing [mobile-app]: $displayName ($appType)"
        
        try {
            # Check if app exists
            $allApps = Get-AllPoliciesOfType -PolicyType "mobile-apps"
            $existingApp = $allApps | Where-Object { $_.displayName.Trim() -ieq $displayName } | Select-Object -First 1
            
            $action = "Create"
            $hasChanges = $true
            
            $changeDetails = $null
            if ($existingApp) {
                # Check if app is protected from baseline updates via description marker
                if (Test-ResourceProtected -Description $existingApp.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  [!] Protected: App has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = "mobile-apps"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Check if app type matches
                if ($existingApp.'@odata.type' -ne $appType) {
                    Write-Host "  âš  Warning: Existing app has different type ($($existingApp.'@odata.type')) - cannot update type" -ForegroundColor Yellow
                    Write-Host "  App exists with same name but different type - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = "mobile-apps"
                        Status = "TypeMismatch"
                        Warning = "App exists with different type: $($existingApp.'@odata.type')"
                    }
                    continue
                }
                
                Write-Host "  [*] Comparing configurations..."
                Write-Host "    Existing App ID: $($existingApp.id)"
                
                # Normalize BOTH existing and baseline configs for fair comparison
                # Clone existing app
                $normalizedExisting = $existingApp | ConvertTo-Json -Depth 30 | ConvertFrom-Json
                
                # Normalize existing app's roleScopeTagIds
                if ($normalizedExisting.roleScopeTagIds -is [string]) {
                    $normalizedExisting.roleScopeTagIds = @($normalizedExisting.roleScopeTagIds)
                }
                elseif ($null -eq $normalizedExisting.roleScopeTagIds -or $normalizedExisting.roleScopeTagIds.Count -eq 0) {
                    $normalizedExisting.roleScopeTagIds = @("0")
                }
                
                # Clone baseline config
                $normalizedConfig = $policyConfig | ConvertTo-Json -Depth 30 | ConvertFrom-Json
                
                # Normalize baseline config's roleScopeTagIds to array format
                if ($normalizedConfig.roleScopeTagIds -is [string]) {
                    if ($normalizedConfig.roleScopeTagIds -match ',') {
                        $normalizedConfig.roleScopeTagIds = @($normalizedConfig.roleScopeTagIds -split ',' | ForEach-Object { $_.Trim() })
                    }
                    else {
                        $normalizedConfig.roleScopeTagIds = @($normalizedConfig.roleScopeTagIds)
                    }
                }
                elseif ($null -eq $normalizedConfig.roleScopeTagIds) {
                    $normalizedConfig.roleScopeTagIds = @("0")
                }
                
                Write-Verbose "    Normalized roleScopeTagIds - Existing: [$($normalizedExisting.roleScopeTagIds -join ',')] vs Baseline: [$($normalizedConfig.roleScopeTagIds -join ',')]"
                
                # Normalize Office Suite app arrays (productIds, localesToInstall)
                if ($normalizedConfig.'@odata.type' -in @('#microsoft.graph.officeSuiteApp', '#microsoft.graph.macOSOfficeSuiteApp')) {
                    if ($normalizedConfig.productIds -is [string]) {
                        $normalizedConfig.productIds = @($normalizedConfig.productIds)
                    }
                    if ($normalizedConfig.localesToInstall -is [string]) {
                        if ($normalizedConfig.localesToInstall) {
                            $normalizedConfig.localesToInstall = @($normalizedConfig.localesToInstall)
                        }
                        else {
                            $normalizedConfig.localesToInstall = @()
                        }
                    }
                    
                    # Normalize existing app's arrays too
                    if ($normalizedExisting.productIds -is [string]) {
                        $normalizedExisting.productIds = @($normalizedExisting.productIds)
                    }
                    if ($normalizedExisting.localesToInstall -is [string]) {
                        if ($normalizedExisting.localesToInstall) {
                            $normalizedExisting.localesToInstall = @($normalizedExisting.localesToInstall)
                        }
                        else {
                            $normalizedExisting.localesToInstall = @()
                        }
                    }
                }
                
                # Load known read-only properties from track file (written by previous deploy runs)
                $trackIgnoreProps = @()
                if ($TenantRepoPath) {
                    $trackFile = Join-Path $TenantRepoPath "config" "baseline-tracking" "intune" "mobile-apps" "$displayName.track.json"
                    if (Test-Path $trackFile) {
                        $trackData = Get-Content $trackFile -Raw | ConvertFrom-Json
                        if ($trackData.readOnlyProperties) {
                            $trackIgnoreProps = @($trackData.readOnlyProperties)
                            Write-Host "  [i] Track file: ignoring known read-only props ($($trackIgnoreProps -join ', '))" -ForegroundColor DarkGray
                        }
                    }
                }

                # Compare app configurations using normalized versions
                $ignoreProps = @('assignments', 'largeIcon', 'committedContentVersion', 'size',
                                'uploadState', 'publishingState', 'isAssigned', 'manifestHash') + $trackIgnoreProps

                $comparison = Compare-PolicyConfigurations -ExistingPolicy $normalizedExisting -DesiredPolicy $normalizedConfig -IgnoreProperties $ignoreProps -ReturnDetails
                
                if ($comparison.IsEquivalent) {
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  âœ… App exists - no changes needed"
                }
                else {
                    $action = "Update"
                    $changeDetails = $comparison.Differences
                    Write-Host "  [*] App exists - changes detected"
                    Write-Host "  âš  Note: Many app properties are immutable after creation" -ForegroundColor Yellow
                    
                    if ($changeDetails.Added.Count -gt 0) { 
                        Write-Host "    âž• Added properties: $($changeDetails.Added -join ', ')" -ForegroundColor Cyan
                        foreach ($prop in $changeDetails.Added) {
                            $desiredValue = if ($normalizedConfig.$prop -is [string] -and $normalizedConfig.$prop.Length -gt 50) {
                                $normalizedConfig.$prop.Substring(0, 50) + "..."
                            } else {
                                $normalizedConfig.$prop | ConvertTo-Json -Compress -Depth 2
                            }
                            Write-Host "       â€¢ $prop = $desiredValue" -ForegroundColor DarkCyan
                        }
                    }
                    if ($changeDetails.Removed.Count -gt 0) { 
                        Write-Host "    âž– Removed properties: $($changeDetails.Removed -join ', ')" -ForegroundColor Yellow
                    }
                    if ($changeDetails.Modified.Count -gt 0) { 
                        Write-Host "    [*]§ Modified properties: $($changeDetails.Modified -join ', ')" -ForegroundColor Magenta
                        foreach ($prop in $changeDetails.Modified) {
                            $existingValue = if ($normalizedExisting.$prop -is [string] -and $normalizedExisting.$prop.Length -gt 50) {
                                $normalizedExisting.$prop.Substring(0, 50) + "..."
                            } else {
                                $normalizedExisting.$prop | ConvertTo-Json -Compress -Depth 2
                            }
                            $desiredValue = if ($normalizedConfig.$prop -is [string] -and $normalizedConfig.$prop.Length -gt 50) {
                                $normalizedConfig.$prop.Substring(0, 50) + "..."
                            } else {
                                $normalizedConfig.$prop | ConvertTo-Json -Compress -Depth 2
                            }
                            Write-Host "       â€¢ $prop" -ForegroundColor DarkMagenta
                            Write-Host "         Existing: $existingValue" -ForegroundColor DarkGray
                            Write-Host "         Desired:  $desiredValue" -ForegroundColor DarkGray
                        }
                    }
                }
            }
            else {
                Write-Host "  âœ¨ App does not exist - will be created"
            }
            
            Write-Host "  [*]¦ App Type: $appType"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus app: $displayName"
                if ($existingApp -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingApp.id -PolicyType "mobile-apps" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                $resultEntry = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    AppType = $appType
                }
                if ($changeDetails) { $resultEntry.Changes = $changeDetails }
                $results += $resultEntry
                continue
            }
            
            # Skip if no app content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingApp.id -PolicyType "mobile-apps" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingApp.id
                    AppType     = $appType
                }
                continue
            }
            
            # Repair the payload
            Write-Host "  [*]§ Preparing payload for deployment..." -ForegroundColor DarkGray
            $repairedConfig = Repair-MobileAppPayload -Payload $policyConfig
            
            # For PATCH: build a separate filtered payload (field-scoped monitoring).
            # CREATE always uses the full repairedConfig; PATCH sends only monitored fields.
            $patchRepairedConfig = if ($action -ne "Create") {
                $patchFiltered = Get-IntuneMonitoredPatchBody -PolicyConfig $policyConfig
                Repair-MobileAppPayload -Payload $patchFiltered
            } else { $repairedConfig }
            
            # Show key payload properties for debugging
            Write-Host "    Repaired payload properties:" -ForegroundColor DarkGray
            Write-Host "      - @odata.type: $($repairedConfig.'@odata.type')" -ForegroundColor DarkGray
            Write-Host "      - roleScopeTagIds: [$($repairedConfig.roleScopeTagIds -join ',')] (Count: $($repairedConfig.roleScopeTagIds.Count))" -ForegroundColor DarkGray
            
            if ($repairedConfig.productIds) {
                Write-Host "      - productIds: [$($repairedConfig.productIds -join ',')] (Count: $($repairedConfig.productIds.Count))" -ForegroundColor DarkGray
            }
            if ($repairedConfig.localesToInstall) {
                Write-Host "      - localesToInstall: [$($repairedConfig.localesToInstall -join ',')] (Count: $($repairedConfig.localesToInstall.Count))" -ForegroundColor DarkGray
            }
            if ($repairedConfig.excludedApps) {
                Write-Host "      - excludedApps: $($repairedConfig.excludedApps.GetType().Name) with $(@($repairedConfig.excludedApps.PSObject.Properties).Count) properties" -ForegroundColor DarkGray
                $excludedAppsProps = $repairedConfig.excludedApps.PSObject.Properties | Sort-Object Name
                foreach ($prop in $excludedAppsProps) {
                    $value = $prop.Value
                    $type = if ($null -eq $value) { "NULL" } else { $value.GetType().Name }
                    Write-Host "         â€¢ $($prop.Name) = $value (Type: $type)" -ForegroundColor DarkGray
                }
            }
            if ($repairedConfig.packageIdentifier) {
                Write-Host "      - packageIdentifier: $($repairedConfig.packageIdentifier)" -ForegroundColor DarkGray
            }
            
            # Convert to JSON - use safe conversion to preserve arrays
            $jsonBody = ConvertTo-SafeJson -InputObject $repairedConfig -Depth 30
            
            # Show the actual JSON payload (first 2000 chars for Office apps)
            if ($appType -eq '#microsoft.graph.officeSuiteApp') {
                Write-Host "    [*] Payload JSON (first 2000 chars):" -ForegroundColor Yellow
                $payloadPreview = if ($jsonBody.Length -gt 2000) { $jsonBody.Substring(0, 2000) + "..." } else { $jsonBody }
                Write-Host $payloadPreview -ForegroundColor DarkYellow
            }
            
            $appId = $null
            if ($action -eq "Create") {
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                $appId = $response.id
                Write-Host "  [+] Mobile App created: $displayName (ID: $appId)"
            }
            else {
                # Update existing app - retry loop strips any property the API explicitly rejects as read-only
                $patchUri = "$uri/$($existingApp.id)"
                $patchObj = (ConvertTo-SafeJson -InputObject $patchRepairedConfig -Depth 30) | ConvertFrom-Json
                $discoveredReadOnly = [System.Collections.Generic.List[string]]::new()
                $patchSuccess = $false

                # Pre-strip properties already known to be read-only (from track file) so we
                # never send them, avoiding a predictable first-attempt failure.
                foreach ($knownProp in $trackIgnoreProps) {
                    $actualProp = $patchObj.PSObject.Properties | Where-Object { $_.Name -ieq $knownProp } | Select-Object -First 1
                    if ($actualProp) {
                        $patchObj.PSObject.Properties.Remove($actualProp.Name)
                        Write-Host "  [i] Pre-stripping known read-only prop '$($actualProp.Name)' from PATCH payload" -ForegroundColor DarkGray
                    }
                }

                for ($attempt = 1; $attempt -le 10; $attempt++) {
                    try {
                        $currentJson = ConvertTo-SafeJson -InputObject $patchObj -Depth 30
                        Invoke-MgGraphRequest -Method PATCH -Uri $patchUri -Body $currentJson -ContentType "application/json"
                        $patchSuccess = $true
                        break
                    }
                    catch {
                        # Match several forms the Graph API uses:
                        #   "Property is read-only: 'PropertyName'"
                        #   "Property 'PropertyName' is read-only"
                        #   "Read-only property: 'PropertyName'"
                        $errStr = $_.ToString()
                        $badProp = $null
                        if ($errStr -match "Property is read-only[:\s]+'?(\w+)'?") { $badProp = $Matches[1] }
                        elseif ($errStr -match "Property '(\w+)' is read-only") { $badProp = $Matches[1] }
                        elseif ($errStr -match "Read-only property[:\s]+'?(\w+)'?") { $badProp = $Matches[1] }

                        if ($badProp) {
                            # Use case-insensitive lookup so the captured name (from error msg) always
                            # finds the actual property regardless of casing differences.
                            $actualProp = $patchObj.PSObject.Properties | Where-Object { $_.Name -ieq $badProp } | Select-Object -First 1
                            if ($actualProp) {
                                Write-Host "  [i] '$($actualProp.Name)' is read-only for this app - stripping and retrying" -ForegroundColor DarkGray
                                $discoveredReadOnly.Add($actualProp.Name)
                                $patchObj.PSObject.Properties.Remove($actualProp.Name)
                            }
                            else {
                                Write-Host "  [!] Read-only property '$badProp' not found in payload - cannot strip" -ForegroundColor Yellow
                                break
                            }
                        }
                        else {
                            Write-Host "  [!] Update failed: $errStr" -ForegroundColor Yellow
                            break
                        }
                    }
                }

                $appId = $existingApp.id
                if ($patchSuccess) {
                    $note = if ($discoveredReadOnly.Count -gt 0) { " (read-only skipped: $($discoveredReadOnly -join ', '))" } else { "" }
                    Write-Host "  [+] Mobile App updated: $displayName$note"

                    # Persist newly discovered read-only properties to track file so future WhatIf runs ignore them
                    if ($discoveredReadOnly.Count -gt 0 -and $TenantRepoPath) {
                        $trackDir = Join-Path $TenantRepoPath "config" "baseline-tracking" "intune" "mobile-apps"
                        New-Item -ItemType Directory -Force -Path $trackDir | Out-Null
                        $tFile = Join-Path $trackDir "$displayName.track.json"
                        $tData = if (Test-Path $tFile) {
                            Get-Content $tFile -Raw | ConvertFrom-Json
                        }
                        else {
                            [PSCustomObject]@{ displayName = $displayName; appType = $appType; readOnlyProperties = @() }
                        }
                        $merged = @(@($tData.readOnlyProperties) + $discoveredReadOnly | Select-Object -Unique)
                        $tData | Add-Member -NotePropertyName 'readOnlyProperties' -NotePropertyValue $merged -Force
                        $tData | Add-Member -NotePropertyName 'lastUpdated' -NotePropertyValue (Get-Date -Format 'o') -Force
                        $tData | ConvertTo-Json -Depth 5 | Out-File $tFile -Encoding UTF8
                        Write-Host "  [i] Track file updated: $tFile" -ForegroundColor DarkGray
                    }
                }
            }
            
            # Sync assignments (covers both create and update)
            # For Create/Update, wait until publishingState == 'published' before assigning.
            # NoChange apps are already published — no polling needed.
            if ($appId) {
                $isPublished = if ($action -eq 'NoChange') {
                    $true
                } else {
                    Wait-MobileAppPublished -AppId $appId -DisplayName $displayName
                }
                if ($isPublished) {
                    Invoke-AssignmentSync -PolicyId $appId -PolicyType "mobile-apps" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
                }
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $appId
                AppType = $appType
            }
        }
        catch {
            Write-Host "  âœ— Failed to $($action.ToLower()) app: $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process app: $displayName"
            Write-Host "##[error]Error: $_"
            
            $results += @{
                DisplayName = $displayName
                Status = "Failed"
                Error = $_.ToString()
                AppType = $appType
            }
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
    
    return $results
}

# ============================================================================
# ENTRY POINT
# ============================================================================

$mobileAppPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "mobile-apps" }

if ($mobileAppPolicies.Count -eq 0) {
    Write-Host "No mobile apps to process"
    return @()
}

Write-Host "`n##[section]Processing Mobile Apps ($($mobileAppPolicies.Count) apps)"

$results = Invoke-MobileApps -Policies $mobileAppPolicies -WhatIf:$WhatIfMode

return $results
