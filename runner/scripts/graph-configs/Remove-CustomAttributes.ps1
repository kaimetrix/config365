<#
.SYNOPSIS
    Removes Custom Security Attributes specified in baseline-remove

.DESCRIPTION
    Processes the baseline-remove/custom-attributes folder and removes matching 
    attribute definitions and attribute sets.
    
    Note: Attribute definitions must be removed before attribute sets.
    Note: Attributes in use by CA policies cannot be removed.

.PARAMETER RemoveDirectory
    Path to the baseline-remove/custom-attributes directory

.EXAMPLE
    .\Remove-CustomAttributes.ps1 -RemoveDirectory "baseline-remove/custom-attributes"
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$RemoveDirectory,
    
    [Parameter(Mandatory=$false)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Removing Custom Security Attributes"

if (-not (Test-Path $RemoveDirectory)) {
    Write-Host "##[warning]Removal directory not found: $RemoveDirectory"
    exit 0
}

$defPath = Join-Path $RemoveDirectory "attribute-definitions"
$setPath = Join-Path $RemoveDirectory "attribute-sets"

$defFiles = @()
$setFiles = @()

if (Test-Path $defPath) {
    $defFiles = @(Get-ChildItem -Path $defPath -Filter "*.json" -File)
}
if (Test-Path $setPath) {
    $setFiles = @(Get-ChildItem -Path $setPath -Filter "*.json" -File)
}

if ($defFiles.Count -eq 0 -and $setFiles.Count -eq 0) {
    Write-Host "No custom attribute removal files found"
    exit 0
}

Write-Host "Found $($defFiles.Count) definition(s) and $($setFiles.Count) set(s) to remove"

# Import modules
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop

# Import common Graph connection utilities (GCC High support)
$commonScriptPath = Join-Path $PSScriptRoot "..\common\Connect-M365Graph.ps1"
if (Test-Path $commonScriptPath) {
    . $commonScriptPath
}

# Check connection (supports GCC High and Tenant-specific credentials)
$context = Ensure-M365GraphConnection -Scopes @("CustomSecAttributeDefinition.ReadWrite.All")
Write-Host "Connected to tenant: $((Get-MgContext).TenantId)"

$results = @()
$successCount = 0
$notFoundCount = 0
$errorCount = 0

# STEP 1: Remove attribute definitions first (before sets)
if ($defFiles.Count -gt 0) {
    Write-Host "`n##[section]Removing Attribute Definitions"
    
    foreach ($file in $defFiles) {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $defId = if ($config.id) { $config.id } else { [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }
        $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
        
        Write-Host "`n##[group]Removing definition: $defId"
        Write-Host "  Reason: $reason"
        
        try {
            # Check if exists
            $existing = $null
            try {
                $existing = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId" -ErrorAction Stop
            } catch { }
            
            if ($existing) {
                Write-Host "  Found definition"
                
                # First, set status to Deprecated (required before deletion)
                if ($existing.status -ne "Deprecated") {
                    Write-Host "  Setting status to Deprecated..."
                    $body = @{ status = "Deprecated" } | ConvertTo-Json
                    Invoke-MgGraphRequest -Method PATCH -Uri "https://graph.microsoft.com/v1.0/directory/customSecurityAttributeDefinitions/$defId" -Body $body -ContentType "application/json"
                }
                
                if ($PSCmdlet.ShouldProcess($defId, "Remove attribute definition")) {
                    # Note: Graph API doesn't support DELETE for attribute definitions
                    # They can only be deprecated, not deleted
                    Write-Host "  ##[warning]Attribute definitions cannot be deleted, only deprecated"
                    Write-Host "  Status set to: Deprecated"
                    
                    $results += [PSCustomObject]@{
                        Type = "AttributeDefinition"
                        Id = $defId
                        Status = "Deprecated"
                        Reason = $reason
                    }
                    $successCount++
                }
            }
            else {
                Write-Host "  Definition not found - skipping"
                $results += [PSCustomObject]@{
                    Type = "AttributeDefinition"
                    Id = $defId
                    Status = "NotFound"
                    Reason = $reason
                }
                $notFoundCount++
            }
        }
        catch {
            Write-Host "  ##[error]Failed: $_"
            $results += [PSCustomObject]@{
                Type = "AttributeDefinition"
                Id = $defId
                Status = "Failed: $($_.Exception.Message)"
                Reason = $reason
            }
            $errorCount++
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
}

# STEP 2: Remove attribute sets
if ($setFiles.Count -gt 0) {
    Write-Host "`n##[section]Removing Attribute Sets"
    Write-Host "##[warning]Note: Attribute sets cannot be deleted if they contain active definitions"
    
    foreach ($file in $setFiles) {
        $config = Get-Content $file.FullName -Raw | ConvertFrom-Json
        $setId = if ($config.id) { $config.id } else { [System.IO.Path]::GetFileNameWithoutExtension($file.Name) }
        $reason = if ($config.reason) { $config.reason } else { "No reason specified" }
        
        Write-Host "`n##[group]Removing set: $setId"
        Write-Host "  Reason: $reason"
        
        try {
            $existing = $null
            try {
                $existing = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/directory/attributeSets/$setId" -ErrorAction Stop
            } catch { }
            
            if ($existing) {
                Write-Host "  Found attribute set"
                
                if ($PSCmdlet.ShouldProcess($setId, "Remove attribute set")) {
                    # Note: Attribute sets also cannot be deleted, only the definitions can be deprecated
                    Write-Host "  ##[warning]Attribute sets cannot be deleted via Graph API"
                    Write-Host "  Ensure all definitions in this set are deprecated first"
                    
                    $results += [PSCustomObject]@{
                        Type = "AttributeSet"
                        Id = $setId
                        Status = "CannotDelete"
                        Reason = $reason
                    }
                }
            }
            else {
                Write-Host "  Set not found - skipping"
                $results += [PSCustomObject]@{
                    Type = "AttributeSet"
                    Id = $setId
                    Status = "NotFound"
                    Reason = $reason
                }
                $notFoundCount++
            }
        }
        catch {
            Write-Host "  ##[error]Failed: $_"
            $results += [PSCustomObject]@{
                Type = "AttributeSet"
                Id = $setId
                Status = "Failed: $($_.Exception.Message)"
                Reason = $reason
            }
            $errorCount++
        }
        finally {
            Write-Host "##[endgroup]"
        }
    }
}

Write-Host "`n##[section]Summary"
Write-Host "Processed: $successCount | Not found: $notFoundCount | Failed: $errorCount"
Write-Host "##[warning]Note: Custom security attributes can only be deprecated, not deleted"

if ($results.Count -gt 0) {
    $results | Format-Table -AutoSize
}

if ($OutputPath) {
    @{ Service = "CustomAttributes-Remove"; Results = $results } | ConvertTo-Json -Depth 10 | Out-File $OutputPath -Encoding UTF8
}

Write-Host "##[command]Custom attribute removal completed!"



