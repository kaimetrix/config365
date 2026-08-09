<#
.SYNOPSIS
    Creates and manages Intune Win32 LOB apps from printer packages via Microsoft Graph API

.DESCRIPTION
    Reads install.ps1 + detection.ps1 + config.json (and optional uninstall.ps1) from one or more
    /apps/printer/{appName}/ directories (baseline repo and/or tenant repo), packages each as a
    Win32 LOB app using IntuneWinAppUtil.exe, uploads the .intunewin content to Intune, and applies
    group assignments.

    Detection is user-supplied (detection.ps1 from the app folder).
    Uninstall command uses uninstall.ps1 if present, otherwise exits with code 0.
    Install behavior (System/User) is read from config.json runAsAccount field.

    Supports -WhatIfMode to preview changes without making them.

.PARAMETER ConfigDirectories
    One or more paths to scan for app subfolders. Each subfolder must contain
    install.ps1, detection.ps1, and config.json. If the same app name appears in multiple
    directories, the last one processed wins (tenant directory should be listed last).

.PARAMETER OutputPath
    Optional path to save a JSON summary of planned/applied changes.

.PARAMETER WhatIfMode
    Show what would be changed without making changes or uploading content.

.EXAMPLE
    .\Configure-PrinterApps.ps1 `
        -ConfigDirectories "baseline/apps/printer","Tenant-repo/apps/printer" `
        -WhatIfMode -OutputPath "printerapps-plan.json"

.NOTES
    Requires Microsoft.Graph.Authentication and Microsoft.Graph.Groups modules.
    Requires DeviceManagementApps.ReadWrite.All Graph API permission.
    Linux runners use the native intunewin CLI at /usr/local/share/config365/tools/intunewin.
    Windows runners may use IntuneWinAppUtil.exe when present.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$ConfigDirectories,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$WhatIfMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

# ============================================================================
# CONSTANTS
# ============================================================================

$GRAPH_BASE              = 'https://graph.microsoft.com/beta'
$UPLOAD_CHUNK_SIZE       = 6 * 1024 * 1024   # 6 MB

# ============================================================================
# IMPORT DEPENDENCIES
# ============================================================================

$commonScriptPath = Join-Path $scriptRoot '..\common\Connect-M365Graph.ps1'
if (Test-Path $commonScriptPath) { . $commonScriptPath }

$intuneWinPackagerPath = Join-Path $scriptRoot '..\common\Get-IntuneWinPackager.ps1'
if (Test-Path $intuneWinPackagerPath) { . $intuneWinPackagerPath }

$intuneWinPackagePath = Join-Path $scriptRoot '..\common\New-IntuneWinPackage.ps1'
if (Test-Path $intuneWinPackagePath) { . $intuneWinPackagePath }

$intuneDisplayNamePath = Join-Path $scriptRoot '..\common\Get-AppIntuneDisplayName.ps1'
if (Test-Path $intuneDisplayNamePath) { . $intuneDisplayNamePath }

$syncAssignmentsPath = Join-Path $scriptRoot '..\common\Sync-MobileAppAssignments.ps1'
if (Test-Path $syncAssignmentsPath) { . $syncAssignmentsPath }

$iconHelperPath = Join-Path $scriptRoot '..\common\Get-Win32AppIconForIntune.ps1'
if (Test-Path $iconHelperPath) { . $iconHelperPath }

# ============================================================================
# GRAPH HELPER FUNCTIONS
# ============================================================================

function Invoke-GraphRequest {
    param(
        [string]$Method = 'GET',
        [string]$Uri,
        [object]$Body,
        [string]$ContentType = 'application/json'
    )
    # Use the SDK's own request cmdlet rather than manually extracting a bearer token.
    # (Get-MgContext).AuthContext.AccessToken / Get-MgAccessToken are NOT reliable ways to
    # get a raw token in current Microsoft.Graph.Authentication versions — Get-MgContext
    # does not expose an AuthContext/AccessToken property and Get-MgAccessToken is not
    # exported at all in the installed SDK version. Invoke-MgGraphRequest uses the SDK's
    # internal auth provider (populated by Connect-MgGraph) directly, so no token
    # extraction is needed.
    $params = @{ Uri = $Uri; Method = $Method; ErrorAction = 'Stop' }
    if ($Body) {
        $params.Body = $Body
        $params.ContentType = $ContentType
    }
    return Invoke-MgGraphRequest @params
}

# ============================================================================
# AUTHENTICATION
# ============================================================================

$moduleHelpersPath = Join-Path $PSScriptRoot "Common-ModuleHelpers.ps1"
. $moduleHelpersPath

$requiredModules = @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Groups')
Import-RequiredGraphModules -ModuleNames $requiredModules

try {
    $context = Ensure-M365GraphConnection
    Write-Host "  Connected to tenant: $($context.TenantId)"
} catch {
    throw "Failed to authenticate to Microsoft Graph: $_"
}

# ============================================================================
# DISCOVER APP FOLDERS
# ============================================================================

Write-Host "`n##[section]Discovering Printer app packages"

# Build a merged map of appName -> { installPs1, detectionPs1, uninstallPs1, configJson, directory }
# Later directories override earlier ones (tenant wins over baseline)
$packageMap = [ordered]@{}

foreach ($dir in $ConfigDirectories) {
    if (-not (Test-Path $dir)) {
        Write-Host "  Directory not found, skipping: $dir" -ForegroundColor DarkGray
        continue
    }
    $subFolders = Get-ChildItem -Path $dir -Directory -ErrorAction SilentlyContinue
    foreach ($folder in $subFolders) {
        $masterCfgPath = Join-Path $folder.FullName 'config.json'
        $splitDeploy   = $false
        if (Test-Path $masterCfgPath) {
            try {
                $masterCfg   = Get-Content $masterCfgPath -Raw | ConvertFrom-Json
                $splitDeploy = [bool]$masterCfg.splitDeploy
            } catch { $splitDeploy = $false }
        }

        $driverDir  = Join-Path $folder.FullName 'driver'
        $connectDir = Join-Path $folder.FullName 'connect'
        $driverCfg  = Join-Path $driverDir 'config.json'
        $connectCfg = Join-Path $connectDir 'config.json'

        if ($splitDeploy -and (Test-Path $driverCfg) -and (Test-Path $connectCfg)) {
            foreach ($roleDir in @(@{ Role = 'driver'; Path = $driverDir }, @{ Role = 'connect'; Path = $connectDir })) {
                $rolePath     = $roleDir.Path
                $installPs1   = Join-Path $rolePath 'install.ps1'
                $detectionPs1 = Join-Path $rolePath 'detection.ps1'
                $configJson   = Join-Path $rolePath 'config.json'
                $uninstallPs1 = Join-Path $rolePath 'uninstall.ps1'
                if (-not (Test-Path $installPs1) -or -not (Test-Path $detectionPs1)) {
                    Write-Host "  Skipping $($folder.Name)/$($roleDir.Role): missing install.ps1 or detection.ps1" -ForegroundColor DarkGray
                    continue
                }
                $mapKey = "$($folder.Name)-$($roleDir.Role)"
                $packageMap[$mapKey] = @{
                    AppName       = $mapKey
                    InstallPs1    = $installPs1
                    DetectionPs1  = $detectionPs1
                    UninstallPs1  = if (Test-Path $uninstallPs1) { $uninstallPs1 } else { $null }
                    ConfigJson    = $configJson
                    Directory     = $rolePath
                    PrinterRole   = $roleDir.Role
                    ParentName    = $folder.Name
                }
                Write-Host "  Found split app: $mapKey (from $dir)"
            }
            continue
        }

        $installPs1   = Join-Path $folder.FullName 'install.ps1'
        $detectionPs1 = Join-Path $folder.FullName 'detection.ps1'
        $configJson   = Join-Path $folder.FullName 'config.json'
        $uninstallPs1 = Join-Path $folder.FullName 'uninstall.ps1'

        if (-not (Test-Path $installPs1) -or -not (Test-Path $configJson) -or -not (Test-Path $detectionPs1)) {
            Write-Host "  Skipping $($folder.Name): missing install.ps1, detection.ps1, or config.json" -ForegroundColor DarkGray
            continue
        }
        $packageMap[$folder.Name] = @{
            AppName       = $folder.Name
            InstallPs1    = $installPs1
            DetectionPs1  = $detectionPs1
            UninstallPs1  = if (Test-Path $uninstallPs1) { $uninstallPs1 } else { $null }
            ConfigJson    = $configJson
            Directory     = $folder.FullName
            PrinterRole   = $null
            ParentName    = $folder.Name
        }
        Write-Host "  Found app: $($folder.Name) (from $dir)"
    }
}

if ($packageMap.Count -eq 0) {
    Write-Host "No Printer app packages found in any of the provided directories." -ForegroundColor DarkGray
    if ($OutputPath) {
        @{ Service = 'PrinterApps'; WouldCreateCount = 0; WouldUpdateCount = 0; NoChangeCount = 0; ErrorCount = 0; Results = @() } |
            ConvertTo-Json | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    }
    exit 0
}

Write-Host "Total apps to process: $($packageMap.Count)"

# ============================================================================
# HELPER: EXTRACT ENCRYPTION METADATA FROM .intunewin
# ============================================================================

function Get-IntuneWinMetadata {
    param([string]$IntuneWinPath)

    Add-Type -Assembly System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($IntuneWinPath)
    try {
        $detectionEntry = $zip.Entries | Where-Object { $_.FullName -like '*/Metadata/Detection.xml' }
        if (-not $detectionEntry) {
            throw "Detection.xml not found inside .intunewin (entries: $($zip.Entries.FullName -join ', '))"
        }
        $stream = $detectionEntry.Open()
        $reader = New-Object System.IO.StreamReader($stream)
        $xmlContent = $reader.ReadToEnd()
        $reader.Close(); $stream.Close()
        $xml = [xml]$xmlContent

        $contentEntry = $zip.Entries | Where-Object { $_.FullName -like '*/Contents/*.intunewin' } | Select-Object -First 1
        if (-not $contentEntry) { throw "Content entry not found inside .intunewin" }

        return @{
            EncryptionKey          = $xml.ApplicationInfo.EncryptionInfo.EncryptionKey
            MacKey                 = $xml.ApplicationInfo.EncryptionInfo.MacKey
            InitializationVector   = $xml.ApplicationInfo.EncryptionInfo.InitializationVector
            Mac                    = $xml.ApplicationInfo.EncryptionInfo.Mac
            ProfileIdentifier      = $xml.ApplicationInfo.EncryptionInfo.ProfileIdentifier
            FileDigest             = $xml.ApplicationInfo.EncryptionInfo.FileDigest
            FileDigestAlgorithm    = $xml.ApplicationInfo.EncryptionInfo.FileDigestAlgorithm
            UnencryptedContentSize = [long]$xml.ApplicationInfo.UnencryptedContentSize
            EncryptedSize          = $contentEntry.Length
            ContentEntryName       = $contentEntry.FullName
        }
    } finally {
        $zip.Dispose()
    }
}

# ============================================================================
# HELPER: UPLOAD CONTENT TO AZURE STORAGE IN BLOCKS
# ============================================================================

function Send-ContentToAzureStorage {
    param(
        [string]$IntuneWinPath,
        [string]$ContentEntryName,
        [string]$SasUri
    )

    Add-Type -Assembly System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($IntuneWinPath)
    try {
        $contentEntry = $zip.Entries | Where-Object { $_.FullName -eq $ContentEntryName } | Select-Object -First 1
        $stream       = $contentEntry.Open()
        $blockIds     = [System.Collections.Generic.List[string]]::new()
        $blockIndex   = 0

        while ($stream.Position -lt $contentEntry.Length) {
            $remaining  = $contentEntry.Length - $stream.Position
            $chunkSize  = [Math]::Min($script:UPLOAD_CHUNK_SIZE, $remaining)
            $buffer     = New-Object byte[] $chunkSize
            $read       = $stream.Read($buffer, 0, $chunkSize)
            if ($read -lt $chunkSize) { $buffer = $buffer[0..($read - 1)] }

            $blockId    = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($blockIndex.ToString('D6')))
            $blockIds.Add($blockId)
            $putUri     = "$SasUri&comp=block&blockid=$([Uri]::EscapeDataString($blockId))"

            Invoke-WebRequest -Uri $putUri -Method PUT -Body $buffer `
                -Headers @{ 'x-ms-blob-type' = 'BlockBlob'; 'Content-Type' = 'application/octet-stream' } `
                -UseBasicParsing | Out-Null

            Write-Host "    Uploaded block $($blockIndex + 1) ($read bytes)"
            $blockIndex++
        }
        $stream.Close()

        $blockListXml = "<?xml version='1.0' encoding='utf-8'?><BlockList>" +
            ($blockIds | ForEach-Object { "<Latest>$_</Latest>" }) + "</BlockList>"
        $commitUri = "$SasUri&comp=blocklist"
        Invoke-WebRequest -Uri $commitUri -Method PUT -Body $blockListXml `
            -Headers @{ 'Content-Type' = 'text/xml' } -UseBasicParsing | Out-Null
        Write-Host "    Block list committed ($blockIndex blocks)"
    } finally {
        $zip.Dispose()
    }
}

# ============================================================================
# HELPER: RESOLVE GROUP ID BY DISPLAY NAME
# ============================================================================

function Resolve-GroupId {
    param([string]$GroupName, [string]$GroupId)
    if ($GroupId) { return $GroupId }
    if (-not $GroupName) { return $null }
    $encoded = [Uri]::EscapeDataString("displayName eq '$GroupName'")
    $result  = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/groups?`$filter=$encoded&`$select=id,displayName"
    $match   = $result.value | Select-Object -First 1
    if (-not $match) {
        Write-Host "    Warning: Group '$GroupName' not found in directory" -ForegroundColor Yellow
        return $null
    }
    return $match.id
}

# ============================================================================
# HELPER: FETCH CURRENT APP ASSIGNMENTS WITH GROUP NAMES (for WhatIf diff)
# ============================================================================

function Get-AppAssignments {
    param([string]$AppId)
    try {
        $result = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId/assignments"
        $assignments = foreach ($a in $result.value) {
            $odataType = [string]$a.target.'@odata.type'
            if ($odataType -match 'allLicensedUsers') {
                [PSCustomObject]@{
                    groupId    = $null
                    groupName  = 'All Users'
                    intent     = $a.intent
                    targetType = 'allLicensedUsers'
                }
                continue
            }
            if ($odataType -match 'allDevices') {
                [PSCustomObject]@{
                    groupId    = $null
                    groupName  = 'All Devices'
                    intent     = $a.intent
                    targetType = 'allDevices'
                }
                continue
            }
            $gId    = $a.target.groupId
            $gName  = $null
            if ($gId) {
                try {
                    $grp   = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/groups/$gId`?`$select=displayName"
                    $gName = $grp.displayName
                } catch { $gName = $gId }
            }
            $intent = if ($a.target.'@odata.type' -match 'exclusion') { 'exclude' } else { $a.intent }
            [PSCustomObject]@{ groupId = $gId; groupName = $gName; intent = $intent }
        }
        return @($assignments)
    } catch {
        return @()
    }
}

# ============================================================================
# HELPER: CHECK IF WIN32 APP EXISTS BY DISPLAY NAME
# ============================================================================

function Get-ExistingWin32App {
    param([string]$DisplayName)
    $encoded = [Uri]::EscapeDataString("displayName eq '$DisplayName'")
    try {
        $result = Invoke-GraphRequest -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps?`$filter=$encoded"
        return $result.value | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.win32LobApp' } | Select-Object -First 1
    } catch {
        return $null
    }
}

function Resolve-PrinterIntuneAppDisplayName {
    param(
        [PSCustomObject]$Config,
        [string]$PackageId
    )
    if ($Config.PSObject.Properties.Name -contains 'intuneDisplayName') {
        $custom = [string]$Config.intuneDisplayName
        if ($custom.Trim()) { return $custom.Trim() }
    }
    $displayName = if ($Config.displayName) { [string]$Config.displayName.Trim() } else { $PackageId }
    $role = if ($Config.PSObject.Properties.Name -contains 'printerRole') { [string]$Config.printerRole } else { '' }
    if ($role -eq 'driver') { return "Printer - $displayName (Driver)" }
    if ($role -eq 'connect') { return "Printer - $displayName (Connect)" }
    return Resolve-IntuneAppDisplayName -Config $Config -PackageId $PackageId -Prefix 'Printer'
}

function Sync-PrinterAppDependency {
    param(
        [string]$ConnectAppId,
        [string]$DriverAppId
    )
    if (-not $ConnectAppId -or -not $DriverAppId) { return }

    $body = @{
        relationships = @(
            @{
                '@odata.type'  = '#microsoft.graph.mobileAppDependency'
                targetId       = $DriverAppId
                targetType     = 'parent'
                dependencyType = 'detect'
            }
        )
    }
    Invoke-GraphRequest -Method POST `
        -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$ConnectAppId/updateRelationships" `
        -Body $body | Out-Null
    Write-Host "    Dependency set: connect app depends on driver app ($DriverAppId)" -ForegroundColor DarkGray
}

# ============================================================================
# HELPER: FULL WIN32 APP CONTENT UPLOAD (multi-step)
# ============================================================================

function Publish-Win32AppContent {
    param(
        [string]$AppId,
        [string]$IntuneWinPath,
        [hashtable]$Metadata
    )

    $contentVersionUri = "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId/microsoft.graph.win32LobApp/contentVersions"
    $versionResult     = Invoke-GraphRequest -Method POST -Uri $contentVersionUri -Body @{}
    $versionId         = $versionResult.id
    Write-Host "    Content version created: $versionId"

    $fileBody = @{
        '@odata.type' = '#microsoft.graph.mobileAppContentFile'
        name          = 'install.intunewin'
        size          = $Metadata.UnencryptedContentSize
        sizeEncrypted = $Metadata.EncryptedSize
        manifest      = $null
        isDependency  = $false
    }
    $filesUri    = "$contentVersionUri/$versionId/files"
    $fileResult  = Invoke-GraphRequest -Method POST -Uri $filesUri -Body $fileBody
    $fileId      = $fileResult.id

    $sasUri = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 3
        $fileStatus = Invoke-GraphRequest -Uri "$filesUri/$fileId"
        if ($fileStatus.azureStorageUri) { $sasUri = $fileStatus.azureStorageUri; break }
    }
    if (-not $sasUri) { throw "Timed out waiting for Azure Storage SAS URI" }
    Write-Host "    Azure Storage URI obtained"

    Send-ContentToAzureStorage -IntuneWinPath $IntuneWinPath `
        -ContentEntryName $Metadata.ContentEntryName -SasUri $sasUri

    $commitBody = @{
        fileEncryptionInfo = @{
            encryptionKey        = $Metadata.EncryptionKey
            macKey               = $Metadata.MacKey
            initializationVector = $Metadata.InitializationVector
            mac                  = $Metadata.Mac
            profileIdentifier    = $Metadata.ProfileIdentifier
            fileDigest           = $Metadata.FileDigest
            fileDigestAlgorithm  = $Metadata.FileDigestAlgorithm
        }
    }
    Invoke-GraphRequest -Method POST -Uri "$filesUri/$fileId/commit" -Body $commitBody | Out-Null

    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 5
        $fileStatus = Invoke-GraphRequest -Uri "$filesUri/$fileId"
        Write-Host "    Processing state: $($fileStatus.uploadState)"
        if ($fileStatus.uploadState -eq 'commitFileSuccess') { break }
        if ($fileStatus.uploadState -like '*fail*') {
            throw "Content processing failed: $($fileStatus.uploadState)"
        }
    }
    Write-Host "    Content committed successfully"

    Invoke-GraphRequest -Method PATCH `
        -Uri "$script:GRAPH_BASE/deviceAppManagement/mobileApps/$AppId" `
        -Body @{ '@odata.type' = '#microsoft.graph.win32LobApp'; committedContentVersion = $versionId } | Out-Null
    Write-Host "    App content version committed: $versionId"
}

# ============================================================================
# MAIN PROCESSING LOOP
# ============================================================================

Write-Host "`n##[section]Processing Printer apps"

$allResults  = [System.Collections.Generic.List[hashtable]]::new()
$appNameToFile = @{}
$invokeGraphSb = {
    param([string]$Method, [string]$Uri, [object]$Body)
    Invoke-GraphRequest -Method $Method -Uri $Uri -Body $Body
}
$resolveGroupSb = {
    param([string]$GroupName, [string]$GroupId)
    Resolve-GroupId -GroupName $GroupName -GroupId $GroupId
}
$wouldCreate = 0
$wouldUpdate = 0
$noChange    = 0
$errorCount  = 0

$globalTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "PrinterApps-$(Get-Random)"
if (-not $WhatIfMode) { New-Item -ItemType Directory -Path $globalTmpDir -Force | Out-Null }

try {
    $sortedPackages = @($packageMap.Values | Sort-Object {
        if ($_.PrinterRole -eq 'driver') { 0 }
        elseif ($_.PrinterRole -eq 'connect') { 1 }
        else { 2 }
    }, { $_.AppName })

    foreach ($pkg in $sortedPackages) {
        $appName      = $pkg.AppName
        $installPs1   = $pkg.InstallPs1
        $detectionPs1 = $pkg.DetectionPs1
        $uninstallPs1 = $pkg.UninstallPs1
        $configPath   = $pkg.ConfigJson

        Write-Host "`n--- App: $appName ---" -ForegroundColor Cyan

        # Load config
        $config      = Get-Content $configPath -Raw | ConvertFrom-Json
        $displayName = if ($config.displayName) { $config.displayName.Trim() } else { $appName }
        $intuneAppName = Resolve-PrinterIntuneAppDisplayName -Config $config -PackageId $appName
        $appNameToFile[$intuneAppName] = $configPath
        $runAsAccount  = if ($config.runAsAccount -eq 'user') { 'user' } else { 'system' }
        $appFolder     = Split-Path $configPath -Parent
        $iconFilePath  = Resolve-Win32AppIconPath -AppFolderPath $appFolder -Config $config
        $iconHash      = Get-Win32AppIconHash -IconPath $iconFilePath
        $iconFragment  = Get-Win32AppIconJsonFragment -IconPath $iconFilePath

        # Read scripts
        $installContent   = Get-Content $installPs1   -Raw
        $detectionContent = Get-Content $detectionPs1 -Raw
        $uninstallContent = if ($uninstallPs1) { Get-Content $uninstallPs1 -Raw } else { $null }
        $detectionB64     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detectionContent))

        # Uninstall command
        $uninstallCmd = if ($uninstallPs1) {
            'powershell.exe -ExecutionPolicy Bypass -File uninstall.ps1'
        } else {
            'powershell.exe -ExecutionPolicy Bypass -Command "exit 0"'
        }

        # Compute hashes for change detection
        $sha256 = [Security.Cryptography.SHA256]::Create()
        $installHash   = [Convert]::ToBase64String($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($installContent)))
        $detectionHash = [Convert]::ToBase64String($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($detectionContent)))
        $uninstallHash = if ($uninstallContent) {
            [Convert]::ToBase64String($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($uninstallContent)))
        } else { 'none' }
        $availableForAllUsers = [bool]($config.availableForAllUsers)
        $dependTarget  = if ($config.dependsOnIntuneDisplayName) { [string]$config.dependsOnIntuneDisplayName.Trim() } else { '' }
        $dependHash    = [Convert]::ToBase64String($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($dependTarget)))

        # Build the notes field (stores content hashes for change detection)
        $notesValue = "installHash:$installHash;detectionHash:$detectionHash;uninstallHash:$uninstallHash;iconHash:$iconHash;dependHash:$dependHash"

        # Build Win32 app JSON body
        $version       = if ($config.version) { $config.version } else { '' }
        $jAppName      = $intuneAppName | ConvertTo-Json -Compress
        $jDescription  = "Printer Win32 app: $displayName. Managed by CONFIG365." | ConvertTo-Json -Compress
        $jInstallCmd   = 'powershell.exe -ExecutionPolicy Bypass -File install.ps1' | ConvertTo-Json -Compress
        $jUninstallCmd = $uninstallCmd | ConvertTo-Json -Compress
        $jNotes        = $notesValue | ConvertTo-Json -Compress
        $jRunAs        = $runAsAccount | ConvertTo-Json -Compress

        $appBody = @"
{
  "@odata.type": "#microsoft.graph.win32LobApp",
  "displayName": $jAppName,
$iconFragment  "description": $jDescription,
  "publisher": "CONFIG365",
  "fileName": "install.intunewin",
  "setupFilePath": "install.ps1",
  "installCommandLine": $jInstallCmd,
  "uninstallCommandLine": $jUninstallCmd,
  "installExperience": { "runAsAccount": $jRunAs, "deviceRestartBehavior": "suppress" },
  "returnCodes": [{ "returnCode": 0, "type": "success" }],
  "detectionRules": [{
    "@odata.type": "#microsoft.graph.win32LobAppPowerShellScriptDetection",
    "enforceSignatureCheck": false,
    "runAs32Bit": false,
    "scriptContent": "$detectionB64"
  }],
  "applicableArchitectures": "x64",
  "minimumSupportedOperatingSystem": { "v10_1607": true },
  "notes": $jNotes
}
"@

        try {
            $lookup   = Find-ExistingWin32AppForConfig -Config $config -PackageId $appName -Prefix 'Printer' -GetExisting ${function:Get-ExistingWin32App}
            $existing = $lookup.Existing
            if ($lookup.WasLegacyName) {
                Write-Host "  Found existing app under legacy name '$($lookup.WasLegacyName)'" -ForegroundColor DarkGray
            }

            $existingNotes       = $existing.notes ?? ''
            $existingInstallHash    = if ($existingNotes -match 'installHash:([^;]+)')   { $Matches[1] } else { '' }
            $existingDetectionHash  = if ($existingNotes -match 'detectionHash:([^;]+)') { $Matches[1] } else { '' }
            $existingUninstallHash  = if ($existingNotes -match 'uninstallHash:([^;]+)') { $Matches[1] } else { '' }
            $existingIconHash       = if ($existingNotes -match 'iconHash:([^;]*)')      { $Matches[1] } else { '' }
            $existingDependHash     = if ($existingNotes -match 'dependHash:([^;]*)')   { $Matches[1] } else { '' }

            $scriptChanged  = ($existingInstallHash -ne $installHash) -or
                              ($existingDetectionHash -ne $detectionHash) -or
                              ($existingUninstallHash -ne $uninstallHash)
            $iconChanged    = $existingIconHash -ne $iconHash
            $dependChanged  = $existingDependHash -ne $dependHash
            $nameChanged    = $existing -and ($existing.displayName -ne $intuneAppName)

            $existingAsgn  = @()
            $assignChanged = $false
            if ($existing) {
                $existingAsgn  = @(Get-AppAssignments -AppId $existing.id)
                $assignChanged = -not (Test-MobileAppAssignmentsMatch -ExistingAssignments $existingAsgn `
                    -ConfigAssignments @($config.assignments) -AvailableForAllUsers $availableForAllUsers)
            }

            if ($WhatIfMode) {
                if (-not $existing) {
                    Write-Host "  WouldCreate: $intuneAppName" -ForegroundColor Green
                    $wouldCreate++
                    $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'WouldCreate'; Type = 'Win32App'; AppName = $appName })
                } elseif ($scriptChanged) {
                    Write-Host "  WouldUpdate: $intuneAppName (script changed)" -ForegroundColor Yellow
                    $wouldUpdate++
                    $allResults.Add(@{
                        DisplayName = $intuneAppName; Status = 'WouldUpdate'; Type = 'Win32App'; AppName = $appName
                        Changes     = @{ Modified = @('Install Script') }
                    })
                } elseif ($assignChanged -or $nameChanged -or $iconChanged -or $dependChanged) {
                    $changes = @()
                    if ($nameChanged) { $changes += 'Display Name' }
                    if ($assignChanged) { $changes += 'Assignments' }
                    if ($iconChanged) { $changes += 'Icon' }
                    if ($dependChanged) { $changes += 'Dependency' }
                    Write-Host "  WouldUpdate: $intuneAppName ($($changes -join ', ') changed)" -ForegroundColor Yellow
                    $wouldUpdate++
                    $asgnJson     = if ($config.assignments) { ConvertTo-Json -InputObject @($config.assignments) -Compress -Depth 5 } else { '[]' }
                    $existingJson = ConvertTo-Json -InputObject $existingAsgn -Compress -Depth 5
                    $allResults.Add(@{
                        DisplayName = $intuneAppName; Status = 'WouldUpdate'; Type = 'Win32App'; AppName = $appName
                        Changes     = @{ Modified = $changes; AssignmentsDesired = $asgnJson; AssignmentsExisting = $existingJson }
                    })
                } else {
                    Write-Host "  No changes: $intuneAppName" -ForegroundColor DarkGray
                    $noChange++
                    $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'No changes'; Type = 'Win32App'; AppName = $appName })
                }
                continue
            }

            # ── Apply mode ──

            $allowCreate = ($env:ALLOW_CREATE -ne 'false')
            $allowUpdate = ($env:ALLOW_UPDATE -ne 'false')

            $appId = $null

            if (-not $existing) {
                if (-not $allowCreate) {
                    Write-Host "  SKIPPED (ALLOW_CREATE=false): $intuneAppName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Blocked'; Type = 'Win32App'; AppName = $appName })
                    continue
                }

                $pkgTmpDir     = Join-Path $globalTmpDir $appName
                New-Item -ItemType Directory -Path $pkgTmpDir -Force | Out-Null
                $intuneWinPath = New-IntuneWinPackage -InstallPs1Path $installPs1 -UninstallPs1Path $uninstallPs1 -TmpDir $pkgTmpDir
                $metadata      = Get-IntuneWinMetadata -IntuneWinPath $intuneWinPath

                Write-Host "  Creating: $intuneAppName" -ForegroundColor Green
                $createdApp = Invoke-GraphRequest -Method POST `
                    -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps" -Body $appBody
                $appId = $createdApp.id
                Write-Host "  App created: $appId"

                Publish-Win32AppContent -AppId $appId -IntuneWinPath $intuneWinPath -Metadata $metadata
                $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Created'; Type = 'Win32App'; AppName = $appName })

            } elseif ($scriptChanged) {
                if (-not $allowUpdate) {
                    Write-Host "  SKIPPED (ALLOW_UPDATE=false): $intuneAppName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Blocked'; Type = 'Win32App'; AppName = $appName })
                    continue
                }
                $appId = $existing.id

                $pkgTmpDir     = Join-Path $globalTmpDir $appName
                New-Item -ItemType Directory -Path $pkgTmpDir -Force | Out-Null
                $intuneWinPath = New-IntuneWinPackage -InstallPs1Path $installPs1 -UninstallPs1Path $uninstallPs1 -TmpDir $pkgTmpDir
                $metadata      = Get-IntuneWinMetadata -IntuneWinPath $intuneWinPath

                Write-Host "  Updating: $intuneAppName (scripts changed)" -ForegroundColor Yellow
                Invoke-GraphRequest -Method PATCH `
                    -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body $appBody | Out-Null
                Publish-Win32AppContent -AppId $appId -IntuneWinPath $intuneWinPath -Metadata $metadata
                $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Updated'; Type = 'Win32App'; AppName = $appName })

            } elseif ($assignChanged -or $nameChanged -or $iconChanged -or $dependChanged) {
                if (-not $allowUpdate) {
                    Write-Host "  SKIPPED (ALLOW_UPDATE=false): $intuneAppName" -ForegroundColor DarkGray
                    $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Blocked'; Type = 'Win32App'; AppName = $appName })
                    continue
                }
                $appId = $existing.id

                $changes = @()
                if ($nameChanged) { $changes += 'display name' }
                if ($assignChanged) { $changes += 'assignments' }
                if ($iconChanged) { $changes += 'icon' }
                if ($dependChanged) { $changes += 'dependency' }
                Write-Host "  Updating: $intuneAppName ($($changes -join ', ') changed, skipping repackage)" -ForegroundColor Yellow
                $metaBody = @{
                    '@odata.type' = '#microsoft.graph.win32LobApp'
                    notes         = $notesValue
                }
                if ($nameChanged) { $metaBody.displayName = $intuneAppName }
                if ($iconChanged) {
                    $metaBody = Add-Win32AppIconToPatchBody -Body $metaBody -IconPath $iconFilePath
                }
                Invoke-GraphRequest -Method PATCH `
                    -Uri "$GRAPH_BASE/deviceAppManagement/mobileApps/$appId" -Body ($metaBody | ConvertTo-Json -Compress -Depth 6) | Out-Null
                $status = if ($iconChanged -and ($assignChanged -or $nameChanged)) { 'MetadataUpdated' }
                          elseif ($iconChanged) { 'MetadataUpdated' }
                          elseif ($assignChanged -and $nameChanged) { 'MetadataUpdated' }
                          elseif ($assignChanged) { 'AssignmentsUpdated' }
                          else { 'MetadataUpdated' }
                $allResults.Add(@{ DisplayName = $intuneAppName; Status = $status; Type = 'Win32App'; AppName = $appName })

            } else {
                $appId = $existing.id
                Write-Host "  No changes: $intuneAppName" -ForegroundColor DarkGray
                $noChange++
                $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'No changes'; Type = 'Win32App'; AppName = $appName })
            }

            # ── Assignments — sync when the app was created/updated or assignment metadata changed ──
            if (-not $appId) { continue }

            $currentAssignments = @()
            if (-not $WhatIfMode) {
                $currentAssignments = @(Get-AppAssignments -AppId $appId)
            }
            $currentHasAllUsersAvailable = @($currentAssignments | Where-Object {
                $_.targetType -eq 'allLicensedUsers' -and $_.intent -eq 'available'
            }).Count -gt 0
            $configuredGroupCount = @($config.assignments | Where-Object {
                $_.groupName -and [string]$_.groupName.Trim()
            }).Count
            $currentGroupCount = @($currentAssignments | Where-Object { $_.groupId }).Count
            $missingConfiguredAssignments = ($configuredGroupCount -gt 0 -and $currentGroupCount -eq 0) `
                -or ($availableForAllUsers -and -not $currentHasAllUsersAvailable)

            $shouldSyncAssignments = (-not $WhatIfMode) -and (
                -not $existing -or $scriptChanged -or $assignChanged -or $nameChanged -or $missingConfiguredAssignments
            )

            if ($shouldSyncAssignments) {
                if ($missingConfiguredAssignments -and -not $assignChanged) {
                    Write-Host "  Assignments missing in Intune — re-syncing" -ForegroundColor Yellow
                }
                Write-Host "  Syncing assignments..."
                Sync-MobileAppAssignments -GraphBase $GRAPH_BASE -AppId $appId `
                    -InvokeGraph $invokeGraphSb -ResolveGroupId $resolveGroupSb `
                    -ConfigAssignments @($config.assignments) `
                    -AvailableForAllUsers $availableForAllUsers
            }

            if ((-not $WhatIfMode) -and $appId -and $config.printerRole -eq 'connect' -and $dependTarget) {
                $driverApp = Get-ExistingWin32App -DisplayName $dependTarget
                if ($driverApp) {
                    $needsDependSync = (-not $existing) -or $dependChanged -or $scriptChanged
                    if ($needsDependSync) {
                        Write-Host "  Syncing dependency on driver app..."
                        Sync-PrinterAppDependency -ConnectAppId $appId -DriverAppId $driverApp.id
                    }
                } else {
                    Write-Host "  Warning: Driver app '$dependTarget' not found — connect dependency not set" -ForegroundColor Yellow
                }
            }

        } catch {
            Write-Host "##[error]Failed to process app '$appName': $_" -ForegroundColor Red
            $errorCount++
            $allResults.Add(@{ DisplayName = $intuneAppName; Status = 'Failed'; Type = 'Win32App'; AppName = $appName; Error = $_.ToString() })
        }
    }
} finally {
    if ($globalTmpDir -and (Test-Path $globalTmpDir)) {
        Remove-Item $globalTmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# SUMMARY
# ============================================================================

Write-Host "`n##[section]Printer Apps Summary"

if ($WhatIfMode) {
    Write-Host "  WouldCreate : $wouldCreate"
    Write-Host "  WouldUpdate : $wouldUpdate"
    Write-Host "  No changes  : $noChange"
} else {
    $updateStatuses = @('Updated', 'AssignmentsUpdated', 'DetectionUpdated', 'MetadataUpdated')
    $created  = @($allResults | Where-Object { $_.Status -eq 'Created' }).Count
    $updated  = @($allResults | Where-Object { $_.Status -in $updateStatuses }).Count
    $noChange = @($allResults | Where-Object { $_.Status -eq 'No changes' }).Count
    Write-Host "  Created     : $created"
    Write-Host "  Updated     : $updated"
    Write-Host "  No changes  : $noChange"
}
Write-Host "  Errors      : $errorCount"

if ($errorCount -gt 0) {
    $allResults | Where-Object { $_.Status -eq 'Failed' } | ForEach-Object {
        Write-Host "  Failed: $($_.DisplayName) - $($_.Error)" -ForegroundColor Red
    }
}

# ============================================================================
# OUTPUT JSON
# ============================================================================

if ($OutputPath) {
    $summary = @{
        Service          = 'PrinterApps'
        Timestamp        = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        WhatIfMode       = [bool]$WhatIfMode
        WouldCreateCount = $wouldCreate
        WouldUpdateCount = $wouldUpdate
        NoChangeCount    = $noChange
        ErrorCount       = $errorCount
        Results          = @($allResults | ForEach-Object {
            @{
                DisplayName = $_.DisplayName
                PolicyType  = $_.Type
                Status      = $_.Status
                Type        = $_.Type
                Error       = $_.Error
                AppName     = $_.AppName
                Changes     = $_.Changes
                FilePath    = $appNameToFile[$_.DisplayName]
            }
        })
    }
    $summary | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8 -WhatIf:$false
    Write-Host "Plan summary saved to: $OutputPath"
}

if ($errorCount -gt 0) { exit 1 }
