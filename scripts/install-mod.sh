#!/bin/sh
# Copy the pane into Herdr. A copy, not a symlink: Herdr doesn't load a
# mod's icons through a symlinked folder. Rerun after editing mods/whetstone.
set -e
src="$(cd "$(dirname "$0")/.." && pwd)/mods/whetstone"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/whetstone"
if [ -L "$dest" ]; then rm "$dest"; fi
mkdir -p "$dest"
rsync -a --delete --exclude 'gpui-kit.d.ts' --exclude 'herdr.d.ts' --exclude 'jsconfig.json' "$src/" "$dest/"
# Herdr runs commands without a login shell's PATH, so record where node and
# the CLI are; the pane runs "$node $cli <command>".
node_bin="$(command -v node)"
cli="$(cd "$(dirname "$0")/.." && pwd)/engine/cli.mjs"
printf '{ "node": "%s", "cli": "%s" }\n' "$node_bin" "$cli" > "$dest/cli.json"
herdr-app check "$dest"
