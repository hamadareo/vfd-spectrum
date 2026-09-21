#!/usr/bin/env python3
"""Builds dist/: the files of the hosted (browser / iPad) copy of the app.

usage: tools/build_web.py            (run from anywhere; needs Pillow only if the icons are missing)

dist/ holds index.html, style.css, js/, the manifest, icons, robots.txt, _headers and a generated sw.js whose version is a
hash of every file, so a changed file always produces a new cache. Point the static host at dist/ (no build step there).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
dist = os.path.join(root, "dist")
assets = os.path.join(root, "web-assets")

if not os.path.isdir(os.path.join(assets, "icons")):
    subprocess.check_call([sys.executable, os.path.join(root, "tools", "make_web_icons.py"), os.path.join(assets, "icons")])

if os.path.isdir(dist):
    shutil.rmtree(dist)
os.makedirs(os.path.join(dist, "js"))
os.makedirs(os.path.join(dist, "icons"))

copies = [("index.html", "index.html"), ("style.css", "style.css")]
copies += [(os.path.join("js", f), os.path.join("js", f)) for f in sorted(os.listdir(os.path.join(root, "js"))) if f.endswith(".js")]
for src, dst in copies:
    shutil.copy(os.path.join(root, src), os.path.join(dist, dst))
for f in ("manifest.webmanifest", "robots.txt", "_headers"):
    shutil.copy(os.path.join(assets, f), os.path.join(dist, f))
for f in sorted(os.listdir(os.path.join(assets, "icons"))):
    shutil.copy(os.path.join(assets, "icons", f), os.path.join(dist, "icons", f))
open(os.path.join(dist, ".nojekyll"), "w").close()

# what the service worker keeps: everything the page needs (not the headers / robots / the worker itself)
files = ["./"] + sorted(
    os.path.relpath(os.path.join(d, f), dist).replace(os.sep, "/")
    for d, _, fs in os.walk(dist) for f in fs
    if f not in ("_headers", "robots.txt", ".nojekyll")
)
h = hashlib.sha1()
for f in files:
    if f != "./":
        h.update(f.encode())
        h.update(open(os.path.join(dist, f), "rb").read())
version = h.hexdigest()[:10]
tpl = open(os.path.join(assets, "sw.template.js"), encoding="utf-8").read()
open(os.path.join(dist, "sw.js"), "w", encoding="utf-8").write(tpl.replace("__VERSION__", version).replace("__FILES__", json.dumps(files, indent=2)))
print("dist/ built, version", version, "-", len(files), "files cached")
