# Publishing on extensions.gnome.org

Reference: [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html),
[extension anatomy](https://gjs.guide/extensions/overview/anatomy.html).

## 1. Push the repository

```bash
git remote add origin git@github.com:mumpkin/viseur.git
git push -u origin main
git push origin v1.0
```

`metadata.json` points to `https://github.com/mumpkin/viseur`: the repository must exist and be public,
reviewers and users follow that link to report issues.

## 2. Build the bundle

```bash
make zip        # runs the tests, then writes dist/viseur@mumpkin.shell-extension.zip
unzip -l dist/viseur@mumpkin.shell-extension.zip
```

The bundle only contains what the extension needs at runtime: `metadata.json`, `extension.js`,
`prefs.js`, `model.js`, `renderer.js`, `profiles.js`, `icons/`, `schemas/*.gschema.xml`.
No compiled schema (GNOME 45+ compiles it on install), no scripts, tests or docs.

## 3. Test the exact bundle you will upload

```bash
gnome-extensions install --force dist/viseur@mumpkin.shell-extension.zip
# log out, log back in
gnome-extensions enable viseur@mumpkin
```

Quick check: crosshair visible in a fullscreen game, panel menu, preferences, right click.
Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i viseur` (must stay clean).

## 4. Upload

1. Create an account / log in on <https://extensions.gnome.org> (top right).
2. Open <https://extensions.gnome.org/upload/>.
3. Select `dist/viseur@mumpkin.shell-extension.zip`, tick the checkbox accepting distribution under
   GPL-2.0-or-later compatible terms (the project is GPL-3.0-or-later), submit.
4. The extension shows as *Unreviewed*. Review takes from a few days to a few weeks; reviewers answer
   on the review page (`https://extensions.gnome.org/review/<id>`) and by e-mail.
5. Once approved, add a screenshot (a fullscreen game with the crosshair, or the preferences window)
   from the extension page, while logged in.

## 5. Points reviewers may ask about (answers ready)

| Topic | Answer |
|---|---|
| `global.compositor.disable_unredirect()` | Required: while a fullscreen window is unredirected, nothing composited above it is shown. Called only while the crosshair is visible, released when it is hidden and in `disable()`; calls are kept balanced (`_setUnredirect`). |
| GLib timeouts | Right-click poll (30 ms) only while the right-click option is enabled; hold poll (25 ms) only during a keyboard hold; one 600 ms timeout after resume. All tracked in `_timeouts` and removed in `disable()`. |
| `Main.layoutManager.addChrome` | Non-reactive actor, `trackFullscreen: false`, removed in `disable()`. |
| Profiles file | `~/.config/viseur/profiles.json`, read/written by the extension and prefs; the file monitor is cancelled in `disable()`. |
| `viseurctl`, install scripts | Not part of the bundle; the extension never spawns a process. |
| Session modes | Only `user` mode: the crosshair is hidden on the lock screen. |

Reviewers also reject code that looks machine-generated and that the author cannot explain: read
through `extension.js` and `prefs.js` before submitting so you can answer questions on any part.

## 6. Releasing an update

1. Change the code, update `CHANGELOG.md`.
2. Bump `version-name` in `extension/metadata.json` (e.g. `1.1`). Never add a `version` key:
   extensions.gnome.org sets it.
3. When a new GNOME version is out and tested, add it to `shell-version` (stable releases only).
4. `make zip`, test the bundle, upload it on <https://extensions.gnome.org/upload/>, tag the release
   (`git tag v1.1`) and push.
