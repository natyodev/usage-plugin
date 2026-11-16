#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dist="$repo/dist"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
share="$data/usage-plugin"
fonts="$data/fonts"
bin_dir="$HOME/.local/bin"
config="${XDG_CONFIG_HOME:-$HOME/.config}/usage-plugin/config.jsonc"

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

changed=0
place() {
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2.new" && chmod "$3" "$2.new" && mv -f "$2.new" "$2"
    changed=1
  fi
}

place "$dist/usage-plugin" "$share/usage-plugin" 755
place "$dist/widget.js" "$share/widget.js" 644
hover=no
if [ -f "$dist/usage-plugin-cffi.so" ]; then
  place "$dist/usage-plugin-cffi.so" "$share/usage-plugin-cffi.so" 755
  hover=yes
else
  warn "the hover module was not built: it needs gcc, pkg-config and the gtk3 and json-glib headers. The click-only module below works without it."
fi
if [ "$(readlink "$bin_dir/usage-plugin" 2>/dev/null)" != "$share/usage-plugin" ]; then
  mkdir -p "$bin_dir"
  ln -sfn "$share/usage-plugin" "$bin_dir/usage-plugin"
fi

bin_changed=$changed
changed=0
place "$dist/usage-plugin-icons.ttf" "$fonts/usage-plugin-icons.ttf" 644
if [ "$changed" = 1 ]; then
  if command -v fc-cache >/dev/null 2>&1; then fc-cache -f "$fonts" >/dev/null 2>&1 || warn "fc-cache failed. Run fc-cache -f $fonts"
  else warn "fc-cache is missing, so the logo font may not show until fontconfig rescans $fonts"; fi
fi
version=$("$share/usage-plugin" --version)
if [ "$bin_changed" = 1 ] || [ "$changed" = 1 ]; then say "Installed usage-plugin $version to $share"
else say "usage-plugin $version is already installed in $share"; fi

command -v gjs >/dev/null 2>&1 || warn "gjs is missing, so the module cannot open the widget. Install gjs and gtk4. The module works without it."
has_layer_shell() {
  ldconfig -p 2>/dev/null | grep -q 'libgtk4-layer-shell\.so\.0' && return 0
  for dir in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu /usr/local/lib; do
    [ -e "$dir/libgtk4-layer-shell.so.0" ] && return 0
  done
  return 1
}
has_layer_shell || warn "gtk4-layer-shell is missing, so the widget cannot open beside the bar. Install gtk4-layer-shell. The module works without it."

source=auto
if [ -f "$config" ]; then
  named=$(sed 's|//.*||' "$config" | grep -o '"source"[[:space:]]*:[[:space:]]*"[a-z0-9]*"' | grep -o '"[a-z0-9]*"$' | tr -d '"' || true)
  [ -n "$named" ] && source=$named
fi
t3=no
{ command -v t3 >/dev/null 2>&1 || [ -x "$HOME/.local/bin/t3" ] || [ -d "$HOME/.t3/userdata" ]; } && t3=yes
logins=""
[ -f "$HOME/.claude/.credentials.json" ] && logins="$logins claude"
[ -f "$HOME/.grok/auth.json" ] && logins="$logins grok"
logins=${logins# }

say ""
case "$source:$t3" in
  auto:yes) say "Readings: from T3 Code (source auto). While T3 Code is closed, providers fall back to CLI logins: ${logins:-none found}." ;;
  auto:no) say "Readings: from CLI logins (source auto, no T3 Code found): ${logins:-none found yet, run claude or grok to sign in}." ;;
  t3:yes) say "Readings: from T3 Code only (source t3). Open T3 Code to see them." ;;
  t3:no) warn "source is t3 but no T3 Code was found, so the module will wait for it" ;;
  direct:*) say "Readings: from CLI logins only (source direct): ${logins:-none found yet, run claude or grok to sign in}." ;;
  *) warn "source \"$source\" in $config is not auto, t3 or direct, so the module uses auto" ;;
esac

exe="$bin_dir/usage-plugin"
say ""
say "Add one block to your Waybar config, put its name in a modules list, and reload Waybar with:"
say "  pkill -SIGUSR2 waybar"
if [ "$hover" = yes ]; then
  cat <<EOF

Hover opens the widget, a click pins it. Use "stacked" on a vertical bar, "inline" on a horizontal one:

  "cffi/usage": {
    "module_path": "$share/usage-plugin-cffi.so",
    "exec": "$exe",
    "layout": "stacked",
    "interval": 30,
    "tooltip": false
  },

Style it in your Waybar style.css:

  #cffi-usage { min-width: 42px; margin: 3px 7px; padding: 7px 0; }
EOF
else
  cat <<EOF

A click opens the widget. Use "--layout stacked" on a vertical bar, "--layout inline" on a horizontal one:

  "custom/usage": {
    "exec": "$exe module --layout stacked",
    "return-type": "json",
    "interval": 30,
    "justify": "center",
    "tooltip": true,
    "on-click": "$exe widget --toggle"
  },

Style it in your Waybar style.css:

  #custom-usage { min-width: 42px; margin: 3px 7px; padding: 7px 0; }
EOF
fi
say ""
say "More examples: $repo/examples"
