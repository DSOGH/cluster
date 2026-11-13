'use strict';
/* kwfuse.js: on a simulated electric drive (accelerating, cruising, regenerating), with eDrive Live's readings 3 a
 * second and each 300 ms old when it arrives, the fused kW follows the true battery power much more closely than the
 * readings themselves; with the engine running the reading passes through; silent eDrive Live: nothing. */
const assert = require('assert');
const path = require('path');
const { createFuse, wheelKw } = require(path.join(__dirname, '..', 'shared', 'kwfuse'));

let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };

// the car: a drive profile in g, and its true battery power (its own drive train, not the fuse's start guess)
const accelAt = (t) => (t < 4 ? 0.25 : t < 10 ? 0.02 : t < 14 ? -0.2 : t < 18 ? 0.3 : t < 24 ? 0 : -0.15);
const trueKw = (w) => (w > 0 ? w / 0.9 : w * 0.65) + 2.2;

function drive(seconds, opts) {
    opts = opts || {};
    const f = createFuse();
    let v = 20, last = null, errFused = 0, errMeas = 0, n = 0;
    const queue = [];                       // readings in flight: [arrives, taken, kw]
    for (let ms = 0; ms <= seconds * 1000; ms += 20) {
        const t = ms / 1000, a = accelAt(t);
        v = Math.max(0, v + a * 9.80665 * 0.02 * 3.6);
        const truth = trueKw(wheelKw(v, a));
        f.sample(ms, { speed: v, gLong: a + (Math.random() - 0.5) * 0.01, engineOn: opts.engineOn ? true : false });
        if (ms % 333 < 20) queue.push([ms + 300, ms, truth]);       // a read every ~333 ms, landing 300 ms later
        while (queue.length && queue[0][0] <= ms) { const q = queue.shift(); f.measure(q[1], q[2]); last = q[2]; }
        const r = f.now(ms);
        if (ms > 6000 && r) { errFused += Math.abs(r.kw - truth); errMeas += Math.abs(last - truth); n++; }
    }
    return { f, fused: errFused / n, meas: errMeas / n };
}

check('electric: the fused kW tracks the battery far closer than the late readings', () => {
    const r = drive(30);
    console.log('     mean error: readings ' + r.meas.toFixed(2) + ' kW, fused ' + r.fused.toFixed(2) + ' kW; fit ' + JSON.stringify(r.f.fit()));
    assert(r.fused < r.meas * 0.5, 'fused ' + r.fused + ' vs readings ' + r.meas);
});

check('engine running: eDrive Live\'s reading passed through as it is', () => {
    const f = createFuse();
    f.sample(0, { speed: 50, gLong: 0.2, engineOn: true });
    f.measure(0, 12.5);
    assert.deepStrictEqual([f.now(10).kw, f.now(10).fused], [12.5, false]);
});

check('no reading for 4 s: nothing shown', () => {
    const f = createFuse();
    f.sample(0, { speed: 50, gLong: 0, engineOn: false });
    f.measure(0, 10);
    f.sample(5000, { speed: 50, gLong: 0, engineOn: false });
    assert.strictEqual(f.now(5000), null);
});

check('the cluster\'s own power meter (relative %): fitted, chosen over the wheels, closer still', () => {
    const f = createFuse();
    let v = 20, last = null, errF = 0, errM = 0, n = 0, used = {};
    const queue = [];
    for (let ms = 0; ms <= 40000; ms += 20) {
        const t = ms / 1000, a = accelAt(t % 30);
        v = Math.max(0, v + a * 9.80665 * 0.02 * 3.6);
        const truth = trueKw(wheelKw(v, a));
        f.sample(ms, { speed: v, gLong: a + (Math.random() - 0.5) * 0.04, engineOn: false });
        // the meter: % of 83 kW driving, % of 60 kW recuperating, every 100 ms
        if (ms % 100 === 0) f.signal(ms, 'rel', { drive: Math.max(0, truth) / 0.83, recup: Math.max(0, -truth) / 0.6 });
        if (ms % 333 < 20) queue.push([ms + 300, ms, truth]);
        while (queue.length && queue[0][0] <= ms) { const q = queue.shift(); f.measure(q[1], q[2]); last = q[2]; }
        const r = f.now(ms);
        if (ms > 15000 && r) { errF += Math.abs(r.kw - truth); errM += Math.abs(last - truth); n++; used[r.model] = (used[r.model] || 0) + 1; }
    }
    const fit = f.fit().models.rel;
    console.log('     mean error: readings ' + (errM / n).toFixed(2) + ' kW, fused ' + (errF / n).toFixed(2) + ' kW; models ' + JSON.stringify(used) + '; rel ' + JSON.stringify(fit.theta));
    assert(used.rel > n * 0.9, 'the meter\'s model shows');
    assert(errF / n < 1.5, 'within 1.5 kW: ' + errF / n);
});

check('a car signal gone quiet (no notification for 2.5 s): not used', () => {
    const f = createFuse();
    for (let i = 0; i < 30; i++) { f.sample(i * 100, { speed: 50, gLong: 0, engineOn: false }); f.signal(i * 100, 'rel', { drive: 10, recup: 0 }); f.measure(i * 100, 9); }
    assert.strictEqual(f.now(3000).model, 'rel');
    f.sample(6000, { speed: 50, gLong: 0, engineOn: false }); f.measure(6000, 9);
    assert.strictEqual(f.now(6000).model, 'wheel');
});

console.log(ok + ' passed');
