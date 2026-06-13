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

if (-not (Test-Path "bin")) {
	New-Item -ItemType Directory -Path "bin" | Out-Null
}

Write-Host "Building Windows x64 binary..."
& zig build-exe scripts/baseline-recital.zig -O ReleaseSmall -target x86_64-windows -femit-bin=bin/baseline-recital-windows-x64.exe
if ($LASTEXITCODE -ne 0) { throw "Windows build failed (zig exited $LASTEXITCODE)." }

Write-Host "Building Linux x64 binary..."
& zig build-exe scripts/baseline-recital.zig -O ReleaseSmall -target x86_64-linux-gnu -femit-bin=bin/baseline-recital-linux-x64
if ($LASTEXITCODE -ne 0) { throw "Linux build failed (zig exited $LASTEXITCODE)." }

# Drop the debug/object leftovers Zig emits next to the binaries.
Remove-Item -Path "bin\*.pdb", "bin\*.o", "bin\*.obj" -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Built binaries:"
Get-ChildItem bin\ | Select-Object Mode, Length, LastWriteTime, Name | Format-Table -AutoSize
