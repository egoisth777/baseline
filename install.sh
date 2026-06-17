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

# Node runs the installer. Without it we cannot continue.
if ! command -v node >/dev/null 2>&1; then
	echo "Error: Node is required to run the baseline installer, but 'node' was not found on your PATH." >&2
	echo "Install Node (https://nodejs.org) and try again." >&2
	exit 1
fi

# Zig is only needed when building from source. Warn early, but keep going.
if [[ " $* " == *" --build "* ]]; then
	if ! command -v zig >/dev/null 2>&1; then
		echo "Error: Zig was not found, so --build cannot compile from source." >&2
		exit 1
	fi
fi

node "$SCRIPT_DIR/scripts/manage.js" install "$@"

echo
echo "Done. Open /hooks once (or restart Claude Code) so the new settings are picked up."
