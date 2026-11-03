// Automated tests (Node ≥ 20): node --test tests/
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    LIMITS, acceleratorModifiers, cycleProfileId, defaultProfiles, extentOf, parseColor,
    sanitizeProfile, sanitizeStore, slugify, uniqueId,
} from '../extension/model.js';
import {buildShapes, drawCrosshair} from '../extension/renderer.js';

test('sanitizeProfile clamps values and ignores invalid types', () => {
    const p = sanitizeProfile({
        name: '  Test  ', color: 'red', opacity: 7,
        cross: {length: 9999, thickness: -3, gap: 'x', enabled: 'yes'},
        offsetX: 1e9,
    });
    assert.equal(p.name, 'Test');
    assert.equal(p.color, '#00ff00');
    assert.equal(p.opacity, 1);
    assert.equal(p.cross.length, LIMITS.crossLength[1]);
    assert.equal(p.cross.thickness, LIMITS.crossThickness[0]);
    assert.equal(p.cross.gap, 3);
    assert.equal(p.cross.enabled, true);
    assert.equal(p.offsetX, LIMITS.offset[1]);
    assert.equal(p.id, null);
});

test('sanitizeStore rejects empty input and makes ids unique', () => {
    assert.equal(sanitizeStore(null), null);
    assert.equal(sanitizeStore({profiles: []}), null);
    const s = sanitizeStore({profiles: [{id: 'a', name: 'A'}, {id: 'a', name: 'A'}, {name: 'A'}]});
    const ids = s.profiles.map(p => p.id);
    assert.equal(new Set(ids).size, 3);
});

test('presets are valid, have unique ids, and the default profile exists', () => {
    const presets = defaultProfiles();
    assert.ok(presets.length >= 4);
    assert.ok(presets.some(p => p.id === 'default'));
    assert.equal(new Set(presets.map(p => p.id)).size, presets.length);
    for (const p of presets)
        assert.deepEqual(sanitizeProfile(p), p);
});

test('slugify / uniqueId', () => {
    assert.equal(slugify('Épée Rouge !'), 'epee-rouge');
    assert.equal(slugify('***'), 'profile');
    assert.equal(uniqueId('Test', ['test', 'test-2']), 'test-3');
});

test('extentOf covers cross, dot, circle and outline', () => {
    const p = sanitizeProfile({
        cross: {enabled: true, length: 10, thickness: 2, gap: 4},
        outline: {enabled: true, thickness: 2},
    });
    assert.equal(extentOf(p), 14 + 2 + 2);
    const c = sanitizeProfile({
        cross: {enabled: false}, circle: {enabled: true, radius: 20, thickness: 4},
        outline: {enabled: false},
    });
    assert.equal(extentOf(c), 22 + 2);
});

test('acceleratorModifiers', () => {
    assert.deepEqual(acceleratorModifiers('<Control><Alt>x').sort(), ['ALT', 'CONTROL']);
    assert.deepEqual(acceleratorModifiers('<Primary><Shift>F9'), ['CONTROL', 'SHIFT']);
    assert.deepEqual(acceleratorModifiers('<Super>a'), ['SUPER']);
    assert.deepEqual(acceleratorModifiers('F9'), []);
    assert.deepEqual(acceleratorModifiers(undefined), []);
});

test('cycleProfileId wraps around in both directions', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(cycleProfileId(ids, 'a', 1), 'b');
    assert.equal(cycleProfileId(ids, 'c', 1), 'a');
    assert.equal(cycleProfileId(ids, 'a', -1), 'c');
    assert.equal(cycleProfileId(ids, 'unknown', 1), 'a');
    assert.equal(cycleProfileId([], 'a', 1), null);
});

test('parseColor', () => {
    assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
    assert.deepEqual(parseColor('garbage'), [0, 1, 0]);
});

test('buildShapes: cross with separated arms, centered and symmetric', () => {
    const p = sanitizeProfile({cross: {enabled: true, length: 6, thickness: 2, gap: 3}});
    const {rects} = buildShapes(p, 20, 20);
    assert.equal(rects.length, 4);
    const [top, bottom, left, right] = rects;
    assert.deepEqual(top, {x: 19, y: 11, w: 2, h: 6});
    assert.deepEqual(bottom, {x: 19, y: 23, w: 2, h: 6});
    assert.deepEqual(left, {x: 11, y: 19, w: 6, h: 2});
    assert.deepEqual(right, {x: 23, y: 19, w: 6, h: 2});
    for (const r of rects) {
        for (const v of [r.x, r.y, r.w, r.h])
            assert.ok(Number.isInteger(v), 'integer coordinates (crisp pixels)');
    }
});

test('buildShapes: gap 0 = joined arms; disabled cross = no arms', () => {
    const joined = buildShapes(sanitizeProfile({cross: {gap: 0, length: 5}}), 10, 10).rects;
    assert.equal(joined[0].y + joined[0].h, 10);
    assert.equal(joined[1].y, 10);
    const none = buildShapes(sanitizeProfile({cross: {enabled: false}}), 10, 10);
    assert.equal(none.rects.length, 0);
    assert.equal(none.circle, null);
});

function recorder() {
    const calls = [];
    return new Proxy({calls}, {
        get(t, name) {
            if (name === 'calls')
                return t.calls;
            return (...args) => t.calls.push([name, ...args]);
        },
    });
}

test('drawCrosshair: Cairo group + global opacity, outline drawn before fill', () => {
    const cr = recorder();
    const p = sanitizeProfile({
        cross: {enabled: true}, outline: {enabled: true, color: '#000000'},
        color: '#ffffff', opacity: 0.5,
    });
    drawCrosshair(cr, p, 20, 20);
    const names = cr.calls.map(c => c[0]);
    assert.equal(names[0], 'save');
    assert.equal(names[1], 'pushGroup');
    assert.deepEqual(names.slice(-3), ['popGroupToSource', 'paintWithAlpha', 'restore']);
    const colors = cr.calls.filter(c => c[0] === 'setSourceRGB');
    assert.deepEqual(colors[0].slice(1), [0, 0, 0], 'outline first');
    assert.deepEqual(colors[1].slice(1), [1, 1, 1], 'then crosshair color');
    assert.equal(cr.calls.at(-2)[1], 0.5);
});

test('drawCrosshair: nothing to draw = no Cairo calls', () => {
    const cr = recorder();
    drawCrosshair(cr, sanitizeProfile({cross: {enabled: false}}), 10, 10);
    assert.equal(cr.calls.length, 0);
});
