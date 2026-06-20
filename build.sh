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
ZIG_VERSION="$(zig version)"
case "$ZIG_VERSION" in
	0.16.*) ;;
	*)
		echo "Error: Zig 0.16.x is required; found $ZIG_VERSION." >&2
		exit 1
		;;
esac

mkdir -p bin

echo "Building Windows x64 binary..."
rm -f baseline-recital.exe
zig build-exe -O ReleaseSmall -target x86_64-windows-gnu --name baseline-recital src/baseline-recital.zig
mv baseline-recital.exe bin/baseline-recital-windows-x64.exe

echo "Building Linux x64 binary..."
rm -f baseline-recital
zig build-exe -O ReleaseSmall -target x86_64-linux-gnu --name baseline-recital src/baseline-recital.zig
mv baseline-recital bin/baseline-recital-linux-x64

# Drop the debug/object leftovers Zig emits next to the binaries.
rm -f bin/*.pdb bin/*.o bin/*.obj

if command -v sha256sum >/dev/null 2>&1; then
	(cd bin && sha256sum baseline-recital-windows-x64.exe baseline-recital-linux-x64 > SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
	(cd bin && shasum -a 256 baseline-recital-windows-x64.exe baseline-recital-linux-x64 > SHA256SUMS)
else
	echo "Warning: no sha256sum or shasum found; bin/SHA256SUMS was not refreshed." >&2
fi

echo
echo "Built binaries:"
ls -la bin/
