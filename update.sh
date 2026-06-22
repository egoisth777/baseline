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

# Pull the latest repo first, if this is a git work tree and git is available.
# Skip the pull when the tree is dirty (a fast-forward over local edits would
# redeploy mixed source). A pull failure is a warning, not fatal.
if command -v git >/dev/null 2>&1 && git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain)" ]; then
		echo "Skipping git pull: working tree has local changes." >&2
	else
		echo "Pulling latest baseline source..."
		git -C "$SCRIPT_DIR" pull --ff-only || echo "Warning: git pull failed (continuing with the current local source)." >&2
	fi
	echo
fi

node "$SCRIPT_DIR/scripts/manage.js" update "$@"

echo
echo "Done. Open /hooks once in each agent (or restart) so the refreshed hook is picked up."
