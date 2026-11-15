#!/usr/bin/env python3
"""
bake_canvas_font.py - a glyph atlas for the head unit's canvas (kit/runtime/fonts/<family>.json, as kit/runtime/
fonts.js reads them), from a font file: the M340i layout's song and directions, drawn on the head unit, in the
face of its figures (Titillium Web, SIL Open Font License, tools/m340/fonts/OFL.txt).

    python3 tools/bake_canvas_font.py [Pirulen.ttf]   (tw: Titillium Web Regular, twb: Bold; pir: Pirulen Bold, the
                                                     figures' face, from the owner's file, not kept here)

Each size: the glyphs packed in rows on one atlas (one byte a pixel, zlib, base64); a glyph is
[x, y, w, h, left, top (from the baseline, up negative), advance], as the kit's own families.
"""
import base64, json, os, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'kit', 'runtime', 'fonts')
FAMILIES = {'tw': 'TitilliumWeb-Regular.ttf', 'twb': 'TitilliumWeb-Bold.ttf'}
SIZES = [24, 32, 44, 60]
CHARS = [chr(c) for c in range(32, 127)] + [chr(c) for c in range(160, 256)] + list('‘’“”–—•…·')
ATLAS_W = 1024


def bake(path, size):
    font = ImageFont.truetype(path, size)
    asc, desc = font.getmetrics()
    cells = []
    for ch in CHARS:
        try:
            if not font.getmask(ch).size and ch != ' ':
                continue
        except Exception:
            continue
        l, t, r, b = font.getbbox(ch, anchor='ls')
        adv = font.getlength(ch)
        w, h = max(0, r - l), max(0, b - t)
        img = None
        if w and h:
            img = Image.new('L', (w + 2, h + 2), 0)
            ImageDraw.Draw(img).text((1 - l, 1 - t), ch, font=font, fill=255, anchor='ls')
        cells.append((ch, img, l - 1, t - 1, adv))
    x = y = rowh = 0
    place = []
    for ch, img, ox, oy, adv in cells:
        if img is not None:
            if x + img.width > ATLAS_W:
                x, y, rowh = 0, y + rowh + 1, 0
            place.append((ch, x, y, img, ox, oy, adv))
            x += img.width + 1
            rowh = max(rowh, img.height)
        else:
            place.append((ch, 0, 0, None, 0, 0, adv))
    H = y + rowh + 1
    atlas = Image.new('L', (ATLAS_W, H), 0)
    glyphs = {}
    for ch, gx, gy, img, ox, oy, adv in place:
        if img is not None:
            atlas.paste(img, (gx, gy))
            glyphs[str(ord(ch))] = [gx, gy, img.width, img.height, ox, oy, round(adv, 2)]
        else:
            glyphs[str(ord(ch))] = [0, 0, 0, 0, 0, 0, round(adv, 2)]
    return {'size': size, 'ascent': asc, 'descent': desc, 'atlasW': ATLAS_W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}


import sys
if len(sys.argv) > 1:
    FAMILIES = {'pir': sys.argv[1]}
for fam, fn in FAMILIES.items():
    path = fn if os.path.isabs(fn) else os.path.join(HERE, 'm340', 'fonts', fn)
    j = {'family': fam, 'source': os.path.basename(fn) + ('' if fam == 'pir' else ' (SIL Open Font License 1.1)'), 'sizes': [bake(path, s) for s in SIZES]}
    out = os.path.join(OUT, fam + '.json')
    json.dump(j, open(out, 'w'), separators=(',', ':'))
    print(fam, os.path.getsize(out))
