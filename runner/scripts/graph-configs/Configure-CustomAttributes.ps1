<#
.SYNOPSIS
    Creates and manages Custom Security Attributes via Microsoft Graph API

.DESCRIPTION
    Deploys custom security attribute sets and definitions to the target tenant.
    These must be deployed BEFORE Conditional Access policies that use dynamic filters.
    
    Expected directory structure:
    ConfigDirectory/
    ├── attribute-sets/        (Attribute set definitions)
    │   └── *.json
    └── attribute-definitions/ (Attribute definitions with allowed values)
        └── *.json

.PARAMETER ConfigDirectory
    Path to the directory containing subdirectories for attribute-sets and attribute-definitions

.PARAMETER WhatIf
    Show what would be changed without making changes

.EXAMPLE
    .\Configure-CustomAttributes.ps1 -ConfigDirectory "baseline/custom-attributes"

.NOTES
    Requires Microsoft.Graph.Identity.DirectoryManagement module
    Requires CustomSecAttributeDefinition.ReadWrite.All permission
    Requires Attribute Definition Administrator role
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

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

Write-Host "##[section]Configuring Custom Security Attributes"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Check if configuration directory exists
if (-not (Test-Path $ConfigDirectory)) {
    Write-Host "##[warning]Configuration directory not found: $ConfigDirectory"
    Write-Host "Skipping Custom Security Attributes configuration"
    exit 0
}

# Check for subdirectories
$attributeSetsPath = Join-Path $ConfigDirectory "attribute-sets"
$attributeDefsPath = Join-Path $ConfigDirectory "attribute-definitions"

$attributeSetFiles = @()
$attributeDefFiles = @()

# Use the baseline folder root so patterns like "custom-security-attributes/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }

if (Test-Path $attributeSetsPath) {
    $attributeSetFiles = @(Get-ChildItem -Path $attributeSetsPath -Filter "*.json" -File)
    # Filter out ignored files based on .baseline-ignore and group exclusions
    $attributeSetFiles = @(Get-FilteredPolicyFiles -PolicyFiles $attributeSetFiles -BaselineRoot $baselineRoot)
    $attributeSetFiles = @(Get-GroupExcludedFiles -Files $attributeSetFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
}

if (Test-Path $attributeDefsPath) {
    $attributeDefFiles = @(Get-ChildItem -Path $attributeDefsPath -Filter "*.json" -File)
    # Filter out ignored files based on .baseline-ignore and group exclusions
    $attributeDefFiles = @(Get-FilteredPolicyFiles -PolicyFiles $attributeDefFiles -BaselineRoot $baselineRoot)
    $attributeDefFiles = @(Get-GroupExcludedFiles -Files $attributeDefFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
}

if ($attributeSetFiles.Count -eq 0 -and $attributeDefFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    Write-Host "Skipping Custom Security Attributes configuration"
    exit 0
}

Write-Host "Found $($attributeSetFiles.Count) attribute set(s) and $($attributeDefFiles.Count) attribute definition(s)"

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Identity.DirectoryManagement"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("CustomSecAttributeDefinition.ReadWrite.All")
    Write-Host "Connected to tenant: $($context.TenantId)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Helper function to remove read-only properties
function Remove-ReadOnlyProps {
    param([hashtable]$Object)
    
    $propsToRemove = @('id', '@odata.context', '@odata.type')
    foreach ($prop in $propsToRemove) {
        if ($Object.ContainsKey($prop)) {
            $Object.Remove($prop)
        }
    }
    return $Object
}

# Helper function to convert PSObject to hashtable (PS 5.1 compatibility)
function ConvertTo-HashtableRecursive {
    param([object]$InputObject)
    
    if ($null -eq $InputObject) { return $null }
    
    if ($InputObject -is [array] -or ($InputObject -is [System.Collections.IList] -and $InputObject -isnot [string])) {
        $result = [System.Collections.ArrayList]::new()
        foreach ($object in $InputObject) {
            [void]$result.Add((ConvertTo-HashtableRecursive -InputObject $object))
        }
        return @($result)
    }
    elseif ($InputObject -is [System.Management.Automation.PSObject] -and $InputObject -isnot [string]) {
        $hash = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $hash[$property.Name] = ConvertTo-HashtableRecursive -InputObject $property.Value
        }
        return $hash
    }
    else {
        return $InputObject
    }
}

# ============================================================================
# STEP 1: Deploy Attribute Sets
# ============================================================================
Write-Host "`n##[section]Creating/Updating Attribute Sets"

$attributeSetResults = @()
$setCreatedCount = 0
$setUpdatedCount = 0
$setNoChangeCount = 0
$setWouldCreateCount = 0
$setWouldUpdateCount = 0
$attributeSetErrorCount = 0

foreach ($file in $attributeSetFiles) {
    $setId = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    Write-Host "`n##[group]Processing attribute set: $setId"
    
    try {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $configHash = ConvertTo-HashtableRecursive -InputObject $config
        
        # Check if attribute set exists
        $existingSet = $null
        try {
            $existingSet = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets/$setId" -ErrorAction SilentlyContinue
        }
        catch {
            # Not found - will create
        }
        
        # Prepare the body
        $body = @{
            id = $setId
            description = $configHash.description
            maxAttributesPerSet = if ($configHash.maxAttributesPerSet) { $configHash.maxAttributesPerSet } else { 25 }
        }
        $bodyJson = $body | ConvertTo-Json -Depth 5
        
        $status = $null
        
        if ($existingSet) {
            Write-Host "Attribute set already exists"
            
            # Check if description changed
            $existingDesc = $existingSet.description
            $baselineDesc = $body.description
            $needsUpdate = $existingDesc -ne $baselineDesc
            
            if (-not $needsUpdate) {
                Write-Host "✓ Attribute set is up to date - no changes needed"
                $status = "No changes"
                $setNoChangeCount++
            }
            elseif ($PSCmdlet.ShouldProcess($setId, "Update attribute set")) {
                # Update - only description can be updated
                $updateBody = @{ description = $body.description } | ConvertTo-Json
                Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets/$setId" -Body $updateBody -ContentType "application/json"
                Write-Host "✓ Attribute set updated successfully"
                $status = "Updated"
                $setUpdatedCount++
            }
            else {
                Write-Host "[WhatIf] Would UPDATE attribute set: $setId (description changed)"
                $status = "Would UPDATE"
                $setWouldUpdateCount++
            }
        }
        else {
            Write-Host "Attribute set does not exist - creating"
            
            if ($PSCmdlet.ShouldProcess($setId, "Create attribute set")) {
                Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets" -Body $bodyJson -ContentType "application/json"
                Write-Host "✓ Attribute set created successfully"
                $status = "Created"
                $setCreatedCount++
            }
            else {
                Write-Host "[WhatIf] Would CREATE attribute set: $setId"
                $status = "Would CREATE"
                $setWouldCreateCount++
            }
        }
        
        $attributeSetResults += [PSCustomObject]@{
            Id = $setId
            Status = $status
            FilePath = $file.FullName
        }
    }
    catch {
        Write-Host "##[error]Failed to process attribute set: $_"
        $attributeSetResults += [PSCustomObject]@{
            Id = $setId
            Status = "Failed: $($_.Exception.Message)"
            FilePath = $file.FullName
        }
        $attributeSetErrorCount++
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# ============================================================================
# STEP 1.5: Verify Attribute Sets are Propagated
# ============================================================================
if ($attributeSetSuccessCount -gt 0) {
    Write-Host "`n##[section]Verifying Attribute Set Propagation"
    
    $maxRetries = 10
    $retryDelaySeconds = 3
    $allSetsVerified = $false
    
    for ($retry = 1; $retry -le $maxRetries; $retry++) {
        $allVerified = $true
        $pendingSets = @()
        
        foreach ($result in $attributeSetResults | Where-Object { $_.Status -eq "Success" }) {
            try {
                $check = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets/$($result.Id)" -ErrorAction Stop
                Write-Verbose "  Verified: $($result.Id)"
            }
            catch {
                $allVerified = $false
                $pendingSets += $result.Id
            }
        }
        
        if ($allVerified) {
            Write-Host "  All attribute sets verified after $retry attempt(s)"
            $allSetsVerified = $true
            break
        }
        else {
            Write-Host "  Attempt $retry/$maxRetries - Waiting for propagation of: $($pendingSets -join ', ')"
            Start-Sleep -Seconds $retryDelaySeconds
        }
    }
    
    if (-not $allSetsVerified) {
        Write-Host "##[warning]Some attribute sets may not have fully propagated. Continuing with extended delay..."
        Start-Sleep -Seconds 10
    }
}

# ============================================================================
# STEP 2: Deploy Attribute Definitions
# ============================================================================
Write-Host "`n##[section]Creating/Updating Attribute Definitions"

$attributeDefResults = @()
$defCreatedCount = 0
$defUpdatedCount = 0
$defNoChangeCount = 0
$defWouldCreateCount = 0
$defWouldUpdateCount = 0
$attributeDefErrorCount = 0

foreach ($file in $attributeDefFiles) {
    $defId = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    Write-Host "`n##[group]Processing attribute definition: $defId"
    
    try {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $configHash = ConvertTo-HashtableRecursive -InputObject $config
        
        # Extract allowed values if present (stored during backup)
        $allowedValues = $null
        if ($configHash.ContainsKey('_allowedValues')) {
            $allowedValues = $configHash['_allowedValues']
            $configHash.Remove('_allowedValues')
        }
        
        # Check if attribute definition exists (with retry for propagation)
        $existingDef = $null
        $maxCheckRetries = 3
        for ($checkRetry = 1; $checkRetry -le $maxCheckRetries; $checkRetry++) {
            try {
                $existingDef = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId" -ErrorAction Stop
                break
            }
            catch {
                if ($checkRetry -lt $maxCheckRetries -and $_.Exception.Message -match "NotFound") {
                    Start-Sleep -Seconds 2
                }
                # Not found - will create
            }
        }
        
        # Prepare the body for creation
        $body = @{
            attributeSet = $configHash.attributeSet
            name = $configHash.name
            description = $configHash.description
            type = if ($configHash.type) { $configHash.type } else { "String" }
            isSearchable = if ($null -ne $configHash.isSearchable) { $configHash.isSearchable } else { $true }
            isCollection = if ($null -ne $configHash.isCollection) { $configHash.isCollection } else { $false }
            usePreDefinedValuesOnly = if ($null -ne $configHash.usePreDefinedValuesOnly) { $configHash.usePreDefinedValuesOnly } else { $false }
            status = if ($configHash.status) { $configHash.status } else { "Available" }
        }
        
        $status = $null
        
        if ($existingDef) {
            Write-Host "Attribute definition already exists"
            
            # Check if description changed (only property that can be updated)
            $existingDesc = $existingDef.description
            $baselineDesc = $body.description
            $needsUpdate = $existingDesc -ne $baselineDesc
            
            # Also check for missing allowed values
            $missingValues = @()
            if ($allowedValues -and $allowedValues.Count -gt 0) {
                foreach ($av in $allowedValues) {
                    try {
                        $existingValue = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId/allowedValues/$($av.id)" -ErrorAction SilentlyContinue
                    }
                    catch {
                        $missingValues += $av.id
                    }
                }
            }
            
            if (-not $needsUpdate -and $missingValues.Count -eq 0) {
                Write-Host "✓ Attribute definition is up to date - no changes needed"
                $status = "No changes"
                $defNoChangeCount++
            }
            elseif ($PSCmdlet.ShouldProcess($defId, "Update attribute definition")) {
                if ($needsUpdate) {
                    # Only description and status can be updated
                    $updateBody = @{
                        description = $body.description
                    } | ConvertTo-Json
                    Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId" -Body $updateBody -ContentType "application/json"
                    Write-Host "✓ Attribute definition updated successfully"
                }
                $status = "Updated"
                $defUpdatedCount++
            }
            else {
                $changes = @()
                if ($needsUpdate) { $changes += "description" }
                if ($missingValues.Count -gt 0) { $changes += "allowedValues ($($missingValues -join ', '))" }
                Write-Host "[WhatIf] Would UPDATE attribute definition: $defId (changes: $($changes -join ', '))"
                $status = "Would UPDATE"
                $defWouldUpdateCount++
            }
        }
        else {
            Write-Host "Attribute definition does not exist - creating"
            
            if ($PSCmdlet.ShouldProcess($defId, "Create attribute definition")) {
                $bodyJson = $body | ConvertTo-Json -Depth 5
                
                # Retry creation with delay (handles AttributeSet propagation issues)
                $createMaxRetries = 5
                $createRetryDelay = 3
                $created = $false
                
                for ($createRetry = 1; $createRetry -le $createMaxRetries; $createRetry++) {
                    try {
                        Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions" -Body $bodyJson -ContentType "application/json"
                        Write-Host "✓ Attribute definition created successfully"
                        $created = $true
                        break
                    }
                    catch {
                        $errorMessage = $_.Exception.Message
                        
                        # Check if it's a propagation issue (AttributeSet not found) or conflict (already exists)
                        if ($errorMessage -match "AttributeSet.*does not exist" -or $errorMessage -match "provided with request does not exist") {
                            if ($createRetry -lt $createMaxRetries) {
                                Write-Host "  Waiting for attribute set propagation (attempt $createRetry/$createMaxRetries)..."
                                Start-Sleep -Seconds $createRetryDelay
                            }
                            else {
                                throw $_
                            }
                        }
                        elseif ($errorMessage -match "same value for property id already exists") {
                            # Already exists - treat as success
                            Write-Host "Attribute definition already exists (created by previous attempt)"
                            $created = $true
                            break
                        }
                        else {
                            throw $_
                        }
                    }
                }
                
                if (-not $created) {
                    throw "Failed to create attribute definition after $createMaxRetries attempts"
                }
                $status = "Created"
                $defCreatedCount++
            }
            else {
                Write-Host "[WhatIf] Would CREATE attribute definition: $defId"
                $status = "Would CREATE"
                $defWouldCreateCount++
            }
        }
        
        # Deploy allowed values if present (only in Apply mode, not WhatIf)
        if ($allowedValues -and $allowedValues.Count -gt 0 -and -not $WhatIfPreference) {
            Write-Host "Processing $($allowedValues.Count) allowed value(s)..."
            
            # If we just created the definition, wait for propagation before adding allowed values
            if (-not $existingDef) {
                Write-Host "  Waiting for attribute definition propagation..."
                $valueMaxRetries = 10
                $valueRetryDelay = 3
                $defVerified = $false
                
                for ($verifyRetry = 1; $verifyRetry -le $valueMaxRetries; $verifyRetry++) {
                    try {
                        $verifyDef = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId" -ErrorAction Stop
                        Write-Host "  Attribute definition verified after $verifyRetry attempt(s)"
                        $defVerified = $true
                        Start-Sleep -Seconds 2  # Additional buffer
                        break
                    }
                    catch {
                        if ($verifyRetry -lt $valueMaxRetries) {
                            Write-Host "  Attempt $verifyRetry/$valueMaxRetries - waiting for propagation..."
                            Start-Sleep -Seconds $valueRetryDelay
                        }
                    }
                }
                
                if (-not $defVerified) {
                    Write-Host "##[warning]Attribute definition may not be fully propagated. Continuing anyway..."
                }
            }
            
            foreach ($allowedValue in $allowedValues) {
                $valueId = $allowedValue.id
                
                # Check if value exists
                $existingValue = $null
                try {
                    $existingValue = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId/allowedValues/$valueId" -ErrorAction SilentlyContinue
                }
                catch {
                    # Not found
                }
                
                if (-not $existingValue) {
                    if ($PSCmdlet.ShouldProcess("$defId/$valueId", "Create allowed value")) {
                        $valueBody = @{
                            id = $valueId
                            isActive = if ($null -ne $allowedValue.isActive) { $allowedValue.isActive } else { $true }
                        } | ConvertTo-Json
                        
                        # Retry creating allowed value with delay
                        $createValueMaxRetries = 5
                        $createValueDelay = 3
                        $valueCreated = $false
                        
                        for ($createValueRetry = 1; $createValueRetry -le $createValueMaxRetries; $createValueRetry++) {
                            try {
                                Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId/allowedValues" -Body $valueBody -ContentType "application/json"
                                Write-Host "  ✓ Created allowed value: $valueId"
                                $valueCreated = $true
                                break
                            }
                            catch {
                                $valueError = $_.Exception.Message
                                if ($valueError -match "does not exist" -or $valueError -match "NotFound") {
                                    if ($createValueRetry -lt $createValueMaxRetries) {
                                        Write-Host "  Waiting for propagation before creating $valueId (attempt $createValueRetry/$createValueMaxRetries)..."
                                        Start-Sleep -Seconds $createValueDelay
                                    }
                                    else {
                                        throw $_
                                    }
                                }
                                elseif ($valueError -match "already exists") {
                                    Write-Host "  Allowed value already exists: $valueId"
                                    $valueCreated = $true
                                    break
                                }
                                else {
                                    throw $_
                                }
                            }
                        }
                        
                        if (-not $valueCreated) {
                            throw "Failed to create allowed value $valueId after $createValueMaxRetries attempts"
                        }
                    }
                }
                else {
                    Write-Host "  Allowed value already exists: $valueId"
                }
            }
        }
        
        $attributeDefResults += [PSCustomObject]@{
            Id = $defId
            AttributeSet = $configHash.attributeSet
            Status = $status
            FilePath = $file.FullName
        }
    }
    catch {
        Write-Host "##[error]Failed to process attribute definition: $_"
        $attributeDefResults += [PSCustomObject]@{
            Id = $defId
            AttributeSet = $configHash.attributeSet
            Status = "Failed: $($_.Exception.Message)"
            FilePath = $file.FullName
        }
        $attributeDefErrorCount++
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# ============================================================================
# STEP 3: Verify Attribute Definitions are Propagated
# ============================================================================
if ($attributeDefSuccessCount -gt 0) {
    Write-Host "`n##[section]Verifying Attribute Definition Propagation"
    
    $maxRetries = 10
    $retryDelaySeconds = 3
    $allDefsVerified = $false
    
    for ($retry = 1; $retry -le $maxRetries; $retry++) {
        $allVerified = $true
        $pendingDefs = @()
        
        foreach ($result in $attributeDefResults | Where-Object { $_.Status -eq "Success" }) {
            try {
                $check = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$($result.Id)" -ErrorAction Stop
                Write-Verbose "  Verified: $($result.Id)"
            }
            catch {
                $allVerified = $false
                $pendingDefs += $result.Id
            }
        }
        
        if ($allVerified) {
            Write-Host "  All attribute definitions verified after $retry attempt(s)"
            $allDefsVerified = $true
            break
        }
        else {
            Write-Host "  Attempt $retry/$maxRetries - Waiting for propagation of: $($pendingDefs -join ', ')"
            Start-Sleep -Seconds $retryDelaySeconds
        }
    }
    
    if (-not $allDefsVerified) {
        Write-Host "##[warning]Some attribute definitions may not have fully propagated"
        Write-Host "  Adding additional 15 second delay before completing..."
        Start-Sleep -Seconds 15
    }
    else {
        # Even if all verified, add a small buffer for CA policy deployment
        Write-Host "  Adding 5 second buffer for full propagation..."
        Start-Sleep -Seconds 5
    }
}

# ============================================================================
# Summary
# ============================================================================
Write-Host "`n##[section]Summary"

if ($attributeSetFiles.Count -gt 0) {
    Write-Host "Attribute Sets: $($attributeSetFiles.Count) processed"
    if ($WhatIfPreference) {
        Write-Host "  → Would CREATE: $setWouldCreateCount"
        Write-Host "  → Would UPDATE: $setWouldUpdateCount"
        Write-Host "  ○ No changes needed: $setNoChangeCount"
    }
    else {
        Write-Host "  ✓ Created: $setCreatedCount"
        Write-Host "  ✓ Updated: $setUpdatedCount"
        Write-Host "  ○ No changes needed: $setNoChangeCount"
    }
    if ($attributeSetErrorCount -gt 0) {
        Write-Host "  ✗ Failed: $attributeSetErrorCount"
    }
    Write-Host ""
}

if ($attributeDefFiles.Count -gt 0) {
    Write-Host "Attribute Definitions: $($attributeDefFiles.Count) processed"
    if ($WhatIfPreference) {
        Write-Host "  → Would CREATE: $defWouldCreateCount"
        Write-Host "  → Would UPDATE: $defWouldUpdateCount"
        Write-Host "  ○ No changes needed: $defNoChangeCount"
    }
    else {
        Write-Host "  ✓ Created: $defCreatedCount"
        Write-Host "  ✓ Updated: $defUpdatedCount"
        Write-Host "  ○ No changes needed: $defNoChangeCount"
    }
    if ($attributeDefErrorCount -gt 0) {
        Write-Host "  ✗ Failed: $attributeDefErrorCount"
    }
    Write-Host ""
}

# Show results with status indicators
if ($attributeSetResults.Count -gt 0) {
    Write-Host "Attribute Set Results:"
    foreach ($r in $attributeSetResults) {
        $icon = switch -Wildcard ($r.Status) {
            "Created" { "✓ CREATED" }
            "Updated" { "✓ UPDATED" }
            "Would CREATE" { "→ WOULD CREATE" }
            "Would UPDATE" { "→ WOULD UPDATE" }
            "No changes" { "○ NO CHANGE" }
            "Failed*" { "✗ FAILED" }
            default { $r.Status }
        }
        Write-Host "  $icon : $($r.Id)"
    }
    Write-Host ""
}

if ($attributeDefResults.Count -gt 0) {
    Write-Host "Attribute Definition Results:"
    foreach ($r in $attributeDefResults) {
        $icon = switch -Wildcard ($r.Status) {
            "Created" { "✓ CREATED" }
            "Updated" { "✓ UPDATED" }
            "Would CREATE" { "→ WOULD CREATE" }
            "Would UPDATE" { "→ WOULD UPDATE" }
            "No changes" { "○ NO CHANGE" }
            "Failed*" { "✗ FAILED" }
            default { $r.Status }
        }
        Write-Host "  $icon : $($r.Id)"
    }
    Write-Host ""
}

# Save summary if OutputPath provided
if ($OutputPath) {
    $summary = @{
        Service = "CustomAttributes"
        TotalItems = $attributeSetFiles.Count + $attributeDefFiles.Count
        CreatedCount = $setCreatedCount + $defCreatedCount
        UpdatedCount = $setUpdatedCount + $defUpdatedCount
        NoChangeCount = $setNoChangeCount + $defNoChangeCount
        WouldCreateCount = $setWouldCreateCount + $defWouldCreateCount
        WouldUpdateCount = $setWouldUpdateCount + $defWouldUpdateCount
        ErrorCount = $attributeSetErrorCount + $attributeDefErrorCount
        Results = @{
            AttributeSets = $attributeSetResults
            AttributeDefinitions = $attributeDefResults
        }
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nSummary saved to: $OutputPath"
}

if ($attributeSetErrorCount -gt 0 -or $attributeDefErrorCount -gt 0) {
    Write-Host "##[error]Some resources failed to process"
    exit 1
}
else {
    Write-Host "##[command]All Custom Security Attributes configured successfully!"
}

