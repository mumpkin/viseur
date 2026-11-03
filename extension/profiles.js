// SPDX-License-Identifier: GPL-3.0-or-later
// Profile storage: ~/.config/viseur/profiles.json (JSON format documented in the README).
// Shared between the extension (read + watch) and the preferences window (write).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MAX_PROFILES, SCHEMA_VERSION, defaultProfiles, sanitizeProfile, sanitizeStore, uniqueId,
} from './model.js';

export function profilesDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'viseur']);
}

export function profilesPath() {
    return GLib.build_filenamev([profilesDir(), 'profiles.json']);
}

export class ProfileStore {
    constructor() {
        this.profiles = [];
        this._file = Gio.File.new_for_path(profilesPath());
        this._monitor = null;
        this._monitorId = 0;
        this._debounce = 0;
    }

    /** Loads the file; if missing or corrupted, restores the presets. */
    load() {
        let data = null;
        try {
            const [ok, bytes] = this._file.load_contents(null);
            if (ok)
                data = sanitizeStore(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))) {
                console.error(`[viseur] profiles.json unreadable (${e.message}); ` +
                    'backing up to profiles.json.bak and restoring presets.');
                this._backupCorrupted();
            }
        }
        if (data) {
            this.profiles = data.profiles;
            return;
        }
        this.profiles = defaultProfiles();
        this.save();
    }

    _backupCorrupted() {
        try {
            const bak = Gio.File.new_for_path(`${profilesPath()}.bak`);
            this._file.copy(bak, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (_e) {
            // Nothing more to try.
        }
    }

    save() {
        try {
            GLib.mkdir_with_parents(profilesDir(), 0o755);
            const json = JSON.stringify({version: SCHEMA_VERSION, profiles: this.profiles}, null, 2);
            this._file.replace_contents(
                new TextEncoder().encode(`${json}\n`), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return true;
        } catch (e) {
            console.error(`[viseur] cannot write ${profilesPath()}: ${e.message}`);
            return false;
        }
    }

    get(id) {
        return this.profiles.find(p => p.id === id) ?? null;
    }

    add(partial) {
        if (this.profiles.length >= MAX_PROFILES)
            return null;
        const p = sanitizeProfile(partial, 'New profile');
        p.id = uniqueId(p.name, this.profiles.map(x => x.id));
        this.profiles.push(p);
        this.save();
        return p;
    }

    duplicate(id) {
        const src = this.get(id);
        if (!src)
            return null;
        const copy = JSON.parse(JSON.stringify(src));
        copy.name = `${src.name} (copy)`.slice(0, 40);
        copy.id = null;
        return this.add(copy);
    }

    rename(id, name) {
        const p = this.get(id);
        const clean = String(name ?? '').trim().slice(0, 40);
        if (!p || !clean)
            return false;
        p.name = clean;
        return this.save();
    }

    remove(id) {
        if (this.profiles.length <= 1)
            return false;
        const i = this.profiles.findIndex(p => p.id === id);
        if (i < 0)
            return false;
        this.profiles.splice(i, 1);
        return this.save();
    }

    resetToPresets() {
        this.profiles = defaultProfiles();
        return this.save();
    }

    /** Calls callback() (after reloading) when another process modifies the file. */
    watch(callback) {
        this.unwatch();
        try {
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', (_m, _f, _o, event) => {
                if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    event === Gio.FileMonitorEvent.CREATED ||
                    event === Gio.FileMonitorEvent.RENAMED) {
                    if (this._debounce)
                        GLib.source_remove(this._debounce);
                    this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        this._debounce = 0;
                        this.load();
                        callback();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        } catch (e) {
            console.error(`[viseur] cannot watch profiles.json: ${e.message}`);
        }
    }

    unwatch() {
        if (this._debounce) {
            GLib.source_remove(this._debounce);
            this._debounce = 0;
        }
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = 0;
        }
    }
}
