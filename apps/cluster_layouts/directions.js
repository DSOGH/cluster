'use strict';
/**
 * directions.js - the next turn while a route runs (CarPlay, Android Auto or BMW's own navigation), for the
 * cluster: { kind, dir, exit, side, dist, unit, road, ... } (nav.js's object) or null.
 *
 * Read only, as Redline reads it (its navlog.js; shared/NOTICE): the route's state from Guidance and the phones'
 * "guiding" flags (watched), and the turns from GuidanceEventList.queryContent, asked once a second while a route
 * runs and the turns are wanted (opts.wanted). The decoding and what counts as a route are nav.js's (Redline's).
 *
 *   const dir = startDirections(ctx, log, { wanted: () => true });
 *   dir.now()     // the next turn, or null;  dir.status()  // one line for the Signals page
 */
const Nav = require('./nav');

const SOURCES = [
    { name: 'guidance', iface: 'de.bmw.infotainment.navigation.guiding.Guidance', inst: 'Main_Instance',
        fields: ['guidanceState', 'guidingProvider', 'conclusiveDart', 'currentLaneGuiding'] },
    { name: 'phone', iface: 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding', inst: 'Main_Instance', fields: ['currentLaneGuiding'] },
    { name: 'carplay', iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', inst: 'CarPlayManagerInst1', fields: ['projectedGuidanceActive'] },
    { name: 'androidauto', iface: 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', inst: 'AndroidAutoProjectedManagerInst1',
        fields: ['projectedGuidanceActive'] },
];
const EVENT_LIST = { iface: 'de.bmw.infotainment.navigation.guiding.GuidanceEventList', inst: 'Main_Instance', method: 'queryContent' };
const SILENT_MS = 10000, QUERY_MS = 1000, CALL_MS = 900, PROXY_RETRY_MS = 30000, CALL_BACKOFF_MS = 2000, FAILS_RECONNECT = 5;
/** The request (Redline's): one view from the car's position, six events: turns, lanes, keep left / right, destinations. */
function eventQuery() {
    return { viewConfigs: [{
        viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 6, endPoints: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_LANE_GUIDINGS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS'] },
        options: [], minimumUpdateIntervalMs: 1000, segmentItemRasterLength: 100,
    }] };
}

/** The interfaces an app declares to read directions (app.json "signals"): all optional. */
const IFACES = SOURCES.map((s) => s.iface).concat(EVENT_LIST.iface);

function startDirections(ctx, log, opts) {
    const wanted = opts && opts.wanted ? opts.wanted : () => true;
    const T = Nav.Tracker(), mono = Nav.mono;
    const st = { sources: {}, events: 'not asked', turn: 'none' };
    const tap = (src, name, v, askedAt) => {
        try {
            const now = mono();
            if (src === 'events') { if (name === 'reply') return T.events(v, now, askedAt); T.failed(v); return; }
            T.field(src, name, v, now);
        } catch (e) { st.events = 'error: ' + e; }
    };
    const subs = [];
    if (!ctx.signals || !ctx.signals.watch) return { now: () => null, silent: () => false, status: () => 'no signals here', stop() {} };
    SOURCES.forEach((S) => {
        const h = {};
        S.fields.forEach((f) => { h[f] = (v) => tap(S.name, f, v); });
        Promise.resolve().then(() => ctx.signals.watch(S.iface, S.inst, h, null)).then((res) => {
            subs.push(res);
            st.sources[S.name] = res.error ? 'error' : res.available ? 'up' : 'waiting';
            if (res.error) return;
            let was = res.available;
            if (!was) tap(S.name, 'available', false);
            res.timer = setInterval(() => {
                if (res.available === was) return;
                was = res.available; st.sources[S.name] = was ? 'up' : 'waiting'; tap(S.name, 'available', was);
            }, 2000);
        }).catch((e) => { st.sources[S.name] = 'error'; if (log) log.warn('directions: ' + S.name + ': ' + e); });
    });
    // the turns: asked once a second while a route runs and they're wanted; a failed connection tried again after
    // PROXY_RETRY_MS, failed calls backed off (a provider that doesn't answer holds the shared queue)
    let proxy = null, proxyFailedAt = -Infinity, callFailedAt = -Infinity, fails = 0, asking = false;
    const ask = () => {
        const now = mono();
        if (asking || !T.routing() || !wanted() || !ctx.signals.proxy || !ctx.signals.call) return;
        if (fails >= 2 && now - callFailedAt < CALL_BACKOFF_MS) return;
        if (!proxy && now - proxyFailedAt < PROXY_RETRY_MS) return;
        asking = true;
        Promise.resolve().then(() => proxy || ctx.signals.proxy(EVENT_LIST.iface, EVENT_LIST.inst).then((p) => { proxy = p; return p; }, (e) => { proxyFailedAt = mono(); throw e; }))
            .then((p) => ctx.signals.call(p, EVENT_LIST.method, eventQuery(), CALL_MS))
            .then((reply) => {
                fails = 0; st.events = 'answering';
                const r = tap('events', 'reply', reply, now);
                if (r && r.ok && r.events && r.events.length) quiet.turnAt = mono();
            })
            .catch((e) => {
                const m = String((e && e.message) || e).slice(0, 120);
                if (proxy) { callFailedAt = mono(); if (++fails >= FAILS_RECONNECT) { proxy = null; fails = 0; proxyFailedAt = mono(); } }
                st.events = 'error: ' + m; tap('events', 'error', m);
            })
            .then(() => { asking = false; });
    };
    // a route the phone runs with no turns sent to the car (Waze over CarPlay on iDrive 7: Redline checked on a G21,
    // 2026-11-10; its turn card is drawn in its own map instead): said on the Signals page and logged once a route
    const quiet = { since: null, turnAt: -Infinity, said: false };
    const silent = () => {
        const now = mono();
        if (!T.routing()) { quiet.since = null; quiet.said = false; return false; }
        if (quiet.since === null) quiet.since = now;
        const ms = (opts && opts.silentMs) || SILENT_MS, is = now - quiet.since >= ms && now - quiet.turnAt >= ms;
        if (is && !quiet.said && log) log.info('directions: a route runs and no turns come from it (Waze sends the car none: its turn card is in its map)');
        quiet.said = quiet.said || is;
        return is;
    };
    const timer = setInterval(() => { ask(); silent(); }, QUERY_MS);
    let lastLine = '';
    return {
        /** The next turn, or null (no route, nothing readable, or not wanted). */
        now() {
            if (!wanted()) return null;
            const v = T.view('route', mono()), m = v && v.show;
            const line = Nav.describe(m).replace(/ [\d.,]+ (km|m|mi|yd|ft)\b/, '');
            if (line !== lastLine) { lastLine = line; st.turn = line; if (log) log.info('directions: ' + line); }
            return m || null;
        },
        /** True while a route runs and nothing has come with turns for SILENT_MS (Waze). */
        silent: silent,
        status: () => 'route ' + (T.routing() ? (silent() ? 'on, no turns sent (Waze sends none: its card is in its map)' : 'on') : 'off') + ', ' + Object.keys(st.sources).map((k) => k + ' ' + st.sources[k]).join(', ') + ', turns ' + st.events + ', showing ' + st.turn,
        stop() { clearInterval(timer); subs.forEach((s) => { try { if (s.timer) clearInterval(s.timer); s.shutdown(); } catch (e) { /* gone */ } }); },
    };
}

module.exports = { startDirections, IFACES, EVENT_LIST, eventQuery };
