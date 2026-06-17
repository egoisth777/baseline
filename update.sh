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
	echo "Error: Node is required to run the baseline updater, but 'node' was not found on your PATH." >&2
	echo "Install Node (https://nodejs.org) and try again." >&2
	exit 1
fi

# Pull the latest repo first, if this is a git checkout and git is available.
# A pull failure (e.g. local edits) is a warning, not fatal.
if command -v git >/dev/null 2>&1 && [ -d "$SCRIPT_DIR/.git" ]; then
	echo "Pulling latest baseline source..."
	git -C "$SCRIPT_DIR" pull --ff-only || echo "Warning: git pull failed (continuing with the current local source)." >&2
	echo
fi

node "$SCRIPT_DIR/scripts/manage.js" update "$@"

echo
echo "Done. Open /hooks once (or restart Claude Code) so the refreshed hook is picked up."
