'use strict';
/**
 * media.js - the song the car's media player shows, from the head unit's own media state
 * (de.bmw.infotainment.hmi.hmimediastate.HmiMediaState, the centre screen's instance HMI_CID), for a now-playing
 * readout on the cluster.
 *
 * The interface has four fields, and the car fills them differently by source (james10424/idrive7-custom read them
 * on a car, Nov 2026: its player's playerMetadata had only the artist and the album):
 *   playerMetadata    two lines, each typed ARTIST, ALBUM, TITLE or UNDEFINED, and a three-row text
 *   mainMenuMetadata  three lines of text
 *   tracks            a list of tracks, each with its first and second line
 *   trackSelection    the playing track's id in that list
 * So each part is taken from wherever it is: the title from a line typed TITLE, else the playing track's entry in
 * the list, else the three-row text, else the main menu's first line that is not the artist or album, else an
 * untyped line. Nothing has a position or a length: `elapsed` is counted here from when the song changed.
 *
 *   const m = createMedia();
 *   m.put('pm' | 'mm' | 'tracks' | 'sel', value);
 *   m.now()   // { title, artist, album, elapsed (s), from: { title, artist, album } } or null: nothing playing
 */
const ITEM = { UNDEFINED: 0, ARTIST: 1, ALBUM: 2, TITLE: 3 };

const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
/** A line's type: the enum's number or its name. */
function kind(t) {
    if (typeof t === 'number') return t >= 0 && t <= 3 ? t : ITEM.UNDEFINED;
    const n = String(t || '').toUpperCase();
    return /TITLE/.test(n) ? ITEM.TITLE : /ARTIST/.test(n) ? ITEM.ARTIST : /ALBUM/.test(n) ? ITEM.ALBUM : ITEM.UNDEFINED;
}
/** The tracks of a `tracks` value: an array however it comes (the binding hands one entry over as an object). */
function trackList(v) {
    const t = v && v.tracks;
    if (Array.isArray(t)) return t;
    return t && typeof t === 'object' ? (t.trackId !== undefined || t.firstLine !== undefined ? [t] : Object.keys(t).map((k) => t[k])) : [];
}

/** The song in the four fields: { title, artist, album, from } (empty strings where nothing says it). */
function pick(s) {
    const pm = s.pm || {}, out = { title: '', artist: '', album: '', from: {} };
    const lines = [[clean(pm.firstLineText), kind(pm.firstLineType)], [clean(pm.secondLineText), kind(pm.secondLineType)]];
    const typed = (k) => { const l = lines.find((x) => x[0] && x[1] === k); return l ? l[0] : ''; };
    const set = (k, v, from) => { if (!out[k] && v) { out[k] = v; out.from[k] = from; } };
    set('title', typed(ITEM.TITLE), 'player (title line)');
    set('artist', typed(ITEM.ARTIST), 'player (artist line)');
    set('album', typed(ITEM.ALBUM), 'player (album line)');
    const known = () => [out.artist, out.album].filter(Boolean);
    const isNew = (v) => v && known().indexOf(v) < 0;
    // the playing track's entry in the list
    const id = s.sel && s.sel.selectedTrackId !== undefined ? s.sel.selectedTrackId : pm.trackId;
    const track = id !== undefined ? trackList(s.tracks).find((t) => t && String(t.trackId) === String(id)) : null;
    if (track) {
        if (isNew(clean(track.firstLine))) set('title', clean(track.firstLine), 'track list');
        if (isNew(clean(track.secondLine)) && clean(track.secondLine) !== out.title) set('artist', clean(track.secondLine), 'track list');
    }
    if (isNew(clean(pm.threeRowText))) set('title', clean(pm.threeRowText), 'player (three-row text)');
    const mm = s.mm || {};
    [mm.firstLineText, mm.secondLineText, mm.thirdLineText].map(clean).forEach((v) => { if (isNew(v) && v !== out.title) set('title', v, 'main menu'); });
    // untyped lines: the first a title, the second an artist
    const untyped = lines.filter((l) => l[0] && l[1] === ITEM.UNDEFINED).map((l) => l[0]);
    if (untyped[0] && isNew(untyped[0])) set('title', untyped[0], 'player (untyped line)');
    if (untyped[1] && isNew(untyped[1]) && untyped[1] !== out.title) set('artist', untyped[1], 'player (untyped line)');
    return out;
}

function createMedia(clock) {
    const now = clock || Date.now;
    const s = { pm: null, mm: null, tracks: null, sel: null };
    let cur = null, key = '', since = 0;
    return {
        put(k, v) {
            s[k] = v && typeof v === 'object' ? v : null;
            const p = pick(s), k2 = p.title + '\n' + p.artist + '\n' + p.album;
            if (k2 !== key) { key = k2; since = now(); }
            cur = p.title || p.artist ? p : null;
        },
        now() { return cur ? Object.assign({}, cur, { elapsed: Math.max(0, (now() - since) / 1000) }) : null; },
    };
}

module.exports = { createMedia, pick, ITEM, IFACE: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', INSTANCE: 'HMI_CID' };
