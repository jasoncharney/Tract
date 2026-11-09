#!/usr/bin/env bash
#
# set-icon.command — give tract and Tract.command the Tract icon.
#
# Double-click me once. macOS keeps a custom icon in the file's own metadata,
# so it sticks until the file is replaced — which is what happens when git
# rewrites one of these, so run it again after a pull that changes them.
#
# The icon itself is art/Tract.icns: the stage's own tract drawing, of a real
# vowel the synth made, drawn by the visualiser's own code.

set -uo pipefail
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"
ICON="$ROOT/art/Tract.icns"

[ -f "$ICON" ] || { echo "set-icon: no $ICON" >&2; exit 1; }

set_icon() {
  # NSWorkspace is the supported way in, and AppleScript-ObjC reaches it
  # without Xcode's command-line tools installed.
  osascript - "$ICON" "$1" <<'SCPT'
use framework "Foundation"
use framework "AppKit"
use scripting additions
on run argv
	set img to current application's NSImage's alloc()'s initWithContentsOfFile:(item 1 of argv)
	if img is missing value then error "could not read the icon"
	set ok to current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:(item 2 of argv) options:0
	return ok as text
end run
SCPT
}

for f in Tract.command tract; do
  if [ ! -e "$ROOT/$f" ]; then
    echo "  skipped $f -- not here"
    continue
  fi
  out="$(set_icon "$ROOT/$f" 2>&1)"
  if [ "$out" = "true" ]; then
    echo "  icon set on $f"
  else
    echo "  could not set the icon on $f: $out" >&2
  fi
done

# The Finder caches what it has already drawn. Touching the folder is usually
# enough; if an old icon is still there, close the window and open it again.
touch "$ROOT" 2>/dev/null
echo
echo "Done. If the old icon is still showing, close the Finder window and"
echo "open it again."
