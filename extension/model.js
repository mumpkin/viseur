// SPDX-License-Identifier: GPL-3.0-or-later
// Pure data model (no gi:// dependency): testable with Node.

export const SCHEMA_VERSION = 1;
export const MAX_PROFILES = 50;

export const LIMITS = {
    crossLength: [0, 100],
    crossThickness: [1, 20],
    crossGap: [0, 60],
    dotSize: [1, 30],
    circleRadius: [2, 120],
    circleThickness: [1, 20],
    outlineThickness: [1, 10],
    offset: [-600, 600],
    opacity: [0.05, 1],
};

const clampInt = (v, [lo, hi], fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
};

const clampFloat = (v, [lo, hi], fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n))
        return fallback;
    return Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;
};

const asBool = (v, fallback) => typeof v === 'boolean' ? v : fallback;
const asColor = (v, fallback) =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;

export const DEFAULT_PROFILE = Object.freeze({
    name: 'Green cross',
    cross: {enabled: true, length: 6, thickness: 2, gap: 3},
    dot: {enabled: false, size: 3},
    circle: {enabled: false, radius: 12, thickness: 2},
    color: '#00ff00',
    opacity: 1,
    outline: {enabled: true, color: '#000000', thickness: 1},
    offsetX: 0,
    offsetY: 0,
});

/**
 * Normalizes any profile (hand-edited JSON file, older version…) into a valid
 * profile. The id may stay null: the store assigns a unique one.
 */
export function sanitizeProfile(raw, fallbackName = 'Profile') {
    const r = raw && typeof raw === 'object' ? raw : {};
    const d = DEFAULT_PROFILE;
    const cross = r.cross && typeof r.cross === 'object' ? r.cross : {};
    const dot = r.dot && typeof r.dot === 'object' ? r.dot : {};
    const circle = r.circle && typeof r.circle === 'object' ? r.circle : {};
    const outline = r.outline && typeof r.outline === 'object' ? r.outline : {};
    const name = typeof r.name === 'string' && r.name.trim()
        ? r.name.trim().slice(0, 40) : fallbackName;
    return {
        id: typeof r.id === 'string' && /^[a-z0-9_-]{1,40}$/.test(r.id) ? r.id : null,
        name,
        cross: {
            enabled: asBool(cross.enabled, d.cross.enabled),
            length: clampInt(cross.length, LIMITS.crossLength, d.cross.length),
            thickness: clampInt(cross.thickness, LIMITS.crossThickness, d.cross.thickness),
            gap: clampInt(cross.gap, LIMITS.crossGap, d.cross.gap),
        },
        dot: {
            enabled: asBool(dot.enabled, d.dot.enabled),
            size: clampInt(dot.size, LIMITS.dotSize, d.dot.size),
        },
        circle: {
            enabled: asBool(circle.enabled, d.circle.enabled),
            radius: clampInt(circle.radius, LIMITS.circleRadius, d.circle.radius),
            thickness: clampInt(circle.thickness, LIMITS.circleThickness, d.circle.thickness),
        },
        color: asColor(r.color, d.color),
        opacity: clampFloat(r.opacity, LIMITS.opacity, d.opacity),
        outline: {
            enabled: asBool(outline.enabled, d.outline.enabled),
            color: asColor(outline.color, d.outline.color),
            thickness: clampInt(outline.thickness, LIMITS.outlineThickness, d.outline.thickness),
        },
        offsetX: clampInt(r.offsetX, LIMITS.offset, 0),
        offsetY: clampInt(r.offsetY, LIMITS.offset, 0),
    };
}

export function slugify(text) {
    const s = String(text ?? '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return s || 'profile';
}

export function uniqueId(base, existingIds) {
    const taken = new Set(existingIds);
    const root = slugify(base);
    if (!taken.has(root))
        return root;
    for (let i = 2; ; i++) {
        const candidate = `${root}-${i}`;
        if (!taken.has(candidate))
            return candidate;
    }
}

/** Starter presets (all editable). */
export function defaultProfiles() {
    const mk = (id, over) => ({...sanitizeProfile(over), id});
    return [
        mk('default', {name: 'Green cross'}),
        mk('red-dot', {
            name: 'Red dot',
            cross: {enabled: false},
            dot: {enabled: true, size: 4},
            color: '#ff2020',
        }),
        mk('joined-cross', {
            name: 'Joined cyan cross',
            cross: {enabled: true, length: 8, thickness: 2, gap: 0},
            color: '#00ffff',
        }),
        mk('circle-dot', {
            name: 'Circle and dot',
            cross: {enabled: false},
            dot: {enabled: true, size: 3},
            circle: {enabled: true, radius: 12, thickness: 2},
            color: '#ffffff',
        }),
        mk('cross-dot', {
            name: 'Yellow cross and dot',
            cross: {enabled: true, length: 5, thickness: 1, gap: 4},
            dot: {enabled: true, size: 2},
            color: '#ffe600',
        }),
    ];
}

/**
 * Validates the full contents of profiles.json.
 * Returns null if unusable (the caller falls back to the presets).
 */
export function sanitizeStore(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.profiles) || raw.profiles.length === 0)
        return null;
    const out = [];
    for (const item of raw.profiles.slice(0, MAX_PROFILES)) {
        const p = sanitizeProfile(item, `Profile ${out.length + 1}`);
        p.id = p.id && !out.some(o => o.id === p.id)
            ? p.id : uniqueId(p.name, out.map(o => o.id));
        out.push(p);
    }
    return {version: SCHEMA_VERSION, profiles: out};
}

/** Half-side (px) of the square needed to draw the crosshair, outline included. */
export function extentOf(p) {
    let e = 0;
    if (p.cross.enabled)
        e = Math.max(e, p.cross.gap + p.cross.length, Math.ceil(p.cross.thickness / 2));
    if (p.dot.enabled)
        e = Math.max(e, Math.ceil(p.dot.size / 2));
    if (p.circle.enabled)
        e = Math.max(e, p.circle.radius + Math.ceil(p.circle.thickness / 2));
    const o = p.outline.enabled ? p.outline.thickness : 0;
    return Math.ceil(e + o) + 2;
}

export function parseColor(hex) {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
    if (!m)
        return [0, 1, 0];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Canonical modifier names of a GTK accelerator: "<Control><Alt>x" → CONTROL, ALT. */
export function acceleratorModifiers(accel) {
    const found = new Set();
    for (const m of String(accel ?? '').matchAll(/<([A-Za-z0-9_]+)>/g)) {
        switch (m[1].toLowerCase()) {
        case 'control': case 'ctrl': case 'primary': found.add('CONTROL'); break;
        case 'alt': case 'mod1': found.add('ALT'); break;
        case 'shift': found.add('SHIFT'); break;
        case 'super': case 'mod4': case 'meta': found.add('SUPER'); break;
        default: break;
        }
    }
    return [...found];
}

/** Next/previous profile (dir = +1 / -1), wrapping around. */
export function cycleProfileId(ids, currentId, dir) {
    if (ids.length === 0)
        return null;
    const i = ids.indexOf(currentId);
    if (i < 0)
        return ids[0];
    return ids[(i + dir + ids.length) % ids.length];
}
