#Requires -Version 5.1
$ErrorActionPreference = "Stop"

# This script's own directory.
$root = $PSScriptRoot
Set-Location $root

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

$hashes = @(
	Get-FileHash -Algorithm SHA256 -Path "bin\baseline-recital-windows-x64.exe"
	Get-FileHash -Algorithm SHA256 -Path "bin\baseline-recital-linux-x64"
) | ForEach-Object {
	"$($_.Hash.ToLower())  $(Split-Path -Leaf $_.Path)"
}
# Join with LF (not CRLF) so `sha256sum -c` works on POSIX consumers.
[System.IO.File]::WriteAllText("$root\bin\SHA256SUMS", ($hashes -join "`n") + "`n", (New-Object System.Text.ASCIIEncoding))

Write-Host ""
Write-Host "Built binaries:"
Get-ChildItem bin\ | Select-Object Mode, Length, LastWriteTime, Name | Format-Table -AutoSize
