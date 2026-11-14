'use strict';
/**
 * test_waze_window.js - the m340-waze-window tool (native/m340_waze_window), installed with Cluster Layouts: its
 * service follows the layout's map window (map_window.js's file) and starts Waze on cluster there:
 *   node tools/test_waze_window.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'native', 'm340_waze_window');
const WIN = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woc-')), 'map_window.txt');
process.env.MAP_WINDOW_FILE = WIN;
const W = require(path.join(DIR, 'watch.js'));
let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };

const c = JSON.parse(fs.readFileSync(path.join(DIR, 'component.json'), 'utf8'));
check('component.json: a tool without a build step, its service enabled, listed in mgu-repo.json', () => {
    assert.strictEqual(c.kind, 'tool'); assert(!c.build); assert(/^\d+\.\d+\.\d+$/.test(c.version)); assert(!c.dropins);
    const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-repo.json'), 'utf8'));
    assert((repo.components || []).some((x) => x.id === c.id && x.kind === 'tool' && x.path === 'native/m340_waze_window'));
    c.files.concat(c.units).forEach((f) => assert(fs.existsSync(path.join(DIR, f.from)), f.from));
    assert.deepStrictEqual(c.enable.map((e) => e.unit), c.units.map((u) => u.name));
    const unit = fs.readFileSync(path.join(DIR, c.units[0].from), 'utf8');
    assert(unit.indexOf('/var/opt/' + c.id + '/current/watch.js') > 0);
});
check('Cluster Layouts requires it (one install), at this version or older', () => {
    const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cluster_layouts', 'app.json'), 'utf8'));
    const v = (s) => s.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
    assert(app.requires && app.requires[c.id] && v(app.requires[c.id]) <= v(c.version));
});
check('the window: taken while fresh, as Cluster Layouts writes it (the M340i\'s), none when stale or gone', () => {
    const { META } = require('../apps/cluster_layouts/m340_art');
    assert.strictEqual(W.wanted(), null);
    fs.writeFileSync(WIN, 'panel ' + META.window.join(' ') + '\n');
    assert.strictEqual(W.wanted(), META.window.join(','));
    const old = (Date.now() - 10000) / 1000; fs.utimesSync(WIN, old, old);
    assert.strictEqual(W.wanted(), null);
    fs.writeFileSync(WIN, 'map 1 2 3\n');
    assert.strictEqual(W.wanted(), null);
    fs.unlinkSync(WIN);
});
check('the start line: Waze on cluster\'s own, with the target and the place before $WOC_SRC_CROP', () => {
    const l = W.execLine('416,128,1088,480');
    assert(/^\/var\/opt\/waze-on-cluster\/current\/waze-on-cluster -c \S+ -s target=panel -s map_rect=416,128,1088,480 \$WOC_SRC_CROP$/.test(l), l);
});
console.log(ok + ' passed');
