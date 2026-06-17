#Requires -Version 5.1
param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot

# Node runs the manager. Without it we cannot continue.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
	Write-Error "Node is required to run the baseline updater, but 'node' was not found on your PATH. Install Node (https://nodejs.org) and try again."
	exit 1
}

# Pull the latest repo first, if this is a git checkout and git is available.
# A pull failure (e.g. local edits) is a warning, not fatal — we still redeploy
# whatever is on disk so the deployed hook tracks the current source.
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git -and (Test-Path (Join-Path $root ".git"))) {
	Write-Host "Pulling latest baseline source..."
	& git -C $root pull --ff-only
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "git pull failed (continuing with the current local source)."
	}
	Write-Host ""
}

$manage = Join-Path $root "scripts\manage.js"
$forwardArgs = @()
if ($RemainingArgs) { $forwardArgs += $RemainingArgs }

& node $manage update @forwardArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
	Write-Host ""
	Write-Host "Done. Open /hooks once (or restart Claude Code) so the refreshed hook is picked up."
}

exit $code
