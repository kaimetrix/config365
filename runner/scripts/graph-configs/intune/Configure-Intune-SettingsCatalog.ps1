<#
.SYNOPSIS
    Creates and manages Intune Settings Catalog policies via Microsoft Graph API
    
.DESCRIPTION
    Handles Settings Catalog (configurationPolicies) profiles.
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
# SETTINGS CATALOG SPECIFIC FUNCTIONS
# ============================================================================

function Remove-ApiOnlyProperties {
    # Recursively removes/normalizes API-only properties that shouldn't be used in comparison
    # This includes: settingInstanceTemplateReference, id, @odata.type, etc.
    # Also normalizes null vs empty array differences (API returns [] where backup has null)
    param([object]$Object)
    
    if ($null -eq $Object) { return $null }
    
    if ($Object -is [hashtable]) {
        # ─── Mask encrypted secret values BEFORE stripping @odata.type ────────
        # Encrypted setting values (e.g. EDR onboarding tokens, connector secrets)
        # have a different token per tenant by design and Graph never returns the
        # plaintext, so direct comparison always reports a false diff. Detect them
        # via either @odata.type *SecretSettingValue* or valueState=encryptedValueToken
        # and normalize the value to a constant so structural changes still surface
        # but token-only churn doesn't.
        $odataType  = $Object['@odata.type']
        $valueState = $Object['valueState']
        $isSecretValue = ($odataType -and $odataType -match 'SecretSettingValue') -or `
                         ($valueState -and $valueState -eq 'encryptedValueToken')
        if ($isSecretValue -and $Object.ContainsKey('value')) {
            $Object['value'] = '__ENCRYPTED_TOKEN__'
        }

        # Remove properties that are API-only or shouldn't be in comparison
        # Remove ALL @odata.type and template references - these vary between backup and API
        $propsToRemove = @(
            'id', '@odata.type', '@odata.context', 'auditRuleInformation',
            # Always remove template references - they vary between backup and API formats
            'settingInstanceTemplateReference', 'settingValueTemplateReference',
            # valueState is API-only metadata about the value's encryption state
            'valueState'
        )
        foreach ($prop in $propsToRemove) {
            if ($Object.ContainsKey($prop)) {
                $Object.Remove($prop)
            }
        }
        
        # Normalize children: empty array [] and null should be treated the same (remove both)
        if ($Object.ContainsKey('children')) {
            $children = $Object['children']
            if ($null -eq $children -or ($children -is [System.Collections.IList] -and $children.Count -eq 0)) {
                $Object.Remove('children')
            }
        }
        
        # Remove null values entirely for cleaner comparison
        $keysToRemove = @()
        foreach ($key in @($Object.Keys)) {
            if ($null -eq $Object[$key]) {
                $keysToRemove += $key
            }
        }
        foreach ($key in $keysToRemove) {
            $Object.Remove($key)
        }
        
        # Recursively process all remaining values
        $keys = @($Object.Keys)  # Copy keys to avoid modification during enumeration
        foreach ($key in $keys) {
            $Object[$key] = Remove-ApiOnlyProperties -Object $Object[$key]
        }
        
        # After recursion: sort children arrays by settingDefinitionId so array order
        # never causes a false diff (API and backup may return them in different order).
        if ($Object.ContainsKey('children') -and $Object['children'] -is [System.Collections.IList]) {
            $Object['children'] = @($Object['children'] | Sort-Object {
                if ($_ -is [hashtable]) { $_['settingDefinitionId'] } else { $_.settingDefinitionId }
            })
        }
        # Same for groupSettingCollectionValue items — wrap single objects into arrays first,
        # then sort the outer array by canonical JSON so item order never drives a false diff
        # (e.g. firewall rules returned in different order by API vs baseline).
        if ($Object.ContainsKey('groupSettingCollectionValue')) {
            $gscv = $Object['groupSettingCollectionValue']
            # If PowerShell unwrapped a single-item array to an object, re-wrap it
            if ($gscv -is [hashtable]) {
                $gscv = @($gscv)
                $Object['groupSettingCollectionValue'] = $gscv
            }
            # Sort the collection items by their canonical JSON so array order is deterministic
            if ($gscv -is [System.Collections.IList] -and $gscv.Count -gt 1) {
                $Object['groupSettingCollectionValue'] = @($gscv | Sort-Object {
                    ConvertTo-SortedJson -InputObject $_
                })
            }
        }
    }
    elseif ($Object -is [System.Collections.IList]) {
        for ($i = 0; $i -lt $Object.Count; $i++) {
            $Object[$i] = Remove-ApiOnlyProperties -Object $Object[$i]
        }
    }
    
    return $Object
}

function Get-ChildSettingDisplayValue {
    # Returns a short display string for a child setting hashtable
    param([object]$Child)
    if ($Child -is [hashtable]) {
        if ($Child.ContainsKey('choiceSettingValue') -and $Child['choiceSettingValue']) {
            $v = $Child['choiceSettingValue']['value']
            if ($v) { return ($v -split '_' | Select-Object -Last 1) }
        }
        if ($Child.ContainsKey('simpleSettingValue') -and $null -ne $Child['simpleSettingValue']) {
            return "$($Child['simpleSettingValue']['value'])"
        }
        if ($Child.ContainsKey('groupSettingCollectionValue')) { return '(nested collection)' }
        if ($Child.ContainsKey('simpleSettingCollectionValue')) { return '(list)' }
    }
    return ''
}

function Get-GroupSettingCollectionDiff {
    # Compares two groupSettingCollectionValue arrays and returns human-readable diff lines.
    param(
        [object[]]$Existing,
        [object[]]$Desired,
        [int]$MaxDiffs = 10
    )
    $diffs = @()
    $minItems = [Math]::Min($Existing.Count, $Desired.Count)

    for ($idx = 0; $idx -lt $minItems -and $diffs.Count -lt $MaxDiffs; $idx++) {
        $bItem = $Existing[$idx]
        $dItem = $Desired[$idx]

        $bChildren = @()
        $dChildren = @()
        if ($bItem -is [hashtable] -and $bItem.ContainsKey('children')) { $bChildren = @($bItem['children']) }
        if ($dItem -is [hashtable] -and $dItem.ContainsKey('children')) { $dChildren = @($dItem['children']) }

        $bByDefId = @{}
        foreach ($c in $bChildren) {
            if ($c -is [hashtable]) { $id = $c['settingDefinitionId']; if ($id) { $bByDefId[$id] = $c } }
        }
        $dByDefId = @{}
        foreach ($c in $dChildren) {
            if ($c -is [hashtable]) { $id = $c['settingDefinitionId']; if ($id) { $dByDefId[$id] = $c } }
        }

        $allIds = ($bByDefId.Keys + $dByDefId.Keys) | Select-Object -Unique
        foreach ($defId in $allIds) {
            if ($diffs.Count -ge $MaxDiffs) { break }
            $shortChild = ($defId -split '_' | Select-Object -Last 1)
            $inB = $bByDefId.ContainsKey($defId)
            $inD = $dByDefId.ContainsKey($defId)
            if ($inD -and -not $inB) {
                $diffs += "    + [item $idx] ${shortChild}: '$(Get-ChildSettingDisplayValue $dByDefId[$defId])'"
            } elseif ($inB -and -not $inD) {
                $diffs += "    - [item $idx] ${shortChild}: '$(Get-ChildSettingDisplayValue $bByDefId[$defId])'"
            } elseif ($inB -and $inD) {
                $bVal = Get-ChildSettingDisplayValue $bByDefId[$defId]
                $dVal = Get-ChildSettingDisplayValue $dByDefId[$defId]
                if ($bVal -ne $dVal) {
                    $diffs += "    ~ [item $idx] ${shortChild}: '$bVal' -> '$dVal'"
                }
            }
        }
    }

    if ($Desired.Count -gt $Existing.Count) {
        $diffs += "    + ($($Desired.Count - $Existing.Count) item(s) added to collection)"
    } elseif ($Existing.Count -gt $Desired.Count) {
        $diffs += "    - ($($Existing.Count - $Desired.Count) item(s) removed from collection)"
    }

    return $diffs
}

function Remove-NullSettingTemplateReferences {
    # Recursively removes null settingInstanceTemplateReference and settingValueTemplateReference
    # This is used during REPAIR - it preserves @odata.type which is required by the API
    param([object]$Object)
    
    if ($null -eq $Object) { return $null }
    
    if ($Object -is [hashtable]) {
        # Remove settingInstanceTemplateReference if null or has only null/empty values
        if ($Object.ContainsKey('settingInstanceTemplateReference')) {
            $ref = $Object['settingInstanceTemplateReference']
            if ($null -eq $ref -or 
                ($ref -is [hashtable] -and ($ref.Count -eq 0 -or ($ref.ContainsKey('settingInstanceTemplateId') -and $null -eq $ref['settingInstanceTemplateId'])))) {
                $Object.Remove('settingInstanceTemplateReference')
            }
        }
        
        # Remove settingValueTemplateReference if null
        if ($Object.ContainsKey('settingValueTemplateReference') -and $null -eq $Object['settingValueTemplateReference']) {
            $Object.Remove('settingValueTemplateReference')
        }
        
        # Remove auditRuleInformation if null
        if ($Object.ContainsKey('auditRuleInformation') -and $null -eq $Object['auditRuleInformation']) {
            $Object.Remove('auditRuleInformation')
        }
        
        # Recursively process all values
        $keys = @($Object.Keys)
        foreach ($key in $keys) {
            $Object[$key] = Remove-NullSettingTemplateReferences -Object $Object[$key]
        }
    }
    elseif ($Object -is [System.Collections.IList]) {
        for ($i = 0; $i -lt $Object.Count; $i++) {
            $Object[$i] = Remove-NullSettingTemplateReferences -Object $Object[$i]
        }
    }
    
    return $Object
}

function Repair-SettingsCatalogPayload {
    param(
        [Parameter(Mandatory=$true)]
        [object]$Payload
    )
    
    # Convert to hashtable for manipulation
    $json = $Payload | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable
    
    # Remove metadata properties
    $propsToRemove = @('id', 'createdDateTime', 'lastModifiedDateTime', 'modifiedDateTime', 
                       'version', '@odata.context', '@odata.type', 'settingCount', 'creationSource',
                       '_sourceFile', '_policyType', '_assignments')
    foreach ($prop in $propsToRemove) {
        if ($json.ContainsKey($prop)) {
            $json.Remove($prop)
        }
    }
    
    # Recursively remove all null settingInstanceTemplateReference values
    $json = Remove-NullSettingTemplateReferences -Object $json
    
    # Fix roleScopeTagIds - MUST be an array of strings
    if ($json.ContainsKey('roleScopeTagIds')) {
        $tagIds = $json['roleScopeTagIds']
        if ($null -eq $tagIds) {
            $json['roleScopeTagIds'] = @("0")
        }
        elseif ($tagIds -is [string]) {
            if ($tagIds -match ',') {
                $json['roleScopeTagIds'] = @($tagIds -split ',' | ForEach-Object { $_.Trim() })
            }
            else {
                $json['roleScopeTagIds'] = @($tagIds)
            }
        }
        elseif ($tagIds -isnot [System.Collections.IList]) {
            $json['roleScopeTagIds'] = @($tagIds.ToString())
        }
        $json['roleScopeTagIds'] = [array]$json['roleScopeTagIds']
    }
    else {
        $json['roleScopeTagIds'] = @("0")
    }
    
    # Fix settings - must be an array
    if ($json.ContainsKey('settings') -and $null -ne $json['settings']) {
        $settings = $json['settings']
        if ($settings -isnot [System.Collections.IList]) {
            $json['settings'] = @($settings)
        }
        # Recursively fix children in settings
        $json['settings'] = @(Repair-SettingsCatalogSettings -Settings $json['settings'])
    }
    elseif (-not $json.ContainsKey('settings')) {
        $json['settings'] = @()
    }
    
    # Clean up templateReference - only keep templateId
    if ($json.ContainsKey('templateReference') -and $null -ne $json['templateReference']) {
        $templateRef = $json['templateReference']
        if ($templateRef -is [hashtable] -and $templateRef.ContainsKey('templateId')) {
            $json['templateReference'] = @{
                templateId = $templateRef['templateId']
            }
        }
    }
    
    return $json
}

function Repair-SettingsCatalogSettings {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $Settings
    )
    
    if ($null -eq $Settings) { return @() }
    
    $repairedSettings = @()
    $settingsArray = if ($Settings -is [System.Collections.IList]) { $Settings } else { @($Settings) }
    
    foreach ($setting in $settingsArray) {
        if ($null -eq $setting) { continue }
        
        $settingHash = if ($setting -is [hashtable]) { 
            $setting 
        } else { 
            $setting | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable 
        }
        
        # Ensure @odata.type is present on the setting wrapper
        if (-not $settingHash.ContainsKey('@odata.type')) {
            $settingHash['@odata.type'] = '#microsoft.graph.deviceManagementConfigurationSetting'
        }
        
        # Remove 'id' property from settings (API adds these)
        if ($settingHash.ContainsKey('id')) {
            $settingHash.Remove('id')
        }
        
        # Process settingInstance
        if ($settingHash.ContainsKey('settingInstance')) {
            $settingHash['settingInstance'] = Repair-SettingInstance -Instance $settingHash['settingInstance']
        }
        
        $repairedSettings += $settingHash
    }
    
    return $repairedSettings
}

function Repair-SettingInstance {
    param(
        [Parameter(Mandatory=$true)]
        [AllowNull()]
        $Instance
    )
    
    if ($null -eq $Instance) { return $null }
    
    $instanceHash = if ($Instance -is [hashtable]) { 
        $Instance 
    } else { 
        $Instance | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable 
    }
    
    # Handle settingInstanceTemplateReference - KEEP if it has a valid templateId, otherwise remove
    if ($instanceHash.ContainsKey('settingInstanceTemplateReference')) {
        $ref = $instanceHash['settingInstanceTemplateReference']
        if ($null -eq $ref -or 
            ($ref -is [hashtable] -and (-not $ref.ContainsKey('settingInstanceTemplateId') -or $null -eq $ref['settingInstanceTemplateId']))) {
            $instanceHash.Remove('settingInstanceTemplateReference')
        }
    }
    
    # Remove auditRuleInformation if null (always remove this one)
    if ($instanceHash.ContainsKey('auditRuleInformation') -and $null -eq $instanceHash['auditRuleInformation']) {
        $instanceHash.Remove('auditRuleInformation')
    }
    
    # Fix EDR onboarding settings - replace encrypted tokens with placeholder
    # The API requires "NotEncrypted" with "autoConnectPlaceholder" for new policies
    if ($instanceHash.ContainsKey('simpleSettingValue') -and $null -ne $instanceHash['simpleSettingValue']) {
        $simpleValue = $instanceHash['simpleSettingValue']
        if ($simpleValue -is [hashtable]) {
            $settingDefId = $instanceHash['settingDefinitionId']
            # Check if this is an EDR onboarding setting with encrypted token
            if ($settingDefId -like "*onboarding_fromconnector*" -or 
                ($simpleValue.ContainsKey('valueState') -and $simpleValue['valueState'] -eq 'encryptedValueToken')) {
                # Replace with placeholder for API to fetch fresh token from connector
                $simpleValue['valueState'] = 'NotEncrypted'
                $simpleValue['value'] = 'autoConnectPlaceholder'
                $instanceHash['simpleSettingValue'] = $simpleValue
            }
        }
    }
    
    # Fix choiceSettingValue
    if ($instanceHash.ContainsKey('choiceSettingValue') -and $null -ne $instanceHash['choiceSettingValue']) {
        $choice = $instanceHash['choiceSettingValue']
        
        # Ensure @odata.type is present
        if (-not $choice.ContainsKey('@odata.type')) {
            $choice['@odata.type'] = '#microsoft.graph.deviceManagementConfigurationChoiceSettingValue'
        }
        
        # Handle settingValueTemplateReference - KEEP if it has valid templateId, remove useTemplateDefault
        if ($choice.ContainsKey('settingValueTemplateReference')) {
            $ref = $choice['settingValueTemplateReference']
            if ($null -eq $ref -or 
                ($ref -is [hashtable] -and (-not $ref.ContainsKey('settingValueTemplateId') -or $null -eq $ref['settingValueTemplateId']))) {
                $choice.Remove('settingValueTemplateReference')
            }
            elseif ($ref -is [hashtable] -and $ref.ContainsKey('useTemplateDefault')) {
                # Remove useTemplateDefault - API doesn't need it
                $ref.Remove('useTemplateDefault')
            }
        }
        
        # Fix children - must be array
        if ($choice.ContainsKey('children')) {
            $children = $choice['children']
            if ($null -eq $children) {
                $choice['children'] = @()
            }
            elseif ($children -isnot [System.Collections.IList]) {
                $choice['children'] = @(Repair-SettingInstance -Instance $children)
            }
            else {
                $choice['children'] = @($children | ForEach-Object { Repair-SettingInstance -Instance $_ })
            }
            
            # Process children for EDR onboarding settings and add @odata.type
            $repairedChildren = @()
            foreach ($child in $choice['children']) {
                if ($null -eq $child) { continue }
                $childHash = if ($child -is [hashtable]) { $child } else { $child | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
                
                # Ensure @odata.type for simpleSettingInstance children
                if ($childHash.ContainsKey('simpleSettingValue') -and -not $childHash.ContainsKey('@odata.type')) {
                    $childHash['@odata.type'] = '#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance'
                }
                
                # Fix EDR onboarding in children
                if ($childHash.ContainsKey('simpleSettingValue') -and $null -ne $childHash['simpleSettingValue']) {
                    $simpleValue = $childHash['simpleSettingValue']
                    if ($simpleValue -is [hashtable]) {
                        # Ensure @odata.type for secretSettingValue
                        if ($simpleValue.ContainsKey('valueState') -and -not $simpleValue.ContainsKey('@odata.type')) {
                            $simpleValue['@odata.type'] = '#microsoft.graph.deviceManagementConfigurationSecretSettingValue'
                        }
                        
                        # Remove null settingValueTemplateReference from simpleSettingValue
                        if ($simpleValue.ContainsKey('settingValueTemplateReference') -and $null -eq $simpleValue['settingValueTemplateReference']) {
                            $simpleValue.Remove('settingValueTemplateReference')
                        }
                        
                        $settingDefId = $childHash['settingDefinitionId']
                        if ($settingDefId -like "*onboarding_fromconnector*" -or 
                            ($simpleValue.ContainsKey('valueState') -and $simpleValue['valueState'] -eq 'encryptedValueToken')) {
                            $simpleValue['valueState'] = 'NotEncrypted'
                            $simpleValue['value'] = 'autoConnectPlaceholder'
                        }
                        $childHash['simpleSettingValue'] = $simpleValue
                    }
                }
                
                # Remove auditRuleInformation if null
                if ($childHash.ContainsKey('auditRuleInformation') -and $null -eq $childHash['auditRuleInformation']) {
                    $childHash.Remove('auditRuleInformation')
                }
                
                # Remove settingInstanceTemplateReference if null
                if ($childHash.ContainsKey('settingInstanceTemplateReference') -and $null -eq $childHash['settingInstanceTemplateReference']) {
                    $childHash.Remove('settingInstanceTemplateReference')
                }
                
                $repairedChildren += $childHash
            }
            $choice['children'] = $repairedChildren
        }
        $instanceHash['choiceSettingValue'] = $choice
    }
    
    # Fix choiceSettingCollectionValue - must be array
    if ($instanceHash.ContainsKey('choiceSettingCollectionValue')) {
        $collection = $instanceHash['choiceSettingCollectionValue']
        if ($null -eq $collection) {
            $instanceHash['choiceSettingCollectionValue'] = @()
        }
        elseif ($collection -isnot [System.Collections.IList]) {
            $instanceHash['choiceSettingCollectionValue'] = @($collection)
        }
        # Repair children in each collection item
        $repairedCollection = @()
        foreach ($item in $instanceHash['choiceSettingCollectionValue']) {
            if ($null -eq $item) { continue }
            $itemHash = if ($item -is [hashtable]) { $item } else { $item | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
            
            # Remove settingInstanceTemplateReference if null from collection items
            if ($itemHash.ContainsKey('settingInstanceTemplateReference') -and $null -eq $itemHash['settingInstanceTemplateReference']) {
                $itemHash.Remove('settingInstanceTemplateReference')
            }
            
            if ($itemHash.ContainsKey('children')) {
                $children = $itemHash['children']
                if ($null -eq $children) {
                    $itemHash['children'] = @()
                }
                elseif ($children -isnot [System.Collections.IList]) {
                    $itemHash['children'] = @(Repair-SettingInstance -Instance $children)
                }
                else {
                    $itemHash['children'] = @($children | ForEach-Object { Repair-SettingInstance -Instance $_ })
                }
            }
            $repairedCollection += $itemHash
        }
        $instanceHash['choiceSettingCollectionValue'] = $repairedCollection
    }
    
    # Fix groupSettingCollectionValue - must be array
    if ($instanceHash.ContainsKey('groupSettingCollectionValue')) {
        $collection = $instanceHash['groupSettingCollectionValue']
        if ($null -eq $collection) {
            $instanceHash['groupSettingCollectionValue'] = @()
        }
        elseif ($collection -isnot [System.Collections.IList]) {
            $instanceHash['groupSettingCollectionValue'] = @($collection)
        }
        # Repair children in each collection item
        $repairedCollection = @()
        foreach ($item in $instanceHash['groupSettingCollectionValue']) {
            if ($null -eq $item) { continue }
            $itemHash = if ($item -is [hashtable]) { $item } else { $item | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
            
            # Remove settingInstanceTemplateReference if null from collection items
            if ($itemHash.ContainsKey('settingInstanceTemplateReference') -and $null -eq $itemHash['settingInstanceTemplateReference']) {
                $itemHash.Remove('settingInstanceTemplateReference')
            }
            
            if ($itemHash.ContainsKey('children')) {
                $children = $itemHash['children']
                if ($null -eq $children) {
                    $itemHash['children'] = @()
                }
                elseif ($children -isnot [System.Collections.IList]) {
                    $itemHash['children'] = @(Repair-SettingInstance -Instance $children)
                }
                else {
                    $itemHash['children'] = @($children | ForEach-Object { Repair-SettingInstance -Instance $_ })
                }
            }
            $repairedCollection += $itemHash
        }
        $instanceHash['groupSettingCollectionValue'] = $repairedCollection
    }
    
    # Fix simpleSettingCollectionValue - must be array
    if ($instanceHash.ContainsKey('simpleSettingCollectionValue')) {
        $collection = $instanceHash['simpleSettingCollectionValue']
        if ($null -eq $collection) {
            $instanceHash['simpleSettingCollectionValue'] = @()
        }
        elseif ($collection -isnot [System.Collections.IList]) {
            $instanceHash['simpleSettingCollectionValue'] = @($collection)
        }
    }
    
    return $instanceHash
}


# ============================================================================
# MAIN PROCESSING FUNCTION
# ============================================================================

function Invoke-SettingsCatalogPolicies {
    param(
        [Parameter(Mandatory=$true)]
        [array]$Policies,
        [switch]$WhatIf
    )
    
    $results = @()
    $uri = "https://graph.microsoft.com/beta/deviceManagement/configurationPolicies"
    
    foreach ($policyConfig in $Policies) {
        $displayName = if ($policyConfig.name) { $policyConfig.name.Trim() } elseif ($policyConfig.displayName) { $policyConfig.displayName.Trim() } else { "Unknown" }
        
        Write-Host "`n##[group]Processing [settings-catalog]: $displayName"
        
        try {
            
            # Check if policy exists
            $allPolicies = Get-AllPoliciesOfType -PolicyType "settings-catalog"
            $existingPolicy = $allPolicies | Where-Object { $_.name -ieq $displayName } | Select-Object -First 1
            
            # Repair the payload first (we need this for comparison)
            $repairedConfig = Repair-SettingsCatalogPayload -Payload $policyConfig
            
            # Extract monitor config injected by Configure-Intune.ps1 and determine which
            # content fields are in scope. When a sidecar exists, only monitored fields
            # trigger drift detection and deletion/recreation. The POST body always uses the
            # full desiredBody because DELETE wipes everything and recreation must be complete.
            $monitorConfig = $null
            if ($policyConfig -is [System.Collections.IDictionary] -and $policyConfig.ContainsKey('_monitorConfig')) {
                $monitorConfig = $policyConfig['_monitorConfig']
            } elseif ($policyConfig.PSObject.Properties.Name -contains '_monitorConfig') {
                $monitorConfig = $policyConfig._monitorConfig
            }
            $monitorSettings    = $true
            $monitorDescription = $true
            $monitorScopeTags   = $true
            if ($monitorConfig) {
                $probe = Apply-MonitorFilter -PolicyObject @{ settings = 1; description = 1; roleScopeTagIds = 1 } -MonitorConfig $monitorConfig
                $monitorSettings    = $probe.ContainsKey('settings')
                $monitorDescription = $probe.ContainsKey('description')
                $monitorScopeTags   = $probe.ContainsKey('roleScopeTagIds')
            }
            
            # Build the desired policy body
            $desiredBody = @{
                name = $displayName
                description = if ($repairedConfig.description) { $repairedConfig.description } else { "" }
                platforms = if ($repairedConfig.platforms) { $repairedConfig.platforms } else { "windows10" }
                technologies = if ($repairedConfig.technologies) { $repairedConfig.technologies } else { "mdm" }
                roleScopeTagIds = $repairedConfig.roleScopeTagIds
                settings = if ($repairedConfig.settings) { $repairedConfig.settings } else { @() }
            }
            
            if ($repairedConfig.templateReference) {
                $desiredBody.templateReference = $repairedConfig.templateReference
            }
            
            # Determine action and check for changes
            $action = "Create"
            $hasChanges = $true
            $settingsChanged = $false
            $metadataChanged = $false
            $changeDetails = $null
            
            if ($existingPolicy) {
                # Check if policy is protected from baseline updates via description marker
                if (Test-ResourceProtected -Description $existingPolicy.description) {
                    $marker = (Get-CONFIG365Options).protectionMarker
                    Write-Host "  [!] Protected: Policy has '$marker' marker in description - skipping"
                    $results += @{
                        DisplayName = $displayName
                        PolicyType = "settings-catalog"
                        Status = "Protected"
                        Changes = @()
                    }
                    continue
                }
                
                # Check if this is a Windows EDR policy - skip content comparison (contains tenant-specific tokens)
                $isWindowsEdrPolicy = $displayName -notlike "*macOS*" -and
                                      $policyConfig.templateReference -and
                                      $policyConfig.templateReference.templateFamily -eq "endpointSecurityEndpointDetectionAndResponse"

                if ($isWindowsEdrPolicy) {
                    # EDR policies contain tenant-specific encrypted onboarding tokens that the
                    # Graph API never returns in plaintext, so per-tenant drift is expected and
                    # comparing would always produce a false positive. Treat existence as success.
                    $action = "NoChange"
                    $hasChanges = $false
                    Write-Host "  Policy exists - EDR policy (skipping content comparison - tenant-specific tokens)"
                }
                else {
                # Fetch existing policy settings for comparison (with pagination)
                $existingSettingsUri = "$uri/$($existingPolicy.id)/settings"
                try {
                    $existingSettings = @()
                    $nextLink = $existingSettingsUri
                    while ($nextLink) {
                        $existingSettingsResponse = Invoke-MgGraphRequest -Method GET -Uri $nextLink
                        $existingSettings += $existingSettingsResponse.value
                        $nextLink = $existingSettingsResponse.'@odata.nextLink'
                    }
                    
                    # Normalize BOTH settings by removing API-specific properties and handling null/empty differences
                    # This ensures we're comparing apples to apples
                    $normalizedExisting = Remove-ApiOnlyProperties -Object ($existingSettings | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable)
                    $normalizedDesired = Remove-ApiOnlyProperties -Object ($desiredBody.settings | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable)
                    
                    # Sort both arrays by settingDefinitionId so array order never drives a false diff.
                    # The Graph API may return settings in a different order than the baseline file.
                    $normalizedExisting = @($normalizedExisting | Sort-Object {
                        if ($_ -is [hashtable]) { $_['settingInstance']['settingDefinitionId'] }
                        else { $_.settingInstance.settingDefinitionId }
                    })
                    $normalizedDesired = @($normalizedDesired | Sort-Object {
                        if ($_ -is [hashtable]) { $_['settingInstance']['settingDefinitionId'] }
                        else { $_.settingInstance.settingDefinitionId }
                    })
                    
                    # Compare settings JSON - use sorted JSON to ignore property order differences
                    $desiredSettingsJson = ConvertTo-SortedJson -InputObject $normalizedDesired
                    $existingSettingsJson = ConvertTo-SortedJson -InputObject $normalizedExisting
                    
                    # Also compare metadata (description, roleScopeTagIds) — only for monitored fields
                    $metadataChanged = ($monitorDescription -and ($existingPolicy.description -ne $desiredBody.description)) -or
                                       ($monitorScopeTags  -and (($existingPolicy.roleScopeTagIds | ConvertTo-Json -Compress) -ne ($desiredBody.roleScopeTagIds | ConvertTo-Json -Compress)))
                    
                    $settingsChanged = $monitorSettings -and ($desiredSettingsJson -ne $existingSettingsJson)
                    
                    # Capture change details for reporting
                    $changeDetails = @{
                        Added = @()
                        Removed = @()
                        Modified = @()
                        Metadata = @()
                    }
                    
                    if ($settingsChanged -or $metadataChanged) {
                        $action = "Update"
                        $hasChanges = $true
                        if ($settingsChanged) {
                            Write-Host "  Policy exists - settings differ, will be recreated"
                            
                            # Identify specific setting differences
                            try {
                                $desiredSettings = $normalizedDesired
                                $existingSettingsNorm = $normalizedExisting
                                
                                # Build lookup tables for settings by definition ID
                                $desiredById = @{}
                                foreach ($s in $desiredSettings) {
                                    $id = $s.settingInstance.settingDefinitionId
                                    if ($id) { $desiredById[$id] = $s }
                                }
                                
                                $existingById = @{}
                                foreach ($s in $existingSettingsNorm) {
                                    $id = $s.settingInstance.settingDefinitionId
                                    if ($id) { $existingById[$id] = $s }
                                }
                                
                                # Find added settings (in desired but not in existing)
                                foreach ($id in $desiredById.Keys) {
                                    if (-not $existingById.ContainsKey($id)) {
                                        # Extract readable name from settingDefinitionId
                                        $shortName = ($id -split '_' | Select-Object -Last 1)
                                        $changeDetails.Added += $shortName
                                    }
                                }
                                
                                # Find removed settings (in existing but not in desired)
                                foreach ($id in $existingById.Keys) {
                                    if (-not $desiredById.ContainsKey($id)) {
                                        $shortName = ($id -split '_' | Select-Object -Last 1)
                                        $changeDetails.Removed += $shortName
                                    }
                                }
                                
                                # Find modified settings (same ID but different values)
                                foreach ($id in $desiredById.Keys) {
                                    if ($existingById.ContainsKey($id)) {
                                        $desiredSetting = $desiredById[$id]
                                        $existingSetting = $existingById[$id]
                                        $desiredJson = ConvertTo-SortedJson -InputObject $desiredSetting
                                        $existingJson = ConvertTo-SortedJson -InputObject $existingSetting
                                        if ($desiredJson -ne $existingJson) {
                                            $shortName = ($id -split '_' | Select-Object -Last 1)
                                            
                                            # Extract the actual values for display
                                            $existingValue = $null
                                            $desiredValue = $null
                                            
                                            # Try to get the value from different setting types
                                            $si = $existingSetting.settingInstance
                                            if ($si.choiceSettingValue) {
                                                $existingValue = ($si.choiceSettingValue.value -split '_' | Select-Object -Last 1)
                                            } elseif ($si.simpleSettingValue) {
                                                $existingValue = $si.simpleSettingValue.value
                                            } elseif ($si.groupSettingCollectionValue) {
                                                $existingValue = "(collection with $($si.groupSettingCollectionValue.Count) items)"
                                            }
                                            
                                            $si = $desiredSetting.settingInstance
                                            if ($si.choiceSettingValue) {
                                                $desiredValue = ($si.choiceSettingValue.value -split '_' | Select-Object -Last 1)
                                            } elseif ($si.simpleSettingValue) {
                                                $desiredValue = $si.simpleSettingValue.value
                                            } elseif ($si.groupSettingCollectionValue) {
                                                $desiredValue = "(collection with $($si.groupSettingCollectionValue.Count) items)"
                                            }
                                            
                                            # Only report as modified if the actual values differ
                                            # (JSON may differ due to metadata but values may be same)
                                            $existingStr = if ($existingValue) { $existingValue.ToString() } else { "" }
                                            $desiredStr = if ($desiredValue) { $desiredValue.ToString() } else { "" }
                                            
                                            # If simplified display values match but the full JSON still differs,
                                            # the setting IS modified (e.g. groupSettingCollectionValue with same
                                            # outer count but different children — ASR rules added/removed).
                                            if ($existingStr -ne $desiredStr -or ($desiredJson -ne $existingJson)) {
                                                # Truncate long values for display
                                                if ($existingStr.Length -gt 50) {
                                                    $existingStr = $existingStr.Substring(0, 47) + "..."
                                                }
                                                if ($desiredStr.Length -gt 50) {
                                                    $desiredStr = $desiredStr.Substring(0, 47) + "..."
                                                }
                                                
                                                if ($existingStr -ne $desiredStr) {
                                                    # Values differ -- show old -> new
                                                    $changeDetails.Modified += "${shortName}: '$existingStr' -> '$desiredStr'"
                                                } elseif ($existingStr -and $desiredStr) {
                                                    # Simplified values look the same but nested content differs (e.g. collection children changed)
                                                    $changeDetails.Modified += "${shortName}: '$existingStr' (sub-properties changed)"
                                                    # Attempt child-level diff for groupSettingCollectionValue
                                                    try {
                                                        $existingSI = $existingSetting['settingInstance']
                                                        $desiredSI  = $desiredSetting['settingInstance']
                                                        if ($existingSI -is [hashtable] -and $existingSI.ContainsKey('groupSettingCollectionValue') -and
                                                            $desiredSI  -is [hashtable] -and $desiredSI.ContainsKey('groupSettingCollectionValue')) {
                                                            $childDiffs = Get-GroupSettingCollectionDiff `
                                                                -Existing @($existingSI['groupSettingCollectionValue']) `
                                                                -Desired  @($desiredSI['groupSettingCollectionValue'])
                                                            $childDiffs | ForEach-Object { $changeDetails.Modified += $_ }
                                                        }
                                                    } catch {}
                                                } else {
                                                    $changeDetails.Modified += $shortName
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            catch {
                                Write-Verbose "  Could not compute detailed diff: $_"
                            }
                            
                            # After detailed analysis, if no actual value differences found, revert to NoChange
                            # (JSON comparison may differ due to metadata but actual settings are same)
                            if ($changeDetails.Added.Count -eq 0 -and 
                                $changeDetails.Removed.Count -eq 0 -and 
                                $changeDetails.Modified.Count -eq 0 -and
                                -not $metadataChanged) {
                                $action = "NoChange"
                                $hasChanges = $false
                                Write-Host "  Policy exists - no changes detected (metadata only differences)"
                            }
                        } else {
                            Write-Host "  Policy exists - metadata differs, will be updated"
                            if ($existingPolicy.description -ne $desiredBody.description) {
                                $changeDetails.Metadata += "Description: '$($existingPolicy.description)' -> '$($desiredBody.description)'"
                            }
                            if (($existingPolicy.roleScopeTagIds | ConvertTo-Json -Compress) -ne ($desiredBody.roleScopeTagIds | ConvertTo-Json -Compress)) {
                                $changeDetails.Metadata += "Role scope tags changed"
                            }
                        }
                    } else {
                        $action = "NoChange"
                        $hasChanges = $false
                        $noChangeMsg = "  Policy exists - no changes detected"
                        if ($monitorConfig) { $noChangeMsg += " (field-scoped monitoring active)" }
                        Write-Host $noChangeMsg
                    }
                }
                catch {
                    Write-Verbose "  Could not fetch existing settings for comparison: $_"
                    $action = "Update"
                    $hasChanges = $true
                    Write-Host "  Policy exists - will be updated (could not compare)"
                }
                } # End else (non-EDR comparison)
            }
            else {
                Write-Host "  Policy does not exist - will be created"
            }
            
            Write-Host "  Type: Settings Catalog"
            
            $baselineAssignments = if ($policyConfig._assignments) { @($policyConfig._assignments) } else { @() }
            
            if ($WhatIf) {
                $whatIfStatus = switch ($action) {
                    "Create" { "WouldCreate" }
                    "Update" { "WouldUpdate" }
                    "NoChange" { "No changes" }
                }
                Write-Host "  [WhatIf] $whatIfStatus policy: $displayName"
                if ($existingPolicy -and $action -eq "NoChange") {
                    $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "settings-catalog" -BaselineAssignments $baselineAssignments -DisplayName $displayName -WhatIf
                    if ($assignSync.HasChanges) { $whatIfStatus = "WouldSyncAssignments"; if ($assignSync.Changes) { $changeDetails = $assignSync.Changes } }
                }
                $result = @{
                    DisplayName = $displayName
                    Status = $whatIfStatus
                    PolicyType = "settings-catalog"
                }
                # Add structured change details for updates
                if ($changeDetails) {
                    $hasAnyChanges = ($changeDetails.Added.Count -gt 0) -or 
                                     ($changeDetails.Removed.Count -gt 0) -or 
                                     ($changeDetails.Modified.Count -gt 0) -or
                                     ($changeDetails.Metadata.Count -gt 0)
                    if ($hasAnyChanges) {
                        $result.Changes = $changeDetails
                    }
                }
                $results += $result
                continue
            }
            
            # Skip if no policy content changes -- but still sync assignments
            if (-not $hasChanges) {
                $assignSync = Invoke-AssignmentSync -PolicyId $existingPolicy.id -PolicyType "settings-catalog" -BaselineAssignments $baselineAssignments -DisplayName $displayName
                $results += @{
                    DisplayName = $displayName
                    Status      = if ($assignSync.HasChanges) { "AssignmentsSynced" } else { "No changes" }
                    PolicyId    = $existingPolicy.id
                }
                continue
            }
            
            # Apply monitor filter to the POST body — excluded fields must not be written.
            # Structural fields (name, platforms, technologies, templateReference) are always
            # included because they are required by the API and are not policy content fields.
            # Only the content fields (settings, description, roleScopeTagIds) are scoped.
            $filteredBody = if ($monitorConfig) {
                $fb = $desiredBody.Clone()
                if (-not $monitorSettings)    { $null = $fb.Remove('settings') }
                if (-not $monitorDescription) { $null = $fb.Remove('description') }
                if (-not $monitorScopeTags)   { $null = $fb.Remove('roleScopeTagIds') }
                $fb
            } else { $desiredBody }

            # Convert to JSON - use custom conversion to preserve single-element arrays
            # PowerShell's ConvertTo-Json collapses single-element arrays by default
            $jsonBody = ConvertTo-SafeJson -InputObject $filteredBody -Depth 30
            
            $policyId = $null
            if ($action -eq "Create") {
                # Check if this is an EDR policy - use hardcoded payload instead of baseline
                $isEdrPolicy = $displayName -like "*Endpoint detection and response*" -and 
                               $displayName -notlike "*macOS*" -and
                               ($policyConfig.templateReference -and $policyConfig.templateReference.templateFamily -eq "endpointSecurityEndpointDetectionAndResponse")
                
                if ($isEdrPolicy) {
                    # Windows EDR onboarding - check for active Defender connector first
                    Write-Host "  INFO: EDR policy detected - checking for Defender connector..." -ForegroundColor Cyan
                    $connectors = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/deviceManagement/mobileThreatDefenseConnectors" -ErrorAction SilentlyContinue).value
                    $activeConnector = $connectors | Where-Object { $_.partnerState -eq "enabled" -or $_.partnerState -eq "available" }
                    
                    if (-not $activeConnector) {
                        throw "No active Defender for Endpoint connector found. Enable deployDefenderConnector before deployIntune (EDR policies require the Windows Defender ATP connector in Intune)."
                    }
                    
                    Write-Host "  [+] Active Defender connector found - creating EDR policy with auto-onboard" -ForegroundColor Green
                    
                    # Create EDR policy with hardcoded payload (reverse-engineered from Intune portal)
                    # The backup contains tenant-specific encrypted tokens that won't work cross-tenant
                    $edrPolicyBody = @{
                        name = $displayName
                        description = ""
                        platforms = "windows10"
                        technologies = "mdm,microsoftSense"
                        templateReference = @{ templateId = "0385b795-0f2f-44ac-8602-9f65bf6adede_1" }
                        roleScopeTagIds = @("0")
                        settings = @(
                            @{
                                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationSetting"
                                settingInstance = @{
                                    "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
                                    settingDefinitionId = "device_vendor_msft_windowsadvancedthreatprotection_configurationtype"
                                    settingInstanceTemplateReference = @{ settingInstanceTemplateId = "23ab0ea3-1b12-429a-8ed0-7390cf699160" }
                                    choiceSettingValue = @{
                                        "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                                        value = "device_vendor_msft_windowsadvancedthreatprotection_configurationtype_autofromconnector"
                                        settingValueTemplateReference = @{ settingValueTemplateId = "e5c7c98c-c854-4140-836e-bd22db59d651" }
                                        children = @(@{
                                            "@odata.type" = "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance"
                                            settingDefinitionId = "device_vendor_msft_windowsadvancedthreatprotection_onboarding_fromconnector"
                                            simpleSettingValue = @{
                                                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationSecretSettingValue"
                                                valueState = "NotEncrypted"
                                                value = "autoConnectPlaceholder"
                                            }
                                        })
                                    }
                                }
                            },
                            @{
                                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationSetting"
                                settingInstance = @{
                                    "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
                                    settingDefinitionId = "device_vendor_msft_windowsadvancedthreatprotection_configuration_samplesharing"
                                    settingInstanceTemplateReference = @{ settingInstanceTemplateId = "6998c81e-2814-4f5e-b492-a6159128a97b" }
                                    choiceSettingValue = @{
                                        "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                                        value = "device_vendor_msft_windowsadvancedthreatprotection_configuration_samplesharing_1"
                                        settingValueTemplateReference = @{ settingValueTemplateId = "f72c326c-7c5b-4224-b890-0b9b54522bd9" }
                                        children = @()
                                    }
                                }
                            }
                        )
                    }
                    
                    $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body ($edrPolicyBody | ConvertTo-Json -Depth 30) -ContentType "application/json"
                    $policyId = $response.id
                    Write-Host "  [+] Settings Catalog created: $displayName (ID: $policyId)"
                }
                else {
                    # Normal policy creation
                    $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                    $policyId = $response.id
                    Write-Host "  [+] Settings Catalog created: $displayName (ID: $policyId)"
                }
            }
            else {
                # Settings Catalog 'settings' is a navigation property and cannot be PATCHed
                # Must DELETE and recreate to update settings
                $deleteUri = "$uri/$($existingPolicy.id)"
                Write-Host "  Deleting existing policy to recreate with updated settings..."
                Invoke-MgGraphRequest -Method DELETE -Uri $deleteUri
                
                # Recreate the policy
                $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body $jsonBody -ContentType "application/json"
                $policyId = $response.id
                Write-Host "  [+] Settings Catalog recreated: $displayName (ID: $policyId)"
            }
            
            # Sync assignments (covers both create and update)
            if ($policyId) {
                Invoke-AssignmentSync -PolicyId $policyId -PolicyType "settings-catalog" -BaselineAssignments $baselineAssignments -DisplayName $displayName | Out-Null
            }
            
            $results += @{
                DisplayName = $displayName
                Status = if ($action -eq "Create") { "Created" } else { "Updated" }
                PolicyId = $policyId
            }
        }
        catch {
            Write-Host "  âœ— Failed to $($action.ToLower()) policy: $_" -ForegroundColor Red
            Write-Host "##[error]Failed to process policy: $displayName"
            Write-Host "##[error]Error: $_"
            
            $results += @{
                DisplayName = $displayName
                Status = "Failed"
                Error = $_.ToString()
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

$settingsCatalogPolicies = $PolicyConfigs | Where-Object { $_._policyType -eq "settings-catalog" }

if ($settingsCatalogPolicies.Count -eq 0) {
    Write-Host "No Settings Catalog policies to process"
    return @()
}

Write-Host "`n##[section]Processing Settings Catalog Policies ($($settingsCatalogPolicies.Count) policies)"

$results = Invoke-SettingsCatalogPolicies -Policies $settingsCatalogPolicies -WhatIf:$WhatIfMode

return $results

