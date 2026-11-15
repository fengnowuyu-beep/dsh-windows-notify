# Parse every PowerShell file in this plugin and report syntax errors.
$files = @(
  'scripts\notify.ps1',
  'test\list-windows.ps1',
  'test\close-windows.ps1',
  'test\list-top-windows.ps1'
)
$root = Split-Path -Parent $PSScriptRoot
if ($PSScriptRoot -eq '') { $root = 'E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify' }
$bad = 0
foreach ($relative in $files) {
  $path = Join-Path $root $relative
  if (-not (Test-Path $path)) { Write-Output "MISSING $relative"; continue }
  $errors = $null
  $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($null -ne $errors -and $errors.Count -gt 0) {
    $bad++
    foreach ($error in $errors) {
      Write-Output ("PARSE ERROR {0}:{1} {2}" -f $relative, $error.Extent.StartLineNumber, $error.Message)
    }
  } else {
    Write-Output "ok  $relative"
  }
}
Write-Output ("files with errors: " + $bad)
