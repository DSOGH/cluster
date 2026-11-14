'use strict';
/**
 * Flex Fuel - how much E85 and how much gasoline to put in to reach the ethanol mix you want.
 *
 *   - the fuel in the tank: the car's own gauge (KombiIF.statusRangeTankStatus, its fuel level in litres), or a
 *     level set by hand in Settings when the car gives none;
 *   - the mix in the tank: set once in Settings, then kept up to date by the app after each fill-up (the level
 *     rising by FILL_L or more, from the plan that was on the screen);
 *   - the pumps: the E85 pump's real ethanol (often nearer 70-80 % than 85), the gasoline's grade and ethanol;
 *   - the fill: the measured fuel first, to the amount shown, then the other until the pump clicks off. The tank's
 *     size less what the pump leaves empty (Settings) is where the click-off is expected; the fuel pumped last is
 *     the one closer to the mix wanted (Settings: Fill to the click with), so the click-off's variation moves the
 *     mix least. The page shows the mix if the pump stops half a gallon early or late.
 *
 * The arithmetic is mix.js.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { plan, afterFill } = require('./mix');

const W = 1600, H = 520;
const L_PER_GAL = 3.785411784;
const FILL_L = 3;            // a rise of this many litres or more is a fill-up
const SETTLE_MS = 60000;     // the level still for this long after rising: the fill-up is over
const SLACK_L = L_PER_GAL / 2;   // the click-off half a gallon early or late (the page's spread)
const isNum = (v) => typeof v === 'number' && isFinite(v);

/** The tank's own level (litres) in a value of statusRangeTankStatus: field names differ by car. */
function fuelLevelOf(v) {
    let whole, half;
    const walk = (o, key) => {
        if (o && typeof o === 'object') { Object.keys(o).forEach((k) => walk(o[k], k)); return; }
        const k = String(key || '').toLowerCase();
        if (typeof o !== 'number' || !isFinite(o) || o < 0 || o >= 0xFFFE) return;
        if (!/level|fill|inhalt|volume|liter/.test(k) || !/fuel|tank|kraftstoff/.test(k)) return;
        // (not a saddle tank's left / right halves)
        if (/left|right|links|rechts/.test(k)) { if (half === undefined) half = o; } else whole = o;
    };
    walk(v, '');
    return whole !== undefined ? whole : half;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const st = { level: undefined, levelAt: 0, source: 'waiting for the car', fill: null, rising: null };

        /* ---------- units ---------- */
        const gal = () => settings.get('units') !== 'l';
        const vol = (l, d) => (gal() ? (l / L_PER_GAL).toFixed(d === undefined ? 1 : d) + ' gal' : l.toFixed(d === undefined ? 1 : Math.max(0, d - 1)) + ' L');
        const pct = (e) => 'E' + (Math.round(e * 10) / 10).toFixed(Math.abs(e - Math.round(e)) < 0.05 ? 0 : 1);

        /* ---------- the mix in the tank: exact, the setting shows it rounded ---------- */
        let ownSet = false;
        const tankE = () => (isNum(settings.get('_tankExact')) && Math.round(settings.get('_tankExact')) === Number(settings.get('tankE')) ? settings.get('_tankExact') : Number(settings.get('tankE')));
        const setTankE = (e) => {
            ownSet = true;
            try { settings.set('_tankExact', Math.round(e * 100) / 100); settings.set('tankE', Math.max(0, Math.min(85, Math.round(e)))); } finally { ownSet = false; }
        };
        settings.onChange((k) => { if (k === 'tankE' && !ownSet) settings.set('_tankExact', Number(settings.get('tankE'))); });

        /* ---------- the tank and the plan ---------- */
        const tankL = () => Number(settings.get('tankL')) || 59;
        const fullL = () => tankL() - (Number(settings.get('shortL')) || 0);
        const litresNow = () => {
            const m = settings.get('level');
            if (m && m !== 'car') return Number(m) / 8 * tankL();
            return st.level;
        };
        const fuels = () => ({ e85: Number(settings.get('e85')), gas: Number(settings.get('gasE')) });
        const planFor = (litres, e) => plan({ litres, e }, fullL(), fuels(), Number(settings.get('target')), settings.get('topOff'), SLACK_L);

        /* ---------- fill-ups: the level rising by FILL_L or more, then still for SETTLE_MS ---------- */
        // (the level before it is kept across restarts: the head unit is usually off while the car is filled)
        const lastLevel = () => settings.get('_lastLevel');
        function onLevel(n) {
            st.level = n; st.levelAt = Date.now(); st.source = 'the car\'s fuel gauge';
            const before = lastLevel();
            if (!isNum(before)) { settings.set('_lastLevel', n); return; }
            if (n >= before + FILL_L) {
                if (!st.rising) { st.rising = { before, e: tankE(), at: Date.now() }; log.info('fuel rising from ' + before + ' L'); }
                // (still rising: the wait starts again)
                if (n > (st.rising.top || 0)) { st.rising.top = n; st.rising.at = Date.now(); }
                return;
            }
            // (small ups and downs are the gauge's own: the level kept is the lowest since the last fill-up)
            if (!st.rising && n < before - 0.5) settings.set('_lastLevel', n);
        }
        function settle() {
            const r = st.rising;
            if (!r || Date.now() - r.at < SETTLE_MS) return;
            st.rising = null;
            const after = r.top, p = planFor(r.before, r.e), e = afterFill({ litres: r.before, e: r.e }, { litres: after }, p.full ? null : p);
            setTankE(e);
            settings.set('_lastLevel', after);
            st.fill = { at: Date.now(), added: after - r.before, e };
            settings.set('_lastFill', st.fill);
            log.info('fill-up: ' + r.before + ' L to ' + after + ' L, the tank now E' + e.toFixed(1));
        }
        if (settings.get('_lastFill') && typeof settings.get('_lastFill') === 'object') st.fill = settings.get('_lastFill');

        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
            statusRangeTankStatus: (v) => { const n = fuelLevelOf(v); if (isNum(n)) onLevel(n); },
        }, log, { pollMs: 10000 }).then((s) => {
            if (s && s.error) { st.source = 'the car\'s fuel level is not available (' + s.error + '): set it in Settings'; log.warn('fuel level: ' + s.error); }
        }).catch((e) => { st.source = 'the car\'s fuel level is not available: set it in Settings'; log.warn('fuel level: ' + e); });

        /* ---------- the page ---------- */
        const fuelName = (k) => (k === 'e85' ? 'E85' : settings.get('grade'));
        const fuelE = (k) => fuels()[k] + ' %';

        function render() {
            settle();
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            const L = litresNow(), e = tankE(), want = Number(settings.get('target'));

            // the tank now
            G.panel(cv, t, 24, 44, 470, 468, 'In the tank');
            if (isNum(L)) {
                cv.text(vol(L), 48, 168, 72, t.text, { font: 'bold' });
                cv.text('of ' + vol(tankL()) + ' (' + Math.round(L / tankL() * 100) + ' %)', 48, 208, 22, t.dim);
                const f = Math.max(0, Math.min(1, L / tankL()));
                cv.roundRect(48, 232, 422, 18, 9, t.track);
                if (f > 0) cv.roundRect(48, 232, Math.max(18, 422 * f), 18, 9, t.accent);
                // where the pump clicks off
                const fx = 48 + 422 * Math.max(0, Math.min(1, fullL() / tankL()));
                cv.fillRect(fx - 1, 226, 3, 30, t.text);
            } else {
                cv.text('--', 48, 168, 72, t.dim, { font: 'bold' });
                cv.text('No fuel level yet', 48, 208, 22, t.dim);
            }
            cv.text('ETHANOL', 48, 312, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(pct(e), 48, 392, 72, t.text, { font: 'bold' });
            cv.text('set in Settings, then kept up to date at each fill-up', 48, 430, 18, t.dim);

            // the plan
            G.panel(cv, t, 514, 44, 1062, 468, 'To fill up to E' + want);
            if (!isNum(L)) {
                cv.text('Waiting for the fuel level: ' + st.source + '.', 546, 160, 26, t.dim);
            } else {
                const p = planFor(L, e);
                if (p.full) {
                    cv.text('The tank is full.', 546, 160, 40, t.text, { font: 'bold' });
                } else {
                    const steps = [];
                    if (p.firstL >= L_PER_GAL * 0.05) steps.push(['Pump exactly', vol(p.firstL, 2), 'of ' + fuelName(p.first) + ' (' + fuelE(p.first) + ')', t.accent]);
                    steps.push([steps.length ? 'Then fill with' : 'Fill with', fuelName(p.last) + ' (' + fuelE(p.last) + ')', 'until the pump stops: about ' + vol(p.lastL), t.text]);
                    steps.forEach(([lead, big, tail, c], i) => {
                        const y = 150 + i * 110;
                        cv.roundRect(546, y - 44, 56, 56, 28, c === t.accent ? t.accent : t.track);
                        cv.text(String(i + 1), 574, y - 2, 30, c === t.accent ? t.bg : t.text, { font: 'bold', align: 'center' });
                        cv.text(lead, 626, y - 22, 20, t.dim, { font: 'bold' });
                        cv.text(big, 626, y + 20, 44, t.text, { font: 'bold' });
                        cv.text(tail, 626 + cv.textWidth(big, 44, { font: 'bold' }) + 18, y + 20, 26, t.dim);
                    });
                    const y = 150 + steps.length * 110 + 10;
                    cv.fillRect(546, y - 34, 998, 1, t.panelEdge);
                    if (p.reached) {
                        cv.text('You will have ' + vol(fullL()) + ' of ' + pct(p.result), 546, y + 8, 30, t.text, { font: 'bold' });
                    } else {
                        cv.text(pct(want) + ' can\'t be reached in one fill-up: the closest is ' + pct(p.result), 546, y + 8, 28, t.warn, { font: 'bold' });
                        cv.text(p.result < want ? 'Run the tank lower first, or use a richer E85.' : 'There is too much ethanol in the tank for this mix: run it lower first.', 546, y + 44, 20, t.dim);
                    }
                    if (p.reached) cv.text('If the pump stops ' + vol(SLACK_L) + ' early or late: ' + pct(p.spread[0]) + ' to ' + pct(p.spread[1]), 546, y + 44, 20, t.dim);
                }
            }
            // what the plan rests on
            const f = st.fill;
            const lines = [
                'E85 pump ' + fuels().e85 + ' %   ·   ' + settings.get('grade') + ' with ' + fuels().gas + ' %   ·   tank ' + vol(tankL()) + ', the pump stops ' + vol(Number(settings.get('shortL')) || 0, 2) + ' short',
                'Fuel level: ' + (settings.get('level') !== 'car' ? 'set by hand (' + settings.display('level') + ')' : st.source + (isNum(st.level) ? ' (' + st.level + ' L)' : ''))
                    + (f ? '   ·   last fill-up ' + vol(f.added) + ', ' + new Date(f.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', the tank then ' + pct(f.e) : ''),
            ];
            lines.forEach((s, i) => cv.text(s, 546, 480 + i * 24, 17, t.dim, { literal: true }));
            G.frame(cv, t, ['Flex Fuel'], 0, []);
            return ui.image('MAIN_GFX', cv);
        }
        settings.onChange(() => { Promise.resolve().then(render).catch((e) => log.warn('render: ' + e)); });
        ctx.loop('MAIN', 1, render);
        Promise.resolve().then(render).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { fuelLevelOf };
