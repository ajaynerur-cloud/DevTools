#!/usr/bin/env python3
"""Generate every DevHub icon from one design.

Outputs
  icons/            favicon.ico, icon.svg, icon-192/512.png, icon-maskable-192/512.png,
                    apple-touch-icon.png, icon-1024.png
  favicon.ico       copy at the site root (browsers request /favicon.ico automatically)
  android-res/      launcher icons (all densities, adaptive + legacy + round) and splash screens

Usage:  pip install fonttools cairosvg   then   python3 scripts/make-icons.py
Change BLUE / YELLOW / WHITE below to restyle everything at once.
"""
import io, os, shutil
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import cairosvg
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLUE, YELLOW, WHITE = '#3346D3', '#F2C94C', '#FFFFFF'
MONO = next(p for p in ['/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'] if os.path.exists(p))
SANS = next(p for p in ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'] if os.path.exists(p))

def glyphs(font_path, text):
    """Outline paths for `text` laid out on one line, in font units (y up)."""
    f = TTFont(font_path); gs = f.getGlyphSet(); cmap = f.getBestCmap()
    x, parts, bounds = 0, [], [1e9, 1e9, -1e9, -1e9]
    for ch in text:
        g = gs[cmap[ord(ch)]]
        if not ch.isspace():
            pen = SVGPathPen(gs); g.draw(pen); bp = BoundsPen(gs); g.draw(bp)
            if bp.bounds:
                b = bp.bounds; parts.append((x, pen.getCommands()))
                bounds = [min(bounds[0], x + b[0]), min(bounds[1], b[1]), max(bounds[2], x + b[2]), max(bounds[3], b[3])]
        x += g.width
    return parts, bounds

BRACES = glyphs(MONO, '{ }')
WORD = glyphs(SANS, 'DevHub')

def text_group(g, cx, top, width, fill):
    """Place glyph outlines so their box is `width` wide, centred on cx, starting at y=top."""
    parts, (x0, y0, x1, y1) = g
    s = width / (x1 - x0); h = (y1 - y0) * s
    tx = cx - width / 2 - x0 * s; ty = top + y1 * s
    paths = ''.join(f'<path transform="translate({px},0)" d="{d}"/>' for px, d in parts)
    return f'<g fill="{fill}" transform="translate({tx:.2f},{ty:.2f}) scale({s:.5f},{-s:.5f})">{paths}</g>', h

def mark(cx, cy, width):
    """The DevHub mark: white { } with a yellow bar underneath, centred on (cx, cy)."""
    _, (x0, y0, x1, y1) = BRACES
    bh = (y1 - y0) * width / (x1 - x0)
    gap, bar_h, bar_w = width * 0.10, width * 0.085, width * 0.62
    total = bh + gap + bar_h
    top = cy - total / 2
    braces, _ = text_group(BRACES, cx, top, width, WHITE)
    by = top + bh + gap
    bar = f'<rect x="{cx - bar_w / 2:.2f}" y="{by:.2f}" width="{bar_w:.2f}" height="{bar_h:.2f}" rx="{bar_h / 2:.2f}" fill="{YELLOW}"/>'
    return braces + bar

def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>'

# Icon variants on a 1024 canvas
def icon_rounded():  # regular app icon, transparent corners
    return svg(1024, 1024, f'<rect width="1024" height="1024" rx="228" fill="{BLUE}"/>' + mark(512, 512, 640))
def icon_full(mark_w=600):  # full-bleed square (maskable / iOS / store); mark kept in the safe zone
    return svg(1024, 1024, f'<rect width="1024" height="1024" fill="{BLUE}"/>' + mark(512, 512, mark_w))
def icon_round():
    return svg(1024, 1024, f'<circle cx="512" cy="512" r="512" fill="{BLUE}"/>' + mark(512, 512, 600))
def adaptive_fg():  # 108dp canvas; launchers show the middle 72dp, the safe zone is 66dp
    return svg(1024, 1024, mark(512, 512, 470))
def tiny():  # favicon at 16–48 px: bigger mark so it stays legible
    return svg(1024, 1024, f'<rect width="1024" height="1024" rx="200" fill="{BLUE}"/>' + mark(512, 512, 800))
def splash(w, h):
    s = min(w, h); mw = s * 0.34
    m = mark(w / 2, h / 2 - s * 0.06, mw)
    word, wh = text_group(WORD, w / 2, h / 2 + s * 0.14, s * 0.30, WHITE)
    return svg(w, h, f'<rect width="{w}" height="{h}" fill="{BLUE}"/>' + m + word)

def png(svg_text, size, path=None):
    w, h = size if isinstance(size, tuple) else (size, size)
    data = cairosvg.svg2png(bytestring=svg_text.encode(), output_width=w, output_height=h)
    if path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'wb').write(data)
    return Image.open(io.BytesIO(data))

def main():
    icons = os.path.join(ROOT, 'icons'); os.makedirs(icons, exist_ok=True)
    # ---- web ----
    open(os.path.join(icons, 'icon.svg'), 'w').write(icon_rounded())
    for s in (192, 512): png(icon_rounded(), s, f'{icons}/icon-{s}.png')
    for s in (192, 512): png(icon_full(560), s, f'{icons}/icon-maskable-{s}.png')
    png(icon_full(620), 180, f'{icons}/apple-touch-icon.png')
    png(icon_full(620), 1024, f'{icons}/icon-1024.png')
    sizes = [16, 32, 48]
    frames = [png(tiny(), s).convert('RGBA') for s in sizes]
    frames[-1].save(f'{icons}/favicon.ico', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    png(tiny(), 32, f'{icons}/favicon-32.png')
    shutil.copy(f'{icons}/favicon.ico', os.path.join(ROOT, 'favicon.ico'))
    # ---- android launcher icons ----
    res = os.path.join(ROOT, 'android-res')
    dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for d, k in dens.items():
        png(adaptive_fg(), int(108 * k), f'{res}/mipmap-{d}/ic_launcher_foreground.png')
        png(icon_rounded(), int(48 * k), f'{res}/mipmap-{d}/ic_launcher.png')
        png(icon_round(), int(48 * k), f'{res}/mipmap-{d}/ic_launcher_round.png')
    os.makedirs(f'{res}/mipmap-anydpi-v26', exist_ok=True)
    adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <background android:drawable="@color/ic_launcher_background"/>\n'
                '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n')
    for n in ('ic_launcher', 'ic_launcher_round'): open(f'{res}/mipmap-anydpi-v26/{n}.xml', 'w').write(adaptive)
    os.makedirs(f'{res}/values', exist_ok=True)
    open(f'{res}/values/ic_launcher_background.xml', 'w').write(f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{BLUE}</color>\n</resources>\n')
    # ---- android splash screens (same sizes as Capacitor's template) ----
    port = {'mdpi': (320, 480), 'hdpi': (480, 800), 'xhdpi': (720, 1280), 'xxhdpi': (960, 1600), 'xxxhdpi': (1280, 1920)}
    for d, (w, h) in port.items():
        png(splash(w, h), (w, h), f'{res}/drawable-port-{d}/splash.png')
        png(splash(h, w), (h, w), f'{res}/drawable-land-{d}/splash.png')
    png(splash(480, 320), (480, 320), f'{res}/drawable/splash.png')
    print('Icons written to icons/, favicon.ico and android-res/')

if __name__ == '__main__':
    main()
