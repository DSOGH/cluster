'use strict';
/**
 * mix.js - the ethanol blend arithmetic of Flex Fuel. Volumes in litres, ethanol as a percentage (0-100).
 *
 * A fill-up is two fuels: one pumped to a measured amount first (the pump's display tells you when to stop), then
 * the other until the pump clicks off. The tank holds `full` litres at the click (its size less what the pump
 * leaves empty), so the second amount is what is left of the room: the click-off's own variation falls on the
 * fuel pumped last, which is why that one should be the fuel closer to the mix you want.
 */

/** The ethanol of `a` litres at `ea` % and `b` litres at `eb` % mixed. */
function blend(a, ea, b, eb) {
    return a + b > 0 ? (a * ea + b * eb) / (a + b) : 0;
}

/**
 * The plan for one fill-up.
 *   now:   { litres, e }          what is in the tank
 *   full:  litres at the click-off
 *   fuels: { e85: %, gas: % }     the two pumps' real ethanol
 *   want:  % wanted
 *   last:  'auto' | 'gas' | 'e85' the fuel that tops off (auto: whichever keeps the result closest)
 * Returns { room, first, firstL, last, lastL, result, reached, spread: [lo, hi], fuelsE } or { full: true } when
 * there is no room. first / last are 'e85' or 'gas'; firstL may be 0 (only the last fuel is needed). `spread` is
 * the mix if the pump clicks `slack` litres earlier / later than expected.
 */
function plan(now, full, fuels, want, last, slack) {
    const L0 = Math.max(0, now.litres), room = full - L0;
    if (room < 0.5) return { full: true, room: Math.max(0, room) };
    const one = (top) => {
        const other = top === 'gas' ? 'e85' : 'gas', et = fuels[top], em = fuels[other];
        // now.e * L0 + em * m + et * (room - m) = want * full
        let m = em === et ? 0 : (want * full - now.e * L0 - et * room) / (em - et);
        const exact = m >= -1e-9 && m <= room + 1e-9;
        m = Math.max(0, Math.min(room, m));
        const result = (now.e * L0 + em * m + et * (room - m)) / full;
        const s = slack || 0;
        // the click-off s litres early (less of the last fuel) or late (more of it)
        const lo = blend(L0 + m, blend(L0, now.e, m, em), Math.max(0, room - m - s), et);
        const hi = blend(L0 + m, blend(L0, now.e, m, em), room - m + s, et);
        return { room, first: other, firstL: m, last: top, lastL: room - m, result, reached: exact, spread: [Math.min(lo, hi), Math.max(lo, hi)], fuelsE: fuels };
    };
    if (last === 'gas' || last === 'e85') return one(last);
    const a = one('gas'), b = one('e85');
    // reachable first; then the narrower spread (the click-off moves the mix least); then the closer result
    const score = (p) => (p.reached ? 0 : 1000 + Math.abs(p.result - want)) + (p.spread[1] - p.spread[0]);
    return score(a) <= score(b) ? a : b;
}

/**
 * The tank after a fill-up from `before` litres to `after` litres, the fill having followed `p` (a plan): the
 * measured fuel first, up to its amount, the rest the last fuel. A fill smaller than the plan's measured amount
 * counts as all measured fuel (the pump was stopped early).
 */
function afterFill(before, after, p) {
    const added = Math.max(0, after.litres - before.litres);
    const first = Math.min(added, p ? p.firstL : 0), rest = added - first;
    const ef = p ? p.fuelsE[p.first] : before.e, el = p ? p.fuelsE[p.last] : before.e;
    return (before.e * before.litres + ef * first + el * rest) / Math.max(1e-9, before.litres + added);
}

module.exports = { blend, plan, afterFill };
