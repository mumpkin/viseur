// SPDX-License-Identifier: GPL-3.0-or-later
//
// Viseur: crosshair overlay for GNOME Shell (Wayland).
//
// The crosshair is a Shell actor (St.DrawingArea) placed in the LayoutManager
// "chrome": Mutter composites it above every window, fullscreen included,
// without it being a Wayland window. It is neither reactive nor part of the
// input region: clicks and keyboard input reach the game.
//
// "Private" Shell APIs used (not guaranteed stable across versions):
//   Main.layoutManager.addChrome / removeChrome, Main.wm.addKeybinding,
//   Main.panel.addToStatusArea, Main.sessionMode, Main.overview,
//   global.compositor.disable_unredirect / enable_unredirect.
// They are all confined to this file.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {acceleratorModifiers, cycleProfileId, extentOf} from './model.js';
import {drawCrosshair} from './renderer.js';
import {ProfileStore} from './profiles.js';

const POLL_HOLD_MS = 25;
const POLL_RIGHTCLICK_MS = 30;
const RESUME_REFRESH_MS = 600;

// Mask reported by global.get_pointer() while the RIGHT mouse button is held.
// Measured on GNOME 51 / Wayland: the right button sets BUTTON2_MASK (0x200), not
// BUTTON3_MASK (0x400), on the desktop and in games alike (left = BUTTON1_MASK, 0x100).
const RIGHT_BUTTON_MASK = Clutter.ModifierType.BUTTON2_MASK;

/** Drawing actor: only repaints when update() is called (never in a loop). */
class CrosshairOverlay {
    constructor() {
        this._profile = null;
        this._unredirectInhibited = false;
        this._actor = new St.DrawingArea({
            name: 'viseur-overlay',
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,
        });
        this._repaintId = this._actor.connect('repaint', () => this._paint());

        // trackFullscreen: false → the actor stays visible when a window goes fullscreen.
        // The actor is not reactive, so it never receives input.
        Main.layoutManager.addChrome(this._actor, {affectsStruts: false, trackFullscreen: false});
    }

    _paint() {
        if (!this._profile)
            return;
        const cr = this._actor.get_context();
        try {
            const [w, h] = this._actor.get_surface_size();
            drawCrosshair(cr, this._profile, w / 2, h / 2);
        } finally {
            cr.$dispose();
        }
    }

    update(profile, monitorIndex, visible) {
        const mon = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        if (!profile || !mon) {
            this._actor.hide();
            this._setUnredirect(true);
            return;
        }
        this._profile = profile;
        const ext = extentOf(profile);
        this._actor.set_size(ext * 2, ext * 2);
        this._actor.set_position(
            Math.round(mon.x + mon.width / 2 - ext + profile.offsetX),
            Math.round(mon.y + mon.height / 2 - ext + profile.offsetY));
        this._actor.queue_repaint();
        if (visible)
            this._actor.show();
        else
            this._actor.hide();
        this._setUnredirect(!visible);
    }

    // When a fullscreen window is unredirected (direct scanout), Mutter sends its buffer
    // straight to the display and nothing composited above it, Shell chrome included,
    // is shown. Inhibit unredirection only while the crosshair is visible.
    // The Mutter API is reference-counted: keep the calls balanced.
    _setUnredirect(allowed) {
        if (allowed === !this._unredirectInhibited)
            return;
        if (allowed)
            global.compositor.enable_unredirect();
        else
            global.compositor.disable_unredirect();
        this._unredirectInhibited = !allowed;
    }

    destroy() {
        this._setUnredirect(true);
        if (this._repaintId) {
            this._actor.disconnect(this._repaintId);
            this._repaintId = 0;
        }
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
        this._profile = null;
    }
}

const ViseurIndicator = GObject.registerClass(
class ViseurIndicator extends PanelMenu.Button {
    _init(controller) {
        super._init(0.0, _('Viseur'), false);
        this._controller = controller;

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${controller.path}/icons/viseur-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._toggle = new PopupMenu.PopupSwitchMenuItem(_('Show crosshair'), false);
        this._toggle.connect('toggled', (_item, state) => controller.setEnabled(state));
        this.menu.addMenuItem(this._toggle);

        this._profilesItem = new PopupMenu.PopupSubMenuMenuItem(_('Profile'));
        this.menu.addMenuItem(this._profilesItem);

        // Right click: exclusive choice (radio) between Off / Hold / Toggle.
        this._rightClickModes = [
            ['off', _('Off')],
            ['hold', _('Hold')],
            ['toggle', _('Toggle')],
        ];
        this._rightClickItem = new PopupMenu.PopupSubMenuMenuItem(_('Right click'));
        this._rightClickRadios = new Map();
        for (const [mode, label] of this._rightClickModes) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => controller.setRightClickMode(mode));
            this._rightClickItem.menu.addMenuItem(item);
            this._rightClickRadios.set(mode, item);
        }
        this.menu.addMenuItem(this._rightClickItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings…'), () => controller.openPreferences());
    }

    refresh(enabled, profiles, activeId, rightClickMode) {
        this._toggle.setToggleState(enabled);
        for (const [mode, item] of this._rightClickRadios)
            item.setOrnament(mode === rightClickMode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        const current = this._rightClickModes.find(([mode]) => mode === rightClickMode);
        this._rightClickItem.label.text = `${_('Right click')}: ${current ? current[1] : '—'}`;
        this._icon.opacity = enabled ? 255 : 110;
        const active = profiles.find(p => p.id === activeId);
        this._profilesItem.label.text = `${_('Profile')}: ${active ? active.name : '—'}`;
        this._profilesItem.menu.removeAll();
        for (const p of profiles) {
            const item = new PopupMenu.PopupMenuItem(p.name);
            item.setOrnament(p.id === activeId ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._controller.setActiveProfile(p.id));
            this._profilesItem.menu.addMenuItem(item);
        }
    }
});

function modifierMaskGroups(names) {
    const T = Clutter.ModifierType;
    const table = {
        CONTROL: [T.CONTROL_MASK],
        ALT: [T.MOD1_MASK],
        SHIFT: [T.SHIFT_MASK],
        SUPER: [T.SUPER_MASK, T.MOD4_MASK],
    };
    return names.map(n => table[n]).filter(Boolean);
}

export default class ViseurExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new ProfileStore();
        this._store.load();

        this._signals = [];
        this._keybindings = [];
        this._timeouts = new Set();
        this._hold = null;
        this._rightButtonDown = false;
        this._rightClickHold = null;
        this._rightClickTimer = 0;
        this._inOverview = false;
        this._indicator = null;
        this._sleepSubscription = 0;

        // At session start, go back to the default profile.
        const def = this._settings.get_string('default-profile');
        if (this._store.get(def))
            this._settings.set_string('active-profile', def);

        this._overlay = new CrosshairOverlay();

        for (const key of [
            'enabled', 'active-profile', 'monitor-mode', 'monitor-index',
        ])
            this._connect(this._settings, `changed::${key}`, () => this._refresh());
        this._connect(this._settings, 'changed::show-indicator', () => this._syncIndicator());
        for (const key of ['rightclick-hold', 'rightclick-mode']) {
            this._connect(this._settings, `changed::${key}`, () => {
                this._syncRightClickPoll();
                this._refresh();
            });
        }

        this._connect(Main.layoutManager, 'monitors-changed', () => this._refresh());
        this._connect(global.display, 'notify::focus-window', () => {
            if (this._settings.get_string('monitor-mode') === 'focus')
                this._refresh();
        });
        this._connect(Main.sessionMode, 'updated', () => this._refresh());
        this._connect(Main.overview, 'showing', () => {
            this._inOverview = true;
            this._refresh();
        });
        this._connect(Main.overview, 'hiding', () => {
            this._inOverview = false;
            this._refresh();
        });

        this._subscribeSleep();
        this._registerKeybindings();
        this._store.watch(() => this._onProfilesChanged());

        this._syncIndicator();
        this._syncRightClickPoll();
        this._refresh();
    }

    disable() {
        this._endHold(false);
        this._stopRightClickPoll();

        this._unregisterKeybindings();
        if (this._sleepSubscription) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSubscription);
            this._sleepSubscription = 0;
        }
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];

        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        this._store?.unwatch();
        this._store = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._overlay?.destroy();
        this._overlay = null;

        this._settings = null;
    }

    // ---- API used by the indicator ---------------------------------------------------------

    setEnabled(state) {
        this._settings.set_boolean('enabled', state);
    }

    setActiveProfile(id) {
        if (this._store.get(id))
            this._settings.set_string('active-profile', id);
    }

    /** 'off' | 'hold' | 'toggle': a single, exclusive choice. */
    rightClickMode() {
        if (!this._settings.get_boolean('rightclick-hold'))
            return 'off';
        return this._settings.get_string('rightclick-mode') === 'toggle' ? 'toggle' : 'hold';
    }

    setRightClickMode(mode) {
        if (mode === 'hold' || mode === 'toggle')
            this._settings.set_string('rightclick-mode', mode);
        this._settings.set_boolean('rightclick-hold', mode !== 'off');
    }

    // ---- Internals --------------------------------------------------------------------------

    _connect(obj, name, callback) {
        this._signals.push([obj, obj.connect(name, callback)]);
    }

    _addTimeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const again = callback();
            if (!again)
                this._timeouts.delete(id);
            return again ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _removeTimeout(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
    }

    _activeProfile() {
        return this._store.get(this._settings.get_string('active-profile')) ??
            this._store.get(this._settings.get_string('default-profile')) ??
            this._store.profiles[0] ?? null;
    }

    _targetMonitorIndex() {
        const lm = Main.layoutManager;
        const count = lm.monitors.length;
        const primary = lm.primaryIndex;
        switch (this._settings.get_string('monitor-mode')) {
        case 'index':
            return Math.min(Math.max(this._settings.get_int('monitor-index'), 0), Math.max(count - 1, 0));
        case 'focus': {
            const idx = global.display.focus_window?.get_monitor() ?? -1;
            return idx >= 0 && idx < count ? idx : primary;
        }
        default:
            return primary;
        }
    }

    _refresh() {
        if (!this._overlay)
            return;
        const enabled = this._settings.get_boolean('enabled');
        const profile = this._activeProfile();
        const visible = enabled && !Main.sessionMode.isLocked && !this._inOverview;
        this._overlay.update(profile, this._targetMonitorIndex(), visible);
        this._indicator?.refresh(enabled, this._store.profiles, profile?.id ?? '', this.rightClickMode());
    }

    _onProfilesChanged() {
        if (!this._overlay)
            return;
        if (this._store.get(this._settings.get_string('active-profile')) === null)
            this._settings.set_string('active-profile', this._activeProfile()?.id ?? 'default');
        this._refresh();
    }

    _syncIndicator() {
        const want = this._settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new ViseurIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._refresh();
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ---- Suspend / resume ------------------------------------------------------------------

    _subscribeSleep() {
        this._sleepSubscription = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1', 'org.freedesktop.login1.Manager', 'PrepareForSleep',
            '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [starting] = params.deepUnpack();
                if (starting) {
                    this._endHold(true);
                    return;
                }
                // Resume: monitors may take a moment to come back.
                this._addTimeout(RESUME_REFRESH_MS, () => {
                    this._refresh();
                    return false;
                });
            });
    }

    // ---- Keybindings -----------------------------------------------------------------------

    _addKey(name, handler) {
        Main.wm.addKeybinding(
            name, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            handler);
        this._keybindings.push(name);
    }

    _registerKeybindings() {
        this._addKey('toggle-shortcut', () =>
            this.setEnabled(!this._settings.get_boolean('enabled')));
        this._addKey('next-profile-shortcut', () => this._cycleProfile(1));
        this._addKey('prev-profile-shortcut', () => this._cycleProfile(-1));
        for (let i = 1; i <= 4; i++) {
            this._addKey(`profile-shortcut-${i}`, () => {
                const p = this._store.profiles[i - 1];
                if (p)
                    this.setActiveProfile(p.id);
            });
        }
        this._addKey('hold-shortcut', () => this._onHoldShortcut());
    }

    _unregisterKeybindings() {
        for (const name of this._keybindings ?? [])
            Main.wm.removeKeybinding(name);
        this._keybindings = [];
    }

    _cycleProfile(dir) {
        const next = cycleProfileId(
            this._store.profiles.map(p => p.id),
            this._settings.get_string('active-profile'), dir);
        if (next)
            this.setActiveProfile(next);
    }

    // ---- Temporary profile (hold) ----------------------------------------------------------

    _beginHold(profileId, heldCheck) {
        if (this._hold || !this._store.get(profileId))
            return;
        this._hold = {
            previous: this._settings.get_string('active-profile'),
            timer: 0,
        };
        this._settings.set_string('active-profile', profileId);
        if (heldCheck) {
            this._hold.timer = this._addTimeout(POLL_HOLD_MS, () => {
                if (!this._hold)
                    return false;
                if (heldCheck())
                    return true;
                this._hold.timer = 0;
                this._endHold(true);
                return false;
            });
        }
    }

    _endHold(restore) {
        const hold = this._hold;
        if (!hold)
            return;
        this._hold = null;
        this._removeTimeout(hold.timer);
        if (restore && this._settings && this._store.get(hold.previous))
            this._settings.set_string('active-profile', hold.previous);
    }

    _onHoldShortcut() {
        const profileId = this._settings.get_string('hold-profile');
        const accel = this._settings.get_strv('hold-shortcut')[0] ?? '';
        const groups = modifierMaskGroups(acceleratorModifiers(accel));

        if (this._hold) {
            // Without a modifier, release cannot be detected: toggle instead.
            if (groups.length === 0)
                this._endHold(true);
            return;
        }
        if (groups.length === 0) {
            this._beginHold(profileId, null);
            return;
        }
        this._beginHold(profileId, () => {
            const [, , mods] = global.get_pointer();
            return groups.every(g => g.some(mask => (mods & mask) !== 0));
        });
    }

    // ---- Right click: hold or toggle (experimental) ----------------------------------------

    /** True if the current temporary profile was started by the right button. */
    _rightClickOwnsHold() {
        return this._hold !== null && this._hold === this._rightClickHold;
    }

    _endRightClickHold() {
        if (this._rightClickOwnsHold())
            this._endHold(true);
        this._rightClickHold = null;
    }

    _syncRightClickPoll() {
        // Mode changed or option toggled: never leave a right-click profile stuck.
        this._endRightClickHold();
        if (this.rightClickMode() !== 'off')
            this._startRightClickPoll();
        else
            this._stopRightClickPoll();
    }

    _startRightClickPoll() {
        if (this._rightClickTimer)
            return;
        const isDown = () => (global.get_pointer()[2] & RIGHT_BUTTON_MASK) !== 0;
        this._rightButtonDown = isDown();
        this._rightClickTimer = this._addTimeout(POLL_RIGHTCLICK_MS, () => {
            const down = isDown();
            const pressed = down && !this._rightButtonDown;
            const released = !down && this._rightButtonDown;
            this._rightButtonDown = down;

            if (this.rightClickMode() === 'toggle') {
                // Each press flips between the temporary profile and the previous one.
                if (pressed) {
                    if (this._rightClickOwnsHold())
                        this._endRightClickHold();
                    else if (!this._hold)
                        this._beginRightClickHold();
                }
            } else if (pressed && !this._hold) {
                this._beginRightClickHold();
            } else if (released) {
                this._endRightClickHold();
            }
            return true;
        });
    }

    _beginRightClickHold() {
        this._beginHold(this._settings.get_string('hold-profile'), null);
        this._rightClickHold = this._hold;
    }

    _stopRightClickPoll() {
        if (this._rightClickTimer) {
            this._removeTimeout(this._rightClickTimer);
            this._rightClickTimer = 0;
        }
        this._rightButtonDown = false;
        this._endRightClickHold();
    }
}
