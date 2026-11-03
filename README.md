# Viseur

Customizable crosshair overlay for GNOME Shell that stays visible above **fullscreen games and videos**
on Wayland.

- Cross, dot and circle shapes (combinable): arm length, thickness, gap, dot size, circle radius
- Color, opacity, outline, fine offset, target monitor
- Multiple profiles with a live preview, 5 editable presets
- Keyboard shortcuts: show/hide, next/previous profile, profiles #1–#4
- Temporary profile while a shortcut or the **right mouse button** is held, or toggled by a right click
- Panel menu to switch profiles and the right-click mode, plus a `viseurctl` command-line helper

Supported: **GNOME Shell 50 and 51**, Wayland session.

## Installation

### From extensions.gnome.org

Install **Viseur** from [extensions.gnome.org](https://extensions.gnome.org) or with the *Extension Manager*
app, then open its settings.

### From source

```bash
git clone https://github.com/mumpkin/viseur.git
cd viseur
./scripts/install.sh
```

On Wayland, GNOME Shell only detects a newly installed extension **after logging in again**:
log out, log back in, then:

```bash
gnome-extensions enable viseur@mumpkin
gnome-extensions prefs  viseur@mumpkin       # settings
```

`install.sh` also installs `viseurctl` to `~/.local/bin`.
Arch Linux users can build a system package instead: `cd packaging && makepkg -si`.

## Usage

| Action | Default |
|---|---|
| Show / hide | `Ctrl+Alt+C` or panel icon |
| Next / previous profile | `Ctrl+Alt+→` / `Ctrl+Alt+←` |
| Profiles #1 to #4 in the list | `Ctrl+Alt+1` … `Ctrl+Alt+4` |
| Temporary profile (hold) | `Ctrl+Alt+X`: active as long as Ctrl **and** Alt stay pressed |
| Right click | **Off** by default. Panel menu → *Right click* → **Off / Hold / Toggle** (also in the *Profiles* tab). *Hold*: temporary profile while the button is held. *Toggle*: one click shows it, the next click goes back. |

All shortcuts can be changed in the *Shortcuts* tab. GNOME only reports the *press* of a shortcut,
not its release, so the hold shortcut detects the release through its modifier keys
(Ctrl, Alt, Shift, Super); a shortcut without a modifier works as a toggle.

Command-line helper, also usable from a custom GNOME keyboard shortcut:

```bash
viseurctl toggle | on | off | status | list | profile <id|next|prev>
```

## Data

- Profiles: `~/.config/viseur/profiles.json` (human-readable JSON, `version: 1`). Kept across updates,
  reinstalls and uninstalls (unless `--purge`). A corrupted file is copied to `profiles.json.bak`
  and the presets are restored.
- Settings (state, shortcuts, target monitor, default/temporary profile, right-click mode): GSettings,
  path `/org/gnome/shell/extensions/viseur/`.

### `profiles.json` format

```json
{ "version": 1,
  "profiles": [ {
    "id": "default", "name": "Green cross",
    "cross":   { "enabled": true,  "length": 6, "thickness": 2, "gap": 3 },
    "dot":     { "enabled": false, "size": 3 },
    "circle":  { "enabled": false, "radius": 12, "thickness": 2 },
    "color": "#00ff00", "opacity": 1,
    "outline": { "enabled": true, "color": "#000000", "thickness": 1 },
    "offsetX": 0, "offsetY": 0 } ] }
```
Out-of-range values are clamped when read; the extension reloads the file automatically when it changes.

## How it works

The crosshair is a small, non-reactive Shell actor added to the layout "chrome", so it is composited
above every window, fullscreen included, and never receives input. Details: `docs/ARCHITECTURE.md`.

## Known limitations

1. **Direct scanout.** To be drawn above a fullscreen window, the crosshair disables Mutter's
   *direct scanout* while it is shown. This can slightly increase latency and GPU load, depending on
   driver and game. Hiding the crosshair (`Ctrl+Alt+C`, `viseurctl off`) restores direct scanout.
2. **Games that grab the keyboard** (XWayland with a grab, or Wayland *shortcuts-inhibit*):
   GNOME no longer receives the shortcuts. Use the panel icon or `viseurctl`.
3. **Right click** reads the pointer state ~30 times/s while enabled; it never intercepts clicks.
   The right button is detected through `BUTTON2_MASK`, as measured on GNOME 51.
4. **Fractional scaling**: sizes are in logical pixels; a 1 px line may look slightly blurred.
5. The crosshair is hidden on the lock screen and in the overview.
6. No guarantee of visibility with exclusive video outputs or hardware overlays outside the compositor.

## Troubleshooting

- Crosshair in the way: panel icon → *Show crosshair* off, `viseurctl off`, or
  `gsettings set org.gnome.shell.extensions.viseur enabled false`.
- Shell unstable: from a TTY (`Ctrl+Alt+F3`), `gnome-extensions disable viseur@mumpkin`.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i viseur`.
- Bugs and requests: <https://github.com/mumpkin/viseur/issues>.

## Uninstall

```bash
./scripts/uninstall.sh            # keeps your profiles
./scripts/uninstall.sh --purge    # also deletes profiles and settings
```

## Development

```bash
make test        # Node tests: model, rendering, schema/code/scripts consistency
make install     # = ./scripts/install.sh
make zip         # bundle for extensions.gnome.org → dist/viseur@mumpkin.shell-extension.zip
```

Publishing steps: `docs/PUBLISHING.md`. Changes: `CHANGELOG.md`.

## License

GPL-3.0-or-later, see `LICENSE`.
