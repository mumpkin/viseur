# Architecture

## Decision

| Option | Verdict |
|---|---|
| 1. GNOME Shell extension | **Chosen.** The only way to draw *inside* the compositor, above fullscreen windows. |
| 2. Extension + configuration app | Rejected: an extension's preferences window (GTK4/libadwaita) already does the job (preview, profiles, shortcuts) and avoids a second process to install, launch and keep in sync. |
| 3. Standalone Wayland window / other tech | Rejected: GNOME offers neither "always on top" nor `wlr-layer-shell`; a normal window goes below a fullscreen one. |

## Components

```
extension/
  extension.js   lifecycle, overlay (St.DrawingArea in the chrome), panel indicator,
                 shortcuts, temporary profile, suspend/resume, target monitor
  prefs.js       preferences window (live preview, settings, profiles, shortcuts, troubleshooting)
  model.js       pure model: defaults, validation/clamping, presets, utilities
  renderer.js    Cairo drawing, shared by the overlay AND the preview (so the preview is accurate)
  profiles.js    atomic read/write of ~/.config/viseur/profiles.json + file watching
  schemas/       GSettings: state, active/default/temporary profile, monitor, shortcuts, right click
  icons/         panel icon
```

Outside the extension bundle (not uploaded to extensions.gnome.org): `scripts/` (install, uninstall,
`viseurctl`), `packaging/` (Arch PKGBUILD), `tests/`, `docs/`.

`model.js` and `renderer.js` import no `gi://` module: they are tested with Node.

## Why the crosshair is visible in fullscreen

The actor is added through `Main.layoutManager.addChrome()` with `trackFullscreen: false`
(so the Shell does not hide it when a window goes fullscreen) and lives in `uiGroup`,
above the `window_group`. It is not a window: no window stacking rule applies to it.

## Input: nothing is intercepted

The actor is `reactive: false` and without `can_focus`, so it never receives input
(GNOME 50 removed the `affectsInputRegion` chrome option, which is therefore not used). Clicks and motion reach the window underneath.
Shortcuts are Mutter *keybindings* (`IGNORE_AUTOREPEAT`) limited to the configured combinations;
no other key is consumed.

## Direct scanout (explicit handling)

In fullscreen, Mutter can send the client's buffer straight to the display (*direct scanout*),
without compositing: lower latency and GPU load. While a window is unredirected this way,
**nothing composited above it is shown** — Shell chrome included. A chrome actor does *not*
automatically force compositing (an early development version assumed it did, and the crosshair
was invisible in every fullscreen scenario).

Consequences and choices:
- Under GNOME Wayland, there is no way to draw a crosshair *on top of* a buffer sent directly
  to the display: visibility therefore means giving up direct scanout while the crosshair is shown.
  This is the trade-off the product accepts (visibility = core requirement).
- Implementation: `CrosshairOverlay` calls `global.compositor.disable_unredirect()` when the crosshair
  becomes visible and `enable_unredirect()` when it is hidden or destroyed. The Mutter API is
  reference-counted, so the calls are kept strictly balanced (one inhibition at most).
- To limit the cost: the actor is **small** (a square fitted to the crosshair, not fullscreen), only
  repaints **on change** (profile, size, position, monitor) and has **no animation or render timer**.
- The real cost (latency, FPS) depends on the driver and the game: it must be **measured**
  (for example with MangoHud). Disabling the crosshair restores direct scanout.

## Temporary profile (hold)

Mutter only notifies the press of a shortcut. Release is therefore detected by polling
`global.get_pointer()` (modifier mask) every 25 ms **only while holding**.
The previous profile is restored as soon as one of the shortcut's modifiers is released, on suspend,
and when the extension is disabled. Right-click option: same mechanism with `RIGHT_BUTTON_MASK`
(= `BUTTON2_MASK`: measured on GNOME 51, the right button does not set `BUTTON3_MASK`),
but polling continuously (~30 Hz) while the option is enabled; disabled by default.

Right-click mode is a single exclusive choice, Off / Hold / Toggle, stored as `rightclick-hold`
(on/off, key name kept for compatibility) + `rightclick-mode` (`hold` | `toggle`). The poll detects
press/release *edges*: in *hold* mode a press starts the temporary profile and the release ends it;
in *toggle* mode each press flips it. Only a temporary profile started by the right button is ended
by it (`_rightClickOwnsHold`), so it never cancels a keyboard hold. Changing the mode, or turning it
off, always restores the previous profile, so the temporary profile cannot get stuck.

## Suspend, lock, monitors

- Lock: visibility tied to `Main.sessionMode.isLocked`.
- Suspend: system D-Bus subscription to `PrepareForSleep` (ends the hold; redisplay 600 ms after resume).
- Monitors: `monitors-changed` recomputes position and size; "monitor of the focused window" mode
  tracked via `notify::focus-window`.

## Cleanup

`disable()` disconnects all signals, removes the keybindings, stops all timers,
destroys the indicator and the actor, and stops watching the profiles file (GNOME extension
review rule).
