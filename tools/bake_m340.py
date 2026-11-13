#!/usr/bin/env python3
"""
bake_m340.py - the M340i layout's artwork (apps/cluster_layouts/m340_art.js), made from the design's own
prototype page (tools/m340/prototype.html: the Figma export with its overlays) so the cluster shows the same
picture, pixel for pixel.

The prototype is drawn by headless Chrome at the cluster's size (twice over, then halved: clean edges), in pages:
  the frame      everything that never changes (the brackets, numerals, labels, gauges, the centre panel)
  the highlights the same with every scale numeral in its lit form (white, larger, a glow)
  the masks      where a reading may light: each bracket's whole channel, the fuel and oil bars' segments
  the glyphs     the figures and words the layout writes (speed, gear, time, range, temperature, drive mode)
  the map's veil how far the map shows through at each place (the design's feathered edges)

To keep what goes to the cluster small (the link carries every byte of a texture), the pages are stored as a
sparse texture: 16 px tiles, each kept once however often it occurs (the black most of all), colours as one byte
a pixel into a palette of 256. A tile map says which tile sits where. All of it together is a fraction of one
plain 1920x720 picture (5.5 MB).

    python3 tools/bake_m340.py            (needs Playwright with a Chrome, Pillow, numpy)
    CHROME=/path/to/chrome python3 tools/bake_m340.py
"""
import asyncio
import base64
import json
import os
import sys
import zlib

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROTO = os.path.join(HERE, 'm340', 'prototype.html')
OUT = os.path.join(HERE, '..', 'apps', 'cluster_layouts', 'm340_art.js')
WORK = os.environ.get('M340_WORK', os.path.join(HERE, 'm340', 'work'))

W, H = 1920, 720
S = 1891.0 / 2576.0          # the design's px (2576 x 1051) to the cluster's
OX, OY = 15, -8              # where the design's corner lands: its brackets from y 124 to the car's strip (646)
TILE = 8
ATLAS_COLS = 128
SS = 2                       # drawn this many times over, then averaged

MODES = ['COMFORT', 'COMFORT PLUS', 'COMFORT INDIVIDUAL', 'SPORT', 'SPORT PLUS', 'SPORT INDIVIDUAL',
         'ECO PRO', 'ECO PRO PLUS', 'ECO PRO INDIVIDUAL', 'ADAPTIVE']
EXTRA_GLYPHS = 'AVI'         # (for the mode names the prototype's glyph set lacks)

SETUP = r'''
(() => {
  const st = document.createElement('style');
  st.textContent = 'html,body{margin:0!important;padding:0!important;background:#000!important;overflow:hidden}' +
    'h1,.panel{display:none!important}.wrap{max-width:none!important;margin:0!important}' +
    '.stage{position:fixed;left:0;top:0;width:%(W)dpx;height:%(H)dpx;border-radius:0!important;overflow:hidden;background:#000}' +
    '#svg{position:absolute;left:%(OX)dpx;top:%(OY)dpx;width:1891px!important;height:auto}';
  document.head.appendChild(st);
  window.__S = %(S)r; window.__OX = %(OX)d; window.__OY = %(OY)d;
  window.artX = (sx) => (sx - __OX) / __S; window.artY = (sy) => (sy - __OY) / __S;
  const svg = document.getElementById('svg');
  window.__kids = () => Array.from(svg.children).filter((e) => e.tagName !== 'defs');
  window.__only = (g) => { __kids().forEach((e) => { e.__d = e.style.display; e.style.display = e === g ? '' : 'none'; }); };
  window.__back = () => { __kids().forEach((e) => { if ('__d' in e) e.style.display = e.__d; }); };
  window.__g = (id) => { const g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.id = id; svg.appendChild(g); return g; };
  window.__black = (g) => { g.innerHTML = '<rect x="-100" y="-100" width="2800" height="1300" fill="#000"/>'; };
})()
'''

FRAME = r'''
(() => {
  cluster.update({ engine: false, speed: 0, rpm: 0, sel: 'P', map: false, fuel: 0, oil: 0, mode: 'COMFORT', time: '1:11 pm' });
  ['sPoly', 'tPoly', 'sCap', 'tCap', 'sHl', 'tHl', 'sHlBg', 'tHlBg', 'speedG', 'gearG', 'timeG', 'rangeG', 'tempG', 'modeG', 'pmTxt',
    'readyTxt', 'rpm0Cover', 'handles', 'mapG'].forEach((id) => { document.getElementById(id).style.display = 'none'; });
  document.querySelectorAll('g[clip-path="url(#fClip)"],g[clip-path="url(#oClip)"]').forEach((e) => { e.style.display = 'none'; });
  /* nothing redraws them: the pages are taken with the prototype's own drawing switched off */
  window.render = () => {};
})()
'''

HIGHLIGHTS = r'''
(() => {
  const svg = document.getElementById('svg'), hold = __g('bakeHl');
  const boxes = { speed: [], rpm: [] };
  ['speed', 'rpm'].forEach((k) => {
    const p = k === 'speed' ? 's' : 't', g = document.getElementById(p + 'Hl'), bg = document.getElementById(p + 'HlBg');
    T[k].forEach((t) => {
      highlight(k, t[0], true);
      const b = bg.cloneNode(true), c = g.cloneNode(true); b.removeAttribute('id'); c.removeAttribute('id'); b.style.display = ''; c.style.display = '';
      hold.appendChild(b); hold.appendChild(c);
      const r = c.getBoundingClientRect(), q = b.getBoundingClientRect();
      boxes[k].push([Math.min(r.left, q.left), Math.min(r.top, q.top), Math.max(r.right, q.right), Math.max(r.bottom, q.bottom)]);
    });
    g.style.display = 'none'; bg.style.display = 'none';
  });
  return boxes;
})()
'''

MASKS = r'''
(() => {
  document.getElementById('bakeHl').style.display = 'none';
  const g = __g('bakeMask'); __black(g);
  let h = '';
  ['speed', 'rpm'].forEach((k) => {
    const b = BAND[k], a = [], c = [];
    for (let y = b.y0; y <= 830; y += (y < 816 ? b.step : 1)) { const [lo, hi] = span(b, y); a.push(lo.toFixed(2) + ',' + y); c.unshift(hi.toFixed(2) + ',' + y); }
    h += '<polygon fill="#fff" points="' + a.concat(c).join(' ') + '"/>';
  });
  document.querySelectorAll('g[clip-path="url(#fClip)"] polygon,g[clip-path="url(#oClip)"] polygon').forEach((p) => { h += '<polygon fill="#fff" points="' + p.getAttribute('points') + '"/>'; });
  g.innerHTML += h; __only(g);
})()
'''

VEIL = r'''
(() => {
  const g = __g('bakeVeil'); __black(g);
  g.innerHTML += '<g clip-path="url(#hexClip)"><g mask="url(#mapMask)"><rect x="0" y="0" width="2576" height="1051" fill="#fff"/></g></g>';
  __only(g);
})()
'''

# the glyph pages: each glyph alone, its pen at a whole pixel, so it can be set anywhere afterwards. A glyph with
# one place in the design is drawn at that place's own fraction of a pixel instead (fx across: READY, the gear
# centred on its place; fy down: a set's baseline), so the cluster's copy has the design's very pixels there.
GLYPHS = r'''
((spec) => {
  const g = __g('bakeGl' + spec.page); __black(g); __only(g);
  const out = [];
  spec.items.forEach((it, i) => {
    const id = 'bakeGl' + spec.page + '_' + i, e = document.createElementNS('http://www.w3.org/2000/svg', it.kind === 'text' ? 'text' : 'g');
    e.id = id; g.appendChild(e);
    if (it.kind === 'text') {
      e.setAttribute('x', artX(it.x + (it.fx || 0))); e.setAttribute('y', it.artBase); e.setAttribute('font-size', it.size); e.setAttribute('fill', '#fff');
      e.setAttribute('font-family', "'Helvetica Neue',Helvetica,Arial,sans-serif"); e.setAttribute('font-weight', '300');
      // (as the prototype's READY: its length made up between the letters, the letters' own shapes kept)
      if (it.len) { e.setAttribute('textLength', it.len); e.setAttribute('lengthAdjust', 'spacing'); }
      e.textContent = it.s;
      out.push({ adv: e.getComputedTextLength() * __S });
    } else {
      const gl = [...it.s].map((c) => GL.c[c]);
      let x = 0; const pos = gl.map((q) => { const p = x; x += q[0]; return p; });
      const inkL = gl[0][1], inkR = pos[pos.length - 1] + gl[gl.length - 1][2];
      // the pen (the first glyph's origin) at screen x it.x: drawText's start anchor puts the ink's left edge at ax
      // (it.mid: the glyph stands alone, centred there: its pen's fraction of a pixel)
      const pen = it.mid === undefined ? 0 : it.mid - (inkL + inkR) / 2 * it.scale * __S, fx = pen - Math.floor(pen);
      drawText(id, it.s, it.scale, it.artBase !== undefined ? it.artBase : artY(it.y + (it.fy || 0)), 'start', artX(it.x + fx) + inkL * it.scale, '#fff');
      out.push({ adv: x * it.scale * __S, inkL: inkL * it.scale * __S, inkR: inkR * it.scale * __S, fx: fx });
    }
  });
  return out;
})
'''

# what the shaders need of the prototype's own geometry, in cluster pixels: the lit channel's two edges at every
# row, the ticks' heights, the bars' segments, the map's hexagon
GEO = r'''
((H) => {
  const sx = (x) => x * __S + __OX, sy = (y) => y * __S + __OY;
  const edges = { speed: [], rpm: [] };
  ['speed', 'rpm'].forEach((k) => {
    const b = BAND[k];
    for (let r = 0; r < H; r++) {
      const ay = artY(r + 0.5);
      if (ay < b.y0 - 6 || ay > 832) { edges[k].push([0, 0]); continue; }
      const [lo, hi] = span(b, ay); edges[k].push([sx(lo), sx(hi)]);
    }
  });
  const pts = (sel) => Array.from(document.querySelectorAll(sel)).map((p) => p.getAttribute('points').trim().split(/\s+/).map((q) => q.split(',').map(Number)).map(([x, y]) => [sx(x), sy(y)]));
  const grad = (id) => Array.from(document.querySelectorAll('#' + id + ' stop')).map((e) => [Number(e.getAttribute('offset')), e.getAttribute('stop-color')]);
  const hex = document.querySelector('#hexClip polygon').getAttribute('points').trim().split(/\s+/).map((q) => q.split(',').map(Number)).map(([x, y]) => [sx(x), sy(y)]);
  const cover = document.getElementById('rpm0Cover');
  return {
    edges, hex,
    ticks: { speed: T.speed.map((t) => [t[0], sy(t[1])]), rpm: T.rpm.map((t) => [t[0], sy(t[1])]) },
    fuelSegs: pts('g[clip-path="url(#fClip)"] polygon'), oilSegs: pts('g[clip-path="url(#oClip)"] polygon'),
    fuelY: [sy(821), sy(821 - 234)], oil: OIL.map((t) => [t[0], sy(t[1])]), barGrad: grad('fGrad'), barGradLen: 228 * __S,
    fillGrad: { speed: grad('sGrad'), rpm: grad('tGrad'), y: [sy(180), sy(819)] }, capHalf: 4 * __S,
    cover: ['x', 'y', 'width', 'height'].map((a) => Number(cover.getAttribute(a))).map((v, i) => (i === 0 ? sx(v) : i === 1 ? sy(v) : v * __S)),
    speed: { x: sx(705.5), base: sy(492) }, gear: { x: sx(1977), base: sy(511) }, mode: { x: sx(1290), base: sy(925) },
    time: { x: sx(187), base: sy(954), gap: 15 * __S }, range: { x: sx(628), base: sy(954) }, temp: { x: sx(2479), base: sy(954) },
    ready: { x: sx(2115), base: sy(838) }, space: GL.c[' '][0] * __S,
  };
})
'''

EXTRAS = r'''
((add) => { Object.keys(add).forEach((c) => { GL.c[c] = add[c]; }); return { sp: SC.sp, gr: SC.gr, sm: SC.sm, md: SC.md }; })
'''


def extra_glyphs():
    """Outlines of the letters the mode names need beyond the prototype's set, from the design's font."""
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.boundsPen import BoundsPen
    path = os.environ.get('M340_FONT', '/mnt/user-data/uploads/Pirulen-W05-Bold.ttf')
    if not os.path.exists(path):
        return {}
    f = TTFont(path)
    gs, cm = f.getGlyphSet(), f.getBestCmap()
    out = {}
    for c in EXTRA_GLYPHS:
        n = cm[ord(c)]
        p = SVGPathPen(gs, ntos=lambda v: '%d' % round(v))
        gs[n].draw(p)
        b = BoundsPen(gs)
        gs[n].draw(b)
        out[c] = [f['hmtx'][n][0], round(b.bounds[0]), round(b.bounds[2]), p.getCommands()]
    return out


async def shots():
    from playwright.async_api import async_playwright
    os.makedirs(WORK, exist_ok=True)
    meta = {}
    async with async_playwright() as p:
        kw = {'args': ['--no-sandbox', '--force-color-profile=srgb']}
        if os.environ.get('CHROME') or os.path.exists('/usr/bin/google-chrome'):
            kw['executable_path'] = os.environ.get('CHROME', '/usr/bin/google-chrome')
        b = await p.chromium.launch(**kw)
        pg = await b.new_page(viewport={'width': W, 'height': H}, device_scale_factor=SS)
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('file://' + PROTO)
        await pg.wait_for_timeout(400)
        await pg.evaluate(SETUP % {'W': W, 'H': H, 'OX': OX, 'OY': OY, 'S': S})

        async def snap(name):
            await pg.wait_for_timeout(120)
            await pg.screenshot(path=os.path.join(WORK, name + '.png'), clip={'x': 0, 'y': 0, 'width': W, 'height': H})

        await pg.evaluate(FRAME)
        await snap('frame')
        meta['hl'] = await pg.evaluate(HIGHLIGHTS)
        await snap('highlights')
        await pg.evaluate(MASKS)
        await snap('masks')
        await pg.evaluate('__back()')
        await pg.evaluate(VEIL)
        await snap('veil')
        await pg.evaluate('__back()')
        sc = await pg.evaluate(EXTRAS, extra_glyphs())
        meta['sc'] = sc
        meta['geo'] = await pg.evaluate(GEO, H)
        # --- the glyph pages
        pages = []
        # 1: the speed's figures (pen at x, baseline at y 100), the gear's below (baseline y 220)
        items = []
        geo = meta['geo']

        def part(v):
            return v - round(v)      # a baseline's fraction of a pixel, from the whole pixel the layout sets it on
        for i, c in enumerate('0123456789'):
            items.append({'set': 'speed', 's': c, 'scale': sc['sp'], 'x': 40 + i * 110, 'y': 100, 'fy': part(geo['speed']['base'])})
        for i, c in enumerate('PRNDS12345678'):
            items.append({'set': 'gear', 's': c, 'scale': sc['gr'], 'x': 40 + i * 130, 'y': 220, 'fy': part(geo['gear']['base']), 'mid': geo['gear']['x']})
        for i, c in enumerate('0123456789:.+-'):
            items.append({'set': 'small', 's': c, 'scale': sc['sm'], 'x': 40 + i * 60, 'y': 300, 'fy': part(geo['time']['base'])})
        for i, c in enumerate(['am', 'pm']):
            items.append({'set': 'ampm', 'kind': 'text', 's': c, 'size': 36, 'x': 40 + i * 120, 'artBase': (360 - OY) / S})
        # (READY has one place: drawn at that place's own fraction of a pixel, across and down, so the cluster's
        # copy has the design's very pixels; the layout sets its pen on the whole pixel below)
        rx, ry = 2115 * S + OX, 838 * S + OY
        items.append({'set': 'ready', 'kind': 'text', 's': 'READY', 'size': 34, 'len': 108, 'x': 400, 'fx': rx % 1.0,
                      'artBase': (360 + ry - round(ry) - OY) / S})
        pages.append(items)
        # 2: the drive mode's letters
        letters = sorted(set(''.join(MODES)) - {' '})
        pages.append([{'set': 'mode', 's': c, 'scale': sc['md'], 'x': 40 + (i % 24) * 50, 'y': 60 + (i // 24) * 60} for i, c in enumerate(letters)])
        meta['glyphs'] = []
        for n, items in enumerate(pages):
            res = await pg.evaluate(GLYPHS + '(' + json.dumps({'page': n, 'items': items}) + ')')
            await snap('glyphs%d' % n)
            await pg.evaluate('__back()')
            for it, r in zip(items, res):
                it.update(r)
                it['page'] = n
            meta['glyphs'] += items
        await b.close()
    if errs:
        sys.exit('the prototype page reported: ' + '; '.join(errs))
    json.dump(meta, open(os.path.join(WORK, 'meta.json'), 'w'))
    return meta


def load(name):
    """A page at the cluster's size: the mean of each SS x SS block of what Chrome drew."""
    im = Image.open(os.path.join(WORK, name + '.png')).convert('RGB')
    return np.asarray(im.resize((W, H), Image.BOX))


def mdist(a, b):
    return np.abs(a[:, None, :].astype(float) - b[None, :, :].astype(float)).max(2)


def kmeans_palette(px, k, rounds=14):
    """k colours for these pixels: median cut, then moved to the weighted mean of what each serves."""
    if not len(px):
        return np.zeros((k, 3))
    u, cnt = np.unique(px, axis=0, return_counts=True)
    if len(u) <= k:
        return np.concatenate([u, np.zeros((k - len(u), 3))]).astype(float)
    im = Image.fromarray(np.repeat(u, np.minimum(cnt, 50), axis=0).reshape(1, -1, 3).astype(np.uint8))
    q = im.quantize(k, method=Image.Quantize.MEDIANCUT, kmeans=0, dither=Image.Dither.NONE)
    pal = np.array(q.getpalette()[:k * 3], float).reshape(-1, 3)
    if len(pal) < k:
        pal = np.concatenate([pal, np.zeros((k - len(pal), 3))])
    uf = u.astype(float)
    for _ in range(rounds):
        d = ((uf[:, None, :] - pal[None, :, :]) ** 2).sum(2)
        a = d.argmin(1)
        worst = (d.min(1) * cnt)
        for j in range(k):
            m = a == j
            if m.any():
                pal[j] = (uf[m] * cnt[m, None]).sum(0) / cnt[m].sum()
            else:                      # an unused colour goes where the fit is worst
                w = worst.argmax()
                pal[j] = uf[w]
                worst[w] = 0
    return pal


def nearest(px, pal):
    u, inv = np.unique(px, axis=0, return_inverse=True)
    return ((u[:, None, :].astype(float) - pal[None, :, :]) ** 2).sum(2).argmin(1)[inv.ravel()]


NODE = 16        # rows between a material's palette nodes
KEEP = 2.0       # levels a pixel may sit from its material's colour (the picture's own grain is 1)


def materials(img, sel, max_n, min_area=500):
    """The picture's smooth shapes, each a chain of one run a row (so a shape has one colour a row, which a
    palette that changes down the picture can follow): (label plane, -1 elsewhere; row colours of each)."""
    Hh, Ww = sel.shape
    lab = np.full((Hh, Ww), -1, np.int32)
    regs = []                      # per region: {'area', 'rows': {y: (colour, n)}}
    prev = []                      # runs of the row above: (x0, x1, colour, region)
    f = img.astype(float)
    for y in range(Hh):
        row, s = f[y], sel[y]
        brk = np.ones(Ww + 1, bool)
        brk[1:Ww] = (np.abs(row[1:] - row[:-1]).max(1) > 3) | ~s[1:] | ~s[:-1]
        edges = np.where(brk)[0]
        runs = []
        for a, b in zip(edges[:-1], edges[1:]):
            if b - a < 4 or not s[a]:
                continue
            # a run whose colour drifts along the row (a sideways gradient) is cut where it has moved a level:
            # judged on the run smoothed over 9 px, so the picture's own grain (a level either way) cuts nothing
            n = b - a
            k = min(9, n)
            pad = np.concatenate([np.repeat(row[a:a + 1], k // 2, 0), row[a:b], np.repeat(row[b - 1:b], k - 1 - k // 2, 0)])
            cs = np.cumsum(np.concatenate([np.zeros((1, 3)), pad]), 0)
            sm = (cs[k:] - cs[:-k]) / k
            i0 = 0
            while i0 < n:
                far = np.where(np.abs(sm[i0:] - sm[i0]).max(1) > 1.0)[0]
                i1 = i0 + (far[0] if len(far) else n - i0)
                if n - i1 < 4:
                    i1 = n
                if i1 - i0 >= 4:
                    runs.append([a + i0, a + i1, row[a + i0:a + i1].mean(0), -1])
                i0 = i1
        # each run to the run above it shares most with, when their colours agree; one to one
        cand = []
        for i, (a, b, c, _) in enumerate(runs):
            for j, (pa, pb, pc, pr) in enumerate(prev):
                ov = min(b, pb) - max(a, pa)
                if ov > 0 and ov >= 0.5 * min(b - a, pb - pa) and np.abs(c - pc).max() <= 1.5:
                    cand.append((ov, i, j))
        cand.sort(reverse=True)
        ti, tj = set(), set()
        for ov, i, j in cand:
            if i in ti or j in tj:
                continue
            ti.add(i)
            tj.add(j)
            runs[i][3] = prev[j][3]
        for r in runs:
            if r[3] < 0:
                r[3] = len(regs)
                regs.append({'area': 0, 'rows': {}})
            g = regs[r[3]]
            g['area'] += r[1] - r[0]
            g['rows'][y] = (r[2], r[1] - r[0])
            lab[y, r[0]:r[1]] = r[3]
        prev = runs
    order = sorted([i for i, g in enumerate(regs) if g['area'] >= min_area], key=lambda i: -regs[i]['area'])[:max_n]
    remap = np.full(len(regs) + 1, -1, np.int32)
    for n, i in enumerate(order):
        remap[i] = n
    lab = remap[lab]               # (-1 stays -1: the last entry)
    return lab, [regs[i]['rows'] for i in order]


def material_nodes(rows, nn):
    """A material's colour at each node (the middle of each NODE rows), from its rows near it; held past its ends."""
    out = np.full((nn, 3), np.nan)
    for j in range(nn):
        c = j * NODE + NODE / 2.0
        acc, wt = np.zeros(3), 0.0
        for y in range(int(c - NODE / 2), int(c + NODE / 2)):
            if y in rows:
                acc += rows[y][0] * rows[y][1]
                wt += rows[y][1]
        if wt:
            # (the rows found may sit to one side of the node: a line through them, read at the node)
            ys = [y for y in range(int(c - NODE), int(c + NODE)) if y in rows]
            if len(ys) >= 4:
                A = np.array([[1.0, y + 0.5 - c] for y in ys])
                cols = np.array([rows[y][0] for y in ys])
                out[j] = np.linalg.lstsq(A, cols, rcond=None)[0][0]
            else:
                out[j] = acc / wt
    ok = np.where(~np.isnan(out[:, 0]))[0]
    for ch in range(3):
        out[:, ch] = np.interp(np.arange(nn), ok, out[ok, ch])
    return out


def classes(img, sel, with_materials):
    """Every pixel a class (0: nothing there), and the classes' colours down the picture: (plane, palette (nodes, 256, 3))."""
    Hh, Ww = sel.shape
    nn = (Hh + NODE - 1) // NODE + 1 if with_materials else 1
    pal = np.zeros((nn, 256, 3))
    cls = np.zeros((Hh, Ww), np.uint8)
    lit = sel & (img.max(2) > 2)
    left = lit.copy()
    n_mat = 0
    if with_materials:
        lab, rows = materials(img, lit, 120, 160)
        n_mat = len(rows)
        for m in range(n_mat):
            pal[:, 1 + m] = material_nodes(rows[m], nn)
        # the colour a material has at each row (the nodes joined by straight lines), and who fits it
        yc = (np.arange(Hh) + 0.5) / NODE - 0.5
        i0 = np.clip(np.floor(yc).astype(int), 0, nn - 1)
        i1 = np.clip(i0 + 1, 0, nn - 1)
        t = np.clip(yc - np.floor(yc), 0, 1)
        t[yc < 0] = 0
        ys, xs = np.where(lab >= 0)
        m = lab[ys, xs]
        want = pal[i0[ys], 1 + m] * (1 - t[ys])[:, None] + pal[i1[ys], 1 + m] * t[ys][:, None]
        fits = np.abs(img[ys, xs].astype(float) - want).max(1) <= KEEP + 0.5
        cls[ys[fits], xs[fits]] = 1 + m[fits]
        left[ys[fits], xs[fits]] = False
        # a material takes in the pixels beside it that fit its colour too (the ragged ends of its runs, the
        # grain's strays), so its inside is whole and its tiles all alike
        rowpal = pal[i0] * (1 - t)[:, None, None] + pal[i1] * t[:, None, None]          # (rows, 256, 3)
        fimg = img.astype(float)
        yy = np.arange(Hh)[:, None]
        for _ in range(60):
            grew = False
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nb = np.roll(cls, (dy, dx), (0, 1))
                if dy == 1:
                    nb[0] = 0
                elif dy == -1:
                    nb[-1] = 0
                elif dx == 1:
                    nb[:, 0] = 0
                else:
                    nb[:, -1] = 0
                cand = left & (nb >= 1) & (nb <= n_mat)
                if not cand.any():
                    continue
                cy, cx = np.where(cand)
                ok = np.abs(fimg[cy, cx] - rowpal[cy, nb[cy, cx]]).max(1) <= KEEP + 0.5
                if ok.any():
                    cls[cy[ok], cx[ok]] = nb[cy[ok], cx[ok]]
                    left[cy[ok], cx[ok]] = False
                    grew = True
            if not grew:
                break
    # everything else: the nearest of the fixed colours that are left
    k = 255 - n_mat
    fixed = kmeans_palette(img[left], k)
    pal[:, 1 + n_mat:1 + n_mat + k] = fixed[None]
    if left.any():
        cls[left] = 1 + n_mat + nearest(img[left], fixed)
    return cls, pal, n_mat


def render(cls, pal):
    """What the cluster shows for a class plane (for checking the fit)."""
    Hh = cls.shape[0]
    nn = pal.shape[0]
    if nn == 1:
        return np.round(pal[0][cls]).astype(np.uint8)
    yc = (np.arange(Hh) + 0.5) / NODE - 0.5
    i0 = np.clip(np.floor(yc).astype(int), 0, nn - 1)
    i1 = np.clip(i0 + 1, 0, nn - 1)
    t = np.clip(yc - np.floor(yc), 0, 1)
    t[yc < 0] = 0
    yy = np.arange(Hh)[:, None]
    out = pal[i0[yy], cls] * (1 - t)[:, None, None] + pal[i1[yy], cls] * t[:, None, None]
    return np.round(out).astype(np.uint8)


def tile_pack(cls):
    """(map of tile numbers (rows, cols), atlas (h, ATLAS_COLS * TILE)): each distinct tile once, tile 0 the empty one."""
    Hh, Ww = cls.shape
    t = cls.reshape(Hh // TILE, TILE, Ww // TILE, TILE).swapaxes(1, 2)
    seen = {bytes(TILE * TILE): 0}
    order = [np.zeros((TILE, TILE), np.uint8)]
    tmap = np.zeros((Hh // TILE, Ww // TILE), np.uint16)
    for y in range(t.shape[0]):
        for x in range(t.shape[1]):
            k = t[y, x].tobytes()
            if k not in seen:
                seen[k] = len(order)
                order.append(t[y, x])
            tmap[y, x] = seen[k]
    rows = (len(order) + ATLAS_COLS - 1) // ATLAS_COLS
    atlas = np.zeros((rows * TILE, ATLAS_COLS * TILE), np.uint8)
    for i, tl in enumerate(order):
        atlas[(i // ATLAS_COLS) * TILE:(i // ATLAS_COLS + 1) * TILE, (i % ATLAS_COLS) * TILE:(i % ATLAS_COLS + 1) * TILE] = tl
    return tmap, atlas


def map_texels(tmap):
    """Two tiles a texel: (low, high) bytes of the even one in R, G and of the odd one in B, A."""
    rows, cols = tmap.shape
    if cols % 2:
        tmap = np.concatenate([tmap, np.zeros((rows, 1), np.uint16)], 1)
        cols += 1
    out = np.zeros((rows, cols // 2, 4), np.uint8)
    out[..., 0] = tmap[:, 0::2] & 255
    out[..., 1] = tmap[:, 0::2] >> 8
    out[..., 2] = tmap[:, 1::2] & 255
    out[..., 3] = tmap[:, 1::2] >> 8
    return out


def pal_texels(pal):
    out = np.zeros((pal.shape[0], 256, 4), np.uint8)
    out[..., :3] = np.clip(np.round(pal), 0, 255)
    out[..., 3] = 255
    return out


def b64(a):
    return base64.b64encode(zlib.compress(np.ascontiguousarray(a).tobytes(), 9)).decode()


def pack(meta):
    frame, hl = load('frame'), load('highlights')
    geo = meta['geo']
    tex, blob, info = {}, {}, {}

    def put(name, arr, fmt, sampling='nearest'):
        tex[name] = {'w': int(arr.shape[1]), 'h': int(arr.shape[0]), 'format': fmt, 'sampling': sampling}
        blob[name] = b64(arr)
        return arr.size

    # --- which tiles are the centre panel's: wholly inside the map's hexagon and clear of what sits over the map
    from PIL import ImageDraw
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon([tuple(p) for p in geo['hex']], fill=255)
    inhex = np.asarray(m) > 0
    keep = np.zeros((H, W), bool)
    over = {}
    for name, (ax0, ay0, ax1, ay1) in (('fuel', (480, 572, 735, 838)), ('oil', (1815, 572, 2096, 838)), ('unit', (655, 490, 760, 548))):
        x0, y0 = int(np.floor(ax0 * S + OX)) // TILE * TILE, int(np.floor(ay0 * S + OY)) // TILE * TILE
        x1, y1 = -(-int(np.ceil(ax1 * S + OX)) // TILE) * TILE, -(-int(np.ceil(ay1 * S + OY)) // TILE) * TILE
        keep[y0:y1, x0:x1] = True
        over[name] = [x0, y0, x1 - x0, y1 - y0]
    # (what stays when the panel is cut away from over the map: the prototype's own rule, see CUT in the shader)
    f = frame.astype(int)
    mx = f.max(2)
    solid = ~((mx < 14) | ((f[..., 0] <= 14) & (f[..., 2] >= 1.6 * f[..., 1]) & (f[..., 2] <= 150)))
    tl = lambda a: a.reshape(H // TILE, TILE, W // TILE, TILE).swapaxes(1, 2)
    tiles_in = tl(inhex).all((2, 3)) & ~tl(keep & solid).any((2, 3))
    centre = np.repeat(np.repeat(tiles_in, TILE, 0), TILE, 1)
    ys, xs = np.where(centre)
    cx0, cy0, cx1, cy1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1

    # --- the sides: the frame without the centre's tiles. Each scale numeral's lit form (where the highlights page
    # differs from the frame, between its neighbours) is kept in the part of this picture the centre's tiles left
    # empty, and shown in the numeral's place when the reading is nearest it
    d = np.abs(frame.astype(int) - hl).max(2) > 2
    a_img = frame.copy()
    a_sel = ~centre
    boxes = {}
    free_x, free_y, cell_w, cell_h, per_row = 640, 160, 120, 64, 5
    assert not a_sel[free_y:free_y + 4 * cell_h, free_x:free_x + per_row * cell_w].any(), 'the place for the lit numerals is not empty'
    n = 0
    for half, k in ((slice(0, W // 2), 'speed'), (slice(W // 2, W), 'rpm')):
        cs = [(b[1] + b[3]) / 2 for b in meta['hl'][k]]
        bs = []
        for i, c in enumerate(cs):                      # (the numerals run up the scale)
            lo = int((c + cs[i + 1]) / 2) + 1 if i + 1 < len(cs) else int(c - 30)
            hi = int((c + cs[i - 1]) / 2) if i else int(c + 30)
            yy, xx = np.where(d[lo:hi, half])
            x0, y0, x1, y1 = half.start + xx.min() - 1, lo + yy.min() - 1, half.start + xx.max() + 2, lo + yy.max() + 2
            assert x1 - x0 <= cell_w and y1 - y0 <= cell_h, 'a lit numeral (%d x %d) is larger than its cell' % (x1 - x0, y1 - y0)
            vx, vy = free_x + (n % per_row) * cell_w, free_y + (n // per_row) * cell_h
            a_img[vy:vy + y1 - y0, vx:vx + x1 - x0] = hl[y0:y1, x0:x1]
            a_sel[vy:vy + y1 - y0, vx:vx + x1 - x0] = True
            bs.append([int(x0), int(y0), int(x1), int(y1), int(vx - x0), int(vy - y0)])
            n += 1
        boxes[k] = bs
    a_cls, a_pal, _ = classes(a_img, a_sel, False)
    # (only the part of the screen the sides' picture reaches is mapped)
    ys, xs = np.where(a_cls > 0)
    ax0, ay0 = xs.min() // 16 * 16, ys.min() // TILE * TILE
    ax1, ay1 = -(-(xs.max() + 1) // 16) * 16, -(-(ys.max() + 1) // TILE) * TILE
    a_map, a_atlas = tile_pack(a_cls[ay0:ay1, ax0:ax1])
    size = {'sides': put('a_map', map_texels(a_map), 'rgba8') + put('a_atlas', a_atlas, 'r8') + put('a_pal', pal_texels(a_pal), 'rgba8', 'bilinear')}
    # --- the centre panel: its smooth shapes as materials whose colour runs down the picture
    b_img, b_sel = frame[cy0:cy1, cx0:cx1], centre[cy0:cy1, cx0:cx1]
    b_cls, b_pal, n_mat = classes(b_img, b_sel, True)
    b_map, b_atlas = tile_pack(b_cls)
    size['centre'] = put('b_map', map_texels(b_map), 'rgba8') + put('b_atlas', b_atlas, 'r8') + put('b_pal', pal_texels(b_pal), 'rgba8', 'bilinear')
    # how close the cluster's picture comes to the design's
    got = np.zeros_like(frame)
    got[:, :] = render(a_cls, a_pal)
    got[centre] = 0
    got[cy0:cy1, cx0:cx1][b_sel] = render(b_cls, b_pal)[b_sel]
    err = np.abs(got.astype(int) - frame).max(2)
    info['fit'] = {'mean': round(float(err.mean()), 3), 'p99': float(np.percentile(err, 99)), 'over4': round(float((err > 4).mean() * 100), 3), 'max': int(err.max())}
    info['tiles'] = {'sides': int(a_map.max()) + 1, 'centre': int(b_map.max()) + 1, 'materials': int(n_mat)}
    Image.fromarray(got).save(os.path.join(WORK, 'fit.png'))

    # --- the lit channel's edges, a row each: x * 16 in two bytes, left edge then right edge; column 0 speed, 1 revs
    e = np.zeros((H, 2, 4), np.uint8)
    for c, k in enumerate(('speed', 'rpm')):
        for r, (lo, hi) in enumerate(geo['edges'][k]):
            a, b = int(round(lo * 16)), int(round(hi * 16))
            e[r, c] = (a >> 8, a & 255, b >> 8, b & 255)
    size['edges'] = put('edges', e, 'rgba8')

    # --- the map's veil, an eighth the size (it is all soft)
    veil = load('veil')[..., 0]
    win = [416, int(cy0), 1088, 480]
    v = Image.fromarray(veil[win[1]:win[1] + win[3], win[0]:win[0] + win[2]]).resize((win[2] // 8, win[3] // 8), Image.BOX)
    size['veil'] = put('veil', np.asarray(v), 'r8', 'bilinear')

    # --- the glyphs: each cut from its page, a set's glyphs all one height
    pages = {}
    sets = {}
    for it in meta['glyphs']:
        pg = pages.get(it['page'])
        if pg is None:
            pg = pages[it['page']] = load('glyphs%d' % it['page'])[..., 0]
        base = it['y'] if 'y' in it else int(round(it['artBase'] * S + OY))
        nxt = min([o['x'] for o in meta['glyphs'] if o['page'] == it['page'] and abs((o['y'] if 'y' in o else int(round(o['artBase'] * S + OY))) - base) < 30 and o['x'] > it['x']] + [W])
        x0, x1 = max(0, it['x'] - 16), nxt - 16
        tall = it['size'] * S if it.get('kind') == 'text' else 704 * it['scale'] * S
        y0 = max(0, int(base - tall * 1.12 - 6))
        cell = pg[y0:int(base + tall * 0.34 + 6), x0:x1]
        ys2, xs2 = np.where(cell > 8)
        if not len(xs2):
            sys.exit('no ink found for the glyph %r of the set %s' % (it['s'], it['set']))
        it['box'] = [int(x0 + xs2.min()), int(y0 + ys2.min()), int(x0 + xs2.max()) + 1, int(y0 + ys2.max()) + 1]
        it['base'] = base
        sets.setdefault(it['set'], []).append(it)
    sheet_w = 1024
    shelves, x, y, rowh = [], 0, 0, 0
    gl = {}
    placed = []
    for name, items in sets.items():
        top = min(i['box'][1] - i['base'] for i in items) - 1
        bot = max(i['box'][3] - i['base'] for i in items) + 1
        h = bot - top
        gl[name] = {'h': int(h), 'oy': int(top), 'g': {}}
        if 'scale' in items[0]:
            gl[name]['space'] = round(geo['space'] * items[0]['scale'], 3)
        for i in items:
            w = i['box'][2] - i['box'][0] + 2
            if x + w > sheet_w:
                x, y, rowh = 0, y + rowh, 0
            src = pages[i['page']][i['base'] + top:i['base'] + bot, i['box'][0] - 1:i['box'][2] + 1]
            placed.append((x, y, src))
            gl[name]['g'][i['s']] = {'x': int(x), 'y': int(y), 'w': int(w), 'ox': int(i['box'][0] - 1 - i['x']), 'adv': round(i['adv'], 3),
                                     'inkL': round(i.get('inkL', 0), 3), 'inkR': round(i.get('inkR', i['adv']), 3)}
            if i.get('fx'):
                gl[name]['g'][i['s']]['fx'] = round(i['fx'], 3)     # (drawn this far right of its pen's whole pixel)
            x += w
            rowh = max(rowh, h)
    sheet = np.zeros((y + rowh, sheet_w), np.uint8)
    for x, y, src in placed:
        sheet[y:y + src.shape[0], x:x + src.shape[1]] = src
    size['glyphs'] = put('glyphs', sheet, 'r8')

    meta_out = {
        'w': W, 'h': H, 'tile': TILE, 'atlasCols': ATLAS_COLS, 'node': NODE, 'scale': S, 'origin': [OX, OY],
        'centre': [int(cx0), int(cy0), int(cx1 - cx0), int(cy1 - cy0)], 'sides': [int(ax0), int(ay0), int(ax1 - ax0), int(ay1 - ay0)], 'window': win, 'over': over,
        'boxes': boxes,
        'hex': [[round(a, 2), round(b, 2)] for a, b in geo['hex']],
        'ticks': {k: [round(t[1], 2) for t in geo['ticks'][k]] for k in ('speed', 'rpm')},
        'speedMarks': [t[0] for t in geo['ticks']['speed']],
        'fuel': {'segs': [[[round(a, 2), round(b, 2)] for a, b in seg] for seg in geo['fuelSegs']], 'y': [round(v, 2) for v in geo['fuelY']]},
        'oil': {'segs': [[[round(a, 2), round(b, 2)] for a, b in seg] for seg in geo['oilSegs']], 'marks': [[t[0], round(t[1], 2)] for t in geo['oil']]},
        'barGrad': geo['barGrad'], 'barGradLen': round(geo['barGradLen'], 2),
        'fillGrad': geo['fillGrad'], 'capHalf': round(geo['capHalf'], 3), 'cover': [round(v, 2) for v in geo['cover']],
        'at': {k: {a: round(b, 2) for a, b in geo[k].items()} for k in ('speed', 'gear', 'mode', 'time', 'range', 'temp', 'ready')},
        'glyphs': gl, 'tex': tex, 'bytes': {k: int(v) for k, v in size.items()}, 'fit': info['fit'], 'tiles': info['tiles'],
    }
    js = ("'use strict';\n/* GENERATED by tools/bake_m340.py from tools/m340/prototype.html: the M340i layout's artwork as the cluster takes it\n"
          " * (tile maps, tile atlases, palettes, the glyph sheet, the lit channel's edges, the map's veil; zlib, base64). Do not edit. */\n"
          "const zlib = require('zlib');\n"
          'const META = ' + json.dumps(meta_out, separators=(',', ':')) + ';\n'
          'const BLOB = ' + json.dumps(blob, separators=(',', ':')) + ';\n'
          "const cache = {};\n"
          "const bytes = (n) => cache[n] || (cache[n] = zlib.inflateSync(Buffer.from(BLOB[n], 'base64')));\n"
          "/** A texture for a piece's `textures`: () => { w, h, px, format, sampling }, with the id the engine keeps it under. */\n"
          "function tex(n) {\n    const t = META.tex[n], f = () => ({ w: t.w, h: t.h, px: bytes(n), format: t.format, sampling: t.sampling });\n    f.id = 'm340.' + n;\n    return f;\n}\n"
          'module.exports = { META, tex };\n')
    open(OUT, 'w').write(js)
    print('fit to the design: mean %(mean)s levels, 99%% within %(p99)s, over 4 levels %(over4)s%%, worst %(max)s' % info['fit'])
    print('tiles: sides %(sides)d, centre %(centre)d (materials %(materials)d)' % info['tiles'])
    total = 0
    for k, v in size.items():
        print('  %-8s %6.1f KB' % (k, v / 1024.0))
        total += v
    print('  %-8s %6.1f KB to the cluster in all (the centre and the veil are never both sent); %s is %.0f KB' % ('total', total / 1024.0, os.path.basename(OUT), os.path.getsize(OUT) / 1024.0))


if __name__ == '__main__':
    if '--shots' in sys.argv or not os.path.exists(os.path.join(WORK, 'meta.json')):
        meta = asyncio.run(shots())
    else:
        meta = json.load(open(os.path.join(WORK, 'meta.json')))
    pack(meta)
