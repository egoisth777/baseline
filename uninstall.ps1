#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot

# Node runs the manager. Without it we cannot continue.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Write-Error "Node is required to run the baseline uninstaller, but 'node' was not found on your PATH. Install Node (https://nodejs.org) and try again."
	exit 1
}

$manage = Join-Path $root "scripts\manage.js"
& node $manage uninstall
$code = $LASTEXITCODE

if ($code -eq 0) {
	Write-Host ""
	Write-Host "Done. Open /hooks once (or restart Claude Code) so the removed hook is picked up."
}

exit $code
