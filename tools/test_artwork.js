'use strict';
/**
 * test_artwork.js - the song's artwork (shared/artwork.js): its JPEG and PNG decoding to 128 x 128, and the search
 * for the picture the head unit writes when the song changes:  node tools/test_artwork.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const A = require('../shared/artwork');

let ok = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('ok   ' + name); });
const at = (px, x, y) => Array.from(px.slice((y * A.SIZE + x) * 4, (y * A.SIZE + x) * 4 + 4));
const near = (a, b, d) => a.every((v, i) => Math.abs(v - b[i]) <= d);
/** A w x h RGB PNG, each row filtered as `f` (0 none, 1 sub, 2 up). */
function png(w, h, colour, f) {
    const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); return b; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const rows = [];
    for (let y = 0; y < h; y++) {
        const line = Buffer.alloc(1 + w * 3); line[0] = f;
        for (let x = 0; x < w; x++) {
            const c = colour(x, y), p = y ? colour(x, y - 1) : [0, 0, 0], l = x ? colour(x - 1, y) : [0, 0, 0];
            for (let k = 0; k < 3; k++) line[1 + x * 3 + k] = (c[k] - (f === 1 ? l[k] : f === 2 ? p[k] : 0)) & 255;
        }
        rows.push(line);
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
    await check('JPEG: decoded, squared to 128 x 128 (the fixture: red, yellow, black, green quarters)', () => {
        const px = A.load(path.join(__dirname, 'fixtures', 'art.jpg'));
        assert(px && px.length === A.SIZE * A.SIZE * 4);
        assert(near(at(px, 20, 20), [255, 255, 128, 255], 24), 'top left ' + at(px, 20, 20));
        assert(near(at(px, 108, 108), [0, 0, 128, 255], 24), 'bottom right ' + at(px, 108, 108));
    });
    await check('PNG: each row filter, the middle square of a wide picture', () => {
        [0, 1, 2].forEach((f) => {
            const file = path.join(dir, 'p' + f + '.png');
            fs.writeFileSync(file, png(240, 200, (x, y) => [x < 120 ? 200 : 10, y < 100 ? 50 : 150, 88 + ((x * 2654435761 ^ y * 40503) >>> 7) % 5], f));   // (a little grain: a flat picture packs below artwork's least size)
            const px = A.load(file);
            assert(px, 'filter ' + f);
            assert(near(at(px, 10, 10), [200, 50, 90, 255], 3) && near(at(px, 118, 118), [10, 150, 90, 255], 3), 'filter ' + f);
        });
    });
    await check('not artwork: text, a strip, a tiny picture', () => {
        fs.writeFileSync(path.join(dir, 'x.txt'), 'hello'.repeat(500));
        fs.writeFileSync(path.join(dir, 'strip.png'), png(400, 60, () => [1, 2, 3], 0));
        assert.strictEqual(A.load(path.join(dir, 'x.txt')), null);
        assert.strictEqual(A.load(path.join(dir, 'strip.png')), null);
    });
    await check('a path in the media state\'s values', () => {
        assert.deepStrictEqual(A.pathsIn({ a: { coverArt: 'file:///var/cache/art/1.jpg' }, b: 'Song', c: ['/tmp/x.png'] }), ['/var/cache/art/1.jpg', '/tmp/x.png']);
    });
    await check('the search: the picture written at the song\'s change found, its folder kept for the next', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-')), data = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
        fs.mkdirSync(path.join(root, 'media', 'covers'), { recursive: true });
        const art = A.createArtwork({ dataDir: data, roots: [root], settleMs: 20 });
        art.song('Coastline\nMara Ellis', {});
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'art.jpg'), path.join(root, 'media', 'covers', 'c1.jpg'));
        for (let i = 0; i < 100 && !art.now(); i++) await new Promise((r) => setTimeout(r, 20));
        assert(art.now() && art.now().px.length === A.SIZE * A.SIZE * 4, art.status());
        assert(/c1\.jpg/.test(art.status()));
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'artwork.json'), 'utf8')).dir, path.join(root, 'media', 'covers'));
        art.song('', {});
        assert.strictEqual(art.now(), null);
    });
    console.log(ok + ' passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
