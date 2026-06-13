#Requires -Version 5.1
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	$Args
)

$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot

# Node runs the installer. Without it we cannot continue.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Write-Error "Node is required to run the baseline installer, but 'node' was not found on your PATH. Install Node (https://nodejs.org) and try again."
	exit 1
}

$manage = Join-Path $root "scripts\manage.js"

& node $manage install @Args
$code = $LASTEXITCODE

if ($code -eq 0) {
	Write-Host ""
	Write-Host "Done. Open /hooks once (or restart Claude Code) so the new settings are picked up."
}

exit $code
