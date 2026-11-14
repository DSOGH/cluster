'use strict';
/**
 * hook.js on|off - the tool's install and removal hooks (run as root by mgu-deploy). The change itself is the
 * drop-in for waze-on-cluster.service, which the deploy tool lays and takes out; Waze on cluster reads it when it
 * next starts, so both hooks ask for a head-unit restart (the last stdout line).
 */
const fs = require('fs');

const on = process.argv[2] !== 'off';
const woc = ['/etc/systemd/system/waze-on-cluster.service', '/lib/systemd/system/waze-on-cluster.service', '/var/opt/waze-on-cluster/current/waze-on-cluster']
    .some((f) => { try { fs.accessSync(f); return true; } catch (e) { return false; } });
if (on && !woc) console.log('Waze on cluster is not installed: the map window takes effect once it is');
console.log(JSON.stringify({
    reboot: on ? 'Waze on cluster draws its map in the M340i layout\'s window from the next start'
        : 'Waze on cluster draws its map in its usual place from the next start',
}));
