'use strict';
/**
 * Cluster Layouts - your own layout on the whole instrument cluster, drawn by the cluster itself.
 *
 * The layout (layout_*.js) is a set of shader layers on the cluster render service's `panel` target; the
 * KOMBI's GPU draws them (engine.js, shaders.js). While driving, the head unit sends only needle and band
 * values, a text's glyph codes when it changes and colours when they change. The stock warning lights stay
 * on top.
 *
 * Readings (data.js, shared with Cluster Centre): speed, engine speed, gear, oil and coolant, torque and g
 * from the car (kit/car.js); the selector's S / M programme, outside, gearbox oil, the
 * battery's temperature and the power distribution from the car's services; intake air, boost and fuel
 * pressures from the engine unit over UDS (only while a layout that shows them is up); the battery's charge
 * and power from eDrive Live; ranges from any app that shares them, until the car's own range signals are
 * added (the page lists the ones this car has: signal_finder.js).
 *
 * Safe by default: off until "Show on the cluster" is turned on; hidden (the stock cluster back) whenever the
 * car's data is not live, and whenever this app or the render service stops.
 */
const clock = require('./clock');
const mgu = require('./kit/mgu');
const { ClusterRender } = require('./cluster_render_client');
const { startCluster, STALE_MS } = require('./engine');
const { byId } = require('./layouts');
const { lookNow } = require('./themes');
const { startData } = require('./data');
const presence = require('./presence');
const { startDap, DEMO: DAP_DEMO } = require('./dap');
const { startMapWindow } = require('./map_window');
const { findSignals } = require('./signal_finder');
const logs = require('./logs');
const attribution = require('./attribution');
const path = require('path');

const W = 1600, H = 520;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const SIGNALS_PER_PAGE = 7;

/* The free / open-source notice on the app's own screen (attribution.js): the repo and the refund line, dim when
 * the build is the author's, a warning in red when it was altered. Drawn on every app that carries the cluster
 * mark, so the notice is visible in the menu as well as on the glass. */
function creditFooter(cv, t) {
    const v = attribution.verify();
    const red = '#ff5a5a';
    const head = v.ok ? attribution.INFO.notice : 'MODIFIED BUILD (' + v.reason + ') - this is free: ' + attribution.INFO.notice;
    cv.text(head, 48, 486, 17, v.ok ? t.dim : red, { font: 'bold', literal: true });
    cv.text(attribution.INFO.url + (v.ok ? '   ·   official build, key ' + (v.fingerprint || '?') : ''), 48, 506, 15, v.ok ? t.dim : red, { font: 'label', literal: true });
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // the clock's zone and format (clock.js: the unit runs its apps on UTC)
        const clockNow = () => { clock.setZone(settings.get('timeZone')); clock.setTwelve(settings.get('clock') !== '24'); };
        clockNow();
        settings.onChange((k) => { if (k === 'timeZone' || k === 'clock') clockNow(); });
        const showing = () => settings.get('show') === 'on';
        // every reading (data.js, shared with Cluster Centre): the car's signals, the engine unit over UDS for
        // what a layout needs (layout.needs), eDrive Live's charge and power while shown
        const D = startData(ctx, { shown: showing, tyres: true, media: true, directions: true, warnings: true });
        const car = D.car;
        // the driving assistant (dap.js), for the layouts that show it (layout.dap: Modern wide's road, Sport's
        // cruise control): subscribed once one is first shown
        let dap = null;
        const dapWanted = () => showing() && !!byId(settings.get('layout')).dap;
        const data = () => {
            const d = D.data();
            if (!dap && dapWanted() && !d.demo) dap = startDap(ctx, log);
            d.dap = d.demo ? DAP_DEMO : dap ? dap.state() : null;
            return d;
        };
        /* the Waze centre only while Waze on cluster shows its map (its /run/waze-on-cluster/status.json, written each
         * second: state 'showing'); otherwise the layout's own centre (the M colours), never the stock cluster's map
         * screen behind an empty window. A change counts once held WAZE_ON_MS (on) or WAZE_OFF_MS (off). */
        const WOC_STATUS = '/run/waze-on-cluster/status.json', WAZE_ON_MS = 3000, WAZE_OFF_MS = 8000;
        const waze = { on: false, cand: false, since: 0 };
        const wazeShowing = () => {
            try {
                if (Date.now() - require('fs').statSync(WOC_STATUS).mtimeMs > 5000) return false;
                return JSON.parse(require('fs').readFileSync(WOC_STATUS, 'utf8')).state === 'showing';
            } catch (e) { return false; }
        };
        const wantMap = () => settings.get('centre') === 'map' || settings.get('centre') === 'pages';
        const options = () => ({
            speedUnit: settings.get('speedUnit'), tempUnit: settings.get('tempUnit'), torqueUnit: settings.get('torqueUnit'),
            // (a saved 'pages', retired: Waze; Waze only while its map shows, else the layout's own centre)
            centre: wantMap() ? (waze.on || car.data().demo ? 'map' : 'info') : settings.get('centre'),
            redline: Number(settings.get('redline')) || 7000, rpmMax: Number(settings.get('rpmMax')) || 8000,
            boxClear: settings.get('boxClear') === 'on',
            cluster: settings.get('cluster') === 'm' ? 'm' : 'standard',
            bottomStrip: settings.get('bottomStrip') === 'layout' ? 'layout' : 'stock',   // the KOMBI's strip under y 660 (layouts.js)
            boxBezel: settings.get('boxBezel') === 'on',   // (off: the box sits on the plain background)
            nowPlaying: settings.get('nowPlaying') === 'off' ? 'off' : 'on',   // (M340i Sport: the song in the centre panel)
            directions: settings.get('directions') === 'off' ? 'off' : 'on',   // (M340i Sport: the next turn at the top of the centre)
            // (M340i Sport: the side gauges, and where their power and torque are taken)
            sideLeft: settings.get('sideLeft') || 'off', sideRight: settings.get('sideRight') || 'off',
            dialLeft: settings.get('dialLeft') || 'off', dialRight: settings.get('dialRight') || 'off',
            powerAt: settings.get('powerAt') === 'wheel' ? 'wheel' : 'crank', drivetrainLoss: Number(settings.get('drivetrainLoss')) || 15,
            vehicle: D.vehicle().vehicle,      // set, or found from the car (Auto)
        });
        /** Live: demo data on, or the car's signals answer (a parked car sends nothing new for minutes, so a
         * provider that is there counts), or a value came in the last STALE_MS. */
        const live = () => {
            if (car.data().demo) return true;
            return car.subs.some((s) => s.available) || (car.lastCar > 0 && Date.now() - car.lastCar < STALE_MS);
        };
        let layout = byId(settings.get('layout'));
        /* the colours now: the layout's palette for the look, with pure black behind everything unless the
         * Background setting says tinted. The KOMBI leaves a black box where its own gear readout sits while a
         * layout covers the panel; on black (backgrounds and dial faces) it doesn't show. */
        const BLACK = { bg: '#000000', bgTop: '#000000', bgBottom: '#000000', face0: '#000000', face1: '#000000' };
        const themeNow = () => {
            const t = layout.palette(look());
            return settings.get('background') === 'tinted' ? t : Object.assign({}, t, BLACK);
        };
        const look = () => lookNow(settings.get('look'), data());
        /* the renderer target: the panel (slot 0x203), where the HMI's own cluster screen goes down and the
         * KOMBI shows its fallback gear box */
        const start = () => startCluster({
            client: new ClusterRender('cluster_layouts'),
            layout: () => layout,
            // (the glyphs: the layout's own family, M and Sport's wide one, else the bold)
            font: () => layout.font || 'bold',
            options, log, live, data,
            theme: () => themeNow(),
            enabled: showing,
            sweep: () => settings.get('sweep') !== 'off',
            target: 'panel',
            // the Waze centre: the map is drawn on the panel over the layout's lower pieces (map_window.js)
            underMap: () => options().centre === 'map',
            onFresh: D.onFresh,
        });
        let cluster = start();
        const mapWindow = startMapWindow(log);
        let lastVehicle = null, lastModeGear = null;
        // the engine-unit readings the layout shows, read fast while it shows
        setInterval(() => {
            if (showing()) D.want((layout.needs || []).concat(require('./layout_common').focus.needs(options())));
            // Cluster Centre steps aside while a layout shows
            if (cluster.status().shown) presence.mark('layouts', { centre: options().centre });
            // the Waze centre: Waze on cluster draws its map over the layout, filling the window (map_window.js): the
            // layout's own (M's and Sport's: where bimmer-lab's put it), else the native map area
            // (held while the Waze centre is set, its map showing or not: m340-waze-window keeps Waze on cluster there)
            mapWindow.set(cluster.status().shown && wantMap() ? (layout.mapWindow || require('./layout_common').MAP) : null);
            // Waze's map showing or not: the layout's centre follows (held, then rebuilt)
            const ws = wantMap() && wazeShowing(), tNow = Date.now();
            if (ws !== waze.cand) { waze.cand = ws; waze.since = tNow; }
            if (waze.cand !== waze.on && tNow - waze.since >= (waze.cand ? WAZE_ON_MS : WAZE_OFF_MS)) {
                waze.on = waze.cand; log.info('Waze on cluster ' + (waze.on ? 'shows its map: the Waze centre' : 'shows no map: the layout\'s own centre'));
                cluster.rebuild();
            }
            // the vehicle found (Settings > Vehicle: Auto): the layout redrawn for it once known
            const v = D.vehicle().vehicle;
            if (v !== lastVehicle) { if (lastVehicle) cluster.rebuild(); lastVehicle = v; }
            // drive mode and gear changes in the log (timestamped), beside the cluster's target changes: what the
            // KOMBI does to the layout on a mode change (the stock cluster back for a few seconds) shows in one log
            const dn = data(), mg = (dn.driveMode || '-') + ' / ' + (dn.gear == null ? '-' : dn.gear);
            if (mg !== lastModeGear) {
                if (lastModeGear !== null && !dn.demo) log.info('drive mode / gear: ' + lastModeGear + ' -> ' + mg + '   (cluster: ' + JSON.stringify(cluster.status()) + ')');
                lastModeGear = mg;
            }
        }, 500);
        settings.onChange((k) => {
            if (k === 'look' || k === 'background') return cluster.recolour();
            if (k === 'layout') layout = byId(settings.get('layout'));
            if (['layout', 'centre', 'speedUnit', 'tempUnit', 'torqueUnit', 'redline', 'rpmMax', 'boxClear', 'boxBezel', 'cluster', 'bottomStrip', 'vehicle', 'tankLitres', 'nowPlaying', 'directions', 'sideLeft', 'sideRight', 'dialLeft', 'dialRight', 'powerAt', 'drivetrainLoss'].indexOf(k) >= 0) cluster.rebuild();
        });

        /* ---------- the car's range and charge signals, from its own catalog ---------- */
        const found = findSignals();
        if (found.error) log.warn('signals: ' + found.error);
        else {
            log.info('signals for ranges, fuel and charge: ' + found.list.length);
            found.list.slice(0, 60).forEach((s) => log.info('  ' + s.iface + ' ' + s.field + (s.get ? ' get' : '') + (s.notify ? ' notify' : '') + ' {' + s.members.slice(0, 12).join(', ') + '}'));
        }
        let page = 0;   // 0: status; 1...: the signal list, SIGNALS_PER_PAGE a page
        // 0: status; 1: the raw drive-mode and range values; 2: what the cluster has up; 3...: the signal list
        // (status, the drive mode and ranges, the cluster's report, the song playing, then the signal list)
        const pages = () => 5 + Math.ceil(found.list.length / SIGNALS_PER_PAGE);   // (4: the side gauges' preview)

        /* the side gauges' preview (Signals, page 5): each side's gauge as the cluster draws it, with the car's reading
         * now (or a sample while parked), the warnings and the 0-60 best below */
        function widgetsPage(cv, t) {
            const d = data(), o = options(), L = require('./layout_m340');
            cv.text('Side gauges   ·   Settings > Upright gauge and Round gauge, left / right', 48, 60, 24, t.text, { font: 'bold', literal: true });
            const sample = !(isNum(d.rpm) && d.rpm > 300);
            if (sample) cv.text('(sample readings: the engine is off)', 48, 92, 18, t.dim, { font: 'label', literal: true });
            const dd = sample ? Object.assign({}, d, { rpm: 4800, torque: 480, boostActual: 1.05, oil: 105, coolant: 95, gLong: 0.4, gLat: 0.3, speed: 96 }) : d;
            const NAMES = { boost: 'Boost', hp: 'Horsepower', torque: 'Torque', oil: 'Oil temperature', coolant: 'Coolant temperature', gforce: 'G-force', speedkmh: 'Speed in km/h' };
            /* each side as on the cluster: the upright gauge at the outer edge, the round one beside it */
            [['left', 'Left', 60], ['right', 'Right', 840]].forEach(([side, Side, x0]) => {
                cv.text(Side, x0, 136, 22, t.dim, { font: 'bold', literal: true });
                const bar = o['side' + Side], dial = o['dial' + Side];
                const one = (kind, x, round) => {
                    if (!kind || kind === 'off') { cv.text((round ? 'Round' : 'Upright') + ': off', x, 300, 22, t.dim, { font: 'bold', literal: true }); return; }
                    const r = L.sideReading(kind, o, dd), K = L.SIDE_KINDS[kind];
                    const f = Math.max(0, Math.min(1, ((r.value || 0) - (K.min || 0)) / (K.max - (K.min || 0))));
                    if (round) {
                        const cx = x + 80, cy = 300, R = 80;
                        cv.arc(cx, cy, R - 16, R, 225, 495, '#151c2a');
                        if (f > 0) cv.arc(cx, cy, R - 16, R, 225, 225 + 270 * f, K.c[1]);
                        cv.text(r.text, cx, cy + 12, 36, t.text, { font: 'bold', literal: true, align: 'center' });
                        cv.text(r.unit, cx, cy + 40, 16, t.dim, { font: 'bold', literal: true, align: 'center' });
                    } else {
                        const by = 170, bw = 40, bh = 280;
                        cv.roundRect(x, by, bw, bh, bw / 2, '#151c2a');
                        if (f > 0) cv.roundRect(x, by + bh * (1 - f), bw, bh * f, bw / 2, K.c[1]);
                        cv.fillRect(x, by + bh * (1 - f), bw, 3, '#ffffff');
                        cv.text(r.text, x + bw / 2, by - 12, 26, t.text, { font: 'bold', literal: true, align: 'center' });
                        cv.text(r.unit, x + bw / 2, by + bh + 24, 16, t.dim, { font: 'bold', literal: true, align: 'center' });
                    }
                    cv.text(NAMES[kind] + (kind === 'hp' || kind === 'torque' ? (o.powerAt === 'wheel' ? ' (wheels, less ' + o.drivetrainLoss + ' %)' : ' (crank)') : ''), round ? x + 10 : x - 10, 440, 16, t.dim, { font: 'label', literal: true });
                };
                // (the left side's upright gauge at its outer edge, then the round one; the right side mirrored)
                if (side === 'left') { one(bar, x0, false); one(dial, x0 + 110, true); } else { one(dial, x0 + 380, true); one(bar, x0 + 640, false); }
            });
            cv.text('Warnings: ' + (D.status().warnings || '-'), 48, 490, 16, t.dim, { font: 'label', literal: true });
            return cv;
        }
        ui.onClick('BTN_SHOW', () => { settings.set('show', showing() ? 'off' : 'on'); return render(); });
        ui.onClick('BTN_SIGNALS', () => { logView = null; page = (page + 1) % Math.max(1, pages()); return render(); });

        /* ---------- Logs: what's needed to find a problem, as QR codes to photograph and as a file on a USB stick ---------- */
        let logView = null;   // { codes, page, saved, bytes }
        const PER_PAGE = 3;
        /** A finder result as lines: 'Iface.field [get notify] { members }'. */
        const sigList = (f, max) => (f.error ? f.error : f.list.slice(0, max).map((x) => x.iface.replace(/^de\.bmw\./, '') + '.' + x.field + (x.get ? ' get' : '') + (x.notify ? ' notify' : '') + ' {' + x.members.slice(0, 10).join(', ') + '}').join('\n') + (f.list.length > max ? '\n(' + (f.list.length - max) + ' more)' : ''));
        /** The renderer's status with this app's own effect layers (one line each, ~60) counted, for the codes. */
        const squeeze = (txt, full) => {
            if (full) return txt;
            let ours = 0;
            const kept = String(txt).split('\n').filter((l) => (/^layer \d+ effect of cluster_layouts on panel/.test(l) ? (ours++, false) : true));
            return kept.join('\n') + (ours ? '\n(' + ours + ' effect layers of cluster_layouts, one line each in the full logs)' : '');
        };
        function logBundle(full) {
            const n = (short, long) => (full ? long : short);
            const d = data(), o = options(), snap = {};
            Object.keys(d).forEach((k) => { const v = d[k]; if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') snap[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v; });
            return logs.bundle('Cluster Layouts ' + ((ctx.spec && ctx.spec.version) || ''), [
                ['settings', JSON.stringify({ layout: settings.get('layout'), centre: o.centre, look: settings.get('look'), background: settings.get('background'), show: settings.get('show') })],
                ['engine', JSON.stringify(cluster.status())],
                ['cluster renderer status', squeeze(cluster.rendererStatus() || '(no answer yet)', full)],
                ['data now', JSON.stringify(snap)],
                ['raw signals', JSON.stringify(D.status().raw || {})],
                ['driving assistant (Modern wide, Sport)', dap ? JSON.stringify(dap.status()) + '\nnow ' + JSON.stringify(dap.state()) : 'not started (Modern wide or Sport not shown yet)'],
                ['vehicle', (() => { const v = D.vehicle(); return v.vehicle + ' (' + v.how + ': ' + v.why + ')'; })()],
                ['data status', JSON.stringify(Object.assign({}, D.status(), { raw: undefined }))],
                // the kW gauges' sources: each of the car's power signals (how often it came, its last value), its fit to
                // eDrive Live's readings (theta: kW = theta . features; err: the average miss, kW) and the one shown
                ['fast power (the kW gauges)', (() => {
                    const f = D.status().kwFit || {}, ms = f.models || {};
                    return ['shown now: ' + (d.kwModel || (isNum(d.kwRead) ? 'eDrive Live\'s reading as it is' : 'nothing')) + '   eDrive Live ' + (isNum(d.kwRead) ? d.kwRead.toFixed(1) + ' kW' : '--') + '   gauges ' + (isNum(d.kw) ? d.kw.toFixed(1) + ' kW' : '--')]
                        .concat(Object.keys(ms).map((k) => k + ': ' + (ms[k].rate === null ? 'every car sample' : ms[k].rate + '/s') + ', fits ' + ms[k].fits + ', error ' + (ms[k].err === null ? '--' : ms[k].err + ' kW') + ', theta ' + JSON.stringify(ms[k].theta) + (ms[k].last !== null ? ', last ' + JSON.stringify(ms[k].last) : '')))
                        .concat(['cruise (head-up display): ' + (d.cruise ? JSON.stringify(d.cruise) : 'nothing yet')]).join('\n');
                })()],
                // the car's own names for these (its service catalog): what to declare for the electric range
                // and the local time
                ['range and charge signals', sigList(found, n(40, 400))],
                // the battery's power as the car itself sends it (the head unit's live consumption and energy flow
                // come from somewhere): every power, current, consumption and energy-flow field the catalog has, to pick
                // one that updates without being asked (eDrive Live's diagnostic reads are a few a second)
                ['power and consumption signals', sigList(findSignals({ match: /power|leistung|current|strom|ampere|voltage|spannung|consum|verbrauch|efficien|energ|flow|momentan|instant|eboost|traction|antrieb|hvs|highvoltage|electricmachine|emachine/i }), n(150, 1500))],
                // the cruise control's: the driving assistant's view services send nothing on this car (Nov 9 2026,
                // "seen" empty), so the catalog's other candidates, to pick from
                ['cruise control signals', sigList(findSignals({ match: /cruise|tempomat|geschwindigkeitsregel|wunschgeschw|speed.?limit|limiter|set.?speed|target.?speed|abstand|distance.?control|longitudinal.?(control|guid|function|assist)|\bacc\b|acc[A-Z_]|ACC|DCC|FGR/ }), n(30, 300))],
                ['time and date signals', sigList(findSignals({ match: /time|date|uhrzeit|datum|zone|clock/i }), n(10, 300))],
                ['cluster-render log', logs.tail(logs.RENDER_LOG, n(50, 1500))],
                ['this app\'s log', logs.tail(path.join(ctx.dataDir || '.', 'cluster_layouts.log'), n(30, 400))],
                ['Cluster Centre log', logs.siblingLog(ctx.dataDir || '.', 'cluster_centre', n(20, 300))],
            ]);
        }
        ui.onClick('BTN_LOGS', () => {
            page = 0;
            if (!logView) {
                const saved = logs.save(logBundle(true), ctx.dataDir);
                saved.forEach((r) => log.info('logs: ' + (r.file ? 'saved ' + r.file : r.dir + ': ' + r.error)));
                const c = logs.codes(logBundle(false));
                logView = { codes: c.codes, page: 0, saved, bytes: c.bytes };
            } else {
                logView.page++;
                if (logView.page * PER_PAGE >= logView.codes.length) logView = null;
            }
            return render();
        });

        const rawOf = (name) => { const r = D.status().raw || {}; return r[name] ? r[name].slice(0, 70) : 'nothing yet'; };
        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (logView) {
                const n = logView.codes.length, pages = Math.ceil(n / PER_PAGE), first = logView.page * PER_PAGE;
                const usb = logView.saved.filter((r) => r.file && !/exports/.test(r.file));
                cv.text('Logs: photograph each code (page ' + (logView.page + 1) + ' of ' + pages + ', codes ' + (first + 1) + '-' + Math.min(n, first + PER_PAGE) + ' of ' + n + '), then press Logs for the next', 40, 34, 20, t.text, { font: 'bold', literal: true });
                cv.text(usb.length ? 'The full logs are also on the USB stick: ' + usb[0].file : 'Plug in a USB stick and press Logs again from the start for the full logs as a file', 40, 62, 16, t.dim, { font: 'label', literal: true });
                logView.codes.slice(first, first + PER_PAGE).forEach((q, i) => {
                    const px = Math.max(3, Math.floor(420 / (q.size + 8)));
                    logs.draw(cv, q, 40 + i * 520, 84, px);
                    cv.text(String(first + i + 1) + ' / ' + n, 40 + i * 520 + 180, 84 + (q.size + 8) * px + 22, 18, t.text, { font: 'bold', literal: true });
                });
                return ui.image('MAIN_GFX', cv);
            }
            if (page === 1) {
                cv.text('What the car sends for the drive mode and the ranges (photograph this in each mode)', 48, 70, 24, t.text, { font: 'bold', literal: true });
                const raw = D.status().raw || {}, d = data();
                let y = 120;
                ['statusFESVehicleDynamicSwitchHMI', 'statusSwitchDriveDynamicSport2', 'statusRangeTankStatus', 'Range', 'statusEngineStatus', 'ActualSteeringAngleDriver', 'statusYawVelocityVehicle'].forEach((n) => {
                    const txt = raw[n] || 'nothing yet';
                    cv.text(n + ':  ' + txt.slice(0, 120), 48, y, 15, t.text, { font: 'label', literal: true }); y += 21;
                    for (let i = 120; i < txt.length && i < 2 * 120; i += 120) { cv.text(txt.slice(i, i + 120), 72, y, 15, t.dim, { font: 'label', literal: true }); y += 21; }
                    y += 6;
                });
                const vh = D.vehicle();
                cv.text('Vehicle: ' + (vh.vehicle === 'ice' ? 'petrol or diesel' : 'plug-in hybrid') + ' (' + vh.how + (vh.how === 'set' ? '' : ': ' + vh.why) + ')', 48, y + 34, 18, t.text, { font: 'bold', literal: true });
                cv.text('Read as: ' + (d.driveMode || '-') + ', steering ' + (isNum(d.steer) ? Math.round(d.steer) + '°' : '--') + ', yaw ' + (isNum(d.yaw) ? d.yaw.toFixed(1) : '--') + ', fuel ' + (isNum(d.frange) ? Math.round(d.frange) : '--') + ', electric ' + (isNum(d.erange) ? Math.round(d.erange) : '--'), 48, y + 6, 18, t.text, { font: 'bold', literal: true });
                return ui.image('MAIN_GFX', cv);
            }
            if (page === 2) {
                cv.text('What the cluster shows besides this app (the renderer\'s report; photograph it with a layout up)', 48, 70, 24, t.text, { font: 'bold', literal: true });
                const txt = cluster.rendererStatus();
                const lines = txt ? txt.split('\n').filter((l) => /^slot 0x|^target (panel|map|hud)|^dcsm/.test(l)) : ['nothing yet'];
                lines.slice(0, 15).forEach((l, i) => cv.text(l.slice(0, 140), 48, 116 + i * 26, 16, t.text, { font: 'label', literal: true }));
                return ui.image('MAIN_GFX', cv);
            }
            if (page === 3) {
                // the car's media state as it comes (shared/media.js), and the song read from it: photograph it with a
                // song playing from each source (CarPlay, Bluetooth, USB, radio)
                cv.text('What the car sends for the song playing (photograph this with music on)', 48, 70, 24, t.text, { font: 'bold', literal: true });
                const raw = D.status().raw || {}, m = data().media;
                let y = 116;
                cv.text('Media state: ' + (D.status().media || 'not subscribed (Settings > Now playing, or no such interface on this car)'), 48, y, 16, t.dim, { font: 'label', literal: true }); y += 30;
                ['playerMetadata', 'mainMenuMetadata', 'trackSelection', 'tracks'].forEach((n) => {
                    const txt = raw[n] || 'nothing yet';
                    cv.text(n + ':  ' + txt.slice(0, 120), 48, y, 15, t.text, { font: 'label', literal: true }); y += 21;
                    for (let i = 120; i < txt.length && i < 3 * 120; i += 120) { cv.text(txt.slice(i, i + 120), 72, y, 15, t.dim, { font: 'label', literal: true }); y += 21; }
                    y += 6;
                });
                const f = (m && m.from) || {};
                cv.text('Read as:  title "' + ((m && m.title) || '') + '"' + (f.title ? ' (' + f.title + ')' : '') + '   ·   artist "' + ((m && m.artist) || '') + '"' + (f.artist ? ' (' + f.artist + ')' : '')
                    + '   ·   album "' + ((m && m.album) || '') + '"', 48, y + 24, 18, t.text, { font: 'bold', literal: true });
                // the directions (shared/directions.js): whether a route runs, each source, the turns' replies
                cv.text('Directions: ' + (D.status().directions || '-'), 48, y + 56, 16, t.dim, { font: 'label', literal: true });
                return ui.image('MAIN_GFX', cv);
            }
            if (page === 4) return ui.image('MAIN_GFX', widgetsPage(cv, t));
            if (page > 4) {
                cv.text('Signals on this car for ranges, fuel and charge (' + found.list.length + ')   ·   page ' + (page - 4) + ' of ' + (pages() - 5), 48, 70, 26, t.text, { font: 'bold', literal: true });
                found.list.slice((page - 5) * SIGNALS_PER_PAGE, (page - 4) * SIGNALS_PER_PAGE).forEach((s, i) => {
                    const y = 130 + i * 54;
                    cv.text(s.iface.replace(/^de\.bmw\./, '') + '  ·  ' + s.field + (s.get ? '  get' : '') + (s.notify ? '  notify' : ''), 48, y, 20, t.text, { font: 'label', literal: true });
                    cv.text(s.members.slice(0, 10).join(', ').slice(0, 150), 72, y + 24, 16, t.dim, { font: 'label', literal: true });
                });
                return ui.image('MAIN_GFX', cv);
            }
            const st = cluster.status(), d = data(), o = options();
            const spd = isNum(d.speed) ? Math.round(o.speedUnit === 'kmh' ? d.speed : d.speed / 1.609344) + ' ' + (o.speedUnit === 'kmh' ? 'km/h' : 'mph') : '--';
            const tmp = (c) => (isNum(c) ? Math.round(o.tempUnit === 'c' ? c : c * 9 / 5 + 32) + '°' : '--');
            const lines = [
                ['On the cluster', !showing() ? 'Off - the stock cluster shows (press Show on the cluster)'
                    : st.shown ? 'Showing: ' + layout.title + ', ' + look() + ' colours' : 'Waiting for live car data'],
                ['Cluster renderer', st.renderer + '   ·   panel: ' + st.target + '   ·   ' + st.layers + ' layers' + (st.refused ? '   ·   refused: ' + st.refused : '')],
                ['Car data', (d.demo ? 'demo   ·   ' : live() ? 'live   ·   ' : 'not live   ·   ') + spd + '   ·   ' + (isNum(d.rpm) ? Math.round(d.rpm) + ' rpm' : '-- rpm')
                    + '   ·   gear ' + layout.gearText(d) + '   ·   oil ' + tmp(d.oil) + '   ·   coolant ' + tmp(d.coolant) + '   ·   outside ' + tmp(d.outside)],
                ['Shared by apps', D.status().providers + '   ·   diagnostic link ' + D.status().diag + '   ·   charge ' + (isNum(d.soc) ? Math.round(d.soc) + '%' : '--') + '   ·   power ' + (isNum(d.kw) ? d.kw.toFixed(1) + ' kW' : '--')],
                ['Drive mode (car)', (d.driveMode || '-') + '   ·   raw: ' + rawOf('statusFESVehicleDynamicSwitchHMI') + '  ' + rawOf('statusSwitchDriveDynamicSport2')],
                ['Range (car)', 'fuel ' + (isNum(d.frange) ? Math.round(d.frange) : '--') + '  electric ' + (isNum(d.erange) ? Math.round(d.erange) : '--') + '   ·   raw: ' + rawOf('statusRangeTankStatus')],
            ];
            cv.text('Cluster Layouts ' + ((ctx.spec && ctx.spec.version) || ''), 48, 80, 44, t.text, { font: 'bold', literal: true });
            lines.forEach(([k, v], i) => {
                cv.text(k, 48, 160 + i * 64, 22, t.dim, { font: 'bold', literal: true });
                cv.text(String(v).slice(0, 120), 330, 160 + i * 64, k.indexOf('(car)') >= 0 ? 17 : 22, t.text, { font: 'label', literal: true });
            });
            creditFooter(cv, t);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        Promise.resolve().then(render).catch((e) => log.warn('first render: ' + (e && e.stack || e)));
    },
});
