'use strict';

// Flex Fuel (apps/flex_fuel): the blend arithmetic, a fill-up seen through the car's fuel level, and the page
// drawn. No SDK or car needed:
//   node kit/tools/test_flex_fuel.js [page.png]

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'flex_fuel');
const { plan, afterFill, blend } = require(path.join(APP, 'mix'));
const GAL = 3.785411784;
let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, (what || '') + ' ' + a + ' vs ' + b);

/* ---------- the arithmetic ---------- */
const fuels = { e85: 75, gas: 10 };
check('a plan reaches the mix wanted exactly, the measured fuel first and the room filled', () => {
    const p = plan({ litres: 15, e: 10 }, 57, fuels, 30, 'gas', 1.9);
    assert(p.reached && p.first === 'e85' && p.last === 'gas');
    near(p.firstL + p.lastL, 42, 1e-9, 'room');
    near((15 * 10 + 75 * p.firstL + 10 * p.lastL) / 57, 30, 1e-9, 'mix');
    near(p.result, 30, 1e-9);
});
check('the spread: the click-off early leaves less of the last fuel, late more', () => {
    const p = plan({ litres: 15, e: 10 }, 57, fuels, 30, 'gas', 1.9);
    assert(p.spread[0] < 30 && p.spread[1] > 30, JSON.stringify(p.spread));
    near(p.spread[1], blend(15 + p.firstL, (15 * 10 + 75 * p.firstL) / (15 + p.firstL), p.lastL - 1.9, 10), 1e-9);
});
check('auto tops off with the fuel nearer the mix: gasoline for E30, E85 for E70', () => {
    assert.strictEqual(plan({ litres: 10, e: 10 }, 57, fuels, 30, 'auto', 1.9).last, 'gas');
    assert.strictEqual(plan({ litres: 10, e: 30 }, 57, fuels, 70, 'auto', 1.9).last, 'e85');
});
check('a mix out of reach in one fill-up says so, with the closest', () => {
    const p = plan({ litres: 40, e: 10 }, 57, fuels, 60, 'auto', 1.9);
    assert(!p.reached);
    near(p.result, (40 * 10 + 17 * 75) / 57, 1e-9, 'all E85');
});
check('a tank already richer than wanted: the closest is all gasoline', () => {
    const p = plan({ litres: 40, e: 60 }, 57, fuels, 30, 'auto', 1.9);
    assert(!p.reached);
    near(p.result, (40 * 60 + 17 * 10) / 57, 1e-9);
});
check('no room: the tank is full', () => assert(plan({ litres: 56.8, e: 30 }, 57, fuels, 30, 'auto', 1.9).full));
check('only the last fuel is needed: no measured amount', () => {
    const p = plan({ litres: 20, e: 10 }, 57, fuels, 10, 'gas', 1.9);
    near(p.firstL, 0, 1e-9); assert(p.reached);
});
check('the tank after a fill-up that followed the plan is the mix wanted', () => {
    const p = plan({ litres: 15, e: 10 }, 57, fuels, 30, 'gas', 1.9);
    near(afterFill({ litres: 15, e: 10 }, { litres: 57 }, p), 30, 1e-9);
    // stopped at 50 L: less gasoline, richer
    assert(afterFill({ litres: 15, e: 10 }, { litres: 50 }, p) > 30);
    // stopped before the E85 amount: all of it E85
    near(afterFill({ litres: 15, e: 10 }, { litres: 20 }, p), (15 * 10 + 5 * 75) / 20, 1e-9);
});

/* ---------- the app on stand-ins: a fill-up through the car's fuel level ---------- */
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
    let app = null;
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req === './kit/mgu') return { run(a) { app = a; } };
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        return load.call(this, req, parent, isMain);
    };
    const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const themes = require(path.join(KIT, 'themes'));
    const { Canvas } = require(path.join(KIT, 'canvas'));
    const { Recorder, play } = require(path.join(KIT, 'record'));
    const S = {}, listeners = [];
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    check('every setting\'s default is one of its choices', () => SPEC.settings.forEach((s) => assert(s.options.some((o) => o[0] === s.default), s.key)));
    S.tankE = 10;
    const handlers = {}, warns = [];
    let loopFn = null, last = null;
    const ctx = {
        app: {}, ui: { onClick() {}, text() {}, image: async (n, cv) => { last = cv; } },
        settings: {
            get: (k) => S[k], set: (k, v) => { S[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f),
            display: (k) => { const s = SPEC.settings.find((x) => x.key === k); const o = s && s.options.find((x) => x[0] === S[k]); return o ? o[1] : String(S[k]); },
        },
        log: { info() {}, warn: (m) => warns.push(m), error: (m, e) => warns.push(m + ' ' + e) },
        spec: SPEC, dataDir: tmp,
        signals: { watch: (iface, inst, h) => { Object.assign(handlers, h); return Promise.resolve({ available: true }); } },
        loop: (name, fps, fn) => { loopFn = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => new Recorder(w, h),
    };
    require(path.join(APP, 'main.js'));
    await app.start(ctx);
    const level = (n) => handlers.statusRangeTankStatus({ rangeFuel: 300, fuelLevel: n });
    let now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    level(15);
    check('the car\'s level is read and kept', () => assert.strictEqual(S._lastLevel, 15));
    // the fill-up the page showed: target E30 from 15 L of E10, 2 L short of 59 L
    const p = plan({ litres: 15, e: 10 }, 57, { e85: S.e85, gas: S.gasE }, S.target, S.topOff, 1.9);
    level(57);
    await loopFn();
    check('a fill-up is not counted until the level has been still for a minute', () => assert.strictEqual(S.tankE, 10));
    now += 61000;
    await loopFn();
    check('then the tank\'s mix is the plan\'s result, and the level after it kept', () => {
        assert.strictEqual(S.tankE, Math.round(p.result));
        near(S._tankExact, p.result, 0.01);
        assert.strictEqual(S._lastLevel, 57);
    });
    level(56.6); level(56.9);
    check('the gauge\'s small ups and downs are not fill-ups', () => assert.strictEqual(S._lastLevel, 57));
    level(50);
    check('the level falling as the car drives is kept', () => assert.strictEqual(S._lastLevel, 50));
    S.tankE = 40; listeners.forEach((f) => f('tankE', 40));
    check('the mix set by hand in Settings is taken as it is', () => assert.strictEqual(S._tankExact, 40));
    Date.now = realNow;
    S.tankE = 12; S._tankExact = 12; S.target = 30;
    level(18);
    await loopFn();
    check('the page draws without warnings', () => assert(last && warns.length === 0, warns.join('; ')));
    // (as the car draws it: the recorded frame played onto a picture)
    if (process.argv[2]) { const cv = new Canvas(last.w, last.h); play(last.words(), cv); fs.writeFileSync(process.argv[2], cv.png(6)); console.log('page: ' + process.argv[2]); }
    console.log(ok + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
