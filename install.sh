#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dist="$repo/dist"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

bun=$(command -v bun || true)
[ -z "$bun" ] && [ -x "$HOME/.bun/bin/bun" ] && bun="$HOME/.bun/bin/bun"

stale() {
  [ -f "$dist/usage-plugin" ] && [ -f "$dist/widget.js" ] && [ -f "$dist/usage-plugin-icons.ttf" ] || return 0
  [ -d "$repo/src" ] || return 1
  [ -n "$(find "$repo/src" "$repo/widget" "$repo/cffi" "$repo/assets" "$repo/scripts" "$repo/package.json" "$repo/bun.lock" \
    -newer "$dist/usage-plugin" -print 2>/dev/null | head -n 1)" ]
}

if stale; then
  if [ -n "$bun" ]; then
    say "Building with $bun"
    (cd "$repo" && "$bun" install --frozen-lockfile >/dev/null)
    (cd "$repo" && "$bun" run build >/dev/null 2>&1) || true
    [ -f "$dist/usage-plugin" ] && [ -f "$dist/widget.js" ] && [ -f "$dist/usage-plugin-icons.ttf" ] || {
      say "error: the build failed. Run $bun run build in $repo to see why." >&2
      exit 1
    }
  elif [ -f "$dist/usage-plugin" ]; then
    warn "dist/ is older than the source and Bun is not installed, so the old build is installed"
  else
    say "error: there is no build in dist/ and Bun is not installed. Install Bun from https://bun.sh and run this again." >&2
    exit 1
  fi
fi

js=$(command -v node || printf '%s' "$bun")
[ -n "$js" ] || {
  say "error: installing needs Node.js or Bun. Install Bun from https://bun.sh and run this again." >&2
  exit 1
}
exec "$js" "$repo/npm/usage-plugin/bin/usage-plugin.js" install --from "$dist"
