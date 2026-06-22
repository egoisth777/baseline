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

# Pull the latest repo first, if this is a git work tree and git is available.
# Skip the pull when the tree is dirty (a fast-forward over local edits would
# redeploy mixed source). A pull failure is a warning, not fatal — we still
# redeploy whatever is on disk so the deployed hook tracks the current source.
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
	& git -C $root rev-parse --is-inside-work-tree *> $null
	if ($LASTEXITCODE -eq 0) {
		if (& git -C $root status --porcelain) {
			Write-Warning "Skipping git pull: working tree has local changes."
		} else {
			Write-Host "Pulling latest baseline source..."
			& git -C $root pull --ff-only
			if ($LASTEXITCODE -ne 0) {
				Write-Warning "git pull failed (continuing with the current local source)."
			}
		}
		Write-Host ""
	}
}

$manage = Join-Path $root "scripts\manage.js"
$forwardArgs = @()
if ($RemainingArgs) { $forwardArgs += $RemainingArgs }

& node $manage update @forwardArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
	Write-Host ""
	Write-Host "Done. Open /hooks once in each agent (or restart) so the refreshed hook is picked up."
}

exit $code
