'use strict';
/**
 * test_directions.js - the next turn (shared/directions.js on Redline's nav.js) as the cluster gets it, from a
 * mock of the car's guidance service, and the M340i layout's directions piece:  node tools/test_directions.js
 */
const assert = require('assert');
const { startDirections } = require('../shared/directions');
require('./scene');   // (the apps' ./kit/ paths: this repo's kit/runtime)

let ok = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('ok   ' + name); });
const fd = (d, u) => ({ distance: d, unit: u, rawDistance: 1 });
const reply = (dir, d, u, road) => ({ viewContent: [{ eventsInView: [{ maneuver: { intersection: { direction: dir, formattedDistance: fd(d, u),
    description: { elements: [{ text: road }] } } } }] }] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A car: the watched fields' handlers kept, queryContent answered with `answer`. */
function car(answer) {
    const h = {}, calls = [];
    return { h, calls, signals: {
        watch: (iface, inst, handlers) => { Object.assign(h, handlers); return Promise.resolve({ available: true, shutdown: () => Promise.resolve() }); },
        proxy: () => Promise.resolve({}),
        call: (p, method, params) => { calls.push(method); return Promise.resolve(answer()); },
    } };
}

(async () => {
    await check('no route: nothing asked, no turn', async () => {
        const c = car(() => reply('RIGHT', '0.3', 'MILE_US', 'Main St')), d = startDirections({ signals: c.signals }, null, {});
        await wait(1200);
        assert.strictEqual(c.calls.length, 0); assert.strictEqual(d.now(), null);
        d.stop();
    });
    await check('CarPlay guiding: the turns asked, the next one read (arrow, distance, road)', async () => {
        const c = car(() => reply('RIGHT', '0.3', 'MILE_US', 'Main St')), d = startDirections({ signals: c.signals }, null, {});
        await wait(10);
        c.h.projectedGuidanceActive(true);
        await wait(1200);
        assert(c.calls.indexOf('queryContent') >= 0);
        const m = d.now();
        assert(m, 'a turn'); assert.deepStrictEqual([m.kind, m.dir, m.dist, m.unit, m.road], ['turn', 'RIGHT', '0.3', 'mi', 'Main St']);
        d.stop();
    });
    await check('not wanted (another layout, Settings off): nothing asked, nothing shown', async () => {
        const c = car(() => reply('LEFT', '500', 'FEET', 'Lake St')), d = startDirections({ signals: c.signals }, null, { wanted: () => false });
        await wait(10);
        c.h.projectedGuidanceActive(true);
        await wait(1200);
        assert.strictEqual(c.calls.length, 0); assert.strictEqual(d.now(), null);
        d.stop();
    });
    await check('the M340i layout: the directions piece draws the turn, hidden without one', () => {
        const L = require('../apps/cluster_layouts/layout_m340');
        ['map', 'info'].forEach((centre) => {
            const p = L.pieces({ speedUnit: 'mph', tempUnit: 'f', centre, redline: 7000, rpmMax: 8000 }).find((x) => x.key === 'directions');
            assert(p, centre);
            assert.strictEqual(p.visible({ nav: null }), false);
            const m = { kind: 'turn', dir: 'LEFT', dist: '500', unit: 'ft', road: 'Lake St' }, r = p.live.draw({ nav: m });
            assert(r && r.px.length === p.live.w * p.live.h && r.px.some((v) => v > 200), 'drawn');
            assert.strictEqual(p.live.draw({ nav: Object.assign({}, m) }), r, 'the same turn: not drawn again');
            ['roundabout', 'destination'].concat(['UTURN_RIGHT', 'SLIGHT_RIGHT', 'STRAIGHT_ON']).forEach((k) => {
                const n = /^[a-z]/.test(k) ? { kind: k, dir: 'LEFT', exit: 2, dist: '1.2', unit: 'mi', road: 'X' } : { kind: 'turn', dir: k, dist: '1', unit: 'mi', road: '' };
                assert(p.live.draw({ nav: n }).px.some((v) => v > 200), k);
            });
            if (centre === 'map') assert(p.overMap && p.z > 900);
        });
        const off = L.pieces({ speedUnit: 'mph', tempUnit: 'f', centre: 'map', redline: 7000, rpmMax: 8000, directions: 'off' });
        assert(!off.some((x) => x.key === 'directions'));
    });
    console.log(ok + ' passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
