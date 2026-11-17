'use strict';

// Task Manager (apps/task_manager): the head unit's figures read from a stand-in /proc and /sys, the processes named
// and shared out, what is slowing it down, and each page drawn. No SDK or car needed:
//   node kit/tools/test_task_manager.js [out-folder]   (with a folder: each page as a PNG there)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'task_manager');
const S = require(path.join(APP, 'sysmon'));
let ok = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('ok   ' + name); });

/* ---------- a stand-in head unit: /proc and /sys under a folder, its numbers moved on by step() ---------- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const T = { busy: [0, 0, 0, 0], idle: [0, 0, 0, 0], procs: {}, rx: 0, tx: 0, rd: 0, wr: 0 };
const PROCS = {
    101: { name: 'cluster-render', cmd: '/var/opt/cluster-render/current/cluster-render\0-c\0x.conf', rss: 9000, thr: 6 },
    202: { name: 'node', cmd: '/usr/bin/node\0/var/opt/oap_cluster_layouts/javascript/main.js', rss: 21000, thr: 11 },
    203: { name: 'node', cmd: '/usr/bin/node\0/var/opt/oap_cluster_layouts/javascript/worker.js', rss: 5000, thr: 4 },
    303: { name: 'waze-on-cluste', cmd: '/var/opt/waze-on-cluster/current/waze-on-cluster\0-c\0w.conf', rss: 40000, thr: 9 },
    404: { name: 'node', cmd: '/usr/bin/node\0/var/opt/oap_flex_fuel/javascript/main.js', rss: 15000, thr: 7 },
    505: { name: 'hmi_app', cmd: '/opt/bmw/bin/hmi_app', rss: 300000, thr: 80 },
};
/** One step of the stand-in: each core and process busy as given (ticks this step, 100 a core). */
function step(coreBusy, procTicks) {
    coreBusy.forEach((b, i) => { T.busy[i] += b; T.idle[i] += 100 - b; });
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    put('proc/stat', 'cpu  ' + sum(T.busy) + ' 0 0 ' + sum(T.idle) + ' 0 0 0 0 0 0\n' + T.busy.map((b, i) => 'cpu' + i + ' ' + b + ' 0 0 ' + T.idle[i] + ' 0 0 0 0 0 0').join('\n') + '\nctxt 5000\nprocs_running 3\n');
    Object.keys(PROCS).forEach((pid) => {
        const p = PROCS[pid];
        T.procs[pid] = (T.procs[pid] || 0) + (procTicks[pid] || 0);
        // (fields after the name: state ppid ... utime(14) stime(15) ... num_threads(20) ... rss(24), counted from 1)
        const f = ['S', 1, 1, 1, 0, -1, 0, 0, 0, 0, 0, T.procs[pid], 0, 0, 0, 20, 0, p.thr, 0, 100, 1000, p.rss / 4];
        put('proc/' + pid + '/stat', pid + ' (' + p.name + ') ' + f.join(' ') + '\n');
        put('proc/' + pid + '/cmdline', p.cmd);
    });
    T.rx += 200000; T.tx += 50000; T.rd += 4096 * 10; T.wr += 512 * 4;
    put('proc/net/dev', 'Inter-|\n face |\n    lo: 999 0 0 0 0 0 0 0 999 0\n  eth0: ' + T.rx + ' 0 0 0 0 0 0 0 ' + T.tx + ' 0 0 0 0 0 0 0\n');
    put('proc/diskstats', '   8       0 mmcblk0 10 0 ' + T.rd / 512 + ' 0 4 0 ' + T.wr / 512 + ' 0 0 0 0\n   8       1 mmcblk0p1 10 0 999999 0 4 0 999999 0 0 0 0\n');
}
put('proc/meminfo', 'MemTotal:        4000000 kB\nMemFree:          200000 kB\nMemAvailable:    1000000 kB\nCached:           500000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
put('proc/loadavg', '2.50 1.80 1.20 3/400 999\n');
put('proc/uptime', '7384.2 1000.0\n');
put('sys/class/drm/card0/gt_act_freq_mhz', '450\n'); put('sys/class/drm/card0/gt_max_freq_mhz', '700\n');
put('sys/class/thermal/thermal_zone0/type', 'x86_pkg_temp\n'); put('sys/class/thermal/thermal_zone0/temp', '71000\n');
put('sys/class/thermal/thermal_zone1/type', 'acpitz\n'); put('sys/class/thermal/thermal_zone1/temp', '45000\n');

(async () => {
    await check('the parsers: /proc/stat, meminfo, net, disks and a process\'s stat with a space and brackets in its name', () => {
        const st = S.parseStat('cpu  10 0 10 70 10 0 0 0\ncpu0 5 0 5 35 5 0 0 0\ncpu1 5 0 5 35 5 0 0 0\nctxt 42\n');
        assert.deepStrictEqual(st.all, [20, 100]); assert.strictEqual(st.cores.length, 2); assert.strictEqual(st.ctxt, 42);
        const m = S.parseMem('MemTotal: 1000 kB\nMemAvailable: 250 kB\n');
        assert.strictEqual(m.used, 750);
        assert.deepStrictEqual(S.parseNet('a\nb\n lo: 5 0 0 0 0 0 0 0 5\n wlan0: 100 0 0 0 0 0 0 0 40\n'), { rx: 100, tx: 40 });
        const p = S.parseProcStat('77 (my (odd) app) R 1 1 1 0 -1 0 0 0 0 0 30 12 0 0 20 0 5 0 100 1000 256');
        assert.deepStrictEqual([p.name, p.state, p.t, p.threads, p.rss], ['my (odd) app', 'R', 42, 5, 1024]);
    });
    await check('names: a Store app\'s node process by its app folder, the cluster\'s services as cluster, the rest as system', () => {
        assert.deepStrictEqual(S.labelOf('node', '/usr/bin/node /var/opt/oap_cluster_layouts/javascript/main.js'), { label: 'cluster_layouts', kind: 'app' });
        assert.strictEqual(S.labelOf('cluster-render', '/var/opt/cluster-render/current/cluster-render -c x').kind, 'cluster');
        assert.strictEqual(S.labelOf('waze-on-cluste', '/var/opt/waze-on-cluster/current/waze-on-cluster').label, 'waze-on-cluster');
        assert.strictEqual(S.labelOf('hmi_app', '/opt/bmw/bin/hmi_app').kind, 'system');
    });

    step([10, 10, 10, 10], {});
    const m = S.startMonitor({ root, manual: true, sampleMs: 2000, procMs: 2000 });
    m.fast(true);
    // a step: cores 30 % busy, Waze on cluster takes 60 ticks of the 400, cluster-render 20, the app's two processes 10 + 6
    const busy = () => { step([30, 30, 30, 30], { 303: 60, 101: 20, 202: 10, 203: 6, 505: 4 }); m.sample(); };
    busy();
    await check('the system: CPU all and each core, memory, load, uptime, GPU clock, temperatures, network and disk rates', () => {
        const n = m.now();
        assert(Math.abs(n.cpu - 0.3) < 1e-9, n.cpu); assert.strictEqual(n.cores.length, 4); assert(n.cores.every((c) => Math.abs(c - 0.3) < 1e-9));
        assert.strictEqual(n.mem.used, 3000000); assert.deepStrictEqual(n.load, [2.5, 1.8, 1.2]); assert.strictEqual(Math.round(n.uptime), 7384);
        assert(Math.abs(n.gpu - 450 / 700) < 1e-9); assert.deepStrictEqual(n.temps.map((x) => [x.name, x.c]), [['x86_pkg_temp', 71], ['acpitz', 45]]);
        assert(n.netIn > 0 && n.netOut > 0 && n.diskRead > 0, 'rates (the loopback and the partitions not counted)');
    });
    await check('processes: each one\'s share of all cores, busiest first; by memory', () => {
        const ps = m.procs('cpu');
        assert.strictEqual(ps[0].label, 'waze-on-cluster'); assert(Math.abs(ps[0].cpu - 60 / 400) < 1e-9, ps[0].cpu);
        assert.strictEqual(m.procs('mem')[0].label, 'hmi_app');
    });
    await check('apps: a Store app\'s processes counted together; the cluster\'s services apart', () => {
        const a = m.groups('app').find((g) => g.label === 'cluster_layouts');
        assert.strictEqual(a.n, 2); assert(Math.abs(a.cpu - 16 / 400) < 1e-9); assert.strictEqual(a.rss, 26000);
        assert.deepStrictEqual(m.groups('cluster').map((g) => g.label).sort(), ['cluster-render', 'waze-on-cluster']);
    });
    await check('nothing slowing it down at 30 %', () => assert.deepStrictEqual(m.hogs(), []));
    // a hog: Waze on cluster at 70 % of all cores, the CPU over 85 % busy, for a few samples
    for (let i = 0; i < 4; i++) { step([95, 95, 90, 92], { 303: 280, 101: 30, 202: 20 }); m.sample(); }
    await check('a hog: the process named, the CPU over 85 % said', () => {
        const h = m.hogs();
        assert(h.some((x) => x.level === 'red' && /^waze-on-cluster has used 70 %/.test(x.text)), JSON.stringify(h));
        assert(h.some((x) => /CPU has been over 85 %/.test(x.text)), JSON.stringify(h));
        assert(h.some((x) => /Load 2.5/.test(x.text)) === false, 'load 2.5 on 4 cores is fine');
    });
    await check('a process that ends: gone from the list, said for a minute', () => {
        fs.rmSync(path.join(root, 'proc', '404'), { recursive: true });
        delete PROCS[404];
        step([30, 30, 30, 30], {}); m.sample();
        assert(!m.procs().some((p) => p.pid === 404));
        assert.deepStrictEqual(m.ended().map((e) => e.label), ['flex_fuel']);
    });
    await check('closed: the processes only every procMs; open again: at once', () => {
        const m2 = S.startMonitor({ root, manual: true, sampleMs: 2000, procMs: 10000 });
        const p0 = m2.stats().procPasses;
        for (let i = 0; i < 4; i++) m2.sample();
        assert.strictEqual(m2.stats().procPasses - p0, 0, 'none in 4 samples');
        m2.sample(); assert.strictEqual(m2.stats().procPasses - p0, 1, 'the 5th');
        m2.fast(true); m2.sample(); assert(m2.stats().procPasses - p0 >= 2);
        m2.stop();
    });

    /* ---------- the app on stand-ins: each page drawn ---------- */
    const info = fs.mkdtempSync(path.join(os.tmpdir(), 'tmi-'));
    process.env.CLUSTER_INFO_DIR = info;
    process.env.RENDER_STATUS = path.join(info, 'status.txt');
    process.env.WOC_STATUS = path.join(info, 'woc.json');
    fs.writeFileSync(path.join(info, 'layouts_perf.json'), JSON.stringify({ app: 'cluster_layouts', at: Date.now(), layout: 'm340', shown: true, layers: 44, updatesPerS: 52, avgMs: 1.8, maxMs: 9.5, msgsPerS: 96, kbPerS: 11.2, rttMs: 14, rttMaxMs: 38, rttOn: true }));
    fs.writeFileSync(process.env.RENDER_STATUS, 'upload: cap 5500 KB/s (ceiling 5500, floor 2000): ceiling\ntarget map: slot 0x100 scene 0x10004f0 1088x480: idle\ntarget panel: slot 0x203 scene 0x10004f8 1920x720: shown (us); renderer subscription not observable\ntarget hud: slot 0x323 scene 0x1000400 800x480: idle\n');
    fs.writeFileSync(process.env.WOC_STATUS, JSON.stringify({ ev: 'status', state: 'showing', target: 'panel', page: 'Waze map — 29 frames/s (385.1 MB, 37708 frames)', reason: '' }));
    let app = null, appMon = null;
    const load = Module._load;
    Module._load = function (req, parent, isMain) {
        if (req === './kit/mgu') return { run(a) { app = a; } };
        if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
        if (req === './sysmon') return { startMonitor: (o) => (appMon = S.startMonitor(Object.assign({}, o, { root, manual: true }))) };
        return load.call(this, req, parent, isMain);
    };
    const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const themes = require(path.join(KIT, 'themes'));
    const { Canvas } = require(path.join(KIT, 'canvas'));
    const { Recorder, play } = require(path.join(KIT, 'record'));
    const St = {}, listeners = [], clicks = {};
    SPEC.settings.forEach((s) => { St[s.key] = s.default; });
    await check('every setting\'s default is one of its choices', () => SPEC.settings.forEach((s) => assert(s.options.some((o) => o[0] === s.default), s.key)));
    const warns = [];
    let loopFn = null, last = null, tabFn = null, frames = 0;
    const ctx = {
        app: {}, ui: { onClick(n, f) { clicks[n] = f; }, text() {}, image: async (n, cv) => { last = cv; frames++; } },
        settings: { get: (k) => St[k], set: (k, v) => { St[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f), display: (k) => String(St[k]) },
        log: { info() {}, warn: (x) => warns.push(x), error: (x, e) => warns.push(x + ' ' + e) },
        spec: SPEC, dataDir: info,
        loop: (name, fps, fn) => { loopFn = fn; }, onTab: (f) => { tabFn = f; }, onLayout() {},
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => new Recorder(w, h),
    };
    require(path.join(APP, 'main.js'));
    await app.start(ctx);
    // three minutes of driving with Waze on: the load rising and falling
    for (let i = 0; i < 60; i++) {
        const w = 0.5 + 0.5 * Math.sin(i / 7), c = Math.round(25 + 50 * w);
        step([c + 8, c, c - 6, c + 3], { 303: Math.round(90 + 120 * w), 101: Math.round(20 + 30 * w), 202: Math.round(12 + 10 * w), 203: 4, 505: Math.round(10 + 8 * Math.cos(i / 5)) });
        put('sys/class/drm/card0/gt_act_freq_mhz', String(Math.round(300 + 350 * w)));
        appMon.sample();
    }
    const out = process.argv[2];
    const shot = (name) => { if (!out) return; fs.mkdirSync(out, { recursive: true }); const cv = new Canvas(last.w, last.h); play(last.words(), cv); fs.writeFileSync(path.join(out, name + '.png'), cv.png(6)); };
    for (const [i, name] of ['overview', 'processes', 'apps', 'cluster'].entries()) {
        await tabFn(i);
        await check('the ' + name + ' page draws without warnings', () => assert(last && warns.length === 0, warns.join('; ')));
        shot(name);
    }
    await check('drawn only when something changed: no new frame without a new sample', async () => {
        const f0 = frames;
        await loopFn(); await loopFn();
        assert.strictEqual(frames, f0);
    });
    await check('Sort: by memory, then back', async () => {
        await tabFn(1); await clicks.BTN_SORT();
        assert.strictEqual(St.sortBy, 'mem');
        shot('processes_mem');
        await clicks.BTN_SORT(); assert.strictEqual(St.sortBy, 'cpu');
    });
    console.log(ok + ' passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
