#!/usr/bin/env python3
"""Generate every Toolbox+ icon from one design: a white toolbox with a yellow "+" badge on blue.

Outputs
  icons/            favicon.ico, app.ico (Windows exe), icon.svg, icon-192/512.png, icon-maskable-192/512.png,
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

WORD = glyphs(SANS, 'Toolbox+')

def text_group(g, cx, top, width, fill):
    """Place glyph outlines so their box is `width` wide, centred on cx, starting at y=top."""
    parts, (x0, y0, x1, y1) = g
    s = width / (x1 - x0); h = (y1 - y0) * s
    tx = cx - width / 2 - x0 * s; ty = top + y1 * s
    paths = ''.join(f'<path transform="translate({px},0)" d="{d}"/>' for px, d in parts)
    return f'<g fill="{fill}" transform="translate({tx:.2f},{ty:.2f}) scale({s:.5f},{-s:.5f})">{paths}</g>', h

# The mark on a 100×100 grid (also used inline in index.html / app.js as the brand mark, and as the Android status icon)
def mark_body(blue=BLUE, white=WHITE, yellow=YELLOW):
    return (f'<g transform="translate(-4.5,5.5)">'
            f'<path d="M36 31V24a5 5 0 0 1 5-5h18a5 5 0 0 1 5 5v7" fill="none" stroke="{white}" stroke-width="7" stroke-linecap="round"/>'
            f'<rect x="14" y="30" width="72" height="50" rx="8" fill="{white}"/>'
            f'<rect x="14" y="48" width="72" height="5" fill="{blue}"/>'
            f'<rect x="43" y="44" width="14" height="13" rx="3" fill="{yellow}"/>'
            f'<circle cx="80" cy="24" r="17" fill="{blue}"/><circle cx="80" cy="24" r="14" fill="{yellow}"/>'
            f'<rect x="73" y="21.5" width="14" height="5" rx="1.5" fill="{blue}"/><rect x="77.5" y="17" width="5" height="14" rx="1.5" fill="{blue}"/>'
            f'</g>')

def mark(cx, cy, width):
    """The Toolbox+ mark, `width` wide, centred on (cx, cy)."""
    s = width / 100
    return f'<g transform="translate({cx - 50 * s:.2f},{cy - 50 * s:.2f}) scale({s:.5f})">{mark_body()}</g>'

def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>'

# Icon variants on a 1024 canvas
def icon_rounded():  # regular app icon, transparent corners
    return svg(1024, 1024, f'<rect width="1024" height="1024" rx="228" fill="{BLUE}"/>' + mark(512, 512, 700))
def icon_full(mark_w=600):  # full-bleed square (maskable / iOS / store); mark kept in the safe zone
    return svg(1024, 1024, f'<rect width="1024" height="1024" fill="{BLUE}"/>' + mark(512, 512, mark_w))
def icon_round():
    return svg(1024, 1024, f'<circle cx="512" cy="512" r="512" fill="{BLUE}"/>' + mark(512, 512, 600))
def adaptive_fg():  # 108dp canvas; launchers show the middle 72dp, the safe zone is 66dp
    return svg(1024, 1024, mark(512, 512, 560))
def tiny():  # favicon at 16–48 px: bigger mark so it stays legible
    return svg(1024, 1024, f'<rect width="1024" height="1024" rx="200" fill="{BLUE}"/>' + mark(512, 512, 900))
def splash(w, h):
    s = min(w, h); mw = s * 0.36
    m = mark(w / 2, h / 2 - s * 0.08, mw)
    word, wh = text_group(WORD, w / 2, h / 2 + s * 0.15, s * 0.36, WHITE)
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
    # Windows exe icon (portable build): 16–256 px
    big = [16, 24, 32, 48, 64, 128, 256]
    fr = [png(tiny() if z <= 48 else icon_rounded(), z).convert('RGBA') for z in big]
    fr[-1].save(f'{icons}/app.ico', sizes=[(z, z) for z in big], append_images=fr[:-1])
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
    # ---- android status-bar icon (white silhouette; Android tints it) ----
    os.makedirs(f'{res}/drawable', exist_ok=True)
    open(f'{res}/drawable/ic_stat_reminder.xml', 'w').write('''<?xml version="1.0" encoding="utf-8"?>
<!-- Status-bar icon for Toolbox+ reminders: toolbox with a "+" (white silhouette; Android tints it). Made by scripts/make-icons.py -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="100" android:viewportHeight="100">
    <path android:strokeColor="#FFFFFFFF" android:strokeWidth="7" android:strokeLineCap="round" android:pathData="M31.5,36.5V29.5a5,5 0 0,1 5,-5h18a5,5 0 0,1 5,5v7"/>
    <path android:fillColor="#FFFFFFFF" android:pathData="M17.5,35.5h55v18h-55z M9.5,43.5a8,8 0 0,1 8,-8v18h-8z M72.5,35.5a8,8 0 0,1 8,8v10h-8z M9.5,58.5h71v19a8,8 0 0,1 -8,8h-55a8,8 0 0,1 -8,-8z"/>
    <path android:fillColor="#FFFFFFFF" android:pathData="M80,6h5v9h9v5h-9v9h-5v-9h-9v-5h9z"/>
</vector>
''')
    print('Icons written to icons/, favicon.ico and android-res/')

if __name__ == '__main__':
    main()
