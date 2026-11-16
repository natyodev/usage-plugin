#!/bin/sh
# Installs the packed npm tarballs into a throwaway prefix and HOME, then checks that install places
# every file, that a second install changes nothing, and that uninstall removes it all again.
# usage: scripts/smoke-npm.sh <dir with usage-plugin-*.tgz> [npm|bun]
set -eu

packs=$(CDPATH= cd -- "$1" && pwd)
manager=${2:-npm}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

home="$work/home"
data="$home/.local/share"
mkdir -p "$home" "$work/prefix"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

set -- "$packs"/usage-plugin-*.tgz
case "$manager" in
  npm) npm install --silent --no-audit --no-fund --cache "$work/cache" --prefix "$work/prefix" "$@" ;;
  bun) (cd "$work/prefix" && printf '{}' > package.json && BUN_INSTALL_CACHE_DIR="$work/cache" bun add --silent "$@") ;;
  *) fail "unknown package manager $manager" ;;
esac
cli="$work/prefix/node_modules/.bin/usage-plugin"

run() { HOME="$home" XDG_DATA_HOME="$data" XDG_CONFIG_HOME="$home/.config" "$cli" "$@"; }
# fc-cache on some distros writes a .uuid into the fonts folder. It is fontconfig's, not ours.
snapshot() { find "$home/.local" \( -type f -o -type l \) ! -name .uuid -printf '%p %m %T@ %l\n' 2>/dev/null | sort; }

run install > "$work/first.txt"
grep -q '^Installed usage-plugin ' "$work/first.txt" || fail "first install did not install: $(cat "$work/first.txt")"
grep -q '"module_path": "'"$data"'/usage-plugin/usage-plugin-cffi.so"' "$work/first.txt" || fail "the snippet has no hover module"
for file in usage-plugin/usage-plugin usage-plugin/usage-plugin-cffi.so; do
  [ -x "$data/$file" ] || fail "$file is not an executable file"
done
for file in usage-plugin/widget.js fonts/usage-plugin-icons.ttf; do
  [ -f "$data/$file" ] || fail "$file is missing"
done
[ "$(readlink "$home/.local/bin/usage-plugin")" = "$data/usage-plugin/usage-plugin" ] || fail "the command link is wrong"

before=$(snapshot)
run install > "$work/second.txt"
grep -q ' is already installed in ' "$work/second.txt" || fail "second install reported a change: $(head -n 1 "$work/second.txt")"
[ "$(snapshot)" = "$before" ] || fail "second install touched files"

expected=$(tar -xzOf "$packs"/usage-plugin-[0-9]*.tgz package/package.json | sed -n 's/^ *"version": "\(.*\)",$/\1/p')
[ "$(run --version)" = "$expected" ] || fail "--version through the CLI is not $expected"

run uninstall > "$work/uninstall.txt"
[ -z "$(snapshot)" ] || fail "uninstall left: $(snapshot)"
[ ! -e "$data/usage-plugin" ] || fail "uninstall left the share folder"

printf 'ok: %s install, reinstall and uninstall of usage-plugin %s\n' "$manager" "$expected"
