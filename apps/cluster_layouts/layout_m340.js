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
const VEIL_GAIN = 2;          // the map's faded edges: the design's fade, half as wide (the map brighter)
const OVER_MAP = 960;        // over Waze on cluster's map layer (its kWindowZ, 900) and the veil (950)

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
    return [Object.assign({
        key, kind: slots > 6 ? 'm340words' : 'm340glyphs', x, y, w: room, h: G.h, textures: { u_sheet: ART.tex('glyphs') },
        params: { u_g: new Array(slots * 4).fill(0) },
        colors: (t, d) => ({ color: [typeof colour === 'function' ? colour(t, d) : t[colour], 1] }),
        dyn: (d) => ({ u_g: place(d) }),
        says: say,
    }, o.more)];
}
/**
 * Now playing: the song the car's media player shows (data.js d.media, from the head unit's media state), in the
 * centre panel under the speed and the gear: its title, then artist and album, then how long it has played (counted
 * from when the song changed: the car gives no position or length). The two text lines are drawn on the head unit
 * in the kit's fonts (any script) and sent as pictures when the song changes ('m340text', live).
 */
/* the song: its artwork at the left, the title and the artist beside it (Titillium Web, baked for the head unit's canvas:
 * tw, twb), the time played below; in the centre panel, or along the bottom of the map's window over the map */
const NP = { art: { x: 670, y: 430, s: 124 }, x: 812, w: 448, title: { y: 430, h: 56, size: 42, font: 'twb' }, sub: { y: 488, h: 40, size: 28, font: 'tw' }, timeBase: 558 };
const NP_MAP = { art: { x: 664, y: 526, s: 76 }, x: 758, w: 500, title: { y: 526, h: 42, size: 30, font: 'twb' }, sub: { y: 566, h: 34, size: 22, font: 'tw' } };
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
        if (m.exit) cv.text(String(m.exit), cx, y + s * 0.42 + s * 0.12, Math.round(s * 0.32), c, { font: 'twb', align: 'center', literal: true });
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
    const big = 50, small = 26, fb = { font: 'twb', literal: true }, fl = { font: 'tw', literal: true };
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
/** A now-playing text piece: say(media) its text, from the left of `at` (a card: NP or NP_MAP; at.z over the map). */
function npText(key, row, say, colour, at) {
    const X = at.x, Wd = at.w;
    let last = null;
    const draw = (d) => {
        const str = d.media ? say(d.media) : '';
        if (!str) return null;
        if (!last || last.key !== str) last = { key: str, px: textPx(str, Wd, row.h, row.size, row.font, true) };
        return last;
    };
    return { key, kind: 'm340text', x: X, y: row.y, w: Wd, h: row.h, live: { name: 'u_text', w: Wd, h: row.h, draw },
        colors: (t) => ({ color: [t[colour], 1] }), visible: (d) => !!(d.media && say(d.media)), z: at && at.z, overMap: !!(at && at.z) };
}
/** The artwork's placeholder (no artwork found): a dark tile with a note. */
let notePx = null;
function placeholderPx(s) {
    if (notePx) return notePx;
    if (!Canvas) Canvas = require('./kit/canvas').Canvas;
    const cv = new Canvas(s, s).clear('#1b2433'), c = '#7d8aa3';
    cv.circle(s * 0.38, s * 0.66, s * 0.1, c); cv.circle(s * 0.66, s * 0.6, s * 0.1, c);
    cv.line(s * 0.47, s * 0.66, s * 0.47, s * 0.3, s * 0.05, c); cv.line(s * 0.75, s * 0.6, s * 0.75, s * 0.24, s * 0.05, c);
    cv.line(s * 0.47, s * 0.3, s * 0.75, s * 0.24, s * 0.07, c);
    notePx = { key: 'note', px: Buffer.from(cv.d) };
    return notePx;
}
/** The song's artwork (data.js d.media.art: 128 x 128 RGBA, artwork.js), its corners rounded; the placeholder without. */
function npArt(at) {
    const S = 128, a = at.art;
    const draw = (d) => (d.media ? (d.media.art || placeholderPx(S)) : null);
    return { key: 'npArt', kind: 'm340img', x: a.x, y: a.y, w: a.s, h: a.s, live: { name: 'u_img', w: S, h: S, format: 'rgba8', draw },
        params: { u_round: [Math.round(a.s * 0.1)] }, visible: (d) => !!d.media, z: at.z, overMap: !!at.z };
}
function nowPlaying(at) {
    const time = (d) => { if (!d.media) return ''; const e = Math.floor(d.media.elapsed); return Math.floor(e / 60) + ':' + String(e % 60).padStart(2, '0'); };
    return [
        npArt(at),
        npText('npTitle', at.title, (m) => m.title || m.artist, 'fg', at),
        npText('npSub', at.sub, (m) => (m.title ? [m.artist, m.album].filter(Boolean).join('  ·  ') : m.album), 'dim', at),
        ...(at.timeBase ? line('npTime', 'small', { x: at.x + 2, base: at.timeBase }, 'start', 140, time, 'dim', { more: { visible: (d) => !!d.media } }) : []),
    ];
}

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
    assets: 13,              // (what it sends instead: two tile maps, two atlases, two palettes, the channel edges, the glyph sheet)  (+5: the song's two text lines and its artwork, the next turn, the badge)
    startKB: 680,           // (about 640 KB once, most of it the picture; a plain 1920x720 picture would be 5400)
    stripGear: true,
    stripFuel: false,
    ownStripGauges: true,
    mapWindow: WINDOW,
    speedGauge: true,
    _speedFrac: speedFrac,
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
                // (the drive mode a little above the design's place, clear of the stock warning lights along the bottom middle, y 652 on)
                ...line('driveName', 'mode', { x: M.at.mode.x, base: 648 }, 'middle', 440, modeName, modeColour, { max: 18 }));
        }
        // the next turn while a route runs, at the top of the centre (Settings > Directions)
        if (!stock && o.directions !== 'off') list.push(directionsPiece(OVER_MAP + 30));
        // the badge, top middle between the brackets' top lines (the G20's glass shows the top middle whole)
        if (o.badge !== 'off') {
            const b = require('./m340_badge');
            list.push({ key: 'badge', kind: 'm340text', x: 960 - Math.round(b.BADGE.w / 2), y: 70, w: b.BADGE.w, h: b.BADGE.h, textures: { u_text: b.tex() },
                colors: (t) => ({ color: [t.fg, 1] }), z: OVER_MAP + 20, overMap: true, topMiddle: true,
                // (a route's next turn stands in its place)
                visible: (d) => !(o.directions !== 'off' && d.nav) });
        }
        // the song playing, in the centre panel; over the map, one line along its bottom edge, where the map has
        // faded out (the top middle is under the cowl) (Settings > Now playing)
        if (!stock && o.nowPlaying !== 'off') {
            list.push(...nowPlaying(map ? Object.assign({ z: OVER_MAP + 30 }, NP_MAP) : NP));
        }
        if (stock) return list.filter((p) => p.kind === 'flat' || p.x + p.w <= 566 || p.x >= 1104);
        return list;
    },
};
