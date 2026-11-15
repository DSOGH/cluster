'use strict';
/**
 * warnings.js - the car's active Check Control messages (the warnings the cluster pops up: drivetrain, coolant
 * temperature, tyre pressure ...), for the M340i layout's warning banner: [{ id, name, red }], newest first.
 *
 * Read as cauliflowermossgrape's Fault Scanner reads them (hdp-apps, apps/dtc_scanner, MIT): which messages are
 * active from CheckControlMaster.basicList (each { ccmId, activeState 'AKTIV' or 0, ... }), their names and colours
 * from the cluster's own list (KombiInterface_2.ccList, newCCMessage: { cCIdentifer, cCShortName or cCName, cCColor }).
 * A message without a name yet shows as "Check Control <id>".
 *
 *   const w = startWarnings(ctx, log);  w.list();  w.status();
 */
function walk(o, fn) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
    fn(o);
    Object.keys(o).forEach((k) => { if (o[k] && typeof o[k] === 'object') walk(o[k], fn); });
}
const isRed = (c) => /RED|ROT|^1$|^2$/.test(String(c === undefined ? '' : c).toUpperCase());

function createWarnings() {
    const active = new Map(), names = new Map();
    let order = 0;
    return {
        /** CheckControlMaster.basicList's value. */
        basic(v) {
            const seen = new Set();
            walk(v, (o) => {
                if (o.ccmId === undefined) return;
                const on = o.activeState === 'AKTIV' || o.activeState === 0 || o.activeState === 'ACTIVE';
                seen.add(String(o.ccmId));
                if (on && !active.has(String(o.ccmId))) active.set(String(o.ccmId), ++order);
                if (!on) active.delete(String(o.ccmId));
            });
        },
        /** KombiInterface_2.ccList / newCCMessage's value. */
        names(v) {
            walk(v, (o) => {
                const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
                const nm = o.cCShortName || o.cCName;
                if (id !== undefined && nm) names.set(String(id), { name: String(nm).trim(), red: isRed(o.cCColor) });
            });
        },
        list() {
            return Array.from(active.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => {
                const n = names.get(id);
                return { id, name: n ? n.name : 'Check Control ' + id, red: n ? n.red : false };
            });
        },
    };
}

function startWarnings(ctx, log) {
    const w = createWarnings();
    const st = { master: 'waiting', kombi: 'waiting' };
    let said = '';
    const note = () => { const l = w.list().map((x) => x.name).join(', '); if (l !== said) { said = l; if (log) log.info('warnings: ' + (l || 'none')); } };
    if (ctx.signals && ctx.signals.watch) {
        ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', { basicList: (v) => { w.basic(v); note(); } }, log)
            .then((r) => { st.master = r && r.error ? 'error' : 'subscribed'; }).catch(() => { st.master = 'error'; });
        ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', { ccList: (v) => { w.names(v); note(); }, newCCMessage: (v) => { w.names(v); note(); } }, log)
            .then((r) => { st.kombi = r && r.error ? 'error' : 'subscribed'; }).catch(() => { st.kombi = 'error'; });
    }
    return { list: () => w.list(), status: () => 'check control ' + st.master + ', names ' + st.kombi + ', active: ' + (w.list().map((x) => x.name).join(', ') || 'none') };
}

module.exports = { createWarnings, startWarnings };
