<#
.SYNOPSIS
    Syncs pipeline YAML files from Tenant-template to the Tenant repository.

.DESCRIPTION
    Compares azure-pipelines.yml and azure-pipelines-backup.yml in the Tenant
    repository with their template versions. If different, copies the template
    versions and commits them to keep Tenant pipelines up to date.

.PARAMETER TenantRepoPath
    Path to the Tenant repository (where pipeline YAML files will be updated).

.PARAMETER TemplatePath
    Path to the Tenant-template repository (source of the templates).

.PARAMETER WhatIf
    Show what would be changed without making changes.

.EXAMPLE
    .\Sync-TenantPipeline.ps1 -TenantRepoPath "D:\a\1\Tenant-repo" -TemplatePath "D:\a\1\Tenant-template"

.NOTES
    This script is called from the deploy pipeline to keep Tenant pipelines in sync.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)]
    [string]$TenantRepoPath,
    
    [Parameter(Mandatory=$true)]
    [string]$TemplatePath
)

$ErrorActionPreference = "Stop"

Write-Host "##[section]Syncing Tenant Pipeline files from Template"

$filesToSync = @('azure-pipelines.yml', 'azure-pipelines-backup.yml', 'azure-pipelines-maintenance.yml')
$anyChanged  = $false

Push-Location $TenantRepoPath
try {
    # Configure git user for commits (use pipeline service identity)
    $existingEmail = git config user.email 2>$null
    $existingName  = git config user.name  2>$null
    if (-not $existingEmail) { git config user.email "pipeline@azure-devops.local" }
    if (-not $existingName)  { git config user.name  "Azure DevOps Pipeline" }

    foreach ($fileName in $filesToSync) {
        $templateFilePath = Join-Path $TemplatePath $fileName
        $tenantFilePath   = Join-Path $TenantRepoPath $fileName

        if (-not (Test-Path $templateFilePath)) {
            Write-Host "  [Skip] Template file not found: $fileName" -ForegroundColor Yellow
            continue
        }

        if (-not (Test-Path $tenantFilePath)) {
            Write-Host "  [New] $fileName not present in Tenant repo - copying from template" -ForegroundColor Cyan
            if ($WhatIf) {
                Write-Host "  [WhatIf] Would copy $fileName to Tenant repository" -ForegroundColor Yellow
                continue
            }
            Copy-Item -Path $templateFilePath -Destination $tenantFilePath -Force
            git add $fileName
            $anyChanged = $true
            continue
        }

        $templateContent = Get-Content $templateFilePath -Raw
        $tenantContent   = Get-Content $tenantFilePath   -Raw

        # Normalize line endings for comparison
        $templateNormalized = $templateContent -replace "`r`n", "`n"
        $tenantNormalized   = $tenantContent   -replace "`r`n", "`n"

        if ($templateNormalized -eq $tenantNormalized) {
            Write-Host "  [OK] $fileName is up to date" -ForegroundColor Green
            continue
        }

        $templateLines = ($templateContent -split "`n").Count
        $tenantLines   = ($tenantContent   -split "`n").Count
        Write-Host "  [Update] $fileName differs from template (template: $templateLines lines, tenant: $tenantLines lines)" -ForegroundColor Cyan

        if ($WhatIf) {
            Write-Host "  [WhatIf] Would update $fileName from template" -ForegroundColor Yellow
            continue
        }

        Copy-Item -Path $templateFilePath -Destination $tenantFilePath -Force
        git add $fileName
        $anyChanged = $true
    }

    if ($anyChanged) {
        $status = git status --porcelain
        if ($status) {
            $commitMessage = "chore: sync pipeline YAML files from Tenant-template"
            git commit -m $commitMessage
            Write-Host "  Committed pipeline update" -ForegroundColor Green

            # Determine the push branch (detached HEAD is common in Azure Pipelines)
            $currentBranch = git rev-parse --abbrev-ref HEAD 2>$null
            $sourceBranch = if ($currentBranch -eq "HEAD") {
                if ($env:BUILD_SOURCEBRANCH) {
                    $env:BUILD_SOURCEBRANCH -replace "refs/heads/", ""
                } else {
                    "main"
                }
            } else {
                $currentBranch
            }
            Write-Host "  Pushing to branch: $sourceBranch" -ForegroundColor DarkGray

            # Retry loop: if the remote has advanced since checkout, fetch+rebase and retry
            $pushed  = $false
            $maxTries = 3
            for ($attempt = 1; $attempt -le $maxTries; $attempt++) {
                git push origin HEAD:refs/heads/$sourceBranch 2>&1 | Out-Host
                if ($LASTEXITCODE -eq 0) {
                    $pushed = $true
                    break
                }
                if ($attempt -lt $maxTries) {
                    Write-Host "  Push attempt $attempt rejected - fetching latest and rebasing…" -ForegroundColor Yellow
                    git fetch origin $sourceBranch 2>&1 | Out-Host
                    git rebase origin/$sourceBranch 2>&1 | Out-Host
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "  Rebase failed - aborting retry" -ForegroundColor Yellow
                        git rebase --abort 2>$null
                        break
                    }
                }
            }

            if ($pushed) {
                Write-Host "  Pushed pipeline update to remote" -ForegroundColor Green
                Write-Host "##vso[task.setvariable variable=PipelineSynced;isOutput=true]true"
            } else {
                Write-Host "  Could not push pipeline update after $maxTries attempts - will sync on next run" -ForegroundColor Yellow
            }
            # Reset exit code so a push conflict doesn't fail the overall pipeline task
            $global:LASTEXITCODE = 0
        } else {
            Write-Host "  No changes to commit (files are identical after copy)" -ForegroundColor DarkGray
        }
    } else {
        Write-Host "  All pipeline files are up to date - nothing to commit" -ForegroundColor Green
    }
}
catch {
    Write-Host "  Failed to commit/push pipeline update: $_" -ForegroundColor Yellow
    Write-Host "  Pipeline files will be updated on next run" -ForegroundColor Yellow
    # Don't fail the pipeline for a sync conflict
    $global:LASTEXITCODE = 0
}
finally {
    Pop-Location
}

Write-Host "##[section]Pipeline sync complete"
