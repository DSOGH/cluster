'use strict';
/**
 * perf.js - the head unit's load, for the app's Performance page: CPU use (all cores together), each process's
 * share (the busiest first), memory, the load average, and the GPU's clock (Intel's i915 driver: how hard the GPU
 * works shows as its clock against its most; the driver gives no busy figure an app may read).
 *
 * A sample every SAMPLE_MS while the app runs (/proc/stat, /proc/meminfo, /proc/loadavg, the GPU's clock: a few
 * small files); the processes only while the page is open (asked by top()).
 *
 *   const p = startPerf();  p.history()  // [{ t, cpu, mem, gpu }] (0..1, the last HISTORY samples)
 *   p.now()   // { cpu, cores, load, memUsed, memTotal, gpuMhz, gpuMax };  p.top(n)  // [{ pid, name, cpu, rss }]
 */
const fs = require('fs');

const SAMPLE_MS = 2000, HISTORY = 90;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const GPU = ['/sys/class/drm/card0/gt_cur_freq_mhz', '/sys/class/drm/card0/gt_act_freq_mhz'];
const GPU_MAX = ['/sys/class/drm/card0/gt_max_freq_mhz', '/sys/class/drm/card0/gt_RP0_freq_mhz'];
const num = (fs_) => { for (const f of fs_) { const v = parseFloat(read(f)); if (isFinite(v)) return v; } return null; };

/** /proc/stat's first line: [busy, total] jiffies; and the cores. */
function cpuTimes() {
    const s = read('/proc/stat'), first = s.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = (first[3] || 0) + (first[4] || 0), total = first.reduce((a, b) => a + (b || 0), 0);
    return { busy: total - idle, total, cores: (s.match(/^cpu\d+/mg) || []).length || 1 };
}
function mem() {
    const m = read('/proc/meminfo'), kb = (k) => { const r = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(m); return r ? Number(r[1]) : 0; };
    const total = kb('MemTotal'), avail = kb('MemAvailable') || kb('MemFree') + kb('Cached');
    return { used: total - avail, total };
}
/** Each process's CPU jiffies (utime + stime), name and resident memory (kB). */
function procs() {
    const out = new Map();
    let ids = [];
    try { ids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch (e) { return out; }
    ids.forEach((pid) => {
        const st = read('/proc/' + pid + '/stat');
        if (!st) return;
        const close = st.lastIndexOf(')'), name = st.slice(st.indexOf('(') + 1, close), f = st.slice(close + 2).split(' ');
        let label = name;
        // (node apps by their app folder: which Store app it is)
        if (/^node/.test(name)) { const cmd = read('/proc/' + pid + '/cmdline').split('\0').join(' '); const m = /\/(oap_[^/\s]+|[^/\s]+)\/(?:javascript|current)\//.exec(cmd) || /([^/\s]+)\.js\b/.exec(cmd); if (m) label = 'node ' + m[1]; }
        out.set(pid, { name: label, t: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4 });
    });
    return out;
}

function startPerf() {
    const hist = [];
    let last = cpuTimes(), cur = { cpu: 0, cores: last.cores, load: '', memUsed: 0, memTotal: 0, gpuMhz: null, gpuMax: null };
    const sample = () => {
        const c = cpuTimes(), m = mem(), dT = c.total - last.total;
        const cpu = dT > 0 ? Math.max(0, Math.min(1, (c.busy - last.busy) / dT)) : 0;
        last = c;
        const gpuMhz = num(GPU), gpuMax = num(GPU_MAX);
        cur = { cpu, cores: c.cores, load: read('/proc/loadavg').split(' ').slice(0, 3).join(' '), memUsed: m.used, memTotal: m.total, gpuMhz, gpuMax };
        hist.push({ t: Date.now(), cpu, mem: m.total ? m.used / m.total : 0, gpu: gpuMhz !== null && gpuMax ? gpuMhz / gpuMax : null });
        if (hist.length > HISTORY) hist.shift();
    };
    const timer = setInterval(sample, SAMPLE_MS);
    if (timer.unref) timer.unref();
    let prev = null, prevAt = 0, prevTotal = 0, list = [];
    return {
        now: () => cur,
        history: () => hist.slice(),
        /** The busiest processes since the last call (at most once a second), each its share of all cores. */
        top(n) {
            const t = Date.now();
            if (prev && t - prevAt < 1000) return list.slice(0, n);
            const p = procs(), tot = cpuTimes().total;
            if (prev) {
                const dT = Math.max(1, tot - prevTotal);
                list = Array.from(p.entries()).map(([pid, x]) => ({ pid, name: x.name, rss: x.rss, cpu: prev.has(pid) ? Math.max(0, (x.t - prev.get(pid).t) / dT) : 0 }))
                    .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
            }
            prev = p; prevAt = t; prevTotal = tot;
            return list.slice(0, n);
        },
        stop() { clearInterval(timer); },
    };
}

module.exports = { startPerf };
