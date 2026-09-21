#!/usr/bin/env python3
"""Draws the app icon (a VFD spectrum display in a dark plate) and writes an .icns.

usage: make_icon.py <out.icns>      (needs Pillow; iconutil comes with macOS)
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def gradient(size, top, bottom):
    img = Image.new("RGBA", size)
    px = img.load()
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        for x in range(size[0]):
            px[x, y] = c
    return img


def master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # the plate: macOS icon grid (824 px body in a 1024 canvas)
    body = (100, 100, 924, 924)
    mask = Image.new("L", (S, S), 0)
    rounded(ImageDraw.Draw(mask), body, 185, 255)
    plate = gradient((S, S), (46, 47, 51), (13, 13, 15))
    hi = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hi).rounded_rectangle((104, 104, 920, 420), radius=180, fill=(255, 255, 255, 26))
    hi = hi.filter(ImageFilter.GaussianBlur(34))
    plate = Image.alpha_composite(plate, hi)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((100, 118, 924, 940), radius=185, fill=(0, 0, 0, 150))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(18)))
    img.paste(plate, (0, 0), mask)

    # display bezel and glass
    d = ImageDraw.Draw(img)
    rounded(d, (170, 250, 854, 690), 46, (120, 124, 132, 255))
    rounded(d, (178, 258, 846, 682), 40, (6, 8, 8, 255))
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(inner).rounded_rectangle((178, 258, 846, 682), radius=40, fill=(4, 22, 18, 255))
    img = Image.alpha_composite(img, inner)

    # spectrum: 9 bars of 12 segments; unlit ghosts, lit cyan, amber/red on the top rows
    levels = [5, 8, 10, 7, 12, 9, 6, 8, 4]
    rows = 12
    x0, x1 = 214, 810
    top, bottom = 296, 646
    pitch_x = (x1 - x0) / len(levels)
    bar_w = pitch_x * 0.72
    pitch_y = (bottom - top) / rows
    seg_h = pitch_y * 0.7
    ghost = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    lit = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd, ld = ImageDraw.Draw(ghost), ImageDraw.Draw(lit)
    for i, level in enumerate(levels):
        bx = x0 + i * pitch_x + (pitch_x - bar_w) / 2
        for r in range(rows):
            y1 = bottom - r * pitch_y
            box = (bx, y1 - seg_h, bx + bar_w, y1)
            gd.rounded_rectangle(box, radius=4, fill=(150, 210, 185, 22))
            if r < level:
                if r >= rows - 2:
                    col = (255, 96, 48, 255)
                elif r >= rows - 4:
                    col = (255, 178, 20, 255)
                else:
                    col = (0, 240, 190, 255)
                ld.rounded_rectangle(box, radius=4, fill=col)
    glow = lit.filter(ImageFilter.GaussianBlur(22))
    glow2 = lit.filter(ImageFilter.GaussianBlur(7))
    img = Image.alpha_composite(img, ghost)
    for g, k in ((glow, 0.9), (glow2, 0.55)):
        a = g.split()[3].point(lambda v: int(v * k))
        g = Image.merge("RGBA", (*g.split()[:3], a))
        img = Image.alpha_composite(img, g)
    img = Image.alpha_composite(img, lit)

    # glass reflection
    refl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(refl).polygon([(178, 258), (560, 258), (420, 682), (178, 682)], fill=(255, 255, 255, 14))
    refl.putalpha(ImageChops.multiply(refl.split()[3], Image.new("L", (S, S), 255)))
    clip = Image.new("L", (S, S), 0)
    rounded(ImageDraw.Draw(clip), (178, 258, 846, 682), 40, 255)
    refl.putalpha(ImageChops.multiply(refl.split()[3], clip))
    img = Image.alpha_composite(img, refl)

    # two knobs and a row of keys below the display
    d = ImageDraw.Draw(img)
    for cx in (262, 762):
        d.ellipse((cx - 44, 722 - 44 + 40, cx + 44, 722 + 44 + 40), fill=(70, 72, 78, 255), outline=(20, 20, 22, 255), width=5)
        d.ellipse((cx - 30, 722 - 30 + 40, cx + 30, 722 + 30 + 40), fill=(150, 154, 162, 255))
        d.line((cx, 762 - 20, cx, 762 - 4), fill=(255, 168, 60, 255), width=6)
    for k in range(5):
        kx = 372 + k * 62
        rounded(d, (kx, 742, kx + 48, 788), 8, (44, 45, 49, 255))
        d.line((kx + 12, 754, kx + 36, 754), fill=(255, 168, 60, 255), width=5)
    return img


def main():
    out = sys.argv[1]
    m = master()
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "AppIcon.iconset")
        os.makedirs(iconset)
        for size in (16, 32, 128, 256, 512):
            m.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
            m.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}@2x.png"))
        m.save(os.path.join(os.path.dirname(out) or ".", "AppIcon-1024.png"))
        subprocess.check_call(["iconutil", "-c", "icns", iconset, "-o", out])


if __name__ == "__main__":
    main()
