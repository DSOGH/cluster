'use strict';
/**
 * cover.js - the playing song's cover art for the cluster (Settings > Cover art), SIZE x SIZE RGBA, from either of:
 *
 *   online     the iTunes Search API (itunes.apple.com/search, no key), by the song's title and artist, through
 *              mgu-uplink: the app is allowed the internet (app.json "internet"), names resolved through the
 *              uplink's own DNS servers (/run/mgu-uplink/lease.json: the head unit's resolver doesn't reach out).
 *              Needs the uplink online (a phone's hotspot, Wi-Fi, a USB modem). Covers kept in dataDir/covers/.
 *   head unit  the picture the head unit itself shows: the m340-waze-window tool (root, native/m340_waze_window)
 *              looks for JPEG and PNG files written anywhere on the unit as the song changes and copies the newest
 *              few to /dev/shm/cluster-info/cover0.img ... (cover.json: the song, where each came from). The app
 *              asks by writing cover_request.json there.
 *
 * Each song is asked once; what came of it is logged and shown on the Signals screen (status()).
 *
 *   const c = startCover({ dataDir, log, mode: () => 'both' });
 *   c.song(title, artist)   // the song changed;  c.now() -> { key, px } or null;  c.status()
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const MIN_BYTES = 1500, MAX_BYTES = 4 * 1024 * 1024;
const DIR = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';
const LEASE = '/run/mgu-uplink/lease.json';
const HU_WAIT_MS = 15000, NET_TIMEOUT_MS = 8000, CACHE_KEEP = 60;

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
    return fromBytes(buf);
}
/** An image's bytes (JPEG or PNG) as SIZE x SIZE RGBA, or null. */
function fromBytes(buf) {
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


/** The uplink's DNS servers (none: offline). */
function uplinkDns() {
    try { const l = JSON.parse(fs.readFileSync(LEASE, 'utf8')); return Array.isArray(l.dns) ? l.dns.filter(Boolean) : []; } catch (e) { return []; }
}
/** GET https://host/path through the uplink: cb(err, Buffer). */
function get(url, cb, hops) {
    const https = require('https'), dns = require('dns'), URL_ = require('url').URL, u = new URL_(url);
    const servers = uplinkDns();
    if (!servers.length) { cb(new Error('the uplink is offline')); return; }
    const lookup = (host, opts, done) => {
        const r = new dns.Resolver(); r.setServers(servers);
        r.resolve4(host, (e, a) => (e || !a.length ? done(e || new Error('no address')) : opts && opts.all ? done(null, [{ address: a[0], family: 4 }]) : done(null, a[0], 4)));
    };
    let fired = false;
    const end = (e, b) => { if (!fired) { fired = true; cb(e, b); } };
    const req = https.get({ host: u.hostname, path: u.pathname + u.search, lookup, timeout: NET_TIMEOUT_MS, headers: { 'User-Agent': 'cluster-layouts' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (hops || 0) < 3) { res.resume(); get(new (require('url').URL)(res.headers.location, url).href, end, (hops || 0) + 1); return; }
        if (res.statusCode !== 200) { res.resume(); end(new Error('HTTP ' + res.statusCode)); return; }
        const parts = []; let n = 0;
        res.on('data', (d) => { n += d.length; if (n > MAX_BYTES) { req.destroy(); end(new Error('too big')); } else parts.push(d); });
        res.on('end', () => end(null, Buffer.concat(parts)));
    });
    req.on('timeout', () => { req.destroy(); end(new Error('timed out')); });
    req.on('error', (e) => end(e));
}
/** The best match's artwork URL for a song in an iTunes Search reply (its artist matching when it can), or null. */
function artworkUrl(reply, title, artist) {
    const rs = (reply && reply.results) || [];
    const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*$/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const t = norm(title), a = norm(artist);
    const score = (r) => (norm(r.trackName) === t ? 2 : norm(r.trackName).indexOf(t) >= 0 ? 1 : 0) + (a && norm(r.artistName).indexOf(a.split(' ')[0]) >= 0 ? 2 : 0);
    const best = rs.filter((r) => r.artworkUrl100).sort((x, y) => score(y) - score(x))[0];
    return best ? best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.') : null;
}

function startCover(opts) {
    const log = opts.log || { info() {}, warn() {} }, mode = opts.mode || (() => 'both');
    const cacheDir = opts.dataDir ? path.join(opts.dataDir, 'covers') : null;
    const st = { key: '', px: null, from: '', line: 'no song yet', job: 0 };
    const keyOf = (t, a) => (t + '\n' + a).toLowerCase();
    const file = (k) => cacheDir && path.join(cacheDir, require('crypto').createHash('sha1').update(k).digest('hex').slice(0, 16) + '.img');
    const take = (job, px, from) => { if (job !== st.job || !px) return false; st.px = px; st.from = from; st.line = 'cover: ' + from; log.info('cover: ' + from); return true; };
    function online(job, title, artist, key) {
        const q = encodeURIComponent((artist ? artist + ' ' : '') + title);
        get('https://itunes.apple.com/search?media=music&entity=song&limit=8&term=' + q, (e, b) => {
            if (job !== st.job) return;
            let url = null;
            try { url = !e && artworkUrl(JSON.parse(b.toString('utf8')), title, artist); } catch (x) { url = null; }
            if (!url) { if (!st.px) st.line = 'cover: online, ' + (e ? e.message : 'not found'); return; }
            get(url, (e2, img) => {
                if (job !== st.job || e2) { if (e2 && !st.px) st.line = 'cover: online, ' + e2.message; return; }
                const px = fromBytes(img);
                if (px && !st.px) {
                    take(job, px, 'online (iTunes)');
                    try { if (cacheDir) { try { fs.mkdirSync(cacheDir); } catch (x) { /* there */ } fs.writeFileSync(file(key), img); prune(); } } catch (x) { /* not kept */ }
                }
            });
        });
    }
    function prune() {
        try {
            const fsn = fs.readdirSync(cacheDir).map((n) => [n, fs.statSync(path.join(cacheDir, n)).mtimeMs]).sort((a, b) => b[1] - a[1]);
            fsn.slice(CACHE_KEEP).forEach(([n]) => fs.unlinkSync(path.join(cacheDir, n)));
        } catch (e) { /* none */ }
    }
    function headUnit(job, key, at) {
        try { fs.writeFileSync(path.join(DIR, 'cover_request.json'), JSON.stringify({ key, at })); } catch (e) { st.line = 'cover: head unit, ' + e.message; return; }
        const t0 = Date.now();
        const poll = setInterval(() => {
            if (job !== st.job || st.px || Date.now() - t0 > HU_WAIT_MS) { clearInterval(poll); if (job === st.job && !st.px && /looking/.test(st.line)) st.line = 'cover: none found on the head unit' + (mode() === 'both' ? ' or online' : ''); return; }
            try {
                const j = JSON.parse(fs.readFileSync(path.join(DIR, 'cover.json'), 'utf8'));
                if (j.key !== key) return;
                clearInterval(poll);
                // (the newest first; the first that decodes as a cover, square and big enough)
                const src = Array.isArray(j.src) ? j.src : [];
                for (let i = 0; i < src.length; i++) { const px = load(path.join(DIR, 'cover' + i + '.img')); if (px) { take(job, px, 'head unit: ' + src[i]); return; } }
                if (!st.px && job === st.job) st.line = 'cover: the head unit wrote ' + (src.length ? src.length + ' pictures, none a cover: ' + src.slice(0, 2).join(', ') : 'no picture') + ' (' + (j.seen || 0) + ' entries looked at)';
            } catch (e) { /* not yet */ }
        }, 500);
    }
    return {
        song(title, artist) {
            const key = title || artist ? keyOf(title || '', artist || '') : '';
            if (key === st.key) return;
            st.key = key; st.job++; st.px = null; st.from = '';
            const m = mode();
            if (!key || m === 'off') { st.line = m === 'off' ? 'cover art off' : 'no song'; return; }
            st.line = 'cover: looking';
            const job = st.job;
            // a cover fetched before
            if (cacheDir && (m === 'online' || m === 'both')) { const px = load(file(key)); if (px) { take(job, px, 'online (kept)'); return; } }
            if (m === 'headunit' || m === 'both') headUnit(job, key, Date.now());
            if ((m === 'online' || m === 'both') && title) online(job, title, artist, key);
        },
        now: () => (st.px ? { key: st.key + '|' + st.from, px: st.px } : null),
        status: () => st.line,
    };
}

module.exports = { startCover, fromBytes, decodePng, square, load, kindOf, artworkUrl, SIZE };
