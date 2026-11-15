'use strict';
/**
 * layout_m340.js - "M340i Sport": a Figma design for a petrol M340i (G20, B58), shown as its designer drew it.
 *
 * Unlike the other layouts nothing here is worked out as shapes: the picture is the design's own prototype page
 * (tools/m340/prototype.html), drawn at the cluster's size and baked by tools/bake_m340.py into m340_art.js as a
 * sparse palette texture (shared/shaders.js, M340_ART: about a tenth of a plain picture's bytes). Over it the
 * shaders add only what moves, with the prototype's own geometry:
 *   - each bracket's channel lit from the reading down in the design's gradient, over its tick marks and out to
 *     both lines, running into the bottom line; a white bar across it at the reading (always, at 0 too);
 *   - the last scale numeral the reading has reached in its lit form (white, a little larger, a glow);
 *   - the speed and the gear in the design's lettering: D (or S) alone while the gearbox shifts itself, the gear's
 *     number alone (1-8) in manual, P, R or N;
 *   - the fuel bar, and the oil bar on BMW's oil temperature scale (160 / 250 / 340 °F);
 *   - with the engine off and the car standing READY stands where the rev scale's 0 is; the 0 comes back when it runs;
 *   - with the Waze map in the centre the map fills the brackets' hexagon behind the gauges, its edges feathered
 *     as in the design (the veil), the gauges and figures over it;
 *   - without the car's own bottom strip: the design's bottom row too (time, range, outside temperature, and the
 *     drive mode in its colour: ECO PRO light blue, the sport modes red, comfort white).
 * The design is in mph, °F and miles, whatever the unit settings.
 *
 * What it costs the cluster is kept small: a layer's rectangle is cut to what the picture draws in it (drawn()),
 * a line of figures is one uniform (a new speed is one message), and the drive mode's name is one layer.
 */
const C = require('./layout_common');
const ART = require('./m340_art');

const M = ART.META;
const isNum = C.isNum;
const KMH_PER_MPH = 1.609344;
const RPM_MAX = 8000;
const VEIL_GAIN = 1.6;        // the map's faded edges: the design's fade, narrower (the map brighter), eased in the shader
const OVER_MAP = 960;
const MODE_BASE = 671;       // the drive mode's baseline: its letters centred on the blue blocks (y 633 to 690)        // over Waze on cluster's map layer (its kWindowZ, 900) and the veil (950)

const PAL = {
    bg: '#000000', text: '#f4f7fc', fg: '#ffffff', dim: '#a2abbb', faint: '#606e87', red: '#ff4457', regen: '#3ddc84', glow: '#3cd7ff',
    eco: '#7fd4ff', sport: '#ff4457', ready: '#eaeaea',
};
const pal = () => Object.assign({}, PAL);

const WINDOW = { x: M.window[0], y: M.window[1], w: M.window[2], h: M.window[3] };
const A = { u_map: ART.tex('a_map'), u_atlas: ART.tex('a_atlas'), u_pal: ART.tex('a_pal') };
const B = { u_map: ART.tex('b_map'), u_atlas: ART.tex('b_atlas'), u_pal: ART.tex('b_pal') };
const HEX = (on) => ({
    u_hexA: [M.hex[0][0], M.hex[1][0], M.hex[0][1], M.hex[2][1]], u_hexB: [M.hex[5][0], M.hex[2][0], M.hex[4][0], M.hex[3][0]], u_hexC: [M.hex[3][1], on ? 1 : 0],
});

/* ---------- the readings ---------- */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mph = (d) => (isNum(d.speed) ? d.speed / KMH_PER_MPH : 0);
/** 0..1 along the speed scale's eight steps (its numerals are not evenly worth: 0-120 by 20, then 160, 200). */
function speedFrac(v) {
    const m = M.speedMarks;
    if (!(v > 0)) return 0;
    for (let i = 1; i < m.length; i++) if (v <= m[i]) return (i - 1 + (v - m[i - 1]) / (m[i] - m[i - 1])) / (m.length - 1);
    return 1;
}
/** The engine-on look (the revs' 0, no READY): all but READY (data.js d.ready: the engine off with the car standing;
 * rolling with the engine stopped, sailing down a hill, keeps the driving look, the revs at 0). */
const running = (d) => (d.ready !== undefined ? !d.ready : d.engineOn !== false);
const rpmFrac = (d) => (running(d) && isNum(d.rpm) ? clamp01(d.rpm / RPM_MAX) : 0);
/** The gear: the letter alone in D and S, the number alone in manual, P / R / N as they are. */
function gearShort(d) {
    const g = C.gearText(d);
    return /^M\d+$/.test(g) ? g.slice(1) : /^[DS]\d+$/.test(g) ? g[0] : g;
}
/* the drive mode as the car names it (data.js FES_MODES: SPORT+, COMFORT+, ECO PRO+ ...), the + written out */
const modeName = (d) => String((d && d.driveMode) || (d && (d.mode === 'S' || d.mode === 'M') ? 'SPORT' : 'COMFORT')).replace(/\+/g, ' PLUS');
const modeColour = (t, d) => { const m = modeName(d); return /ECO/.test(m) ? t.eco : /SPORT/.test(m) ? t.sport : t.fg; };
/** A row between a bar's marks ([[value, row] ...], the values rising). */
function rowAt(marks, v) {
    if (!isNum(v) || v <= marks[0][0]) return marks[0][1];
    for (let i = 1; i < marks.length; i++) if (v <= marks[i][0]) return marks[i - 1][1] + (v - marks[i - 1][0]) / (marks[i][0] - marks[i - 1][0]) * (marks[i][1] - marks[i - 1][1]);
    return marks[marks.length - 1][1];
}
const clockNow = () => {
    const ck = require('./clock'), t = ck.local(), hm = ck.hm();
    // (am / pm only with the 12-hour clock: hm() then starts with the hour of 12)
    const twelve = (t.h % 12 || 12) + ':' + ('0' + t.m).slice(-2), day = t.h + ':' + ('0' + t.m).slice(-2);
    return { hm, half: hm === twelve && (hm !== day || require('./clock').twelve !== false) ? (t.h < 12 ? 'am' : 'pm') : '' };
};

/* ---------- pieces ---------- */

/**
 * The part of a rectangle the picture draws on: the box round its tiles that are not empty and round what else
 * must stay in it (keep: [x0, y0, x1, y1] each), never larger than the rectangle. A layer's shader runs for
 * every pixel of its rectangle, so the smaller rectangle is work the cluster's GPU is spared; what is drawn is
 * the same.
 */
const tileMap = {};
function drawn(set, x, y, w, h, keep) {
    const name = set === B ? 'b_map' : 'a_map', org = set === B ? M.centre : M.sides, T = M.tile;
    const t = tileMap[name] || (tileMap[name] = ART.tex(name)());
    let x0 = x + w, y0 = y + h, x1 = x, y1 = y;
    const add = (ax0, ay0, ax1, ay1) => { x0 = Math.min(x0, ax0); y0 = Math.min(y0, ay0); x1 = Math.max(x1, ax1); y1 = Math.max(y1, ay1); };
    // (the tile map: two tiles a texel, a tile's number in two bytes; 0 is the empty tile)
    for (let ty = Math.max(0, Math.floor((y - org[1]) / T)); ty < t.h && ty * T + org[1] < y + h; ty++) {
        for (let tx = Math.max(0, Math.floor((x - org[0]) / T)); (tx >> 1) < t.w && tx * T + org[0] < x + w; tx++) {
            const at = (ty * t.w + (tx >> 1)) * 4 + (tx & 1) * 2;
            if (t.px[at] || t.px[at + 1]) add(tx * T + org[0], ty * T + org[1], (tx + 1) * T + org[0], (ty + 1) * T + org[1]);
        }
    }
    (keep || []).forEach((r) => add(Math.floor(r[0]), Math.floor(r[1]), Math.ceil(r[2]), Math.ceil(r[3])));
    x0 = Math.max(x, x0); y0 = Math.max(y, y0); x1 = Math.min(x + w, x1); y1 = Math.min(y + h, y1);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x, y, w, h };
}

/** A rectangle of the picture: set A (the sides) or B (the centre panel). */
function art(key, kind, x, y, w, h, set, o) {
    o = o || {};
    const centre = set === B;
    // (a bar gauge's rectangle is its own: what it lights is not in the picture)
    if (kind !== 'm340bar') ({ x, y, w, h } = drawn(set, x, y, w, h, o.keep));
    return Object.assign({
        key, kind, x, y, w, h, textures: Object.assign({}, set, o.textures),
        params: Object.assign({ u_off: [x, y], u_org: [centre ? M.centre[0] : M.sides[0], centre ? M.centre[1] : M.sides[1], centre ? M.node : 0, o.cut ? 1 : 0] }, HEX(o.hex), o.params),
    }, o.more);
}

/** A bracket with its reading: k 'speed' or 'rpm'. */
function side(k, x, y, w, h, hex) {
    const col = k === 'speed' ? 0 : 1, tk = M.ticks[k], g = M.fillGrad, boxes = M.boxes[k];
    const frac = k === 'speed' ? (d) => speedFrac(mph(d)) : rpmFrac;
    return art(k + 'Side', 'm340side', x, y, w, h, A, {
        // (the numerals' lit forms are larger than the numerals: their places stay in the rectangle)
        hex, textures: { u_edges: ART.tex('edges') }, keep: boxes.map((b) => b.slice(0, 4)),
        params: {
            u_tkA: tk.slice(0, 4), u_tkB: tk.slice(4, 8), u_tkC: [tk[8], 816 * M.scale + M.origin[1]],
            u_fill: [col, g.y[0], g.y[1], M.capHalf], u_box: [0, 0, 0, 0], u_boxTo: [0, 0, 0],
        },
        more: {
            // (glide: the cluster plays the fill's motion between the car's readings, at its own frame rate)
            value: frac, max: 1, sweep: true, glide: true,
            colors: () => ({ c0: g[k][0][1], c1: g[k][1][1] }),
            // the last numeral the reading has reached lit (1 from 1000 rpm up to 1999); with the engine off the revs' 0
            // blank (READY stands there)
            dyn: (d) => {
                if (k === 'rpm' && !running(d)) return { u_box: [M.cover[0], M.cover[1], M.cover[0] + M.cover[2], M.cover[1] + M.cover[3]], u_boxTo: [0, 0, 2] };
                const b = boxes[Math.max(0, Math.min(8, Math.floor(frac(d) * 8 + 1e-6)))];
                return { u_box: b.slice(0, 4), u_boxTo: [b[4], b[5], 1] };
            },
        },
    });
}

/** A bar gauge with its reading: 'fuel' or 'oil'. row(d): the reading's row. */
function bar(k, row, over) {
    const segs = M[k].segs, s0 = segs[0];
    // over the map the gauge's own picture is drawn with it; otherwise only the lit segments, in the box round them
    const xs = [].concat(...segs).map((p) => p[0]), ys = [].concat(...segs).map((p) => p[1]);
    const bx = Math.floor(Math.min(...xs)) - 1, by = Math.floor(Math.min(...ys)) - 1;
    const r = over ? M.over[k] : [bx, by, Math.ceil(Math.max(...xs)) + 1 - bx, Math.ceil(Math.max(...ys)) + 1 - by];
    return art(k + 'Bar', 'm340bar', r[0], r[1], r[2], r[3], A, {
        cut: over,
        params: {
            u_bar: [s0[0][0], s0[0][1], (s0[3][0] - s0[0][0]) / (s0[3][1] - s0[0][1]), s0[1][0] - s0[0][0]],
            u_segA: [segs[0][0][1], segs[0][3][1], segs[1][0][1], segs[1][3][1]], u_segB: [segs[2][0][1], segs[2][3][1], segs[3][0][1], segs[3][3][1]],
            u_lvl: [segs[3][3][1] + 2, M.barGradLen],
        },
        more: Object.assign({ dyn: (d) => ({ u_lvl: [Math.round(row(d) * 10) / 10, M.barGradLen] }) }, over ? { z: OVER_MAP, overMap: true } : {}),
    });
}

/**
 * A line of the design's lettering, one layer: its glyphs set as the prototype sets them (drawText: the pens a
 * glyph's advance apart, the ink's ends at the anchor), each pen on a whole pixel, and sent as one uniform (u_g).
 * A glyph with one place in the design (READY, the gear) is baked at that place's fraction of a pixel (its fx),
 * so there the cluster shows the design's very pixels.
 * Up to six glyphs, or eighteen with o.max over six (the drive mode's name). say(d): the text; at: { x, base }
 * on the cluster; align 'start' | 'middle' | 'end'; room: px.
 */
function line(key, set, at, align, room, say, colour, o) {
    o = o || {};
    const G = M.glyphs[set], slots = (o.max || 6) > 6 ? 18 : 6;
    const x = Math.round(align === 'middle' ? at.x - room / 2 : align === 'end' ? at.x - room + 8 : at.x - 8), y = Math.round(at.base) + G.oy;
    const place = (d) => {
        const said = say(d), str = String(said === undefined || said === null ? '' : said);
        const out = [], u = new Array(slots * 4).fill(0);
        let pen = 0, first = null, inkR = 0;
        // (a set of whole words, am / pm and READY, has the word as one glyph)
        for (const ch of (G.g[str] ? [str] : str)) {
            const g = G.g[ch];
            if (!g) { pen += G.space || 0; continue; }
            if (first === null) first = pen + g.inkL;
            inkR = pen + g.inkR;
            out.push([g, pen]);
            pen += g.adv;
        }
        if (!out.length) return u;
        const start = (align === 'middle' ? at.x - (inkR - first) / 2 : align === 'end' ? at.x - (inkR - first) : at.x) - first + (o.shift ? o.shift(d) : 0);
        out.slice(0, slots).forEach(([g, p], i) => { u[i * 4] = g.x; u[i * 4 + 1] = g.y; u[i * 4 + 2] = g.w; u[i * 4 + 3] = Math.round(start + p - (g.fx || 0)) + g.ox - x; });
        return u;
    };
    // a longer line in layers of six glyphs, each the line's six from k * 6: the one shader of eighteen (m340words)
    // showed dashes for the drive mode on a car (Nov 2026), likely 18 vec4s past what the cluster's GPU takes
    return [0, 1, 2].slice(0, slots / 6).map((k) => Object.assign({
        key: k ? key + '_' + k : key, kind: 'm340glyphs', x, y, w: room, h: G.h, textures: { u_sheet: ART.tex('glyphs') },
        params: { u_g: new Array(24).fill(0) },
        colors: (t, d) => ({ color: [typeof colour === 'function' ? colour(t, d) : t[colour], 1] }),
        dyn: (d) => ({ u_g: place(d).slice(k * 24, k * 24 + 24) }),
        says: k ? undefined : say,
    }, o.more));
}
/**
 * Now playing: the song the car's media player shows (data.js d.media, from the head unit's media state), in the
 * centre panel under the speed and the gear: its title, then artist and album, then how long it has played (counted
 * from when the song changed: the car gives no position or length). The two text lines are drawn on the head unit
 * in the kit's fonts (any script) and sent as pictures when the song changes ('m340text', live).
 */
/* the song: the title over the artist (Pirulen, baked for the head unit's canvas: pir), with its cover art when one
 * is found (Settings > Cover art), as one picture drawn on the head unit at each change, centred on the display, low in the centre panel; over the map, along the bottom
 * edge of its window, where the map has faded out */
const NP = { x: 560, y: 488, w: 800, h: 64, title: 24, sub: 16 };
const NP_MAP = { x: 610, y: 568, w: 700, h: 40, title: 17, sub: 12 };   // (under the phone's safe area, y 200 to 568 on the panel: Waze's turn card is drawn in it)
let Canvas = null;
/** A line of text as one byte a pixel (its coverage), w x h, centred (left: from the left), cut with "..." when too long. */
function textPx(str, w, h, size, font, left) {
    if (!Canvas) Canvas = require('./kit/canvas').Canvas;
    const cv = new Canvas(w, h), o = { font, literal: true };
    let s = String(str);
    if (cv.textWidth(s, size, o) > w - 8) {
        while (s.length > 1 && cv.textWidth(s + '...', size, o) > w - 8) s = s.slice(0, -1);
        s = s.replace(/\s+$/, '') + '...';
    }
    cv.text(s, left ? 2 : w / 2, Math.round(h * 0.5 + size * 0.36), size, '#ffffff', Object.assign({ align: left ? 'left' : 'center' }, o));
    const px = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) px[i] = cv.d[i * 4 + 3];
    return px;
}
/*
 * The next turn while a route runs (data.js d.nav, from directions.js / nav.js): an arrow, the distance and the road,
 * drawn on the head unit as one picture when the turn or its distance changes ('m340text', live), at the top of the
 * centre, over the map.
 */
const DIR = { x: 640, y: 10, w: 640, h: 104 };   // (the top middle, the badge's place: the badge shows when no route runs)
/** The arrow's bend in degrees (0 straight on, negative to the left), or null: no arrow (a roundabout, the destination). */
function turnAngle(m) {
    const d = String(m.dir || ''), left = /LEFT/.test(d), right = /RIGHT/.test(d), side = left ? -1 : right ? 1 : 0;
    if (m.kind === 'turn') {
        if (/UTURN/.test(d)) return side * 180;
        if (/SLIGHT/.test(d)) return side * 45;
        if (/HARD/.test(d)) return side * 135;
        return d === 'STRAIGHT_ON' || !side ? 0 : side * 90;
    }
    if (m.kind === 'branch' || m.kind === 'keep' || m.kind === 'lanechange') return side * (m.kind === 'branch' ? 45 : 30);
    if (m.kind === 'roundabout' || m.kind === 'destination') return null;
    return 0;
}
/** The turn's arrow in an s x s box at (x, y) on cv, white. */
function drawArrow(cv, m, x, y, s) {
    const c = '#ffffff', W = Math.round(s * 0.13), cx = x + s / 2, base = y + s * 0.95;
    const head = (tx, ty, a) => {   // a triangle pointing along angle a (degrees, 0 up), its tip at (tx, ty)
        const r = a * Math.PI / 180, ux = Math.sin(r), uy = -Math.cos(r), L = s * 0.3, H = s * 0.22;
        cv.triangle([[tx, ty], [tx - ux * L - uy * H, ty - uy * L + ux * H], [tx - ux * L + uy * H, ty - uy * L - ux * H]], c);
    };
    if (m.kind === 'destination') {   // a pin
        cv.circle(cx, y + s * 0.35, s * 0.24, c); cv.triangle([[cx - s * 0.2, y + s * 0.47], [cx + s * 0.2, y + s * 0.47], [cx, y + s * 0.92]], c);
        return;
    }
    if (m.kind === 'roundabout') {   // the ring, the way in from below, the exit's number in the ring
        cv.arc(cx, y + s * 0.42, s * 0.22, s * 0.34, 0, 360, c);
        cv.line(cx, base, cx, y + s * 0.76, W, c);
        if (m.exit) cv.text(String(m.exit), cx, y + s * 0.42 + s * 0.12, Math.round(s * 0.32), c, { font: 'pir', align: 'center', literal: true });
        return;
    }
    const a = turnAngle(m), mid = y + s * 0.5;
    if (Math.abs(a) >= 180) {   // a U-turn: up, over and down
        const x2 = cx + (a < 0 ? -1 : 1) * s * 0.32;
        cv.line(cx, base, cx, y + s * 0.3, W, c);
        // (the top half of a ring between the two legs)
        cv.arc((cx + x2) / 2, y + s * 0.3, s * 0.16 - W / 2, s * 0.16 + W / 2, 270, 360, c);
        cv.arc((cx + x2) / 2, y + s * 0.3, s * 0.16 - W / 2, s * 0.16 + W / 2, 0, 90, c);
        cv.line(x2, y + s * 0.3, x2, y + s * 0.62, W, c);
        head(x2, y + s * 0.86, 180);
        return;
    }
    const r = a * Math.PI / 180, L = s * 0.36, ex = cx + Math.sin(r) * L, ey = mid - Math.cos(r) * L;
    cv.line(cx, base, cx, mid, W, c);
    cv.line(cx, mid, ex - Math.sin(r) * s * 0.1, ey + Math.cos(r) * s * 0.1, W, c);
    head(ex + Math.sin(r) * s * 0.06, ey - Math.cos(r) * s * 0.06, a);
}
/** The turn as one byte a pixel: the arrow, then the distance (large) over the road, the whole centred. */
function dirPx(m, w, h) {
    if (!Canvas) Canvas = require('./kit/canvas').Canvas;
    const cv = new Canvas(w, h), s = h - 8, gap = 18;
    const dist = m.dist ? m.dist + ' ' + m.unit : '', road = m.road || (m.kind === 'destination' ? 'Destination' : '');
    const big = 40, small = 20, fb = { font: 'pir', literal: true }, fl = { font: 'pir', literal: true };
    const room = w - s - gap - 8;
    let r = road;
    if (r && cv.textWidth(r, small, fl) > room) { while (r.length > 1 && cv.textWidth(r + '...', small, fl) > room) r = r.slice(0, -1); r = r.replace(/\s+$/, '') + '...'; }
    const tw = Math.min(room, Math.max(dist ? cv.textWidth(dist, big, fb) : 0, r ? cv.textWidth(r, small, fl) : 0));
    const x0 = Math.round((w - (s + gap + tw)) / 2);
    drawArrow(cv, m, x0, 4, s);
    const tx = x0 + s + gap;
    if (dist && r) { cv.text(dist, tx, Math.round(h * 0.52), big, '#ffffff', fb); cv.text(r, tx, Math.round(h * 0.86), small, '#ffffff', fl); }
    else cv.text(dist || r, tx, Math.round(h * 0.5 + big * 0.36), dist ? big : small, '#ffffff', dist ? fb : fl);
    const px = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) px[i] = cv.d[i * 4 + 3];
    return px;
}
/** The directions piece: the top middle, over everything (z). */
function directionsPiece(z) {
    let last = null;
    const draw = (d) => {
        const m = d.nav;
        if (!m) return null;
        const key = [m.kind, m.dir, m.exit, m.dist, m.unit, m.road].join('|');
        if (!last || last.key !== key) last = { key, px: dirPx(m, DIR.w, DIR.h) };
        return last;
    };
    return { key: 'directions', kind: 'm340text', x: DIR.x, y: DIR.y, w: DIR.w, h: DIR.h, live: { name: 'u_text', w: DIR.w, h: DIR.h, draw },
        colors: (t) => ({ color: [t.fg, 1] }), visible: (d) => !!d.nav, z, overMap: true, topMiddle: true };
}
/** The last 0-60 mph run (data.js d.zeroSixty), in the badge's place for a while after it: the time, and the best. */
function zeroSixtyPiece(z) {
    let last = null;
    const draw = (d) => {
        const r = d.zeroSixty;
        if (!r) return null;
        const key = r.s.toFixed(2) + '|' + (r.best || 0).toFixed(2);
        if (!last || last.key !== key) {
            if (!Canvas) Canvas = require('./kit/canvas').Canvas;
            const cv = new Canvas(DIR.w, DIR.h), f = { font: 'pir', literal: true, align: 'center' };
            cv.text('0-60 MPH  ' + r.s.toFixed(2) + ' S', DIR.w / 2, 52, 36, '#ffffff', f);
            cv.text(r.isBest ? 'NEW BEST' : 'BEST ' + r.best.toFixed(2) + ' S', DIR.w / 2, 88, 18, '#ffffff', f);
            const px = Buffer.alloc(DIR.w * DIR.h);
            for (let i = 0; i < px.length; i++) px[i] = cv.d[i * 4 + 3];
            last = { key, px };
        }
        return last;
    };
    return { key: 'zeroSixty', kind: 'm340text', x: DIR.x, y: DIR.y, w: DIR.w, h: DIR.h, live: { name: 'u_text', w: DIR.w, h: DIR.h, draw },
        colors: (t) => ({ color: [t.fg, 1] }), visible: (d) => !!d.zeroSixty && !d.nav, z, overMap: true, topMiddle: true };
}
/** The song card as RGBA w x h: the title over the artist (and album), the whole centred across; with the cover art
 * (d.media.art: 128 x 128 RGBA, cover.js) at the left of the lines, scaled to the card's height, its corners rounded. */
function cardPx(m, c) {
    if (!Canvas) Canvas = require('./kit/canvas').Canvas;
    const cv = new Canvas(c.w, c.h), f = { font: 'pir', literal: true }, art = m.art && m.art.px ? c.h - 4 : 0, gap = art ? Math.round(c.h * 0.22) : 0;
    const title = m.title || m.artist || '', sub = m.title ? [m.artist, m.album].filter(Boolean).join('  ·  ') : m.album || '';
    const room = c.w - 8 - art - gap;
    const fit = (str, size) => { let x = String(str); if (cv.textWidth(x, size, f) <= room) return x; while (x.length > 1 && cv.textWidth(x + '...', size, f) > room) x = x.slice(0, -1); return x.replace(/\s+$/, '') + '...'; };
    const t = fit(title, c.title), u = sub ? fit(sub, c.sub) : '';
    const tw = Math.max(cv.textWidth(t, c.title, f), u ? cv.textWidth(u, c.sub, f) : 0);
    const x0 = Math.round((c.w - (art + gap + tw)) / 2);
    if (art) {
        // the cover, from 128 (box filter) into place, corners rounded
        const src = m.art.px, k = 128 / art, rad = art * 0.12, ay = Math.round((c.h - art) / 2);
        for (let y = 0; y < art; y++) for (let x = 0; x < art; x++) {
            const dx = Math.max(0, Math.abs(x + 0.5 - art / 2) - (art / 2 - rad)), dy = Math.max(0, Math.abs(y + 0.5 - art / 2) - (art / 2 - rad));
            const cover = Math.max(0, Math.min(1, rad + 0.5 - Math.hypot(dx, dy)));
            if (!cover) continue;
            let r = 0, g = 0, b = 0, n = 0;
            for (let sy = Math.floor(y * k); sy < Math.max(Math.floor(y * k) + 1, Math.floor((y + 1) * k)); sy++) for (let sx = Math.floor(x * k); sx < Math.max(Math.floor(x * k) + 1, Math.floor((x + 1) * k)); sx++) {
                const i = (sy * 128 + sx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
            }
            const o = ((ay + y) * c.w + x0 + x) * 4;
            cv.d[o] = r / n; cv.d[o + 1] = g / n; cv.d[o + 2] = b / n; cv.d[o + 3] = Math.round(255 * cover);
        }
    }
    // the lines: centred on the card without a cover, from the cover's right with one
    const tx = art ? x0 + art + gap : c.w / 2, al = Object.assign({ align: art ? 'left' : 'center' }, f);
    if (u) {
        cv.text(t, tx, Math.round(c.h * 0.48), c.title, '#ffffff', al);
        cv.text(u, tx, Math.round(c.h * 0.9), c.sub, '#a2abbb', al);
    } else cv.text(t, tx, Math.round(c.h / 2 + c.title * 0.36), c.title, '#ffffff', al);
    return Buffer.from(cv.d);
}
/** The song: the card (one RGBA picture, drawn again when the song changes). Hidden while a warning shows (it stands
 * in the same place). at.z: over the map. */
function nowPlaying(at) {
    let last = null;
    const draw = (d) => {
        const m = d.media;
        if (!m) return null;
        const key = [m.title, m.artist, m.album, m.art ? m.art.key : ''].join('|');
        if (!last || last.key !== key) last = { key, px: cardPx(m, at) };
        return last;
    };
    const show = (d) => !!d.media && !(d.warnings && d.warnings.length);
    return [{ key: 'npCard', kind: 'm340img', x: at.x, y: at.y, w: at.w, h: at.h, live: { name: 'u_img', w: at.w, h: at.h, format: 'rgba8', draw },
        params: { u_round: [0] }, visible: show, z: at.z, overMap: !!at.z }];
}

/*
 * The car's warnings (data.js d.warnings: Check Control's active messages, [{ name, red }]): a banner at the bottom
 * middle, red for a red message, amber else, over everything (the map too); the first message, and how many more.
 */
const WARN = { x: 560, y: 566, w: 800, h: 60 };
function warningPiece() {
    let last = null;
    const draw = (d) => {
        const ws = d.warnings || [];
        if (!ws.length) return null;
        const w0 = ws[0], key = ws.map((w) => w.name + (w.red ? '!' : '')).join('|');
        if (last && last.key === key) return last;
        if (!Canvas) Canvas = require('./kit/canvas').Canvas;
        const cv = new Canvas(WARN.w, WARN.h), f = { font: 'pir', literal: true }, col = w0.red ? '#ff3b4a' : '#ffb020';
        const text = String(w0.name).toUpperCase() + (ws.length > 1 ? '   +' + (ws.length - 1) : '');
        const size = 20, tw = Math.min(WARN.w - 120, cv.textWidth(text, size, f)), bw = tw + 96, bx = Math.round((WARN.w - bw) / 2);
        cv.roundRect(bx, 4, bw, WARN.h - 8, 12, [12, 14, 20, 235]);
        cv.roundRect(bx, 4, bw, WARN.h - 8, 12, [0, 0, 0, 0]);
        cv.fillRect(bx + 12, 12, 4, WARN.h - 24, col);
        // a warning triangle with its "!"
        const cx = bx + 46, cy = WARN.h / 2;
        cv.triangle([[cx, cy - 15], [cx - 17, cy + 13], [cx + 17, cy + 13]], col);
        cv.fillRect(cx - 2, cy - 6, 4, 11, '#0c0e14'); cv.fillRect(cx - 2, cy + 7, 4, 3, '#0c0e14');
        cv.text(text, bx + 76, Math.round(WARN.h / 2 + size * 0.36), size, '#ffffff', f);
        last = { key, px: Buffer.from(cv.d) };
        return last;
    };
    return { key: 'warning', kind: 'm340img', x: WARN.x, y: WARN.y, w: WARN.w, h: WARN.h, live: { name: 'u_img', w: WARN.w, h: WARN.h, format: 'rgba8', draw },
        params: { u_round: [0] }, visible: (d) => !!(d.warnings && d.warnings.length), z: OVER_MAP + 35, overMap: true };
}

/* the gear lever's place, bottom right (P R N D S M, the one selected lit; M in manual) */
const SEL = { x: 1664, base: 646, letters: 'PRNDSM' };   // (above the outside temperature)
function selectorPieces() {
    const G = M.glyphs.mode, str = SEL.letters.split('').join(' ');
    const sel = (d) => { const g = C.gearText(d); return /^M/.test(g) ? 'M' : /^[PRNDS]/.test(g) ? g[0] : ''; };
    // where each letter's ink starts, from the first's (the lit letter set alone, moved there)
    const offs = {}; let pen = 0, first = null;
    for (const ch of str) { const g = G.g[ch]; if (!g) { pen += G.space || 0; continue; } if (first === null) first = pen + g.inkL; offs[ch] = pen + g.inkL - first; pen += g.adv; }
    return [
        ...line('selAll', 'mode', SEL, 'start', 240, () => str, 'faint'),
        ...line('selLit', 'mode', SEL, 'start', 240, sel, 'fg', { shift: (d) => offs[sel(d)] || 0 }),
    ];
}

/*
 * The side gauges (Settings > Side gauges): an upright bar in each outer gap, beside the scales, its reading above
 * it and its unit below. boost: the turbo's pressure over the air's (psi); hp, torque: the engine's (FES torque, hp
 * from it and the revs), at the crank or the wheels (Settings > Power at: the crank's less the drivetrain's loss).
 */
const SIDE_G = { left: { x: 30, cx: 46 }, right: { x: 1858, cx: 1874 }, y: 304, w: 32, h: 268 };   // (below the top corners and the eDrive box)
const SIDE_KINDS = {
    boost: { max: 25, ticks: 5, unit: 'PSI', of: (d) => (isNum(d.boostActual) ? Math.max(0, d.boostActual * 14.5038) : null), fmt: (v) => v.toFixed(1), c: ['#0a3d8f', '#3cd7ff'] },
    hp: { max: 500, ticks: 5, unit: 'HP', of: null, fmt: (v) => String(Math.round(v)), c: ['#7a0d1a', '#ff4457'] },
    torque: { max: 500, ticks: 5, unit: 'LB-FT', of: null, fmt: (v) => String(Math.round(v)), c: ['#5a2a00', '#ffb020'] },
    oil: { min: 100, max: 320, ticks: 4, unit: 'OIL F', of: (d) => (isNum(d.oil) ? d.oil * 9 / 5 + 32 : null), fmt: (v) => String(Math.round(v)), c: ['#0a3d8f', '#ff4457'] },
    coolant: { min: 100, max: 260, ticks: 4, unit: 'H2O F', of: (d) => (isNum(d.coolant) ? d.coolant * 9 / 5 + 32 : null), fmt: (v) => String(Math.round(v)), c: ['#0a3d8f', '#ff4457'] },
    gforce: { max: 1.2, ticks: 4, unit: 'G', of: (d) => (isNum(d.gLong) || isNum(d.gLat) ? Math.hypot(d.gLong || 0, d.gLat || 0) : null), fmt: (v) => v.toFixed(2), c: ['#1d6b3a', '#3ddc84'] },
    speedkmh: { max: 250, ticks: 5, unit: 'KM/H', of: (d) => (isNum(d.speed) ? d.speed : null), fmt: (v) => String(Math.round(v)), c: ['#0a3d8f', '#3cd7ff'] },
};
/** A reading as a place along a gauge (0..1), from its kind's min (0 by default) to its max. */
const sideFrac = (K, v) => clamp01(((v || 0) - (K.min || 0)) / (K.max - (K.min || 0)));
/* the round gauges (Settings > Round gauge, left / right): beside the upright bars, low in each outer gap, between
 * the bar and the scale's lowest numbers */
const SIDE_D = { left: { cx: 122 }, right: { cx: 1798 }, cy: 530, r: 53 };
/** A side gauge's reading: its value (in its unit), as text, and its unit. */
function sideOf(kind, o) {
    const K = SIDE_KINDS[kind], wheel = o.powerAt === 'wheel', keep = 1 - (Number(o.drivetrainLoss) || 15) / 100;
    const crank = (d) => (isNum(d.torque) && d.torque > 0 ? d.torque : 0);
    const of = K.of || (kind === 'hp'
        ? (d) => (isNum(d.rpm) && isNum(d.torque) ? crank(d) * d.rpm / 7121 * (wheel ? keep : 1) : null)
        : (d) => (isNum(d.torque) ? crank(d) * 0.737562 * (wheel ? keep : 1) : null));
    return { of, unit: wheel && kind === 'hp' ? 'WHP' : wheel && kind === 'torque' ? 'WTQ' : K.unit };
}
function sideReading(kind, o, d) {
    const r = sideOf(kind, o), v = r.of(d);
    return { value: v, text: v === null ? '--' : SIDE_KINDS[kind].fmt(v), unit: r.unit };
}
function sideGauge(side, kind, o) {
    const K = SIDE_KINDS[kind], at = SIDE_G[side], { of, unit } = sideOf(kind, o);
    let lbl = null;
    const label = () => {
        if (lbl) return lbl;
        if (!Canvas) Canvas = require('./kit/canvas').Canvas;
        const cv = new Canvas(96, 28);
        cv.text(unit, 48, 20, 15, '#ffffff', { font: 'pir', literal: true, align: 'center' });
        const px = Buffer.alloc(96 * 28);
        for (let i = 0; i < px.length; i++) px[i] = cv.d[i * 4 + 3];
        return (lbl = { key: unit, px });
    };
    return [
        { key: 'side_' + side, kind: 'm340vbar', x: at.x, y: SIDE_G.y, w: SIDE_G.w, h: SIDE_G.h,
            params: { u_ticks: [K.ticks], u_track: hexRGB('#151c2a') }, colors: () => ({ c0: K.c[0], c1: K.c[1] }),
            value: (d) => sideFrac(K, of(d)), max: 1, glide: true },
        ...line('sideVal_' + side, 'small', { x: at.cx, base: SIDE_G.y - 12 }, 'middle', 110, (d) => { const v = of(d); return v === null ? '' : K.fmt(v); }, 'fg'),
        { key: 'sideUnit_' + side, kind: 'm340text', x: at.cx - 48, y: SIDE_G.y + SIDE_G.h + 8, w: 96, h: 28, live: { name: 'u_text', w: 96, h: 28, draw: label },
            colors: (t) => ({ color: [t.dim, 1] }) },
    ];
}
/** A side gauge as a dial: the ring, its reading in the middle and the unit below it. */
function sideDial(side, kind, o) {
    const K = SIDE_KINDS[kind], cx = SIDE_D[side].cx, R = SIDE_D.r, { of, unit } = sideOf(kind, o);
    let lbl = null;
    const label = () => {
        if (lbl) return lbl;
        if (!Canvas) Canvas = require('./kit/canvas').Canvas;
        const cv = new Canvas(96, 24);
        cv.text(unit, 48, 17, 13, '#ffffff', { font: 'pir', literal: true, align: 'center' });
        const px = Buffer.alloc(96 * 24);
        for (let i = 0; i < px.length; i++) px[i] = cv.d[i * 4 + 3];
        return (lbl = { key: unit, px });
    };
    return [
        { key: 'dial_' + side, kind: 'm340dial', x: cx - R, y: SIDE_D.cy - R, w: 2 * R, h: 2 * R,
            params: { u_ticks: [K.ticks], u_track: hexRGB('#151c2a') }, colors: () => ({ c0: K.c[0], c1: K.c[1] }),
            value: (d) => sideFrac(K, of(d)), max: 1, glide: true },
        ...line('dialVal_' + side, 'small', { x: cx, base: SIDE_D.cy + 7 }, 'middle', 84, (d) => { const v = of(d); return v === null ? '' : K.fmt(v); }, 'fg'),
        { key: 'dialUnit_' + side, kind: 'm340text', x: cx - 48, y: SIDE_D.cy + 14, w: 96, h: 24, live: { name: 'u_text', w: 96, h: 24, draw: label },
            colors: (t) => ({ color: [t.dim, 1] }) },
    ];
}
const hexRGB = (h) => [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) / 255 * 1000) / 1000);

/** Where a line's ink ends on the cluster (the am / pm follows the time). */
function inkEnd(set, at, str) {
    const G = M.glyphs[set];
    let pen = 0, first = null, inkR = 0;
    for (const ch of String(str)) { const g = G.g[ch]; if (!g) continue; if (first === null) first = pen + g.inkL; inkR = pen + g.inkR; pen += g.adv; }
    return first === null ? at.x : at.x + inkR - first;
}

module.exports = {
    id: 'm340',
    title: 'M340i Sport',
    font: 'wide',
    noFont: true,           // (its lettering is the design's own, on its glyph sheet: the engine's glyph atlas is not sent)
    assets: 12,              // (what it sends instead: two tile maps, two atlases, two palettes, the channel edges, the glyph sheet)  (+4: the song's card, the next turn, the 0-60 time, the warning; with the side gauges +1 each)
    startKB: 680,           // (about 640 KB once, most of it the picture; a plain 1920x720 picture would be 5400)
    stripGear: true,
    stripFuel: false,
    ownStripGauges: true,
    mapWindow: WINDOW,
    speedGauge: true,
    _speedFrac: speedFrac,
    sideReading, SIDE_KINDS,
    gearShort: true,        // (D or S alone, the number alone in manual: tools/test_engine.js)
    palette: pal,
    gearText: gearShort,

    pieces(o) {
        const strip = C.strip(o), map = o.centre === 'map', stock = o.centre === 'stock' && !strip;
        // (over the car's strip the middle ends above the design's bottom-centre shapes, which the strip would cut through)
        const bottom = strip ? C.STRIP_Y : 720, low = strip ? 632 : 720;
        const W2 = WINDOW;
        const list = map ? [{ x: 0, y: 0, w: 1920, h: W2.y }, { x: 0, y: W2.y + W2.h, w: 1920, h: 720 - W2.y - W2.h }, { x: 0, y: W2.y, w: W2.x, h: W2.h },
            { x: W2.x + W2.w, y: W2.y, w: 1920 - W2.x - W2.w, h: W2.h }].map((r, i) => C.flat('bg' + i, r.x, r.y, r.w, r.h, 'bg'))
            : stock ? [C.flat('bgL', 0, 0, 566, 720, 'bg'), C.flat('bgR', 1104, 0, 816, 720, 'bg')] : [C.flat('bg', 0, 0, 1920, 720, 'bg')];
        const top = 80, cx0 = M.centre[0], cx1 = M.centre[0] + M.centre[2], cy0 = M.centre[1], cy1 = M.centre[1] + M.centre[3];
        // the brackets with their readings, either side of the centre panel
        const lx1 = stock ? 566 : 608, rx0 = 1312;
        list.push(side('speed', 96, top, lx1 - 96, bottom - top, map), side('rpm', rx0, top, 1872 - rx0, bottom - top, map));
        if (!stock) {
            // between them: the brackets' top lines, and the bottom line with its glow (the bottom row, full screen)
            list.push(art('artTop', 'm340art', lx1, 112, rx0 - lx1, 32, A, { hex: map }), art('artBottom', 'm340art', lx1, 592, rx0 - lx1, low - 592, A, { hex: map }));
            // the centre panel (the map takes its place)
            if (!map) list.push(art('artCentre', 'm340art', cx0, cy0, cx1 - cx0, cy1 - cy0, B, { more: { z: -85 } }));
        } else list.push(art('artTop', 'm340art', 1104, 112, rx0 - 1104, 32, A), art('artBottom', 'm340art', 1104, 592, rx0 - 1104, low - 592, A));
        if (map) {
            // the map's feathered edges, then what the design keeps over the map: the gauges, the speed's unit
            const u = M.over.unit;
            // (the brackets' feet reach into the map's window below the hexagon: drawn again over the map there)
            const fy0 = 536, over = (k, x) => Object.assign(side(k, x, fy0, 48, W2.y + W2.h - fy0, true), { key: k + 'Foot', z: OVER_MAP, overMap: true });
            list.push({ key: 'mapVeil', kind: 'm340veil', x: W2.x, y: W2.y, w: W2.w, h: W2.h, textures: { u_veil: ART.tex('veil') }, params: { u_gain: [VEIL_GAIN] }, overMap: true },
                over('speed', W2.x), over('rpm', W2.x + W2.w - 48),
                art('unitOver', 'm340art', u[0], u[1], u[2], u[3], A, { cut: true, more: { z: OVER_MAP, overMap: true } }));
        }
        const fy = M.fuel.y;
        list.push(bar('fuel', (d) => (isNum(d.fuelPct) ? fy[0] + (fy[1] - fy[0]) * clamp01(d.fuelPct / 100) : fy[0] + 2), map),
            bar('oil', (d) => (isNum(d.oil) ? rowAt(M.oil.marks, d.oil * 9 / 5 + 32) : M.oil.marks[0][1] + 2), map));
        // the figures
        const up = map ? { more: { z: OVER_MAP + 10, overMap: true } } : {};
        list.push(...line('speedDigits', 'speed', M.at.speed, 'middle', 264, (d) => (isNum(d.speed) ? String(Math.round(mph(d))) : ''), 'fg', up),
            // (full screen the KOMBI keeps its own dark box where the design has the gear, x 1410 on: the gear left of it)
            // (and on an M car above its right-hand box)
            ...line('gear', 'gear', strip ? M.at.gear : { x: 1346, base: C.mCar(o) ? 300 : M.at.gear.base }, 'middle', 112, gearShort, 'fg', up),
            ...line('ready', 'ready', M.at.ready, 'start', 100, () => 'READY', 'ready', { more: { visible: (d) => !running(d) } }));
        if (!strip) {
            // the design's bottom row (the car's own strip shows these otherwise)
            const t = M.at.time, rMax = M.at.range.x + 10;
            const rangeTxt = (d) => (isNum(d.frange) ? String(Math.round(d.frange / KMH_PER_MPH)) : '');
            list.push(...line('clockDigits', 'small', t, 'start', 150, () => clockNow().hm, 'dim'),
                ...line('clockHalf', 'ampm', t, 'start', 220, () => clockNow().half, 'dim', { shift: () => inkEnd('small', t, clockNow().hm) - t.x + t.gap }),
                // (the range ends where the design ends it; a figure too wide for that, which would run into the fuel
                // pump's picture (it ends at x 400), moves right towards the "mi" instead, up to 10 px)
                ...line('rangeDigits', 'small', { x: rMax, base: M.at.range.base }, 'end', 110, rangeTxt, 'dim',
                    { shift: (d) => Math.min(rMax, Math.max(M.at.range.x, 406 + inkEnd('small', { x: 0 }, rangeTxt(d)))) - rMax }),
                ...line('outsideDigits', 'small', M.at.temp, 'end', 180, (d) => { if (!isNum(d.outside)) return ''; const f = d.outside * 9 / 5 + 32; return (f < 0 ? '-' : '+') + Math.abs(f).toFixed(1); }, 'dim'),
                // (the drive mode centred on the design's blue blocks at the bottom middle, as the owner asked: a stock
                // warning light there, when one shows, comes over it)
                ...line('driveName', 'mode', { x: M.at.mode.x, base: MODE_BASE }, 'middle', 440, modeName, modeColour, { max: 18, more: { overTelltales: true } }));
        }
        // the next turn while a route runs, at the top of the centre (Settings > Directions)
        if (!stock && o.directions !== 'off') list.push(directionsPiece(OVER_MAP + 30));
        // the last 0-60 mph run, for a while after it (a route's turn comes first)
        if (!stock) list.push(zeroSixtyPiece(OVER_MAP + 30));
        // the song playing, in the centre panel; over the map, one line along its bottom edge, where the map has
        // faded out (the top middle is under the cowl) (Settings > Now playing)
        if (!stock && o.nowPlaying !== 'off') {
            list.push(...nowPlaying(map ? Object.assign({ z: OVER_MAP + 30 }, NP_MAP) : NP));
        }
        // the car's warnings, over everything at the bottom middle
        if (!stock) list.push(warningPiece());
        // the gear lever's place, bottom right (with the layout's own bottom row)
        if (!strip) list.push(...selectorPieces());
        // the side gauges (Settings > Side gauges)
        if (o.sideLeft && o.sideLeft !== 'off' && SIDE_KINDS[o.sideLeft]) list.push(...sideGauge('left', o.sideLeft, o));
        if (o.sideRight && o.sideRight !== 'off' && SIDE_KINDS[o.sideRight]) list.push(...sideGauge('right', o.sideRight, o));
        // the round gauges beside them (Settings > Round gauge, left / right)
        if (o.dialLeft && o.dialLeft !== 'off' && SIDE_KINDS[o.dialLeft]) list.push(...sideDial('left', o.dialLeft, o));
        if (o.dialRight && o.dialRight !== 'off' && SIDE_KINDS[o.dialRight]) list.push(...sideDial('right', o.dialRight, o));
        if (stock) return list.filter((p) => p.kind === 'flat' || p.x + p.w <= 566 || p.x >= 1104);
        return list;
    },
};
