#!/usr/bin/env bash
# make-promo-tile.sh — Chrome Web Store "small promo tile" (440x280).
# Layout: icon + "loroco" wordmark grouped in the upper area, tagline on a
# SINGLE line pinned near the bottom. Warm radial gradient background to match
# the store screenshots. Output: 24-bit PNG, no alpha.
set -euo pipefail

ROOT="/Users/marvin/Projects/Ozone/loroco"
DIR="$ROOT/chrome-store-screenshots"
ICON="$ROOT/packages/extension/.output/chrome-mv3/icon/128.png"
OUT="$DIR/promo-tile-440x280.png"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

FONT_B="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_R="/System/Library/Fonts/Supplemental/Arial.ttf"
ORANGE="#E65F28"
INK="#5A4636"

# background: warm radial gradient
magick -size 440x440 radial-gradient:"#FFF6EE"-"#F7C49C" \
  -gravity center -extent 440x280 "$TMP/bg.png"

# icon with soft shadow
magick "$ICON" -resize 96x96 "$TMP/icon.png"
magick "$TMP/icon.png" \( +clone -background black -shadow 38x6+0+4 \) \
  +swap -background none -layers merge +repage "$TMP/icon_s.png"

# wordmark
magick -background none -fill "$ORANGE" -font "$FONT_B" -pointsize 64 \
  label:"loroco" "$TMP/word.png"

# tagline — single line, auto-shrunk to fit width so it never overflows
magick -background none -fill "$INK" -font "$FONT_R" \
  -size 400x40 -gravity center caption:"Your Chia wallet, right in your browser." \
  "$TMP/tag.png"

# widths to center the icon+wordmark unit as a group
IW=$(magick "$TMP/icon_s.png" -format %w info:)
IH=$(magick "$TMP/icon_s.png" -format %h info:)
WW=$(magick "$TMP/word.png"   -format %w info:)
WH=$(magick "$TMP/word.png"   -format %h info:)
GAP=18
GROUP_W=$(( IW + GAP + WW ))
GX=$(( (440 - GROUP_W) / 2 ))      # left edge of the group
WX=$(( GX + IW + GAP ))            # wordmark x
IY=58                              # icon top
WY=$(( IY + (IH - WH) / 2 ))       # wordmark top → vertically centered on icon

# assemble: icon + wordmark grouped in the upper area, tagline pinned bottom.
# Composite icon and wordmark separately (no +smush → no black box).
magick "$TMP/bg.png" \
  "$TMP/icon_s.png" -gravity NorthWest -geometry "+${GX}+${IY}"  -composite \
  "$TMP/word.png"   -gravity NorthWest -geometry "+${WX}+${WY}"  -composite \
  "$TMP/tag.png"    -gravity South     -geometry "+0+34"         -composite \
  -background white -alpha remove -alpha off -depth 8 -strip \
  "$OUT"
echo "wrote $OUT"
