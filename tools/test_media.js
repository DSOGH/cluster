'use strict';
/**
 * test_media.js - the song read from the car's media state (shared/media.js), as the car's player fills it in
 * different ways:  node tools/test_media.js
 */
const assert = require('assert');
const { createMedia, pick } = require('../shared/media');

let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };
const S = (o) => Object.assign({ pm: null, mm: null, tracks: null, sel: null }, o);

check('typed lines: title, artist and album where the player types them', () => {
    const p = pick(S({ pm: { firstLineText: 'Coastline', firstLineType: 'TITLE', secondLineText: 'Mara Ellis', secondLineType: 'ARTIST' } }));
    assert.deepStrictEqual([p.title, p.artist, p.album], ['Coastline', 'Mara Ellis', '']);
});
check('the types as numbers (the binding\'s enum values)', () => {
    const p = pick(S({ pm: { firstLineText: 'Aimer', firstLineType: 1, secondLineText: 'Sleepless Nights', secondLineType: 2 } }));
    assert.deepStrictEqual([p.title, p.artist, p.album], ['', 'Aimer', 'Sleepless Nights']);
});
check('only artist and album typed (as on a car, Nov 2026): the title from the playing track\'s entry', () => {
    const p = pick(S({ pm: { firstLineText: 'Aimer', firstLineType: 'ARTIST', secondLineText: 'Sleepless Nights', secondLineType: 'ALBUM', trackId: 7 },
        tracks: { tracks: [{ trackId: 6, firstLine: 'Other' }, { trackId: 7, firstLine: 'Hoshi no Hate', secondLine: 'Aimer' }] }, sel: { selectedTrackId: 7 } }));
    assert.strictEqual(p.title, 'Hoshi no Hate'); assert.strictEqual(p.from.title, 'track list'); assert.strictEqual(p.artist, 'Aimer');
});
check('a single track handed over as an object, not a list', () => {
    const p = pick(S({ tracks: { tracks: { trackId: 3, firstLine: 'Second Gear', secondLine: 'Torque & Co.' } }, sel: { selectedTrackId: 3 } }));
    assert.deepStrictEqual([p.title, p.artist], ['Second Gear', 'Torque & Co.']);
});
check('else the three-row text, then the main menu\'s first line that is not the artist or album', () => {
    assert.strictEqual(pick(S({ pm: { firstLineText: 'A', firstLineType: 'ARTIST', threeRowText: 'Song X' } })).title, 'Song X');
    const p = pick(S({ pm: { firstLineText: 'A', firstLineType: 'ARTIST' }, mm: { firstLineText: 'A', secondLineText: 'Song Y' } }));
    assert.strictEqual(p.title, 'Song Y'); assert.strictEqual(p.from.title, 'main menu');
});
check('untyped lines: the first a title, the second an artist', () => {
    const p = pick(S({ pm: { firstLineText: 'Midnight Drive', firstLineType: 'UNDEFINED', secondLineText: 'The Night Shift', secondLineType: 0 } }));
    assert.deepStrictEqual([p.title, p.artist], ['Midnight Drive', 'The Night Shift']);
});
check('the time played counts from the song\'s change; nothing playing is null', () => {
    let t = 1000;
    const m = createMedia(() => t);
    assert.strictEqual(m.now(), null);
    m.put('pm', { firstLineText: 'Coastline', firstLineType: 'TITLE' });
    t += 65000;
    assert.strictEqual(Math.round(m.now().elapsed), 65);
    m.put('pm', { firstLineText: 'Coastline', firstLineType: 'TITLE' });   // (the same song sent again)
    assert.strictEqual(Math.round(m.now().elapsed), 65);
    m.put('pm', { firstLineText: 'Second Gear', firstLineType: 'TITLE' });
    assert.strictEqual(Math.round(m.now().elapsed), 0);
    m.put('pm', null);
    assert.strictEqual(m.now(), null);
});
console.log(ok + ' passed');
