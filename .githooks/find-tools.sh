# shellcheck shell=sh
# Sourced by the hooks. Prints the node_modules/.bin holding Biome and tsc: this
# checkout's, or else the main checkout's, since worktrees (whetstone lanes
# among them) don't run npm install.
find_tools() {
  top=$(git rev-parse --show-toplevel) || return 1
  main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  for dir in "$top/node_modules/.bin" "$main/node_modules/.bin"; do
    if [ -x "$dir/biome" ]; then
      echo "$dir"
      return 0
    fi
  done
  echo "Biome not found in $top or $main: run npm ci in $main" >&2
  return 1
}
