'use strict';
/**
 * sysmon.js - the head unit's load, read from /proc and /sys (no privileges needed, nothing written):
 *
 *   - CPU: all cores together and each core, from /proc/stat;
 *   - memory and swap (/proc/meminfo), the load average and uptime;
 *   - the GPU's clock against its most (Intel's i915: the driver gives no busy figure an app may read);
 *   - temperatures (/sys/class/thermal), the network's and the disks' rates (/proc/net/dev, /proc/diskstats);
 *   - each process: its CPU share, memory, threads and state, named the way the head unit runs it (a Store app's
 *     node process by its app folder, a service by its name), with a short history each, so a process that takes a
 *     lot for a while shows up even when the page wasn't open.
 *
 * Every number comes from a pair of samples (the change over the time between them). Sampling is cheap for the
 * system's own figures; the processes take a pass over /proc, so they are sampled every `procEvery` system samples
 * while the page is closed (opts.procMs) and at each sample while it is open (fast()).
 *
 *   const m = startMonitor({ sampleMs: 2000, procMs: 10000 });
 *   m.now()  m.history()  m.procs()  m.hogs()  m.fast(true)  m.stop()
 *
 * The root of /proc and /sys is opts.root (default '/'), for the tests.
 */
const fs = require('fs');
const path = require('path');

const HISTORY = 90;            // samples kept for the graphs (3 minutes at 2 s)
const PROC_HISTORY = 30;       // each process's own (1 to 5 minutes, with the page open or not)
const HOG_SHARE = 0.25;        // a process over this share of all cores, held HOG_SAMPLES samples running, is a hog
const HOG_SAMPLES = 3;

function reader(root) {
    const at = (p) => path.join(root, p);
    return {
        text: (p) => { try { return fs.readFileSync(at(p), 'utf8'); } catch (e) { return ''; } },
        list: (p) => { try { return fs.readdirSync(at(p)); } catch (e) { return []; } },
    };
}

/** /proc/stat: { all: [busy, total], cores: [[busy, total], ...], ctxt, procsRunning }. */
function parseStat(s) {
    const out = { all: [0, 0], cores: [], ctxt: 0, running: 0 };
    s.split('\n').forEach((line) => {
        const f = line.trim().split(/\s+/);
        if (/^cpu\d*$/.test(f[0])) {
            const n = f.slice(1).map(Number), idle = (n[3] || 0) + (n[4] || 0), total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
            if (f[0] === 'cpu') out.all = [total - idle, total]; else out.cores.push([total - idle, total]);
        } else if (f[0] === 'ctxt') out.ctxt = Number(f[1]) || 0;
        else if (f[0] === 'procs_running') out.running = Number(f[1]) || 0;
    });
    return out;
}
/** /proc/meminfo (kB): { total, avail, used, swapTotal, swapUsed, cached }. */
function parseMem(s) {
    const kb = (k) => { const r = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(s); return r ? Number(r[1]) : 0; };
    const total = kb('MemTotal'), avail = kb('MemAvailable') || kb('MemFree') + kb('Cached') + kb('Buffers');
    return { total, avail, used: Math.max(0, total - avail), cached: kb('Cached'), swapTotal: kb('SwapTotal'), swapUsed: Math.max(0, kb('SwapTotal') - kb('SwapFree')) };
}
/** /proc/net/dev: total bytes in and out, the loopback left out. */
function parseNet(s) {
    let rx = 0, tx = 0;
    s.split('\n').slice(2).forEach((line) => {
        const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
        if (!m || m[1].trim() === 'lo') return;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0; tx += f[8] || 0;
    });
    return { rx, tx };
}
/** /proc/diskstats: bytes read and written by whole disks (not their partitions). */
function parseDisk(s) {
    let rd = 0, wr = 0;
    s.split('\n').forEach((line) => {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !/^(mmcblk\d+|sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+)$/.test(f[2])) return;
        rd += (Number(f[5]) || 0) * 512; wr += (Number(f[9]) || 0) * 512;
    });
    return { rd, wr };
}
/** One /proc/<pid>/stat: { name, state, t (utime + stime, ticks), threads, rss (kB) }, or null. */
function parseProcStat(st) {
    if (!st) return null;
    const open = st.indexOf('('), close = st.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const f = st.slice(close + 2).split(' ');
    return { name: st.slice(open + 1, close), state: f[0], t: Number(f[11]) + Number(f[12]), threads: Number(f[17]) || 1, rss: (Number(f[21]) || 0) * 4 };
}
/**
 * What a process is, from its name and command line: { label, kind: 'app' | 'cluster' | 'system' }.
 * A node process by the Store app it runs (its folder under /var/opt/..., or the script's name).
 */
const CLUSTER = /cluster-render|waze-on-cluster|m340-waze-window|renderd|mgu-render|inputgate|mgu-uplink|mgu-deploy/;
function labelOf(name, cmd) {
    if (/^node/.test(name) && cmd) {
        const m = /\/(?:oap_)?([^/\s]+)\/(?:javascript|current|app)\//.exec(cmd) || /\/opt\/([^/\s]+)\//.exec(cmd) || /([^/\s]+)\.js\b/.exec(cmd);
        if (m) {
            const label = m[1];
            return { label, kind: CLUSTER.test(cmd) ? 'cluster' : 'app' };
        }
    }
    const base = cmd ? path.basename(cmd.split(' ')[0] || name) : name;
    const label = base && base.length > name.length && base.indexOf(name) === 0 ? base : name;
    return { label, kind: CLUSTER.test(label) || CLUSTER.test(cmd || '') ? 'cluster' : 'system' };
}

function startMonitor(opts) {
    opts = opts || {};
    const R = reader(opts.root || '/');
    const sampleMs = opts.sampleMs || 2000, procEvery = Math.max(1, Math.round((opts.procMs || 10000) / sampleMs));
    const hist = [], procs = new Map(), cmdCache = new Map(), gone = new Map();
    let last = null, cur = null, open = false, n = 0, procAt = 0, procTicks = 0, lastProcStat = null;
    const tick = typeof opts.hz === 'number' ? opts.hz : 100;   // (USER_HZ: 100 on Linux)

    function system(now) {
        const s = parseStat(R.text('proc/stat')), m = parseMem(R.text('proc/meminfo')), net = parseNet(R.text('proc/net/dev')), disk = parseDisk(R.text('proc/diskstats'));
        const num = (ps) => { for (const p of ps) { const v = parseFloat(R.text(p)); if (isFinite(v)) return v; } return null; };
        const gpu = num(['sys/class/drm/card0/gt_act_freq_mhz', 'sys/class/drm/card0/gt_cur_freq_mhz']), gpuMax = num(['sys/class/drm/card0/gt_max_freq_mhz', 'sys/class/drm/card0/gt_RP0_freq_mhz']);
        const temps = R.list('sys/class/thermal').filter((z) => /^thermal_zone\d+$/.test(z)).map((z) => {
            const v = parseFloat(R.text('sys/class/thermal/' + z + '/temp'));
            return { name: R.text('sys/class/thermal/' + z + '/type').trim() || z, c: isFinite(v) ? (v > 1000 ? v / 1000 : v) : null };
        }).filter((x) => x.c !== null && x.c > -40 && x.c < 150);
        const share = (a, b) => { const dT = a[1] - b[1]; return dT > 0 ? Math.max(0, Math.min(1, (a[0] - b[0]) / dT)) : 0; };
        const dt = last ? Math.max(0.001, (now - last.at) / 1000) : 0;
        const rate = (a, b) => (last && dt ? Math.max(0, (a - b) / dt) : 0);
        const out = {
            at: now, cpu: last ? share(s.all, last.s.all) : 0, cores: s.cores.map((c, i) => (last && last.s.cores[i] ? share(c, last.s.cores[i]) : 0)),
            running: s.running, ctxtPerS: rate(s.ctxt, last ? last.s.ctxt : 0),
            mem: m, load: R.text('proc/loadavg').split(' ').slice(0, 3).map(Number), uptime: parseFloat(R.text('proc/uptime')) || 0,
            gpuMhz: gpu, gpuMax, gpu: gpu !== null && gpuMax ? Math.max(0, Math.min(1, gpu / gpuMax)) : null, temps,
            netIn: rate(net.rx, last ? last.net.rx : 0), netOut: rate(net.tx, last ? last.net.tx : 0),
            diskRead: rate(disk.rd, last ? last.disk.rd : 0), diskWrite: rate(disk.wr, last ? last.disk.wr : 0),
        };
        last = { at: now, s, net, disk };
        return out;
    }

    /** A pass over /proc: each process's share of all cores since the last pass. */
    function processes(now) {
        const stat = parseStat(R.text('proc/stat')), totalTicks = stat.all[1], cores = Math.max(1, stat.cores.length);
        const dTicks = lastProcStat ? Math.max(1, totalTicks - lastProcStat) : 0;
        lastProcStat = totalTicks;
        const seen = new Set();
        R.list('proc').forEach((pid) => {
            if (!/^\d+$/.test(pid)) return;
            const p = parseProcStat(R.text('proc/' + pid + '/stat'));
            if (!p) return;
            seen.add(pid);
            let cmd = cmdCache.get(pid);
            if (cmd === undefined || (cmd && cmd.name !== p.name)) {
                const c = R.text('proc/' + pid + '/cmdline').split('\0').filter(Boolean).join(' ');
                cmd = { name: p.name, line: c };
                cmdCache.set(pid, cmd);
            }
            const was = procs.get(pid);
            const lab = was && was.name === p.name ? was : Object.assign({ name: p.name }, labelOf(p.name, cmd.line));
            // (its share of all cores: the change in its ticks over all the cores' ticks; the first pass counts none)
            const cpu = was && dTicks ? Math.max(0, Math.min(1, (p.t - was.t) / dTicks)) : 0;
            const h = was ? was.hist : [];
            if (was) { h.push(cpu); if (h.length > PROC_HISTORY) h.shift(); }
            const hot = cpu >= HOG_SHARE ? (was ? was.hot : 0) + 1 : 0;
            procs.set(pid, { pid: Number(pid), name: p.name, label: lab.label, kind: lab.kind, cmd: cmd.line, state: p.state, threads: p.threads, rss: p.rss, t: p.t, cpu, hist: h, hot, since: was ? was.since : now,
                peak: Math.max(was ? was.peak : 0, cpu), cores });
        });
        procs.forEach((p, pid) => { if (!seen.has(pid)) { procs.delete(pid); cmdCache.delete(pid); gone.set(pid, { label: p.label, at: now }); } });
        gone.forEach((g, pid) => { if (now - g.at > 60000) gone.delete(pid); });
        procAt = now; procTicks++;
    }

    function sample() {
        const now = Date.now();
        cur = system(now);
        if (open || n % procEvery === 0) processes(now);
        n++;
        hist.push({ t: now, cpu: cur.cpu, mem: cur.mem.total ? cur.mem.used / cur.mem.total : 0, gpu: cur.gpu, cores: cur.cores.slice() });
        if (hist.length > HISTORY) hist.shift();
        if (opts.onSample) try { opts.onSample(); } catch (e) { /* the listener's own */ }
    }
    sample();
    const timer = opts.manual ? null : setInterval(sample, sampleMs);
    if (timer && timer.unref) timer.unref();

    return {
        sample,
        now: () => cur,
        history: () => hist.slice(),
        /** The processes, busiest first (by: 'cpu' or 'mem'). */
        procs(by) {
            const list = Array.from(procs.values());
            return by === 'mem' ? list.sort((a, b) => b.rss - a.rss || b.cpu - a.cpu) : list.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
        },
        /** The processes grouped by what they are (a Store app's several processes as one), busiest first. */
        groups(kind) {
            const g = new Map();
            procs.forEach((p) => {
                if (kind && p.kind !== kind) return;
                const x = g.get(p.label) || { label: p.label, kind: p.kind, cpu: 0, rss: 0, n: 0, hist: [], pids: [] };
                x.cpu += p.cpu; x.rss += p.rss; x.n++; x.pids.push(p.pid);
                // (the histories added up, lined up at their newest sample)
                const a = x.hist, b = p.hist, L = Math.max(a.length, b.length), sum = [];
                for (let i = 0; i < L; i++) { const ai = a.length - L + i, bi = b.length - L + i; sum.push((ai >= 0 ? a[ai] : 0) + (bi >= 0 ? b[bi] : 0)); }
                x.hist = sum;
                g.set(p.label, x);
            });
            return Array.from(g.values()).sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
        },
        /** What is slowing the head unit now: [{ level: 'red' | 'amber', text }]. */
        hogs() {
            const out = [];
            if (!cur) return out;
            const cpu3 = hist.slice(-3), busy = cpu3.length >= 3 && cpu3.every((h) => h.cpu > 0.85);
            procs.forEach((p) => {
                if (p.hot >= HOG_SAMPLES) out.push({ level: p.cpu >= 0.5 ? 'red' : 'amber', text: p.label + ' has used ' + Math.round(p.cpu * 100) + ' % of the CPU for ' + Math.round(p.hot * (open ? sampleMs : sampleMs * procEvery) / 1000) + ' s' });
            });
            if (busy) out.push({ level: 'red', text: 'The CPU has been over 85 % busy for ' + Math.round(cpu3.length * sampleMs / 1000) + ' s: the cluster and the map will lag' });
            if (cur.mem.total && cur.mem.avail / cur.mem.total < 0.08) out.push({ level: 'red', text: 'Memory is nearly full: ' + Math.round(cur.mem.avail / 1024) + ' MB free' });
            const hotZone = cur.temps.filter((z) => z.c >= 85).sort((a, b) => b.c - a.c)[0];
            if (hotZone) out.push({ level: hotZone.c >= 95 ? 'red' : 'amber', text: 'Hot: ' + hotZone.name + ' at ' + Math.round(hotZone.c) + ' °C (the CPU slows itself down)' });
            if (cur.load[0] > Math.max(2, cur.cores.length * 2)) out.push({ level: 'amber', text: 'Load ' + cur.load[0].toFixed(1) + ' on ' + cur.cores.length + ' cores: more work waiting than the CPU can run' });
            return out;
        },
        /** Processes that ended in the last minute: [{ label, at }]. */
        ended: () => Array.from(gone.values()).sort((a, b) => b.at - a.at),
        /** The page open (every sample takes the processes) or closed (every procMs). */
        fast(on) { const was = open; open = !!on; if (open && !was && Date.now() - procAt > sampleMs) processes(Date.now()); },
        stats: () => ({ samples: n, procPasses: procTicks, procs: procs.size }),
        stop() { if (timer) clearInterval(timer); },
    };
}

module.exports = { startMonitor, parseStat, parseMem, parseNet, parseDisk, parseProcStat, labelOf };
