$e=$null
$null=[System.Management.Automation.Language.Parser]::ParseFile("/tmp/cih.ps1",[ref]$null,[ref]$e)
if($e.Count -gt 0){ $e | ForEach-Object { Write-Host "L$($_.Extent.StartLineNumber): $($_.Message)" } } else { Write-Host "OK Common-IgnoreHelpers.ps1" }

# Also check if the file has CmdletBinding at top level
$lines = Get-Content "/tmp/cih.ps1" -TotalCount 30
Write-Host "`nFirst 30 lines:"
$lines | ForEach-Object { Write-Host $_ }
