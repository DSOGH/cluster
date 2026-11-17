'use strict';
/**
 * watch.js - puts the Waze on cluster map in a Cluster Layouts layout's window while one is shown with the Waze
 * centre, and back in its own place when it isn't (the layout off, another centre, the app stopped); and finds the
 * song's cover art on the head unit when the app asks (below). Runs as root (m340-waze-window.service).
 *
 * Cluster Layouts writes /dev/shm/cluster-info/map_window.txt ("panel X Y W H") every second while its layout shows
 * the Waze centre, and removes it when it stops (map_window.js). Waze on cluster 0.9.14 takes its map's target and
 * place only from its start command, so when the wanted place changes this writes a runtime drop-in for
 * waze-on-cluster.service (-s target=panel -s map_rect=X,Y,W,H, or none) and restarts it. /run is empty at each
 * head-unit start: Waze on cluster starts in its own place, and moves once the layout shows.
 *
 *   - a change counts once it has held ON_MS (a window) or OFF_MS (none): a rebuilt layout, a restarted app or a
 *     busy moment restarts nothing;
 *   - what runs is read from the running process's command line, so a restart is only made when it differs;
 *   - no two restarts within GAP_MS (the map comes back a few seconds after each).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WINDOW = process.env.MAP_WINDOW_FILE || '/dev/shm/cluster-info/map_window.txt';   // (the variable: the tests)
const UNIT = 'waze-on-cluster.service';
const DROPIN_DIR = '/run/systemd/system/' + UNIT + '.d';
const DROPIN = path.join(DROPIN_DIR, 'zz-m340-waze-window.conf');
const FRESH_MS = 15000, ON_MS = 2000, OFF_MS = 20000, GAP_MS = 15000, TICK_MS = 1000, CHECK_MS = 30000;   // (a busy head unit can leave the window file a few seconds old: no restart for that)
const FALLBACK_EXEC = '/var/opt/waze-on-cluster/current/waze-on-cluster -c /var/opt/waze-on-cluster/current/waze-on-cluster.conf $WOC_SRC_CROP';
const SYSTEMCTL = ['/bin/systemctl', '/usr/bin/systemctl'].find((f) => { try { fs.accessSync(f); return true; } catch (e) { return false; } }) || 'systemctl';

const log = (m) => console.log(new Date().toISOString() + ' ' + m);

/*
 * The song's cover art as the head unit keeps it (Cluster Layouts' Settings > Cover art: on the head unit). The app
 * can't read most of the unit; this runs as root, so when the app asks (cover_request.json in the cluster-info
 * folder: { key, at }, at each change of song) it looks through the whole unit, a slice at a time, for JPEG and PNG
 * files written since a little before the change, and copies the newest few to cover0.img ... cover4.img there
 * (0644), listing them in cover.json { key, src: [paths] } (src empty: none found). The app decodes them and takes
 * the first that is a cover (square, big enough). Looked again COVER_AGAIN_MS later when nothing was found.
 */
const INFO = path.dirname(WINDOW);
const COVER_SKIP = /^\/(proc|sys|dev(?!\/shm)|dev\/shm\/cluster-info)(\/|$)|\/(\.git|node_modules|lost\+found)(\/|$)|\/data\/covers(\/|$)/;   // (data/covers: the app's own kept covers)
const COVER_SETTLE_MS = 2500, COVER_AGAIN_MS = 6000, COVER_RECENT_MS = 20000, COVER_MAX_ENTRIES = 40000, COVER_SLICE = 400, COVER_KEEP = 5;
// (the folders a running system writes to; read-only system folders left out, and the search done in small slices
// with pauses: it must not hold up the cluster or the map)
const COVER_ROOTS = ['/var', '/tmp', '/run', '/dev/shm', '/opt', '/mnt', '/home', '/persistence', '/data'];
const cover = { key: '', job: 0 };
function imageKind(f) {
    try {
        const fd = fs.openSync(f, 'r'), b = Buffer.alloc(8);
        fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd);
        return (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47);
    } catch (e) { return false; }
}
function coverScan(key, at, tries) {
    const job = cover.job, found = [], stack = (process.env.COVER_ROOT ? [process.env.COVER_ROOT] : COVER_ROOTS).map((r) => [r, 0]);   // (the variable: the tests)
    let seen = 0;
    const step = () => {
        if (job !== cover.job) return;
        let n = 0;
        while (stack.length && n < COVER_SLICE && seen < COVER_MAX_ENTRIES) {
            const [dir, depth] = stack.pop();
            let names;
            try { names = fs.readdirSync(dir); } catch (e) { continue; }
            for (const name of names) {
                const f = path.join(dir, name);
                if (COVER_SKIP.test(f)) continue;
                n++; seen++;
                let st;
                try { st = fs.lstatSync(f); } catch (e) { continue; }
                if (st.isDirectory()) { if (depth < 12) stack.push([f, depth + 1]); } else if (st.isFile() && st.mtimeMs >= at - COVER_RECENT_MS && st.size >= 1500 && st.size <= 4 * 1024 * 1024) found.push([f, st.mtimeMs, st.size]);
            }
        }
        if (stack.length && seen < COVER_MAX_ENTRIES) { setTimeout(step, 15); return; }
        const imgs = found.filter(([f]) => imageKind(f)).sort((a, b) => b[1] - a[1]).slice(0, COVER_KEEP);
        if (!imgs.length && tries > 0) { setTimeout(() => { if (job === cover.job) coverScan(key, at, tries - 1); }, COVER_AGAIN_MS); return; }
        const src = [];
        imgs.forEach(([f], i) => { try { const out = path.join(INFO, 'cover' + i + '.img'); fs.copyFileSync(f, out); fs.chmodSync(out, 0o644); src.push(f); } catch (e) { /* skipped */ } });
        try { const out = path.join(INFO, 'cover.json'); fs.writeFileSync(out, JSON.stringify({ key, src, seen, newFiles: found.length })); fs.chmodSync(out, 0o644); } catch (e) { /* no folder */ }
        log('cover: ' + (src.length ? src.join(', ') : 'no image written since the song changed') + ' (' + seen + ' entries, ' + found.length + ' new files)');
    };
    step();
}
function coverTick() {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(INFO, 'cover_request.json'), 'utf8')); } catch (e) { return; }
    if (!r || !r.key || r.key === cover.key) return;
    cover.key = r.key; cover.job++;
    const job = cover.job, at = Number(r.at) || Date.now();
    setTimeout(() => { if (job === cover.job) coverScan(r.key, at, 1); }, COVER_SETTLE_MS);
}
const sc = (args) => execFileSync(SYSTEMCTL, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The window Cluster Layouts holds now: "X,Y,W,H", or null. */
function wanted() {
    try {
        if (Date.now() - fs.statSync(WINDOW).mtimeMs > FRESH_MS) return null;
        const m = /^panel (\d+) (\d+) (\d+) (\d+)\s*$/.exec(fs.readFileSync(WINDOW, 'utf8'));
        return m ? [m[1], m[2], m[3], m[4]].join(',') : null;
    } catch (e) { return null; }
}
/** Where the running Waze on cluster draws: "X,Y,W,H" (on the panel), '' (its own place), or undefined (not running). */
function running() {
    let pid;
    try { pid = Number(sc(['show', '-p', 'MainPID', '--value', UNIT])); } catch (e) { return undefined; }
    if (!(pid > 0)) return undefined;
    let args;
    try { args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0'); } catch (e) { return undefined; }
    const val = (k) => { for (let i = 0; i < args.length - 1; i++) if (args[i] === '-s' && args[i + 1].indexOf(k + '=') === 0) return args[i + 1].slice(k.length + 1); return null; };
    return val('target') === 'panel' && val('map_rect') ? val('map_rect') : '';
}
/** Waze on cluster's own start command (its unit's last ExecStart=), with ours added. */
function execLine(rect) {
    let exec = FALLBACK_EXEC;
    try {
        const unit = fs.readFileSync(sc(['show', '-p', 'FragmentPath', '--value', UNIT]), 'utf8');
        const lines = unit.split('\n').map((l) => l.trim()).filter((l) => /^ExecStart=./.test(l));
        if (lines.length) exec = lines[lines.length - 1].slice('ExecStart='.length).replace(/^[-@:+!]+/, '');
    } catch (e) { /* the fallback */ }
    const ours = '-s target=panel -s map_rect=' + rect;
    return /\$WOC_SRC_CROP\b/.test(exec) ? exec.replace(/\$WOC_SRC_CROP\b/, ours + ' $WOC_SRC_CROP') : exec + ' ' + ours;
}
/** The drop-in for rect ('' or null: none). */
function setDropin(rect) {
    if (rect) {
        ['/run/systemd/system', DROPIN_DIR].forEach((d) => { try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; } });
        fs.writeFileSync(DROPIN, '# m340-waze-window (DSOGH/cluster): the map in the layout\'s window while it shows\n[Service]\nExecStart=\nExecStart=' + execLine(rect) + '\n');
    } else {
        try { fs.unlinkSync(DROPIN); } catch (e) { /* none */ }
    }
    sc(['daemon-reload']);
}

/** Take everything back: the drop-in out, Waze on cluster restarted in its own place if it runs in ours. */
function release() {
    const was = running();
    setDropin(null);
    if (was) { log('map back in its own place'); sc(['try-restart', UNIT]); }
}

function main() {
    let cand = null, candAt = 0, lastRestart = 0, applied, settled = null, checkedAt = 0;
    log('started');
    const tick = () => {
        const want = wanted() || '', now = Date.now();
        if (want !== cand) { cand = want; candAt = now; }
        if (now - candAt < (want ? ON_MS : OFF_MS)) return;
        if (applied !== want) {
            try { setDropin(want); applied = want; } catch (e) { log('drop-in: ' + e.message); return; }
            checkedAt = 0;
        }
        // what runs, asked of systemd only when there may be something to do: the wanted place changed, a restart
        // is due, or every CHECK_MS (each ask starts a systemctl: once a second it cost the head unit for nothing)
        if (settled === want && now - checkedAt < CHECK_MS) return;
        checkedAt = now;
        const run = running();
        if (run === want) { settled = want; return; }
        // (not running: nothing to restart; looked at again in 5 s)
        if (run === undefined) { settled = want; checkedAt = now - CHECK_MS + 5000; return; }
        settled = null;
        if (now - lastRestart < GAP_MS) return;
        lastRestart = now;
        log(want ? 'map to the layout\'s window ' + want : 'map back in its own place');
        try { sc(['try-restart', UNIT]); } catch (e) { log('restart: ' + e.message); }
    };
    setInterval(() => { try { tick(); } catch (e) { log('error: ' + e.message); } try { coverTick(); } catch (e) { log('cover: ' + e.message); } }, TICK_MS);
}

if (require.main === module) {
    if (process.argv[2] === 'release') release(); else main();
}
module.exports = { wanted, running, execLine, release, coverScan, coverTick, FALLBACK_EXEC };
