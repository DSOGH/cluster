'use strict';
/**
 * test_cover.js - the song's cover art (shared/cover.js and the root tool's search, native/m340_waze_window):
 * decoding, the iTunes reply's match, the head unit's copy found and taken:  node tools/test_cover.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INFO = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
process.env.CLUSTER_INFO_DIR = INFO;
process.env.MAP_WINDOW_FILE = path.join(INFO, 'map_window.txt');
const C = require('../shared/cover');
let ok = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('ok   ' + name); });
const at = (px, x, y) => Array.from(px.slice((y * C.SIZE + x) * 4, (y * C.SIZE + x) * 4 + 4));
const near = (a, b, d) => a.every((v, i) => Math.abs(v - b[i]) <= d);

(async () => {
    await check('JPEG decoded and squared to 128 x 128 (red, yellow, black, green quarters)', () => {
        const px = C.load(path.join(__dirname, 'fixtures', 'art.jpg'));
        assert(px && px.length === C.SIZE * C.SIZE * 4);
        assert(near(at(px, 20, 20), [255, 255, 128, 255], 24) && near(at(px, 108, 108), [0, 0, 128, 255], 24));
    });
    await check('iTunes reply: the track and artist that match, at 300 x 300', () => {
        const reply = { results: [
            { trackName: 'Coastline (Live)', artistName: 'Someone Else', artworkUrl100: 'https://x/a/100x100bb.jpg' },
            { trackName: 'Coastline', artistName: 'Mara Ellis', artworkUrl100: 'https://x/b/100x100bb.jpg' }] };
        assert.strictEqual(C.artworkUrl(reply, 'Coastline', 'Mara Ellis'), 'https://x/b/300x300bb.jpg');
        assert.strictEqual(C.artworkUrl({ results: [] }, 'X', 'Y'), null);
    });
    await check('the head unit\'s copy: the root tool\'s search finds the picture written at the change, the app takes it', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-'));
        fs.mkdirSync(path.join(root, 'var', 'media', 'covers'), { recursive: true });
        process.env.COVER_ROOT = root;
        const W = require('../native/m340_waze_window/watch.js');
        const c = C.startCover({ log: null, mode: () => 'headunit' });
        c.song('Coastline', 'Mara Ellis');
        const req = JSON.parse(fs.readFileSync(path.join(INFO, 'cover_request.json'), 'utf8'));
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'art.jpg'), path.join(root, 'var', 'media', 'covers', 'c1.jpg'));
        fs.writeFileSync(path.join(root, 'var', 'notes.txt'), 'x'.repeat(4000));
        W.coverScan(req.key, req.at, 0);
        for (let i = 0; i < 60 && !c.now(); i++) await new Promise((r) => setTimeout(r, 100));
        assert(c.now(), c.status());
        assert(/c1\.jpg/.test(c.status()));
        const j = JSON.parse(fs.readFileSync(path.join(INFO, 'cover.json'), 'utf8'));
        assert.deepStrictEqual(j.src, [path.join(root, 'var', 'media', 'covers', 'c1.jpg')]);
        c.song('', '');
        assert.strictEqual(c.now(), null);
    });
    await check('off: nothing asked', () => {
        const c = C.startCover({ mode: () => 'off' });
        c.song('A', 'B');
        assert.strictEqual(c.now(), null); assert.strictEqual(c.status(), 'cover art off');
    });
    console.log(ok + ' passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
