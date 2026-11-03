#!/usr/bin/env bash
# Uninstalls the Viseur extension.
# By default, profiles (~/.config/viseur) and dconf settings are KEPT.
# --purge option: also deletes profiles and resets settings.
set -euo pipefail

UUID="viseur@mumpkin"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if command -v gnome-extensions >/dev/null; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi

rm -rf "$DEST"
rm -f "$HOME/.local/bin/viseurctl"
echo "→ Extension removed from $DEST"

if [ "$PURGE" -eq 1 ]; then
    rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/viseur"
    command -v dconf >/dev/null && dconf reset -f /org/gnome/shell/extensions/viseur/ || true
    echo "→ Profiles and settings deleted."
else
    echo "→ Profiles kept in ${XDG_CONFIG_HOME:-$HOME/.config}/viseur (--purge to delete them)."
fi
echo "Log out and log back in so GNOME Shell fully forgets the extension."
