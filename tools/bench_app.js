'use strict';
/**
 * bench_app.js - how much the whole Cluster Layouts app costs while driving: the app on the kit with stubbed car
 * signals and a counting stand-in for the cluster render client, fed speed and rpm readings at the car's rates for a
 * few seconds; prints the head unit's CPU time a second, the updates a second, and the messages and bytes a second
 * sent to the cluster, for each layout named (all by default):
 *   node tools/bench_app.js [m340 retro ...] [--secs 4] [--hz 50] [--map]
 * --max-cpu N / --max-msg N: exit 1 when a layout passes it (CI).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { FakeClient, APP, KIT } = require('./scene');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const SECS = flag('--secs', 4), HZ = flag('--hz', 50), MAX_CPU = flag('--max-cpu', 0), MAX_MSG = flag('--max-msg', 0), MAP = args.indexOf('--map') >= 0;
const named = args.filter((a, i) => !/^--/.test(a) && !/^--/.test(args[i - 1] || ''));

let app = null, client = null;
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run(a) { app = a; } };
    if (req === './cluster_render_client') return { ClusterRender: function () { client = new FakeClient(); client.log = { push() {} }; return client; } };
    return load.call(this, req, parent, isMain);
};
process.env.SOMEIP_CATALOG = '/nonexistent/someip-interfaces.json';
process.env.CLUSTER_INFO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
process.env.CLUSTER_SETTLE_MS = '0';
process.env.CLUSTER_PRESENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const RT_SPEC = {};
['id', 'title', 'version', 'screens', 'settings', 'config', 'startWidget'].forEach((k) => { RT_SPEC[k] = SPEC[k]; });
const LAYOUTS = SPEC.settings.find((s) => s.key === 'layout').options.map((o) => o[0]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

(async () => {
    const S = {}, changes = [];
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    const handlers = {}, clicks = {};
    const nul = () => {};
    const ctx = {
        app: {}, ui: { onClick(n, fn) { clicks[n] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], set: (k, v) => { S[k] = v; changes.forEach((f) => f(k, v)); }, onChange(f) { changes.push(f); }, display: (k) => String(S[k]) },
        log: { info: nul, warn: nul, error: nul },
        spec: RT_SPEC, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')),
        signals: { watch: (iface, inst, h) => { Object.assign(handlers, h); return Promise.resolve({ available: true }); },
            proxy: () => Promise.reject(new Error('none')), on: () => Promise.resolve(), onAvailable: () => Promise.resolve() },
        loop() {}, theme: () => require(path.join(KIT, 'themes')).theme('m_tricolour'), canvas: (w, h) => new (require(path.join(KIT, 'record')).Recorder)(w, h),
    };
    require(path.join(APP, 'main.js'));
    await app.start(ctx);
    await sleep(200);
    await clicks.BTN_SHOW();
    const rows = [];
    let bad = 0;
    for (const id of (named.length ? named : LAYOUTS)) {
        ctx.settings.set('layout', id);
        if (MAP) ctx.settings.set('centre', 'map');
        handlers.statusGearboxDrive({ statusActualGearDrive: 'G3', statusActualStageDrive: 'D' });
        handlers.statusEngineTemperature({ temperatureEngineDrive: 90 + 48, temperatureEngineOilDrive: 100 + 48 });
        await sleep(2500);   // (built, the sweep over)
        client.reset();
        const eng = require(path.join(APP, 'engine')).startCluster.last;
        const p0 = eng.perf(), c0 = cpuMs(), t0 = Date.now();
        let i = 0;
        // speed and rpm as the car sends them: a reading each every 1000/HZ ms, rising and falling
        const feed = setInterval(() => {
            i++;
            const rpm = 2500 + 2000 * Math.sin(i / HZ * 1.7), kmh = 80 + 30 * Math.sin(i / HZ * 0.4);
            handlers.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: Math.round(rpm / 0.25) });
            handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) });
        }, 1000 / HZ);
        await sleep(SECS * 1000);
        clearInterval(feed);
        const secs = (Date.now() - t0) / 1000, p1 = eng.perf();
        const r = { layout: id, cpu: Math.round((cpuMs() - c0) / secs), ticks: Math.round((p1.n - p0.n) / secs), msgs: Math.round(client.messages / secs), kb: Math.round(client.bytes / secs / 1024 * 10) / 10, layers: eng.status().layers };
        if ((MAX_CPU && r.cpu > MAX_CPU) || (MAX_MSG && r.msgs > MAX_MSG)) { r.over = true; bad++; }
        rows.push(r);
        console.log([r.layout.padEnd(14), String(r.cpu).padStart(4) + ' ms CPU/s', String(r.ticks).padStart(4) + ' updates/s', String(r.msgs).padStart(5) + ' msgs/s', String(r.kb).padStart(6) + ' KB/s', r.layers + ' layers', r.over ? '  OVER' : ''].join('  '));
    }
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
