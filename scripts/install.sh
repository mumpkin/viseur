#!/usr/bin/env bash
# User installation of the Viseur extension (Arch Linux / GNOME Shell on Wayland).
# Does not require root. Profiles (~/.config/viseur) are never modified.
set -euo pipefail

UUID="viseur@mumpkin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin"

fail() { echo "Error: $*" >&2; exit 1; }

command -v gnome-shell >/dev/null || fail "gnome-shell not found (sudo pacman -S gnome-shell)."
command -v glib-compile-schemas >/dev/null || fail "glib-compile-schemas not found (sudo pacman -S glib2)."
command -v gnome-extensions >/dev/null || fail "gnome-extensions not found (provided by gnome-shell)."

SHELL_MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)"
if ! grep -qE "\"$SHELL_MAJOR\"" "$ROOT/extension/metadata.json"; then
    echo "Warning: GNOME Shell $SHELL_MAJOR is not declared in metadata.json." >&2
    echo "  Declared versions: $(grep -o '"shell-version".*' "$ROOT/extension/metadata.json")" >&2
    echo "  The extension will be installed, but GNOME will refuse to load it until the version" >&2
    echo "  is added AND tested (see README, Recovery section)." >&2
fi

echo "→ Copying to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$ROOT/extension/." "$DEST/"
rm -f "$DEST/schemas/gschemas.compiled"
glib-compile-schemas --strict "$DEST/schemas"

echo "→ Installing viseurctl to $BIN"
mkdir -p "$BIN"
install -m 755 "$ROOT/scripts/viseurctl" "$BIN/viseurctl"

# A newly copied extension is only detected by GNOME Shell (Wayland) at the
# next login.
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" && echo "→ Extension enabled."
    echo "If the crosshair does not show up yet (update of an already loaded version):"
    echo "log out and log back in."
else
    echo
    echo "Extension installed. On Wayland, GNOME Shell only detects it after logging in again:"
    echo "  1. Log out, then log back in."
    echo "  2. Run:  gnome-extensions enable $UUID"
    echo "  3. Settings:  gnome-extensions prefs $UUID"
fi

case ":$PATH:" in
    *":$BIN:"*) ;;
    *) echo "Note: add $BIN to your PATH to use the viseurctl command." ;;
esac
