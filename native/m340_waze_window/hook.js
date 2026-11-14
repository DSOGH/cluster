'use strict';
/**
 * hook.js on|off - the tool's install and removal hooks (run as root by mgu-deploy). Installing needs nothing: the
 * service (watch.js) moves the map when the layout asks. Removing stops the service, takes its runtime drop-in out
 * and puts Waze on cluster back in its own place at once.
 */
if (process.argv[2] === 'off') {
    const { execFileSync } = require('child_process');
    try { execFileSync('systemctl', ['stop', 'm340-waze-window.service'], { stdio: 'ignore', timeout: 20000 }); } catch (e) { /* not running */ }
    try { require('./watch').release(); } catch (e) { console.log('release: ' + e.message); }
}
console.log('ok');
