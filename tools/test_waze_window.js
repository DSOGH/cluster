'use strict';
/**
 * test_waze_window.js - the m340-waze-window tool (native/m340_waze_window): its drop-in puts the Waze map at the
 * M340i layout's own window, and its hooks ask for a restart:  node tools/test_waze_window.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'native', 'm340_waze_window');
let ok = 0;
const check = (name, fn) => { fn(); ok++; console.log('ok   ' + name); };

const c = JSON.parse(fs.readFileSync(path.join(DIR, 'component.json'), 'utf8'));
check('component.json: a tool without a build step, listed in mgu-repo.json', () => {
    assert.strictEqual(c.kind, 'tool'); assert(!c.build); assert(/^\d+\.\d+\.\d+$/.test(c.version));
    const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-repo.json'), 'utf8'));
    assert((repo.components || []).some((x) => x.id === c.id && x.kind === 'tool' && x.path === 'native/m340_waze_window'));
    c.files.concat(c.dropins).forEach((f) => assert(fs.existsSync(path.join(DIR, f.from)), f.from));
});
check('the drop-in: the map on the panel at the M340i layout\'s window', () => {
    const d = fs.readFileSync(path.join(DIR, c.dropins[0].from), 'utf8');
    const { META } = require('../apps/cluster_layouts/m340_art');
    assert(/^ExecStart=$/m.test(d), 'ExecStart reset first');
    assert(d.indexOf('-s target=panel -s map_rect=' + META.window.join(',') + ' $WOC_SRC_CROP') > 0, 'the rect is the layout\'s window ' + META.window);
});
check('the hooks: a restart asked for on install and on removal', () => {
    ['on', 'off'].forEach((a) => {
        const out = execFileSync(process.execPath, [path.join(DIR, 'hook.js'), a], { encoding: 'utf8' }).trim().split('\n');
        assert(JSON.parse(out[out.length - 1]).reboot, a);
    });
});
console.log(ok + ' passed');
