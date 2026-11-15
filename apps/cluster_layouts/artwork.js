'use strict';
/**
 * artwork.js - the playing song's artwork, for the cluster's now-playing card: the picture the head unit itself
 * shows, found where it keeps it, as SIZE x SIZE RGBA.
 *
 * Nothing in the car's media state (HmiMediaState) is known to carry the artwork, and where the head unit keeps the
 * pictures it shows is not known either. So, after each change of song (SETTLE_MS later, once the head unit has the
 * new picture), this looks for it:
 *   1. a file named in the media state's own values (a path or file: URL to an image), if any;
 *   2. the folder the last artwork was found in (kept in dataDir/artwork.json across starts);
 *   3. else the folders an app may read (ROOTS, to DEPTH levels), for a JPEG or PNG written since the song changed,
 *      a few thousand entries at most, a slice at a time (the head unit stays responsive).
 * Each search's outcome is logged and shown on the Signals screen (status()), so where the pictures are is known
 * from the first song on a car.
 *
 *   const art = createArtwork({ dataDir, log });   // (roots, settleMs: the tests')
 *   art.song(key, raw)   // the song changed (raw: the media state's values, searched for a path)
 *   art.now()            // { key, px } (SIZE*SIZE*4 bytes) or null;  art.status() // one line
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SETTLE_MS = 2500, AGAIN_MS = 6000, RECENT_MS = 20000;
const ROOTS = ['/var/opt', '/tmp', '/var/tmp', '/run', '/dev/shm', '/var/cache', '/var/lib', '/var/volatile', '/opt', '/mnt', '/media', '/home'];
const SKIP = /^\/(proc|sys|dev\/(?!shm))|\/(\.git|node_modules|lost\+found)(\/|$)/;
const DEPTH = 6, MAX_ENTRIES = 25000, SLICE = 300;
const MIN_BYTES = 1500, MAX_BYTES = 4 * 1024 * 1024;

/** A file's kind from its first bytes: 'jpeg', 'png' or null. */
function kindOf(b) {
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    return null;
}

/** A PNG's pixels as RGBA (8 bits a channel, not interlaced; grey, grey+alpha, RGB, RGBA, palette), or null. */
function decodePng(buf) {
    let p = 8, w = 0, h = 0, depth = 0, ct = 0, il = 0, plte = null, trns = null;
    const idat = [];
    while (p + 8 <= buf.length) {
        const n = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8), d = buf.slice(p + 8, p + 8 + n);
        if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; il = d[12]; }
        else if (t === 'PLTE') plte = d;
        else if (t === 'tRNS') trns = d;
        else if (t === 'IDAT') idat.push(d);
        else if (t === 'IEND') break;
        p += 12 + n;
    }
    if (!w || !h || depth !== 8 || il || w * h > 4096 * 4096) return null;
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!ch) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(w * h * 4);
    let prev = Buffer.alloc(stride), q = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[q++], line = Buffer.from(raw.slice(q, q + stride)); q += stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
            let v = line[i];
            if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            line[i] = v & 255;
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, s = x * ch;
            if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = 255; }
            else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = line[s]; out[o + 3] = line[s + 1]; }
            else if (ct === 2) { out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255; }
            else if (ct === 6) line.copy(out, o, s, s + 4);
            else { const k = line[s]; out[o] = plte[k * 3]; out[o + 1] = plte[k * 3 + 1]; out[o + 2] = plte[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
        }
        prev = line;
    }
    return { width: w, height: h, data: out };
}

/** RGBA w x h to SIZE x SIZE, its middle square, each pixel the average of the source pixels it covers. */
function square(img) {
    const { width: w, height: h, data } = img, side = Math.min(w, h), x0 = (w - side) >> 1, y0 = (h - side) >> 1;
    const out = Buffer.alloc(SIZE * SIZE * 4), k = side / SIZE;
    for (let y = 0; y < SIZE; y++) {
        const sy0 = y0 + Math.floor(y * k), sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * k));
        for (let x = 0; x < SIZE; x++) {
            const sx0 = x0 + Math.floor(x * k), sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * k));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = sy0; sy < sy1; sy += sy1 - sy0 > 4 ? 2 : 1) {
                for (let sx = sx0; sx < sx1; sx += sx1 - sx0 > 4 ? 2 : 1) {
                    const i = (sy * w + sx) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
                }
            }
            const o = (y * SIZE + x) * 4;
            out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
        }
    }
    return out;
}

/** A file's picture as SIZE x SIZE RGBA, or null (not an image, too small, too big, not decodable). */
function load(file) {
    let buf;
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size < MIN_BYTES || st.size > MAX_BYTES) return null;
        buf = fs.readFileSync(file);
    } catch (e) { return null; }
    const k = kindOf(buf);
    try {
        const img = k === 'jpeg' ? require('./jpeg_decode')(buf, { formatAsRGBA: true, maxMemoryUsageInMB: 64, tolerantDecoding: true })
            : k === 'png' ? decodePng(buf) : null;
        if (!img || img.width < 48 || img.height < 48) return null;
        // (not much wider than tall: artwork is square, or nearly)
        if (Math.max(img.width, img.height) > 1.6 * Math.min(img.width, img.height)) return null;
        return square(img);
    } catch (e) { return null; }
}

/** The strings in a value that look like an image's path. */
function pathsIn(v, out) {
    out = out || [];
    if (typeof v === 'string') {
        const s = v.replace(/^file:\/\//, '');
        if (/^\/\S+/.test(s) && (/\.(jpe?g|png)$/i.test(s) || /cover|art|image|thumb/i.test(s))) out.push(s);
    } else if (v && typeof v === 'object') Object.keys(v).forEach((k) => pathsIn(v[k], out));
    return out;
}

function createArtwork(opts) {
    const log = (opts && opts.log) || { info() {}, warn() {} };
    const memo = opts && opts.dataDir ? path.join(opts.dataDir, 'artwork.json') : null;
    let known = null;
    try { known = memo ? JSON.parse(fs.readFileSync(memo, 'utf8')).dir : null; } catch (e) { known = null; }
    const st = { key: null, px: null, songKey: '', job: 0, line: 'no song yet' };
    const roots = (opts && opts.roots) || ROOTS, settle = opts && opts.settleMs !== undefined ? opts.settleMs : SETTLE_MS;

    /** Folders, newest image first: [file, mtime] since `since`, a slice at a time; done(list, scanned). */
    function scan(roots, since, done) {
        const job = st.job, found = [], stack = roots.map((r) => [r, 0]);
        let seen = 0;
        const step = () => {
            if (job !== st.job) return;          // (a newer song started its own)
            let n = 0;
            while (stack.length && n < SLICE && seen < MAX_ENTRIES) {
                const [dir, depth] = stack.pop();
                let names;
                try { names = fs.readdirSync(dir); } catch (e) { continue; }
                for (const name of names) {
                    const f = path.join(dir, name);
                    if (SKIP.test(f)) continue;
                    n++; seen++;
                    let s;
                    try { s = fs.lstatSync(f); } catch (e) { continue; }
                    if (s.isDirectory()) { if (depth < DEPTH) stack.push([f, depth + 1]); }
                    else if (s.isFile() && s.mtimeMs >= since && s.size >= MIN_BYTES && s.size <= MAX_BYTES) found.push([f, s.mtimeMs]);
                }
            }
            if (stack.length && seen < MAX_ENTRIES) setTimeout(step, 5);
            else done(found.sort((a, b) => b[1] - a[1]), seen);
        };
        step();
    }
    function take(file, px, how) {
        st.key = st.songKey + '|' + file; st.px = px;
        st.line = 'artwork: ' + file + ' (' + how + ')';
        log.info('artwork: ' + file + ' (' + how + ')');
        const dir = path.dirname(file);
        if (memo && dir !== known) { known = dir; try { fs.writeFileSync(memo, JSON.stringify({ dir })); } catch (e) { /* kept for this run */ } }
    }
    function search(changedAt, raw, tries) {
        const job = st.job;
        // 1. a path in the media state's own values
        for (const f of pathsIn(raw)) { const px = load(f); if (px) { take(f, px, 'named by the media state'); return; } }
        const since = changedAt - RECENT_MS;
        const pick = (list, scanned, where) => {
            if (job !== st.job) return;
            for (const [f] of list.slice(0, 12)) { const px = load(f); if (px) { take(f, px, where + ', ' + scanned + ' entries looked at'); return; } }
            if (where === 'its folder' && known) { scan(roots, since, (l, s) => pick(l, s, 'a search')); return; }
            if (tries > 0) { setTimeout(() => { if (job === st.job) search(changedAt, raw, tries - 1); }, AGAIN_MS); return; }
            st.line = 'artwork: none found (' + scanned + ' entries looked at, ' + list.length + ' new files)' + (list.length ? ': ' + list.slice(0, 3).map((x) => x[0]).join(', ') : '');
            log.info(st.line);
        };
        // 2. the folder it was found in last; 3. a search
        if (known) scan([known], since, (l, s) => pick(l, s, 'its folder'));
        else scan(roots, since, (l, s) => pick(l, s, 'a search'));
    }
    return {
        /** The song changed: its key, and the media state's raw values (searched for a path). */
        song(key, raw) {
            if (key === st.songKey) return;
            st.songKey = key; st.job++; st.px = null; st.key = null;
            if (!key) { st.line = 'no song'; return; }
            st.line = 'artwork: looking';
            const job = st.job, at = Date.now();
            setTimeout(() => { if (job === st.job) search(at, raw, 1); }, settle);
        },
        now: () => (st.px ? { key: st.key, px: st.px } : null),
        status: () => st.line,
    };
}

module.exports = { createArtwork, decodePng, square, load, kindOf, pathsIn, SIZE };
