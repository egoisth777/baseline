#Requires -Version 5.1
param(
	[switch]$fix,
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot

# Node runs the manager. Without it we cannot continue.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Write-Error "Node is required to run the baseline doctor, but 'node' was not found on your PATH. Install Node (https://nodejs.org) and try again."
	exit 1
}

$manage = Join-Path $root "scripts\manage.js"
$forwardArgs = @()
if ($fix) { $forwardArgs += "--fix" }
if ($RemainingArgs) { $forwardArgs += $RemainingArgs }

& node $manage doctor @forwardArgs
exit $LASTEXITCODE
