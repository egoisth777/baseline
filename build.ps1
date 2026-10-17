#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot
Set-Location $root

& node tools/generate-contracts.js
if ($LASTEXITCODE -ne 0) { throw "Contract generation failed (node exited $LASTEXITCODE)." }
& node tools/generate-contracts.js --check
if ($LASTEXITCODE -ne 0) { throw "Generated contract drift check failed (node exited $LASTEXITCODE)." }

# Zig does the cross-compiling. Without it we cannot build.
$zig = Get-Command zig -ErrorAction SilentlyContinue
if (-not $zig) {
	Write-Error "Zig is required to build the recital binaries, but 'zig' was not found on your PATH. Install Zig (https://ziglang.org/download) and try again."
	exit 1
}
$zigVersion = (& zig version).Trim()
if ($zigVersion -notmatch '^0\.16\.') {
	Write-Error "Zig 0.16.x is required; found $zigVersion."
	exit 1
}

Write-Host "Testing native modules..."
& zig test src/native/test.zig
if ($LASTEXITCODE -ne 0) { throw "Native module tests failed (zig exited $LASTEXITCODE)." }

if (-not (Test-Path "bin")) {
	New-Item -ItemType Directory -Path "bin" | Out-Null
}

Write-Host "Building Windows x64 binary..."
Remove-Item -LiteralPath "baseline-recital.exe" -Force -ErrorAction SilentlyContinue
& zig build-exe -O ReleaseSmall -target x86_64-windows-gnu --name baseline-recital src/baseline-recital.zig
if ($LASTEXITCODE -ne 0) { throw "Windows build failed (zig exited $LASTEXITCODE)." }
Move-Item -LiteralPath "baseline-recital.exe" -Destination "bin\baseline-recital-windows-x64.exe" -Force

Write-Host "Building Linux x64 binary..."
Remove-Item -LiteralPath "baseline-recital" -Force -ErrorAction SilentlyContinue
& zig build-exe -O ReleaseSmall -target x86_64-linux-gnu --name baseline-recital src/baseline-recital.zig
if ($LASTEXITCODE -ne 0) { throw "Linux build failed (zig exited $LASTEXITCODE)." }
Move-Item -LiteralPath "baseline-recital" -Destination "bin\baseline-recital-linux-x64" -Force

# Drop the debug/object leftovers Zig emits next to the binaries.
Remove-Item -Path "bin\*.pdb", "bin\*.o", "bin\*.obj" -Force -ErrorAction SilentlyContinue

function Get-Sha256([string]$Path) {
	$hashCommand = Get-Command Get-FileHash -ErrorAction SilentlyContinue
	if ($hashCommand) {
		return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
	}

	$certutil = Get-Command certutil -ErrorAction SilentlyContinue
	if ($certutil) {
		$output = & $certutil.Source -hashfile $Path SHA256
		if ($LASTEXITCODE -eq 0) {
			$hash = $output |
				ForEach-Object { $_ -replace '\s', '' } |
				Where-Object { $_ -match '^[0-9A-Fa-f]{64}$' } |
				Select-Object -First 1
			if ($hash) { return $hash.ToLowerInvariant() }
		}
	}
	return $null
}

$hashPaths = @(
	"bin\baseline-recital-windows-x64.exe"
	"bin\baseline-recital-linux-x64"
)
$hashes = @()
foreach ($path in $hashPaths) {
	$hash = Get-Sha256 $path
	if (-not $hash) {
		Write-Warning "No working Get-FileHash or certutil found; bin\SHA256SUMS was not refreshed."
		$hashes = @()
		break
	}
	$hashes += "$hash  $(Split-Path -Leaf $path)"
}
if ($hashes.Count -eq $hashPaths.Count) {
	# Join with LF (not CRLF) so `sha256sum -c` works on POSIX consumers.
	[System.IO.File]::WriteAllText("$root\bin\SHA256SUMS", ($hashes -join "`n") + "`n", (New-Object System.Text.ASCIIEncoding))
}

Write-Host ""
Write-Host "Built binaries:"
Get-ChildItem bin\ | Select-Object Mode, Length, LastWriteTime, Name | Format-Table -AutoSize
