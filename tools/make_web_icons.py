#!/usr/bin/env python3
"""Writes the web app icons (PNG) from the same drawing as the Mac app icon.

usage: tools/make_web_icons.py <out-dir>      (needs Pillow)

  icon-192.png / icon-512.png      "any" icons (the rounded plate on a transparent ground)
  icon-maskable-512.png            full-bleed for Android's adaptive masks (art kept inside the safe circle)
  apple-touch-icon.png (180)       opaque and square: iOS rounds the corners itself
"""
import importlib.util
import os
import sys

from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("make_icon", os.path.join(here, "..", "macos", "make_icon.py"))
mi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mi)

out = sys.argv[1] if len(sys.argv) > 1 else "icons"
os.makedirs(out, exist_ok=True)

art = mi.master()                       # 1024 canvas, plate in the middle (macOS icon grid)
plate = art.crop((100, 100, 924, 924))  # the plate itself, 824 px
ground = (13, 13, 15, 255)              # the dark of the plate's lower edge


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(out, name))


# "any": the plate with its rounded corners, a little breathing room
any_icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
any_icon.paste(art.crop((60, 60, 964, 964)).resize((1024, 1024), Image.LANCZOS), (0, 0))
save(any_icon, "icon-512.png", 512)
save(any_icon, "icon-192.png", 192)

# full-bleed on the plate colour, art at ~72% so a circular mask keeps all of it
bleed = Image.new("RGBA", (1024, 1024), ground)
inner = plate.resize((738, 738), Image.LANCZOS)
bleed.alpha_composite(inner, (143, 143))
save(bleed, "icon-maskable-512.png", 512)

# apple-touch-icon: opaque
touch = Image.new("RGBA", (1024, 1024), ground)
touch.alpha_composite(plate.resize((1024, 1024), Image.LANCZOS), (0, 0))
save(touch.convert("RGB"), "apple-touch-icon.png", 180)
print("icons written to", out)
