<#
.SYNOPSIS
    Creates and manages Enterprise Applications via Microsoft Graph API

.DESCRIPTION
    Creates and updates Azure AD Application Registrations and Service Principals.
    The script is idempotent - it will create apps if they don't exist, or verify/update if they do.

.PARAMETER ConfigDirectory
    Path to the directory containing JSON application definition files

.PARAMETER WhatIf
    Show what would be changed without making changes

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned changes

.EXAMPLE
    .\Configure-EnterpriseApps.ps1 -ConfigDirectory "baseline-enterprise-apps"
    
.EXAMPLE
    .\Configure-EnterpriseApps.ps1 -ConfigDirectory "baseline-enterprise-apps" -WhatIf -OutputPath "apps-plan.json"

.NOTES
    Requires Microsoft.Graph.Applications module
    Requires appropriate Graph API permissions: Application.ReadWrite.All
    Each JSON file in the directory should define a single application
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

# Import placeholder resolver module
$resolverPath = Join-Path $PSScriptRoot "Resolve-Placeholders.ps1"
. $resolverPath

# Import baseline ignore helpers
$ignoreHelpersPath = Join-Path $PSScriptRoot "Common-IgnoreHelpers.ps1"
. $ignoreHelpersPath

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

# Import shared diff helpers (provides Apply-MonitorFilter and Get-MonitorConfig)
$diffHelpersPath = Join-Path $PSScriptRoot "Common-DiffHelpers.ps1"
. $diffHelpersPath

Write-Host "##[section]Configuring Enterprise Applications"

# Initialize baseline ignore patterns (if TenantBaselinePath provided)
Initialize-BaselineIgnore -TenantRepoPath $TenantRepoPath -TenantBaselinePath $TenantBaselinePath

# Load app configurations from directory
if (-not (Test-Path $ConfigDirectory)) {
    throw "Configuration directory not found: $ConfigDirectory"
}

$appFiles = @(Get-ChildItem -Path $ConfigDirectory -Filter "*.json" -File -Recurse |
    Where-Object { $_.Name -notlike "*.config.json" -and $_.Name -notlike "*.monitor.json" })

# Filter out ignored files based on .baseline-ignore
# Use the baseline folder root so patterns like "enterprise-apps/file.json" work correctly
$baselineRoot = if ($TenantBaselinePath) { Join-Path $TenantBaselinePath "baseline" } else { Split-Path $ConfigDirectory -Parent }
if ($appFiles.Count -gt 0) {
    $appFiles = @(Get-FilteredPolicyFiles -PolicyFiles $appFiles -BaselineRoot $baselineRoot)
    $appFiles = @(Get-GroupExcludedFiles -Files $appFiles -TenantBaselinePath $TenantBaselinePath -TenantRepoPath $TenantRepoPath)
}

if ($appFiles.Count -eq 0) {
    Write-Host "##[warning]No JSON files found in directory: $ConfigDirectory"
    Write-Host "Skipping Enterprise Apps configuration"
    exit 0
}

Write-Host "Found $($appFiles.Count) application definition(s) in: $ConfigDirectory"

# Load all app configurations
$appConfigs = @()
foreach ($file in $appFiles) {
    Write-Host "  Loading: $($file.Name)"
    $appConfig = Get-Content $file.FullName -Raw | ConvertFrom-Json
    
    # Convert to hashtable and resolve placeholders
    $configHash = $appConfig | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
    $configHash = Resolve-Placeholders -ConfigObject $configHash
    
    # Convert back to PSObject
    $appConfig = $configHash | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    if ($appConfig.displayName) { $appConfig.displayName = $appConfig.displayName.Trim() }

    # Inject monitor config from sibling .monitor.json so Set-EnterpriseApp can filter write payloads
    $appMonitorCfg = Get-MonitorConfig -BaselineFilePath $file.FullName
    if ($appMonitorCfg) {
        Add-Member -InputObject $appConfig -MemberType NoteProperty -Name '_monitorConfig' -Value $appMonitorCfg -Force
    }

    Add-Member -InputObject $appConfig -MemberType NoteProperty -Name '_SourceFile' -Value $file.FullName -Force
    $appConfigs += $appConfig
}

Write-Host "Applications to process: $($appConfigs.Count)"

# Import required modules
$requiredModules = @(
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.Applications"
)

Import-RequiredGraphModules -ModuleNames $requiredModules

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Authenticate to Microsoft Graph (supports GCC High and Tenant-specific credentials)
try {
    $context = Ensure-M365GraphConnection -Scopes @("Application.ReadWrite.All")
    Write-Host "✓ Connected to tenant: $($context.TenantId)"
    Write-Host "  Account: $($context.Account)"
}
catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# Function to create or update an Application
function Set-EnterpriseApp {
    param(
        [Parameter(Mandatory=$true)]
        [object]$AppConfig
    )
    
    Write-Host "`n##[group]Processing: $($AppConfig.DisplayName)"
    
    try {
        # ── External / Microsoft-owned apps ──────────────────────────────────────
        # When ExternalAppId is set the app registration lives in Microsoft's tenant,
        # not ours. All we need is a service principal consented in this tenant.
        # Also support appId (Graph export field name) for JSONs exported directly from the API.
        $externalAppId = if ($AppConfig.ExternalAppId) { $AppConfig.ExternalAppId } `
                         elseif ($AppConfig.appId)     { $AppConfig.appId }      `
                         else { $null }

        if ($externalAppId) {
            # Lookup strategy for external/Microsoft-first-party apps:
            # 1. Direct by servicePrincipalId (fastest, from JSON export)
            # 2. Alternate-key endpoint: GET /servicePrincipals(appId='...')
            #    This finds Microsoft first-party apps that the OData filter misses.
            # 3. OData filter fallback (works for most non-Microsoft apps)
            $existingSp = $null
            if ($AppConfig.servicePrincipalId) {
                $existingSp = Get-MgServicePrincipal -ServicePrincipalId $AppConfig.servicePrincipalId -ErrorAction SilentlyContinue
            }
            if (-not $existingSp) {
                # Alternate key — reliable for Microsoft first-party apps
                try {
                    $altKeyResult = Invoke-MgGraphRequest -Method GET -Uri "v1.0/servicePrincipals(appId='$externalAppId')" -ErrorAction Stop
                    if ($altKeyResult -and $altKeyResult.id) {
                        $existingSp = [PSCustomObject]@{ Id = $altKeyResult.id; DisplayName = $altKeyResult.displayName; AppId = $altKeyResult.appId }
                    }
                } catch {
                    # Not found via alternate key — fall through to OData filter
                }
            }
            if (-not $existingSp) {
                $existingSp = Get-MgServicePrincipal -Filter "appId eq '$externalAppId'" -ErrorAction SilentlyContinue
            }

            if ($existingSp) {
                Write-Host "✓ External service principal already registered: $($existingSp.DisplayName) ($($existingSp.Id))"
                return [PSCustomObject]@{ DisplayName = $AppConfig.DisplayName; AppId = $externalAppId; Status = "Exists" }
            }
            if ($PSCmdlet.ShouldProcess($AppConfig.DisplayName, "Create external service principal")) {
                try {
                    $sp = New-MgServicePrincipal -AppId $externalAppId
                    Write-Host "✓ External service principal created: $($AppConfig.DisplayName) ($($sp.Id))"
                    return [PSCustomObject]@{ DisplayName = $AppConfig.DisplayName; AppId = $externalAppId; Status = "Created" }
                }
                catch {
                    # 409 Conflict: SP exists but all lookup methods missed it — retry alternate key
                    if ($_.Exception.Response.StatusCode.value__ -eq 409 -or $_ -match '409|Conflict|MultipleObjectsWithSameKeyValue') {
                        Write-Host "  [i] 409 on create — retrying alternate-key lookup..."
                        try {
                            $retry = Invoke-MgGraphRequest -Method GET -Uri "v1.0/servicePrincipals(appId='$externalAppId')" -ErrorAction SilentlyContinue
                            if ($retry -and $retry.id) {
                                Write-Host "  [i] Found via alternate key after 409: $($retry.displayName) ($($retry.id))"
                            }
                        } catch { }
                        return [PSCustomObject]@{ DisplayName = $AppConfig.DisplayName; AppId = $externalAppId; Status = "Exists" }
                    }
                    throw
                }
            }
            else {
                Write-Host "[WhatIf] Would create external service principal: $($AppConfig.DisplayName) (appId: $externalAppId)"
                return [PSCustomObject]@{ DisplayName = $AppConfig.DisplayName; AppId = $externalAppId; Status = "WouldCreate" }
            }
        }

        # ── Tenant-owned app registrations ───────────────────────────────────────
        # Check if application already exists
        $existingApp = Get-MgApplication -Filter "displayName eq '$($AppConfig.DisplayName)'" -ErrorAction SilentlyContinue
        
        if ($existingApp) {
            Write-Host "Application already exists: $($existingApp.Id)"
            
            # Check if app is protected from baseline updates via description marker
            if (Test-ResourceProtected -Description $existingApp.Description) {
                $marker = (Get-CONFIG365Options).protectionMarker
                Write-Host "  ⛔ Protected: App has '$marker' marker in description - skipping"
                return [PSCustomObject]@{ App = $existingApp; Status = "Protected" }
            }
            
            # Build monitor config from injected _monitorConfig (if any)
            $appMonitorConfig = $null
            if ($AppConfig._monitorConfig) {
                $appMonitorConfig = @{}
                if ($AppConfig._monitorConfig.Include) { $appMonitorConfig['Include'] = @($AppConfig._monitorConfig.Include) }
                if ($AppConfig._monitorConfig.Exclude) { $appMonitorConfig['Exclude'] = @($AppConfig._monitorConfig.Exclude) }
                if ($appMonitorConfig.Count -eq 0) { $appMonitorConfig = $null }
            }

            # Update application if needed
            if ($PSCmdlet.ShouldProcess($AppConfig.DisplayName, "Update application")) {
                # Prepare update parameters
                $updateParams = @{}
                if ($AppConfig.Description) { $updateParams['Description'] = $AppConfig.Description }
                if ($AppConfig.SignInAudience) { $updateParams['SignInAudience'] = $AppConfig.SignInAudience }
                if ($AppConfig.Web) { $updateParams['Web'] = $AppConfig.Web }
                if ($AppConfig.RequiredResourceAccess) { $updateParams['RequiredResourceAccess'] = $AppConfig.RequiredResourceAccess }

                # Apply monitor filter — excluded fields must not be written
                if ($appMonitorConfig -and $updateParams.Count -gt 0) {
                    $updateParams = Apply-MonitorFilter -PolicyObject $updateParams -MonitorConfig $appMonitorConfig
                }
                
                if ($updateParams.Count -gt 0) {
                    Update-MgApplication -ApplicationId $existingApp.Id -BodyParameter $updateParams
                    Write-Host "✓ Application updated successfully"
                }
                else {
                    Write-Host "✓ Application is up to date - no changes needed"
                }
            }
            else {
                Write-Host "[WhatIf] Would update application: $($AppConfig.DisplayName)"
            }
            
            # Check if service principal exists
            $existingSp = Get-MgServicePrincipal -Filter "appId eq '$($existingApp.AppId)'" -ErrorAction SilentlyContinue
            if (-not $existingSp -and $AppConfig.CreateServicePrincipal) {
                if ($PSCmdlet.ShouldProcess($AppConfig.DisplayName, "Create service principal")) {
                    $sp = New-MgServicePrincipal -AppId $existingApp.AppId
                    Write-Host "✓ Service Principal created: $($sp.Id)"
                }
                else {
                    Write-Host "[WhatIf] Would create service principal"
                }
            }
            
            return $existingApp
        }
        else {
            # Create new application
            Write-Host "Application does not exist - creating new application"
            
            if ($PSCmdlet.ShouldProcess($AppConfig.DisplayName, "Create application")) {
                $appParams = @{
                    DisplayName = $AppConfig.DisplayName
                }
                if ($AppConfig.Description) { $appParams['Description'] = $AppConfig.Description }
                if ($AppConfig.SignInAudience) { $appParams['SignInAudience'] = $AppConfig.SignInAudience }
                if ($AppConfig.Web) { $appParams['Web'] = $AppConfig.Web }
                if ($AppConfig.RequiredResourceAccess) { $appParams['RequiredResourceAccess'] = $AppConfig.RequiredResourceAccess }

                # Apply monitor filter — excluded fields must not be written on initial creation
                # DisplayName is always preserved since it is required by the Graph API
                if ($appMonitorConfig) {
                    $filteredParams = Apply-MonitorFilter -PolicyObject $appParams -MonitorConfig $appMonitorConfig
                    if (-not $filteredParams.ContainsKey('DisplayName')) { $filteredParams['DisplayName'] = $appParams['DisplayName'] }
                    $appParams = $filteredParams
                }
                
                $newApp = New-MgApplication -BodyParameter $appParams
                Write-Host "✓ Application created successfully"
                Write-Host "  Application ID: $($newApp.Id)"
                Write-Host "  Client ID: $($newApp.AppId)"
                
                # Create service principal if requested
                if ($AppConfig.CreateServicePrincipal) {
                    $sp = New-MgServicePrincipal -AppId $newApp.AppId
                    Write-Host "✓ Service Principal created: $($sp.Id)"
                }
                
                return $newApp
            }
            else {
                Write-Host "[WhatIf] Would create application: $($AppConfig.DisplayName)"
                return $null
            }
        }
    }
    catch {
        Write-Host "##[error]Failed to process application: $($AppConfig.DisplayName)"
        Write-Host "##[error]Error: $_"
        throw
    }
    finally {
        Write-Host "##[endgroup]"
    }
}

# Process all applications
Write-Host "`n##[section]Creating/Updating Enterprise Applications"

$results = @()
$successCount = 0
$errorCount = 0
$wouldCreateCount = 0
$wouldUpdateCount = 0

foreach ($appConfig in $appConfigs) {
    try {
        $app = Set-EnterpriseApp -AppConfig $appConfig
        if ($app -or $WhatIfPreference) {
            $successCount++
            # $app is a PSCustomObject with Status when WhatIf, or a Graph object when live
            $itemStatus = if ($app -and $app.PSObject.Properties['Status']) { $app.Status } `
                          elseif ($WhatIfPreference) { "WouldCreate" } `
                          else { "Success" }
            if ($itemStatus -eq "WouldCreate")  { $wouldCreateCount++ }
            if ($itemStatus -eq "WouldUpdate")  { $wouldUpdateCount++ }
            $results += [PSCustomObject]@{
                DisplayName = $appConfig.DisplayName
                Id          = if ($app -and $app.PSObject.Properties['Id'])    { $app.Id }    else { $null }
                AppId       = if ($app -and $app.PSObject.Properties['AppId']) { $app.AppId } else { $null }
                Status      = $itemStatus
                FilePath    = $appConfig._SourceFile
            }
        }
    }
    catch {
        $errorCount++
        $results += [PSCustomObject]@{
            DisplayName = $appConfig.DisplayName
            Id = $null
            AppId = $null
            Status = "Failed: $_"
            FilePath = $appConfig._SourceFile
        }
    }
}

# Summary
Write-Host "`n##[section]Summary"
Write-Host "Total applications processed: $($appConfigs.Count)"
Write-Host "✓ Successful: $successCount"
if ($errorCount -gt 0) {
    Write-Host "✗ Failed: $errorCount"
}

if ($results.Count -gt 0) {
    Write-Host "`nResults:"
    $results | Format-Table -AutoSize
    $failedResults = @($results | Where-Object { $_.Status -like 'Failed:*' })
    if ($failedResults.Count -gt 0) {
        Write-Host "`nFull error details:"
        foreach ($r in $failedResults) {
            Write-Host "  $($r.DisplayName): $($r.Status)"
        }
    }
}

# Output plan summary if requested
if ($OutputPath) {
    $planSummary = @{
        Service            = "EnterpriseApps"
        Timestamp          = Get-Date -Format "o"
        TotalApplications  = $appConfigs.Count
        SuccessCount       = $successCount
        WouldCreateCount   = $wouldCreateCount
        WouldUpdateCount   = $wouldUpdateCount
        ErrorCount         = $errorCount
        Results            = $results
    }
    
    $planSummary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "`nPlan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) {
    Write-Host "##[error]Some applications failed to process"
    exit 1
}
else {
    Write-Host "##[command]All Enterprise Applications configured successfully!"
}

