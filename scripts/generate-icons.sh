#!/bin/bash
# Generate all required Tauri icon formats from a single 1024x1024 source PNG.
# Requires: sips and iconutil (bundled with macOS).
#
# Usage: ./scripts/generate-icons.sh path/to/icon-1024.png

set -e

SRC="${1:-docs/assets/icon-1024.png}"
ICONS_DIR="client/src-tauri/icons"

if [ ! -f "$SRC" ]; then
  echo "Source icon not found: $SRC"
  echo "Provide a 1024x1024 PNG as the first argument."
  exit 1
fi

mkdir -p "$ICONS_DIR"

echo "Generating PNG icons..."
sips -z 32 32     "$SRC" --out "$ICONS_DIR/32x32.png"    > /dev/null
sips -z 128 128   "$SRC" --out "$ICONS_DIR/128x128.png"  > /dev/null
sips -z 256 256   "$SRC" --out "$ICONS_DIR/128x128@2x.png" > /dev/null
cp "$SRC" "$ICONS_DIR/icon.png"

# tray icon: small monochrome-style template (22pt = 44px @2x)
sips -z 44 44     "$SRC" --out "$ICONS_DIR/tray-icon.png" > /dev/null

echo "Generating icon.icns..."
ICONSET=$(mktemp -d)
sips -z 16 16   "$SRC" --out "$ICONSET/icon_16x16.png"    > /dev/null
sips -z 32 32   "$SRC" --out "$ICONSET/icon_16x16@2x.png" > /dev/null
sips -z 32 32   "$SRC" --out "$ICONSET/icon_32x32.png"    > /dev/null
sips -z 64 64   "$SRC" --out "$ICONSET/icon_32x32@2x.png" > /dev/null
sips -z 128 128 "$SRC" --out "$ICONSET/icon_128x128.png"  > /dev/null
sips -z 256 256 "$SRC" --out "$ICONSET/icon_128x128@2x.png" > /dev/null
sips -z 256 256 "$SRC" --out "$ICONSET/icon_256x256.png"  > /dev/null
sips -z 512 512 "$SRC" --out "$ICONSET/icon_256x256@2x.png" > /dev/null
sips -z 512 512 "$SRC" --out "$ICONSET/icon_512x512.png"  > /dev/null
cp "$SRC"                     "$ICONSET/icon_512x512@2x.png"
mv "$ICONSET" "${ICONSET}.iconset"
iconutil -c icns "${ICONSET}.iconset" -o "$ICONS_DIR/icon.icns"
rm -rf "${ICONSET}.iconset"

echo "Generating icon.ico..."
# Requires ImageMagick's convert for ICO.
if command -v convert &>/dev/null; then
  convert "$SRC" -resize 256x256 "$ICONS_DIR/icon.ico"
else
  echo "  (skipped — ImageMagick not found; copy a .ico manually if needed)"
fi

echo "Icons written to $ICONS_DIR"
