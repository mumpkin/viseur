// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences window (libadwaita): live preview, settings, profiles, shortcuts, troubleshooting.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LIMITS} from './model.js';
import {ProfileStore, profilesDir, profilesPath} from './profiles.js';
import {drawCrosshair} from './renderer.js';

// gettext can only be called once the extension is loaded: at module level we only
// mark the strings (N_), and translate them at use time with _().
const N_ = s => s;

const PREVIEW_ZOOM = 4;
const PREVIEW_BACKGROUNDS = [
    [N_('Dark'), [0.10, 0.10, 0.12]],
    [N_('Light'), [0.92, 0.92, 0.92]],
    [N_('Green'), [0.18, 0.42, 0.20]],
    [N_('Red'), [0.55, 0.15, 0.15]],
];

const SHORTCUTS = [
    ['toggle-shortcut', N_('Show / hide the crosshair'), null],
    ['next-profile-shortcut', N_('Next profile'), null],
    ['prev-profile-shortcut', N_('Previous profile'), null],
    ['profile-shortcut-1', N_('Profile #1 in the list'), null],
    ['profile-shortcut-2', N_('Profile #2 in the list'), null],
    ['profile-shortcut-3', N_('Profile #3 in the list'), null],
    ['profile-shortcut-4', N_('Profile #4 in the list'), null],
    ['hold-shortcut', N_('Temporary profile (hold)'),
        N_('Stays active while the shortcut\'s Ctrl / Alt / Shift / Super keys are held down.')],
];

const MODIFIER_KEYVALS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
]);

const getPath = (obj, path) => path.reduce((o, k) => o[k], obj);
const setPath = (obj, path, value) => {
    const parent = path.slice(0, -1).reduce((o, k) => o[k], obj);
    parent[path[path.length - 1]] = value;
};

function toHex(rgba) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(rgba.red)}${h(rgba.green)}${h(rgba.blue)}`;
}

function shortcutLabel(accels) {
    const accel = accels[0];
    if (!accel)
        return _('Disabled');
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(key, mods) : accel;
}

export default class ViseurPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const ui = new PrefsUI(window, this.getSettings());
        ui.build();
    }
}

class PrefsUI {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._store = new ProfileStore();
        this._store.load();
        this._loading = true;
        this._refreshers = [];
        this._profileRows = [];
        this._saveTimer = 0;
        this._previewBg = 0;
        this._current = this._store.get(settings.get_string('active-profile')) ?? this._store.profiles[0];

        window.set_default_size(780, 900);
        window.connect('close-request', () => {
            if (this._saveTimer) {
                GLib.source_remove(this._saveTimer);
                this._saveTimer = 0;
                this._store.save();
            }
            return false;
        });
    }

    build() {
        this._window.add(this._buildMainPage());
        this._window.add(this._buildProfilesPage());
        this._window.add(this._buildShortcutsPage());
        this._window.add(this._buildHelpPage());
        this._rebuildProfiles();
        this._loading = false;
        this._loadEditor();
    }

    // ---- Helpers --------------------------------------------------------------------------

    _changed() {
        this._preview.queue_draw();
        if (this._saveTimer)
            GLib.source_remove(this._saveTimer);
        this._saveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._saveTimer = 0;
            this._store.save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadEditor() {
        this._loading = true;
        for (const fn of this._refreshers)
            fn();
        this._loading = false;
        this._preview.queue_draw();
    }

    _spin(group, title, path, [lo, hi], subtitle = '') {
        const row = new Adw.SpinRow({
            title, subtitle,
            adjustment: new Gtk.Adjustment({
                lower: lo, upper: hi, step_increment: 1, page_increment: 5, value: lo,
            }),
        });
        row.connect('notify::value', () => {
            if (this._loading)
                return;
            setPath(this._current, path, Math.round(row.value));
            this._changed();
        });
        this._refreshers.push(() => row.set_value(getPath(this._current, path)));
        group.add(row);
        return row;
    }

    _switch(group, title, path) {
        const row = new Adw.SwitchRow({title});
        row.connect('notify::active', () => {
            if (this._loading)
                return;
            setPath(this._current, path, row.active);
            this._changed();
        });
        this._refreshers.push(() => row.set_active(getPath(this._current, path)));
        group.add(row);
        return row;
    }

    _color(group, title, path) {
        const button = new Gtk.ColorDialogButton({
            valign: Gtk.Align.CENTER,
            dialog: new Gtk.ColorDialog({with_alpha: false, title}),
        });
        const row = new Adw.ActionRow({title, activatable_widget: button});
        row.add_suffix(button);
        button.connect('notify::rgba', () => {
            if (this._loading)
                return;
            setPath(this._current, path, toHex(button.get_rgba()));
            this._changed();
        });
        this._refreshers.push(() => {
            const rgba = new Gdk.RGBA();
            rgba.parse(getPath(this._current, path));
            button.set_rgba(rgba);
        });
        group.add(row);
        return row;
    }

    _profileCombo(group, title, subtitle, onSelected, getId) {
        const row = new Adw.ComboRow({title, subtitle, model: this._profileNames});
        row.connect('notify::selected', () => {
            if (this._loading)
                return;
            const p = this._store.profiles[row.selected];
            if (p)
                onSelected(p.id);
        });
        this._profileCombos.push({row, getId});
        group.add(row);
        return row;
    }

    _syncCombos() {
        const was = this._loading;
        this._loading = true;
        for (const {row, getId} of this._profileCombos) {
            const i = this._store.profiles.findIndex(p => p.id === getId());
            row.set_selected(i >= 0 ? i : 0);
        }
        this._loading = was;
    }

    // ---- Main page ------------------------------------------------------------------------

    _buildMainPage() {
        const page = new Adw.PreferencesPage({title: _('Crosshair'), icon_name: 'find-location-symbolic'});
        this._profileNames = new Gtk.StringList();
        this._profileCombos = [];

        const status = new Adw.PreferencesGroup({title: _('Status')});
        const enabled = new Adw.SwitchRow({
            title: _('Show crosshair'),
            subtitle: _('Master switch: hides the crosshair without disabling the extension.'),
        });
        this._settings.bind('enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        status.add(enabled);

        const indicator = new Adw.SwitchRow({title: _('Icon in the top panel')});
        this._settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        status.add(indicator);

        this._profileCombo(status, _('Edited and displayed profile'),
            _('The selected profile is shown on screen immediately.'),
            id => {
                this._current = this._store.get(id);
                this._settings.set_string('active-profile', id);
                this._loadEditor();
            },
            () => this._current.id);
        page.add(status);

        const previewGroup = new Adw.PreferencesGroup({title: _('Live preview')});
        this._preview = new Gtk.DrawingArea({content_height: 200, hexpand: true});
        this._preview.add_css_class('card');
        this._preview.set_draw_func((_area, cr, w, h) => this._drawPreview(cr, w, h));
        previewGroup.add(this._preview);
        const bg = new Adw.ComboRow({
            title: _('Preview background'),
            subtitle: _('Preview magnified ×4, to judge contrast.'),
            model: Gtk.StringList.new(PREVIEW_BACKGROUNDS.map(b => _(b[0]))),
        });
        bg.connect('notify::selected', () => {
            this._previewBg = bg.selected;
            this._preview.queue_draw();
        });
        previewGroup.add(bg);
        page.add(previewGroup);

        const cross = new Adw.PreferencesGroup({title: _('Cross')});
        this._switch(cross, _('Show cross'), ['cross', 'enabled']);
        this._spin(cross, _('Arm length (px)'), ['cross', 'length'], LIMITS.crossLength);
        this._spin(cross, _('Thickness (px)'), ['cross', 'thickness'], LIMITS.crossThickness);
        this._spin(cross, _('Center gap (px)'), ['cross', 'gap'], LIMITS.crossGap,
            _('0 = joined arms'));
        page.add(cross);

        const dot = new Adw.PreferencesGroup({title: _('Center dot')});
        this._switch(dot, _('Show dot'), ['dot', 'enabled']);
        this._spin(dot, _('Size (px)'), ['dot', 'size'], LIMITS.dotSize);
        page.add(dot);

        const circle = new Adw.PreferencesGroup({title: _('Circle')});
        this._switch(circle, _('Show circle'), ['circle', 'enabled']);
        this._spin(circle, _('Radius (px)'), ['circle', 'radius'], LIMITS.circleRadius);
        this._spin(circle, _('Thickness (px)'), ['circle', 'thickness'], LIMITS.circleThickness);
        page.add(circle);

        const look = new Adw.PreferencesGroup({title: _('Color and opacity')});
        this._color(look, _('Color'), ['color']);
        const opacityRow = new Adw.ActionRow({title: _('Opacity')});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 5, 100, 1);
        scale.set_draw_value(true);
        scale.set_value_pos(Gtk.PositionType.RIGHT);
        scale.set_size_request(260, -1);
        scale.set_valign(Gtk.Align.CENTER);
        scale.connect('value-changed', () => {
            if (this._loading)
                return;
            this._current.opacity = Math.round(scale.get_value()) / 100;
            this._changed();
        });
        this._refreshers.push(() => scale.set_value(Math.round(this._current.opacity * 100)));
        opacityRow.add_suffix(scale);
        look.add(opacityRow);
        page.add(look);

        const outline = new Adw.PreferencesGroup({title: _('Outline')});
        this._switch(outline, _('Show outline'), ['outline', 'enabled']);
        this._color(outline, _('Outline color'), ['outline', 'color']);
        this._spin(outline, _('Outline thickness (px)'), ['outline', 'thickness'],
            LIMITS.outlineThickness);
        page.add(outline);

        const position = new Adw.PreferencesGroup({
            title: _('Position'),
            description: _('Centered by default. Fine offset in logical pixels (positive = right / down).'),
        });
        this._spin(position, _('Horizontal offset'), ['offsetX'], LIMITS.offset);
        this._spin(position, _('Vertical offset'), ['offsetY'], LIMITS.offset);
        page.add(position);

        page.add(this._buildScreenGroup());
        return page;
    }

    _buildScreenGroup() {
        const group = new Adw.PreferencesGroup({title: _('Target monitor')});
        const modes = ['primary', 'focus', 'index'];
        const monitors = Gdk.Display.get_default()?.get_monitors().get_n_items() ?? 1;

        const mode = new Adw.ComboRow({
            title: _('Show the crosshair on'),
            subtitle: _('%d monitor(s) detected').replace('%d', monitors),
            model: Gtk.StringList.new([
                _('The primary monitor'),
                _('The monitor of the focused window'),
                _('A specific monitor (number)'),
            ]),
        });
        mode.set_selected(Math.max(0, modes.indexOf(this._settings.get_string('monitor-mode'))));
        const index = new Adw.SpinRow({
            title: _('Monitor number'),
            subtitle: _('0 = first monitor in GNOME\'s order'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 15, step_increment: 1, value: 0}),
        });
        this._settings.bind('monitor-index', index.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        index.set_sensitive(mode.selected === 2);
        mode.connect('notify::selected', () => {
            this._settings.set_string('monitor-mode', modes[mode.selected] ?? 'primary');
            index.set_sensitive(mode.selected === 2);
        });
        group.add(mode);
        group.add(index);
        return group;
    }

    _drawPreview(cr, w, h) {
        const [r, g, b] = PREVIEW_BACKGROUNDS[this._previewBg][1];
        cr.setSourceRGB(r, g, b);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // Subtle marker for the screen center.
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(1);
        cr.moveTo(0, Math.round(h / 2) + 0.5);
        cr.lineTo(w, Math.round(h / 2) + 0.5);
        cr.moveTo(Math.round(w / 2) + 0.5, 0);
        cr.lineTo(Math.round(w / 2) + 0.5, h);
        cr.stroke();

        cr.save();
        cr.scale(PREVIEW_ZOOM, PREVIEW_ZOOM);
        const cx = Math.round(w / 2 / PREVIEW_ZOOM) + this._current.offsetX;
        const cy = Math.round(h / 2 / PREVIEW_ZOOM) + this._current.offsetY;
        // The offset is clamped to the visible area of the preview.
        drawCrosshair(cr, this._current,
            Math.min(Math.max(cx, 0), w / PREVIEW_ZOOM),
            Math.min(Math.max(cy, 0), h / PREVIEW_ZOOM));
        cr.restore();
    }

    // ---- Profiles page --------------------------------------------------------------------

    _buildProfilesPage() {
        const page = new Adw.PreferencesPage({title: _('Profiles'), icon_name: 'view-list-symbolic'});
        this._profilesGroup = new Adw.PreferencesGroup({
            title: _('Saved profiles'),
            description: _('Stored in %s. They survive updates and reinstalls.')
                .replace('%s', profilesPath()),
        });
        const add = new Gtk.Button({
            label: _('New profile'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        add.connect('clicked', () => this._askName(_('New profile'), '', name => {
            const p = this._store.add({...this._current, name, id: null});
            if (p)
                this._selectProfile(p.id);
        }));
        this._profilesGroup.set_header_suffix(add);
        page.add(this._profilesGroup);

        const defaults = new Adw.PreferencesGroup({title: _('At startup and while holding')});
        this._profileCombo(defaults, _('Default profile'),
            _('Selected at every login.'),
            id => this._settings.set_string('default-profile', id),
            () => this._settings.get_string('default-profile'));
        this._profileCombo(defaults, _('Temporary profile'),
            _('Shown while the dedicated shortcut or the right mouse button is held.'),
            id => this._settings.set_string('hold-profile', id),
            () => this._settings.get_string('hold-profile'));

        defaults.add(this._buildRightClickRow());
        page.add(defaults);
        return page;
    }

    /** Right click: Off / Hold / Toggle (exclusive). Also available in the panel menu. */
    _buildRightClickRow() {
        const modes = ['off', 'hold', 'toggle'];
        const row = new Adw.ComboRow({
            title: _('Right click (experimental)'),
            subtitle: _('Hold: temporary profile while the button is held. ' +
                'Toggle: one click shows it, the next click goes back. ' +
                'Reads the pointer state ~30 times/s; does not intercept any click.'),
            model: Gtk.StringList.new([_('Off'), _('Hold'), _('Toggle')]),
        });
        let syncing = false;
        const current = () => !this._settings.get_boolean('rightclick-hold') ? 'off'
            : this._settings.get_string('rightclick-mode') === 'toggle' ? 'toggle' : 'hold';
        const sync = () => {
            syncing = true;
            row.set_selected(modes.indexOf(current()));
            syncing = false;
        };
        row.connect('notify::selected', () => {
            if (syncing)
                return;
            const mode = modes[row.selected] ?? 'off';
            if (mode !== 'off')
                this._settings.set_string('rightclick-mode', mode);
            this._settings.set_boolean('rightclick-hold', mode !== 'off');
        });
        // Keep in sync when the choice is changed from the panel menu.
        const ids = ['rightclick-hold', 'rightclick-mode'].map(key =>
            this._settings.connect(`changed::${key}`, sync));
        row.connect('destroy', () => ids.forEach(id => this._settings.disconnect(id)));
        sync();
        return row;
    }

    _selectProfile(id) {
        this._current = this._store.get(id) ?? this._store.profiles[0];
        this._settings.set_string('active-profile', this._current.id);
        this._rebuildProfiles();
        this._loadEditor();
    }

    _rebuildProfiles() {
        const was = this._loading;
        this._loading = true;
        this._profileNames.splice(0, this._profileNames.get_n_items(),
            this._store.profiles.map(p => p.name));
        this._loading = was;

        for (const row of this._profileRows)
            this._profilesGroup.remove(row);
        this._profileRows = [];

        const defaultId = this._settings.get_string('default-profile');
        for (const p of this._store.profiles) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(p.name, -1),
                subtitle: p.id === defaultId ? _('Default profile') : '',
                activatable: true,
            });
            row.connect('activated', () => this._selectProfile(p.id));
            if (p.id === this._current.id)
                row.add_prefix(new Gtk.Image({icon_name: 'object-select-symbolic'}));

            const mkBtn = (icon, tip, cb) => {
                const b = Gtk.Button.new_from_icon_name(icon);
                b.set_tooltip_text(tip);
                b.set_valign(Gtk.Align.CENTER);
                b.add_css_class('flat');
                b.connect('clicked', cb);
                row.add_suffix(b);
            };
            mkBtn('starred-symbolic', _('Set as default profile'), () => {
                this._settings.set_string('default-profile', p.id);
                this._rebuildProfiles();
            });
            mkBtn('document-edit-symbolic', _('Rename'), () =>
                this._askName(_('Rename profile'), p.name, name => {
                    this._store.rename(p.id, name);
                    this._rebuildProfiles();
                }));
            mkBtn('edit-copy-symbolic', _('Duplicate'), () => {
                const copy = this._store.duplicate(p.id);
                if (copy)
                    this._selectProfile(copy.id);
            });
            mkBtn('user-trash-symbolic', _('Delete'), () => this._confirmDelete(p));

            this._profilesGroup.add(row);
            this._profileRows.push(row);
        }
        this._syncCombos();
    }

    _askName(heading, initial, onOk) {
        const entry = new Gtk.Entry({text: initial, activates_default: true, max_length: 40});
        const dialog = new Adw.AlertDialog({heading});
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('ok', _('OK'));
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('ok');
        dialog.choose(this._window, null, (_d, res) => {
            if (dialog.choose_finish(res) !== 'ok')
                return;
            const name = entry.get_text().trim();
            if (name)
                onOk(name);
        });
    }

    _confirmDelete(profile) {
        if (this._store.profiles.length <= 1) {
            this._window.add_toast(new Adw.Toast({title: _('Cannot delete the last profile.')}));
            return;
        }
        const dialog = new Adw.AlertDialog({
            heading: _('Delete this profile?'),
            body: profile.name,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.choose(this._window, null, (_d, res) => {
            if (dialog.choose_finish(res) !== 'delete')
                return;
            this._store.remove(profile.id);
            const first = this._store.profiles[0].id;
            for (const key of ['default-profile', 'hold-profile', 'active-profile']) {
                if (!this._store.get(this._settings.get_string(key)))
                    this._settings.set_string(key, first);
            }
            this._selectProfile(this._store.get(this._current.id) ? this._current.id : first);
        });
    }

    // ---- Shortcuts page -------------------------------------------------------------------

    _buildShortcutsPage() {
        const page = new Adw.PreferencesPage({title: _('Shortcuts'), icon_name: 'input-keyboard-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: _('Keyboard shortcuts'),
            description: _('Some games grab the keyboard and prevent GNOME from receiving ' +
                'shortcuts (see the Troubleshooting tab). The panel icon remains usable.'),
        });
        for (const [key, label, hint] of SHORTCUTS) {
            const row = new Adw.ActionRow({title: _(label), subtitle: hint ? _(hint) : ''});
            const button = new Gtk.Button({valign: Gtk.Align.CENTER, label: shortcutLabel(this._settings.get_strv(key))});
            const clear = Gtk.Button.new_from_icon_name('edit-clear-symbolic');
            clear.set_valign(Gtk.Align.CENTER);
            clear.add_css_class('flat');
            clear.set_tooltip_text(_('Clear shortcut'));
            const update = () => {
                const accels = this._settings.get_strv(key);
                button.set_label(shortcutLabel(accels));
                clear.set_sensitive(accels.length > 0);
            };
            button.connect('clicked', () => this._captureShortcut(accels => {
                this._settings.set_strv(key, accels);
                update();
            }));
            clear.connect('clicked', () => {
                this._settings.set_strv(key, []);
                update();
            });
            update();
            row.add_suffix(button);
            row.add_suffix(clear);
            group.add(row);
        }
        page.add(group);
        return page;
    }

    _captureShortcut(onDone) {
        const win = new Gtk.Window({
            modal: true,
            transient_for: this._window,
            title: _('New shortcut'),
            default_width: 400,
            default_height: 160,
            resizable: false,
        });
        win.set_child(new Gtk.Label({
            label: _('Press the desired key combination.\n' +
                'Escape: cancel — Backspace: clear'),
            justify: Gtk.Justification.CENTER,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            vexpand: true,
        }));
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (MODIFIER_KEYVALS.has(keyval))
                return true;
            if (keyval === Gdk.KEY_Escape && !mask) {
                win.close();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace && !mask) {
                onDone([]);
                win.close();
                return true;
            }
            const isFunctionKey = keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F12;
            if (!mask && !isFunctionKey)
                return true; // a bare key would interfere with normal typing
            onDone([Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mask)]);
            win.close();
            return true;
        });
        win.add_controller(keys);
        win.present();
    }

    // ---- Troubleshooting page -------------------------------------------------------------

    _buildHelpPage() {
        const page = new Adw.PreferencesPage({title: _('Troubleshooting'), icon_name: 'help-browser-symbolic'});

        const tools = new Adw.PreferencesGroup({title: _('Files and reset')});
        const open = new Adw.ActionRow({
            title: _('Open the profiles folder'),
            subtitle: profilesDir(),
            activatable: true,
        });
        open.connect('activated', () => {
            GLib.mkdir_with_parents(profilesDir(), 0o755);
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(profilesDir()).get_uri(), null);
        });
        tools.add(open);

        const reset = new Adw.ActionRow({
            title: _('Restore the original presets'),
            subtitle: _('Replaces all your profiles with the starter presets.'),
            activatable: true,
        });
        reset.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Restore presets?'),
                body: _('All your current profiles will be replaced.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Restore'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.choose(this._window, null, (_d, res) => {
                if (dialog.choose_finish(res) !== 'reset')
                    return;
                this._store.resetToPresets();
                for (const key of ['default-profile', 'hold-profile', 'active-profile'])
                    this._settings.reset(key);
                this._selectProfile(this._store.profiles[0].id);
            });
        });
        tools.add(reset);
        page.add(tools);

        const help = new Adw.PreferencesGroup({title: _('If the crosshair disappears or gets in the way')});
        const text = new Gtk.Label({
            wrap: true,
            xalign: 0,
            selectable: true,
            use_markup: false,
            label: [
                _('• Panel icon → turn off “Show crosshair”.'),
                _('• Default shortcut: Ctrl+Alt+C (if the game does not grab the keyboard).'),
                _('• From a terminal: gsettings set org.gnome.shell.extensions.viseur enabled false'),
                _('• Disable the extension: gnome-extensions disable viseur@mumpkin'),
                _('• After an incompatible GNOME update: GNOME disables the extension, ' +
                    'with no consequence for the session.'),
                _('• Bugs and requests: https://github.com/mumpkin/viseur/issues'),
            ].join('\n'),
        });
        help.add(text);
        page.add(help);
        return page;
    }
}
