'use strict';
/**
 * test_m340_extras.js - the M340i layout's extras: the car's warnings (shared/warnings.js), the side gauges, the gear
 * lever's place, the song card:  node tools/test_m340_extras.js
 */
const assert = require('assert');
require('./scene');
const { createWarnings } = require('../shared/warnings');
const { clashes } = require('./clearance');
const L = require('../apps/cluster_layouts/layout_m340');

let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };
const O = (o) => Object.assign({ speedUnit: 'mph', tempUnit: 'f', redline: 7000, rpmMax: 8000, centre: 'info' }, o);

check('warnings: active ones named from the cluster\'s list, newest first, gone when inactive', () => {
    const w = createWarnings();
    w.names({ list: [{ cCIdentifer: 34, cCShortName: 'Drivetrain malfunction', cCColor: 'RED' }, { cCIdentifer: 50, cCName: 'Tyre pressure low', cCColor: 'YELLOW' }] });
    w.basic([{ ccmId: 34, activeState: 'AKTIV' }]);
    w.basic([{ ccmId: 34, activeState: 'AKTIV' }, { ccmId: 50, activeState: 0 }, { ccmId: 77, activeState: 'AKTIV' }]);
    assert.deepStrictEqual(w.list().map((x) => [x.name, x.red]), [['Check Control 77', false], ['Tyre pressure low', false], ['Drivetrain malfunction', true]]);
    w.basic([{ ccmId: 77, activeState: 'PASSIV' }]);
    assert.strictEqual(w.list().length, 2);
});
check('side gauges: each kind, the bars alone or with the round ones beside them (four at once), clear of the corners, the eDrive box and the readings, in both centres', () => {
    Object.keys(L.SIDE_KINDS).forEach((k) => ['info', 'map'].forEach((centre) => ['bar', 'dial'].forEach((style) => {
        const o = O(style === 'bar' ? { centre, sideLeft: k, sideRight: k } : { centre, sideLeft: k, sideRight: k, dialLeft: k, dialRight: k });
        const bad = L.pieces(o).map((p) => [p.key, clashes(p, o)]).filter(([, c]) => c.length);
        assert(!bad.length, JSON.stringify(bad));
        assert(L.pieces(o).length <= 60);
    })));
});
check('Waze\'s own turn card: with the map, nothing of the layout over the top of the phone\'s safe area (504x368 at 286,72 of the map: Waze draws its next turn there)', () => {
    const W = L.mapWindow, card = { x: W.x + 286, y: W.y + 72, w: 504, h: 360 };   // (a warning may cover its last rows)
    const o = O({ centre: 'map', sideLeft: 'boost', sideRight: 'hp', dialLeft: 'oil', dialRight: 'coolant', nowPlaying: 'on', directions: 'on' });
    const over = L.pieces(o).filter((p) => p.overMap && p.key !== 'mapVeil' && p.key !== 'warning' && p.x < card.x + card.w && p.x + p.w > card.x && p.y < card.y + card.h && p.y + p.h > card.y);
    assert(!over.length, JSON.stringify(over.map((p) => [p.key, p.x, p.y, p.w, p.h])));
});
check('side gauge readings: hp from torque and revs, at the wheels less the loss; boost in psi', () => {
    const r = L.sideReading('hp', O({}), { rpm: 5000, torque: 500 });
    assert.strictEqual(r.text, '351'); assert.strictEqual(r.unit, 'HP');
    const w = L.sideReading('hp', O({ powerAt: 'wheel', drivetrainLoss: 15 }), { rpm: 5000, torque: 500 });
    assert.strictEqual(w.text, '298'); assert.strictEqual(w.unit, 'WHP');
    assert.strictEqual(L.sideReading('torque', O({}), { torque: 500 }).text, '369');
    assert.strictEqual(L.sideReading('boost', O({}), { boostActual: 1 }).text, '14.5');
    assert.strictEqual(L.sideReading('boost', O({}), {}).text, '--');
});
check('the song card: centred, no artwork or timer, drawn once a song; the warning stands in its place', () => {
    const ps = L.pieces(O({})), card = ps.find((p) => p.key === 'npCard'), warn = ps.find((p) => p.key === 'warning');
    assert.strictEqual(card.x + card.w / 2, 960);
    const m = { title: 'Coastline', artist: 'Mara Ellis', album: '', elapsed: 3 }, r = card.live.draw({ media: m });
    assert.strictEqual(r.px.length, card.w * card.h * 4);
    assert.strictEqual(card.live.draw({ media: Object.assign({}, m) }), r);
    assert(!ps.some((p) => /npTime|npArt/.test(p.key)));
    assert(card.visible({ media: m }) && !card.visible({ media: m, warnings: [{ name: 'X' }] }));
    assert(warn.visible({ warnings: [{ name: 'X' }] }) && warn.live.draw({ warnings: [{ name: 'X', red: true }] }).px.length === warn.w * warn.h * 4);
});
check('no badge; the gear lever\'s place with the layout\'s bottom row', () => {
    const ps = L.pieces(O({ bottomStrip: 'layout' }));
    assert(!ps.some((p) => p.key === 'badge'));
    assert(ps.some((p) => p.key === 'selAll') && ps.some((p) => p.key === 'selLit'));
});
check('the renderer backed up: only the newest of each value waits, sent in order when it drains (no seconds-old queue)', () => {
    const { ClusterRender } = require('../shared/cluster_render_client');
    const cr = new ClusterRender('t'), sent = [];
    let full = false;
    cr.sock = { write: (m) => { sent.push(String(m)); return !full; } };
    cr.connected = true; cr.ready = true;
    cr.layers.set(1, { kind: 'effect', uniforms: {}, anims: new Map(), nextAnim: 1 });
    full = true; cr.uniform(1, 'u_value', [0.1]);          // (this write fills the socket)
    for (let i = 2; i <= 9; i++) { cr.uniform(1, 'u_value', [i / 10]); cr.animate(1, { property: 'uniform', name: 'u_value', keys: '0:0 50:' + i / 10, anim: 1 }); }
    assert.strictEqual(sent.length, 1, 'nothing more written while backed up');
    full = false; cr.blocked = false; cr._flushLatest();
    assert.strictEqual(sent.length, 3);
    assert(/"v":"0.9"/.test(sent[1]) && /50:0.9/.test(sent[2]), sent.slice(1).join(' | '));
});
check('a renderer that reads late (busy with the Waze video): values wait for its answer to the marker, only the newest goes (no queue in the socket)', () => {
    const { ClusterRender } = require('../shared/cluster_render_client');
    const cr = new ClusterRender('t'), sent = [];
    cr.sock = { write: (m) => { sent.push(String(m)); return true; } };
    cr.connected = true; cr.ready = true; cr.sync = { out: false, at: 0, echo: true };
    cr.layers.set(1, { kind: 'effect', uniforms: {}, anims: new Map(), nextAnim: 1 });
    cr.uniform(1, 'u_value', [0.1]);
    assert.strictEqual(sent.length, 2); assert(/x_sync/.test(sent[1]), 'the marker after the value');
    cr.sync.at -= 200;   // (no answer for 200 ms: the renderer is behind)
    for (let i = 2; i <= 40; i++) cr.uniform(1, 'u_value', [i / 100]);
    assert.strictEqual(sent.length, 2, 'nothing more while it is behind');
    assert(cr.lag() >= 200);
    cr._event({ ev: 'error', op: 'x_sync', ref: 0, reason: 'unknown op' });   // (it caught up)
    assert.strictEqual(sent.length, 4);
    assert(/"v":"0.4"/.test(sent[2]) && /x_sync/.test(sent[3]), sent.slice(2).join(' | '));
    let refused = 0; cr.on('refused', () => refused++);
    cr._event({ ev: 'error', op: 'x_sync', ref: 0, reason: 'unknown op' });
    assert.strictEqual(refused, 0, 'the marker\'s answer is not a refusal');
});
console.log(ok + ' passed');
