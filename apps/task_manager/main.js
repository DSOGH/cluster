'use strict';
/**
 * Task Manager - what the head unit is doing: how busy its CPU, memory and GPU are, which processes and Store apps
 * take the most, what is slowing it down, and how the cluster's own pipeline keeps up (Cluster Layouts' updates, the
 * cluster renderer, Waze on cluster).
 *
 * Four pages (the tabs):
 *   Overview   CPU (all cores and each), memory and the GPU's clock over the last three minutes; temperatures, the
 *              network and the disks; what is slowing the head unit now (hogs), and the busiest processes;
 *   Processes  every process, busiest first (Sort: CPU or memory), with its share, memory, threads and a trend;
 *   Apps       the Store apps and the cluster's services, each app's processes counted together;
 *   Cluster    Cluster Layouts' updates and the renderer's round trip (how far behind the cluster is), the
 *              renderer's upload cap and targets, Waze on cluster's state.
 *
 * Light by design: the system's figures every few seconds (a few small files); the processes at each sample only
 * while the page is open, every 10 s while it is closed (Settings > Watch while closed), so a process that took a lot
 * meanwhile still shows; the page drawn only when something changed. It reads only (/proc, /sys and the status
 * files the cluster's apps write) and stops nothing.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { startMonitor } = require('./sysmon');

const W = 1600, H = 520;
const TABS = ['Overview', 'Processes', 'Apps', 'Cluster'];
const ROWS = 9;                          // processes a page
const OPEN_MS = 3000;                    // the screen counts as open while it was drawn this recently
const INFO = process.env.CLUSTER_INFO_DIR || '/dev/shm/cluster-info';
const RENDER_STATUS = process.env.RENDER_STATUS || '/run/cluster-render/status.txt';
const WOC_STATUS = process.env.WOC_STATUS || '/run/waze-on-cluster/status.json';
const C = { cpu: '#3cd7ff', mem: '#ffb020', gpu: '#3ddc84', red: '#ff4457', amber: '#ffb020', green: '#3ddc84', app: '#9f8cff', cluster: '#3cd7ff', system: '#8e9199' };

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const age = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch (e) { return Infinity; } };
const mb = (kb) => (kb >= 1024 * 1024 ? (kb / 1024 / 1024).toFixed(1) + ' GB' : Math.round(kb / 1024) + ' MB');
const rate = (b) => (b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB/s' : b >= 1024 ? Math.round(b / 1024) + ' KB/s' : Math.round(b) + ' B/s');
const dur = (s) => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'; };
const fit = (cv, s, size, w, opts) => { s = String(s); if (cv.textWidth(s, size, opts) <= w) return s; while (s.length > 1 && cv.textWidth(s + '…', size, opts) > w) s = s.slice(0, -1); return s + '…'; };

/** Cluster Layouts' own numbers (layouts_perf.json), the renderer's status text and Waze on cluster's status. */
function clusterInfo() {
    const lp = readJson(path.join(INFO, 'layouts_perf.json')), lpAge = age(path.join(INFO, 'layouts_perf.json'));
    const rs = read(RENDER_STATUS), woc = age(WOC_STATUS) < 15000 ? readJson(WOC_STATUS) : null;
    const lines = rs.split('\n');
    return {
        layouts: lp && lpAge < 10000 ? lp : null,
        upload: (lines.find((l) => /^upload:/.test(l)) || '').replace(/^upload:\s*/, ''),
        targets: lines.filter((l) => /^target (map|panel|hud):/.test(l)).map((l) => l.replace(/ scene 0x[0-9a-f]+/, '').replace(/; renderer subscription not observable/, '')),
        renderer: rs ? (age(RENDER_STATUS) < 10000 ? 'running' : 'not updating') : 'not installed or not readable',
        woc,
    };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let tab = 0, page = 0, dirty = true, drawnAt = 0;
        const open = () => Date.now() - drawnAt < OPEN_MS;
        const sortBy = () => (settings.get('sortBy') === 'mem' ? 'mem' : 'cpu');
        // (a share as a percentage: of all the cores together, or 100 % a core, as top shows it)
        const pct = (v, cores) => Math.round((v || 0) * 100 * (settings.get('cpuScale') === 'core' ? cores || 1 : 1)) + ' %';

        let mon = null;
        const startMon = () => {
            if (mon) mon.stop();
            const every = (Number(settings.get('refresh')) || 2) * 1000;
            mon = startMonitor({ sampleMs: every, procMs: settings.get('watchClosed') === 'off' ? 600000 : 10000, onSample: () => { dirty = true; mon && mon.fast(open()); } });
        };
        startMon();
        settings.onChange((k) => { if (k === 'refresh' || k === 'watchClosed') startMon(); dirty = true; });
        ctx.onTab((i) => { tab = i; page = 0; dirty = true; return render(); });
        ctx.onLayout(() => { dirty = true; });
        ui.onClick('BTN_NEXT', () => {
            if (tab === 1) { const n = Math.max(1, Math.ceil(mon.procs().length / ROWS)); page = (page + 1) % n; } else { tab = (tab + 1) % TABS.length; page = 0; }
            dirty = true; return render();
        });
        ui.onClick('BTN_SORT', () => { settings.set('sortBy', sortBy() === 'cpu' ? 'mem' : 'cpu'); page = 0; dirty = true; return render(); });

        /* ---------- Overview ---------- */
        function graph(cv, t, x, y, w, h, hist, key, colour, label, value) {
            cv.roundRect(x, y, w, h, 8, t.track);
            [0.25, 0.5, 0.75].forEach((f) => cv.fillRect(x + 6, Math.round(y + h - f * h), w - 12, 1, G.withAlpha('#ffffff', 0.06)));
            const pts = [];
            hist.forEach((s, i) => { const v = s[key]; if (v !== null && v !== undefined) pts.push([x + 4 + (w - 8) * (i + 90 - hist.length) / 89, y + h - 4 - Math.max(0, Math.min(1, v)) * (h - 8)]); });
            if (pts.length > 1) { cv.fillUnder(pts, y + h - 4, G.withAlpha(colour, 0.18)); cv.polyline(pts, 3, colour); }
            cv.text(label, x, y - 10, 18, t.dim, { font: 'bold', literal: true });
            cv.text(value, x + w, y - 10, 18, t.text, { font: 'bold', literal: true, align: 'right' });
        }
        function overview(cv, t) {
            const n = mon.now(), h = mon.history(), cores = n.cores.length || 1;
            graph(cv, t, 32, 76, 560, 120, h, 'cpu', C.cpu, 'CPU  ·  ' + cores + ' cores', pct(n.cpu, cores) + '   load ' + n.load.map((v) => (v || 0).toFixed(1)).join(' '));
            // each core: a bar, how busy now
            const bw = Math.min(64, (560 - (cores - 1) * 8) / cores);
            n.cores.forEach((c, i) => {
                const x = 32 + i * (bw + 8);
                cv.roundRect(x, 206, bw, 14, 4, t.track);
                if (c > 0.01) cv.roundRect(x, 206, Math.max(6, bw * c), 14, 4, c > 0.85 ? C.red : c > 0.6 ? C.amber : C.cpu);
            });
            graph(cv, t, 32, 262, 560, 100, h, 'mem', C.mem, 'Memory', mb(n.mem.used) + ' of ' + mb(n.mem.total) + (n.mem.swapUsed ? '  ·  swap ' + mb(n.mem.swapUsed) : ''));
            graph(cv, t, 32, 400, 560, 90, h, 'gpu', C.gpu, 'GPU clock', n.gpuMhz !== null ? Math.round(n.gpuMhz) + ' of ' + Math.round(n.gpuMax || 0) + ' MHz' : 'not readable here');

            // right now: tiles
            const hot = n.temps.slice().sort((a, b) => b.c - a.c)[0];
            const tiles = [
                ['UP', dur(n.uptime)],
                ['HOTTEST', hot ? Math.round(hot.c) + ' °C' : '-'],
                ['NETWORK', 'in ' + rate(n.netIn) + '   out ' + rate(n.netOut)],
                ['DISK', 'read ' + rate(n.diskRead) + '   write ' + rate(n.diskWrite)],
            ];
            tiles.forEach(([k, v], i) => {
                const x = 632 + (i % 2) * 476, y = 58 + Math.floor(i / 2) * 70;
                cv.roundRect(x, y, 460, 60, 10, t.track);
                cv.text(k, x + 16, y + 24, 14, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                cv.text(v, x + 16, y + 50, 22, t.text, { font: 'bold', literal: true });
            });

            // what is slowing it down
            const hogs = mon.hogs();
            cv.text('WHAT IS SLOWING IT DOWN', 632, 220, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            if (!hogs.length) cv.text('Nothing: the head unit has room to spare', 632, 252, 22, C.green, { font: 'bold', literal: true });
            hogs.slice(0, 3).forEach((x, i) => {
                const y = 252 + i * 32;
                cv.roundRect(632, y - 18, 8, 22, 3, C[x.level]);
                cv.text(fit(cv, x.text, 20, 920, { literal: true }), 652, y, 20, t.text, { literal: true });
            });
            // the busiest now
            const y0 = 252 + Math.max(1, Math.min(3, hogs.length)) * 32 + 22;
            cv.text('BUSIEST NOW', 632, y0, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            mon.procs('cpu').slice(0, Math.max(2, Math.floor((500 - y0) / 34))).forEach((p, i) => {
                const y = y0 + 32 + i * 34;
                cv.roundRect(632, y - 22, 300, 28, 6, t.track);
                if (p.cpu > 0.005) cv.roundRect(632, y - 22, Math.max(6, 300 * Math.min(1, p.cpu)), 28, 6, G.withAlpha(C[p.kind] || C.system, 0.55));
                cv.text(fit(cv, p.label, 18, 280, { literal: true }), 642, y - 2, 18, t.text, { literal: true });
                cv.text(pct(p.cpu, p.cores), 1010, y - 2, 18, t.text, { font: 'bold', literal: true, align: 'right' });
                cv.text(mb(p.rss), 1120, y - 2, 18, t.dim, { literal: true, align: 'right' });
                cv.text(p.kind, 1140, y - 2, 16, C[p.kind] || t.dim, { literal: true });
            });
        }

        /* ---------- a trend line in a table cell ---------- */
        // (scaled to its own highest, but never finer than a quarter of the CPU: a quiet process stays a flat line)
        function spark(cv, x, y, w, h, hist, colour) {
            cv.fillRect(x, y + h, w, 1, G.withAlpha('#ffffff', 0.12));
            if (hist.length < 2) return;
            const top = Math.max(0.25, Math.max.apply(null, hist)), n = 30;
            const pts = hist.map((v, i) => [x + w * (i + n - hist.length) / (n - 1), y + h - Math.max(0, Math.min(1, v / top)) * h]);
            cv.fillUnder(pts, y + h, G.withAlpha(colour, 0.2));
            cv.polyline(pts, 2, colour);
        }

        /* ---------- Processes ---------- */
        function processes(cv, t) {
            const all = mon.procs(sortBy()), pages = Math.max(1, Math.ceil(all.length / ROWS));
            if (page >= pages) page = 0;
            const rows = all.slice(page * ROWS, (page + 1) * ROWS);
            cv.text(all.length + ' processes  ·  sorted by ' + (sortBy() === 'cpu' ? 'CPU' : 'memory') + '  ·  page ' + (page + 1) + ' of ' + pages + '  ·  CPU as ' + (settings.get('cpuScale') === 'core' ? '100 % a core' : 'a share of all cores'),
                32, 72, 18, t.dim, { literal: true });
            const cols = [['NAME', 32, 'left'], ['KIND', 470, 'left'], ['PID', 640, 'right'], ['CPU', 780, 'right'], ['LAST MINUTE', 820, 'left'], ['MEMORY', 1160, 'right'], ['THREADS', 1290, 'right'], ['STATE', 1330, 'left']];
            cols.forEach(([l, x, al]) => cv.text(l, x, 104, 14, t.dim, { font: 'bold', spacing: 1.5, align: al, literal: true }));
            const STATE = { R: 'running', S: 'sleeping', D: 'waiting on disk', Z: 'zombie', T: 'stopped', I: 'idle' };
            rows.forEach((p, i) => {
                const y = 140 + i * 40;
                if (i % 2) cv.fillRect(24, y - 26, W - 48, 40, G.withAlpha('#ffffff', 0.03));
                cv.text(fit(cv, p.label + (p.label !== p.name ? '  (' + p.name + ')' : ''), 20, 420, { literal: true }), 32, y, 20, t.text, { literal: true });
                cv.text(p.kind, 470, y, 18, C[p.kind] || t.dim, { literal: true });
                cv.text(String(p.pid), 640, y, 18, t.dim, { literal: true, align: 'right' });
                cv.text(pct(p.cpu, p.cores), 780, y, 20, p.cpu > 0.5 ? C.red : p.cpu > 0.25 ? C.amber : t.text, { font: 'bold', literal: true, align: 'right' });
                spark(cv, 820, y - 22, 240, 24, p.hist, C[p.kind] || C.system);
                cv.text(mb(p.rss), 1160, y, 18, t.text, { literal: true, align: 'right' });
                cv.text(String(p.threads), 1290, y, 18, t.dim, { literal: true, align: 'right' });
                cv.text(STATE[p.state] || p.state, 1330, y, 18, p.state === 'D' || p.state === 'Z' ? C.amber : t.dim, { literal: true });
            });
        }

        /* ---------- Apps ---------- */
        function apps(cv, t) {
            const section = (title, list, y0, max) => {
                cv.text(title, 32, y0, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                if (!list.length) { cv.text('none running', 32, y0 + 34, 20, t.dim, { literal: true }); return y0 + 50; }
                list.slice(0, max).forEach((g, i) => {
                    const y = y0 + 34 + i * 38;
                    cv.text(fit(cv, g.label, 20, 380, { literal: true }), 32, y, 20, t.text, { literal: true });
                    cv.text(g.n > 1 ? g.n + ' processes' : '1 process', 430, y, 16, t.dim, { literal: true });
                    cv.text(pct(g.cpu, (mon.now().cores || []).length), 680, y, 20, g.cpu > 0.5 ? C.red : g.cpu > 0.25 ? C.amber : t.text, { font: 'bold', literal: true, align: 'right' });
                    spark(cv, 720, y - 22, 420, 26, g.hist, C[g.kind]);
                    cv.text(mb(g.rss), 1290, y, 18, t.text, { literal: true, align: 'right' });
                });
                return y0 + 34 + Math.min(max, list.length) * 38;
            };
            [['CPU', 680, 'right'], ['LAST MINUTES', 720, 'left'], ['MEMORY', 1290, 'right']].forEach(([l, x, al]) => cv.text(l, x, 66, 14, t.dim, { font: 'bold', spacing: 1.5, align: al, literal: true }));
            const a = mon.groups('app'), c = mon.groups('cluster');
            let y = section('STORE APPS  ·  ' + a.length, a, 72, 5);
            y = section('CLUSTER, MAP AND STORE SERVICES  ·  ' + c.length, c, y + 18, Math.max(2, Math.floor((500 - y - 52) / 38)));
            const ended = mon.ended().slice(0, 3);
            if (ended.length) cv.text('Ended in the last minute: ' + ended.map((e) => e.label).join(', '), 1320, 72, 16, t.dim, { literal: true, align: 'right' });
        }

        /* ---------- Cluster ---------- */
        function cluster(cv, t) {
            const ci = clusterInfo(), L = ci.layouts;
            const col = (ms) => (ms < 60 ? C.green : ms < 200 ? C.amber : C.red);
            cv.text('CLUSTER LAYOUTS', 32, 76, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            if (!L) cv.text('Not running, or not on the cluster (no numbers in the last 10 s)', 32, 110, 20, t.dim, { literal: true });
            else {
                const tiles = [
                    ['ON THE CLUSTER', L.shown ? L.layout + ', ' + L.layers + ' layers' : 'not shown', t.text],
                    ['UPDATES', L.updatesPerS + ' a second, ' + L.avgMs + ' ms each (most ' + L.maxMs + ')', L.maxMs > 30 ? C.amber : t.text],
                    ['SENT TO THE RENDERER', L.msgsPerS + ' messages a second, ' + L.kbPerS + ' KB/s', t.text],
                    ['RENDERER ROUND TRIP', L.rttOn ? L.rttMs + ' ms (most ' + L.rttMaxMs + ' ms)' : 'not measured (older renderer)', L.rttOn ? col(L.rttMaxMs) : t.dim],
                ];
                tiles.forEach(([k, v, c], i) => {
                    const x = 32 + (i % 2) * 776, y = 92 + Math.floor(i / 2) * 70;
                    cv.roundRect(x, y, 760, 60, 10, t.track);
                    cv.text(k, x + 16, y + 24, 14, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                    cv.text(fit(cv, v, 22, 728, { literal: true }), x + 16, y + 50, 22, c, { font: 'bold', literal: true });
                });
                const verdict = !L.rttOn ? null : L.rttMaxMs < 60 ? ['The cluster keeps up: each change reaches the renderer within ' + L.rttMaxMs + ' ms', C.green]
                    : L.rttMaxMs < 200 ? ['The renderer is busy: changes reach it within ' + L.rttMaxMs + ' ms (only the newest goes while it catches up)', C.amber]
                        : ['The renderer is far behind (' + L.rttMaxMs + ' ms): the head unit is overloaded; see Overview for what takes the CPU', C.red];
                if (verdict) cv.text(fit(cv, verdict[0], 20, W - 64, { literal: true }), 32, 252, 20, verdict[1], { font: 'bold', literal: true });
            }
            cv.text('CLUSTER RENDERER  ·  ' + ci.renderer, 32, 300, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            if (ci.upload) cv.text('Upload ' + ci.upload, 32, 330, 18, t.text, { literal: true });
            ci.targets.forEach((l, i) => cv.text(fit(cv, l, 18, 740, { literal: true }), 32, 358 + i * 28, 18, /shown/.test(l) ? C.green : t.dim, { literal: true }));
            cv.text('WAZE ON CLUSTER', 808, 300, 16, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            if (!ci.woc) cv.text('not running', 808, 330, 18, t.dim, { literal: true });
            else {
                cv.text(ci.woc.state + (ci.woc.target ? ' on the ' + ci.woc.target : ''), 808, 330, 18, ci.woc.state === 'showing' ? C.green : t.text, { literal: true });
                if (ci.woc.page) cv.text(fit(cv, ci.woc.page, 18, 760, { literal: true }), 808, 358, 18, t.text, { literal: true });
                if (ci.woc.reason) cv.text(fit(cv, ci.woc.reason, 16, 760, { literal: true }), 808, 386, 16, t.dim, { literal: true });
            }
            const svc = mon.groups('cluster').slice(0, 3);
            svc.forEach((g, i) => cv.text(fit(cv, g.label + '  ' + pct(g.cpu, (mon.now().cores || []).length) + ' CPU, ' + mb(g.rss), 18, 760, { literal: true }), 808, 420 + i * 26, 18, t.dim, { literal: true }));
        }

        function render() {
            drawnAt = Date.now();
            if (mon) mon.fast(true);
            if (!dirty) return;
            dirty = false;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            try {
                [overview, processes, apps, cluster][tab](cv, t);
            } catch (e) { log.warn('page ' + TABS[tab] + ': ' + (e && e.stack || e)); cv.text('This page could not be drawn: ' + e, 32, 120, 20, t.warn, { literal: true }); }
            const n = mon.now(), hogs = mon.hogs();
            G.frame(cv, t, TABS, tab, [hogs.length ? { text: hogs.length + (hogs.length > 1 ? ' ISSUES' : ' ISSUE'), color: hogs.some((x) => x.level === 'red') ? 'crit' : 'warn' } : null,
                { text: 'CPU ' + Math.round(n.cpu * 100) + '%', color: n.cpu > 0.85 ? 'crit' : n.cpu > 0.6 ? 'warn' : 'dim' }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        Promise.resolve().then(render).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { clusterInfo };
