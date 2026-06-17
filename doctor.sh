#!/usr/bin/env bash
set -euo pipefail

# Resolve this script's own directory, following symlinks (Linux + macOS).
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
	DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
	SOURCE="$(readlink "$SOURCE")"
	[[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

# Node runs the manager. Without it we cannot continue.
if ! command -v node >/dev/null 2>&1; then
	echo "Error: Node is required to run the baseline doctor, but 'node' was not found on your PATH." >&2
	echo "Install Node (https://nodejs.org) and try again." >&2
	exit 1
fi

# Forwards flags (e.g. --fix) straight through to the manager.
node "$SCRIPT_DIR/scripts/manage.js" doctor "$@"
