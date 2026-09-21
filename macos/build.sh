#!/bin/bash
# Builds "VFD Spectrum.app" next to the web files. Needs Xcode's command line tools and Pillow (for the icon).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=".."
APP="$ROOT/VFD Spectrum.app"
BUILD="build"

rm -rf "$BUILD" "$APP"
mkdir -p "$BUILD"

python3 make_icon.py "$BUILD/AppIcon.icns"

for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.2" Sources/*.swift -o "$BUILD/vfd-$arch"
done

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
lipo -create -output "$APP/Contents/MacOS/VFD Spectrum" "$BUILD/vfd-arm64" "$BUILD/vfd-x86_64"
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/index.html" "$ROOT/style.css" "$APP/Contents/Resources/web/"
cp -R "$ROOT/js" "$APP/Contents/Resources/web/js"

codesign --force --sign - "$APP"
codesign --verify --verbose "$APP"
rm -rf "$BUILD"
echo "built: $APP"
