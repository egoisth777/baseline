#!/usr/bin/env bash
set -euo pipefail

# Resolve this script's own directory, following symlinks.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
	DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
	SOURCE="$(readlink "$SOURCE")"
	[[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# Zig does the cross-compiling. Without it we cannot build.
if ! command -v zig >/dev/null 2>&1; then
	echo "Error: Zig is required to build the recital binaries, but 'zig' was not found on your PATH." >&2
	echo "Install Zig (https://ziglang.org/download) and try again." >&2
	exit 1
fi

mkdir -p bin

echo "Building Windows x64 binary..."
zig build-exe scripts/baseline-recital.zig -O ReleaseSmall -target x86_64-windows -femit-bin=bin/baseline-recital-windows-x64.exe

echo "Building Linux x64 binary..."
zig build-exe scripts/baseline-recital.zig -O ReleaseSmall -target x86_64-linux-gnu -femit-bin=bin/baseline-recital-linux-x64

# Drop the debug/object leftovers Zig emits next to the binaries.
rm -f bin/*.pdb bin/*.o bin/*.obj

echo
echo "Built binaries:"
ls -la bin/
