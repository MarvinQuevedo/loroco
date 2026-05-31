#!/usr/bin/env bash
# make-marquee.sh — Chrome Web Store "marquee promo tile" (1400x560).
# Layout: branding column on the left (icon + "loroco" wordmark + tagline +
# feature bullets), the wallet popup card floating on the right with a soft
# drop shadow. Warm radial gradient background to match the store screenshots
# and the 440x280 small tile. Output: 24-bit PNG, no alpha (store requirement).
#
# Card source (first match wins):
#   chrome-store-screenshots/raw/home.png        <- drop a synced Home capture here
#   chrome-store-screenshots/raw/marquee-card.png
#   else: crop the popup out of the composed 01-home shot.
set -euo pipefail

ROOT="/Users/marvin/Projects/Ozone/loroco"
DIR="$ROOT/chrome-store-screenshots"
ICON="$ROOT/packages/extension/.output/chrome-mv3/icon/512.png"
SHOT="$DIR/01-home-1280x800.png"
OUT="$DIR/marquee-1400x560.png"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

FONT_B="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_R="/System/Library/Fonts/Supplemental/Arial.ttf"
ORANGE="#E65F28"
INK="#5A4636"

# ── pick the card source ────────────────────────────────────────────────────
CARD_SRC=""
for c in "$DIR/raw/home.png" "$DIR/raw/marquee-card.png"; do
  [ -f "$c" ] && { CARD_SRC="$c"; break; }
done
if [ -n "$CARD_SRC" ]; then
  echo "card source: $CARD_SRC"
  cp "$CARD_SRC" "$TMP/card_raw.png"
else
  echo "card source: cropped from $SHOT (no raw/home.png found)"
  magick "$SHOT" -crop 400x600+440+100 +repage "$TMP/card_raw.png"
fi

# ── background: warm radial gradient (square then extent to 1400x560) ────────
magick -size 1400x1400 radial-gradient:"#FFF6EE"-"#F7C49C" \
  -gravity center -extent 1400x560 "$TMP/bg.png"

# ── right: scale card to height 500, round corners, drop shadow ─────────────
CH=500
magick "$TMP/card_raw.png" -resize x${CH} "$TMP/card_s.png"
CW=$(magick "$TMP/card_s.png" -format %w info:)
R=26
magick "$TMP/card_s.png" -alpha set \( +clone -alpha extract \
    -draw "fill black polygon 0,0 0,$R $R,0 fill white circle $R,$R $R,0" \
    \( +clone -flip \) -compose Multiply -composite \
    \( +clone -flop \) -compose Multiply -composite \) \
  -alpha off -compose CopyOpacity -composite "$TMP/card_r.png"

magick "$TMP/card_r.png" \( +clone -background black -shadow 60x22+0+16 \) \
  +swap -background none -layers merge +repage "$TMP/card_final.png"

# ── left: icon + wordmark + tagline + bullets ───────────────────────────────
magick "$ICON" -resize 132x132 "$TMP/icon.png"
magick "$TMP/icon.png" \( +clone -background black -shadow 40x7+0+5 \) \
  +swap -background none -layers merge +repage "$TMP/icon_s.png"

magick -background none -fill "$ORANGE" -font "$FONT_B" -pointsize 104 \
  label:"loroco" "$TMP/word.png"

# soft white halo behind a transparent layer so text reads on the gradient
# without a solid box. $1 = transparent src (modified in place), $2 = out.
glow() {
  magick "$1" \( +clone -background white -shadow 100x4+0+0 \) \
    \( +clone \) -background none -layers merge +repage \
    "$1" -gravity center -composite "$2"
}

magick -background none -fill "$INK" -font "$FONT_R" \
  -pointsize 38 -size 560x -gravity West \
  caption:"Your Chia wallet, right in your browser." \
  "$TMP/tag0.png"
glow "$TMP/tag0.png" "$TMP/tag.png"

bullet() {  # $1 = text, $2 = output
  magick -background none -fill "$INK" -font "$FONT_R" -pointsize 30 \
    label:"$1" "$TMP/btxt.png"
  magick -size 16x16 xc:none -fill "$ORANGE" -draw "circle 8,8 8,2" "$TMP/dot.png"
  magick "$TMP/dot.png" "$TMP/btxt.png" -background none +smush 18 \
    -gravity West "$TMP/brow.png"
  glow "$TMP/brow.png" "$2"
}
bullet "Send & receive XCH and CATs"     "$TMP/b1.png"
bullet "Connect to Chia dApps securely"  "$TMP/b2.png"
bullet "You approve every transaction"   "$TMP/b3.png"

# ── assemble ────────────────────────────────────────────────────────────────
CARD_X=70
LX=96
magick "$TMP/bg.png" \
  "$TMP/card_final.png" -gravity East      -geometry "+${CARD_X}+8"   -composite \
  "$TMP/icon_s.png"     -gravity NorthWest -geometry "+${LX}+86"      -composite \
  "$TMP/word.png"       -gravity NorthWest -geometry "+250+104"       -composite \
  "$TMP/tag.png"        -gravity NorthWest -geometry "+$((LX+4))+246" -composite \
  "$TMP/b1.png"         -gravity NorthWest -geometry "+$((LX+6))+382" -composite \
  "$TMP/b2.png"         -gravity NorthWest -geometry "+$((LX+6))+434" -composite \
  "$TMP/b3.png"         -gravity NorthWest -geometry "+$((LX+6))+486" -composite \
  -background white -alpha remove -alpha off -depth 8 -strip \
  "$OUT"
echo "wrote $OUT  ($(magick identify -format '%wx%h %[channels] %z-bit' "$OUT"))"
