#!/bin/sh
# Copy the pane into Herdr. A copy, not a symlink: Herdr doesn't load a
# mod's icons through a symlinked folder. Rerun after editing mods/whetstone.
set -e
src="$(cd "$(dirname "$0")/.." && pwd)/mods/whetstone"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/whetstone"
if [ -L "$dest" ]; then rm "$dest"; fi
mkdir -p "$dest"
rsync -a --delete --exclude 'gpui-kit.d.ts' --exclude 'herdr.d.ts' --exclude 'jsconfig.json' "$src/" "$dest/"
herdr-app check "$dest"
