// SPDX-License-Identifier: GPL-3.0-or-later
// Crosshair drawing through a Cairo API (used by the Shell overlay AND by the
// preferences window preview). No gi:// dependency.

import {parseColor} from './model.js';

/**
 * Describes the shapes to draw, in integer coordinates (crisp pixels) around (cx, cy).
 * Returns {rects: [{x,y,w,h}], circle: null | {cx,cy,r,t}}.
 */
export function buildShapes(p, cx, cy) {
    const rects = [];
    let circle = null;

    if (p.cross.enabled && p.cross.length > 0) {
        const {length: len, thickness: t, gap} = p.cross;
        const x0 = Math.round(cx - t / 2);
        const y0 = Math.round(cy - t / 2);
        rects.push(
            {x: x0, y: cy - gap - len, w: t, h: len},
            {x: x0, y: cy + gap, w: t, h: len},
            {x: cx - gap - len, y: y0, w: len, h: t},
            {x: cx + gap, y: y0, w: len, h: t});
    }
    if (p.dot.enabled) {
        const s = p.dot.size;
        rects.push({x: Math.round(cx - s / 2), y: Math.round(cy - s / 2), w: s, h: s});
    }
    if (p.circle.enabled)
        circle = {cx, cy, r: p.circle.radius, t: p.circle.thickness};

    return {rects, circle};
}

/**
 * Draws the crosshair centered on (cx, cy). Opacity is applied to the whole
 * (Cairo group) to avoid more opaque areas where shapes overlap.
 */
export function drawCrosshair(cr, p, cx, cy) {
    const {rects, circle} = buildShapes(p, cx, cy);
    if (rects.length === 0 && !circle)
        return;

    cr.save();
    cr.pushGroup();

    if (p.outline.enabled) {
        const o = p.outline.thickness;
        const [r, g, b] = parseColor(p.outline.color);
        cr.setSourceRGB(r, g, b);
        for (const s of rects) {
            cr.rectangle(s.x - o, s.y - o, s.w + 2 * o, s.h + 2 * o);
            cr.fill();
        }
        if (circle) {
            cr.setLineWidth(circle.t + 2 * o);
            cr.newPath();
            cr.arc(circle.cx, circle.cy, circle.r, 0, 2 * Math.PI);
            cr.stroke();
        }
    }

    const [r, g, b] = parseColor(p.color);
    cr.setSourceRGB(r, g, b);
    for (const s of rects) {
        cr.rectangle(s.x, s.y, s.w, s.h);
        cr.fill();
    }
    if (circle) {
        cr.setLineWidth(circle.t);
        cr.newPath();
        cr.arc(circle.cx, circle.cy, circle.r, 0, 2 * Math.PI);
        cr.stroke();
    }

    cr.popGroupToSource();
    cr.paintWithAlpha(p.opacity);
    cr.restore();
}
