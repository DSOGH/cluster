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
console.log(ok + ' passed');
