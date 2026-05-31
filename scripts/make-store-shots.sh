#!/usr/bin/env bash
# make-store-shots.sh — Chrome Web Store screenshots (1280x800, 24-bit PNG, no
# alpha). Same visual language as the marquee: warm radial gradient, branding
# (icon + "loroco" wordmark) top-left, a headline + subtext mid-left, and the
# dark wallet popup floating on the right with rounded corners + drop shadow.
#
# Source cards: chrome-store-screenshots/raw/s-*.png (portrait dark-theme popup
# captures of a synced, populated wallet). Five slides, one per core screen.
set -euo pipefail

ROOT="/Users/marvin/Projects/Ozone/loroco"
DIR="$ROOT/chrome-store-screenshots"
RAW="$DIR/raw"
ICON="$ROOT/packages/extension/.output/chrome-mv3/icon/512.png"
[ -f "$ICON" ] || ICON="$ROOT/docs/assets/icon-512.png"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

FONT_B="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_R="/System/Library/Fonts/Supplemental/Arial.ttf"
ORANGE="#E65F28"
INK="#5A4636"

CARD_H=724          # popup card height on the 1280x800 canvas
R=26                # corner radius
CARD_MARGIN=92      # gap from the right edge to the card
TEXT_X=92           # left margin for branding + headline
TEXT_W=560          # wrap width for headline/subtext

# soft white halo behind transparent text so it reads on the gradient
glow() {  # $1 = transparent src (read), $2 = out
  magick "$1" \( +clone -background white -shadow 120x5+0+0 \) \
    \( +clone \) -background none -layers merge +repage \
    "$1" -gravity center -composite "$2"
}

# ── shared pieces: branded background + the wordmark header ───────────────────
magick -size 1400x1400 radial-gradient:"#FFF6EE"-"#F7C49C" \
  -gravity center -extent 1280x800 "$TMP/bg.png"

magick "$ICON" -resize 72x72 "$TMP/icon.png"
magick "$TMP/icon.png" \( +clone -background black -shadow 38x6+0+4 \) \
  +swap -background none -layers merge +repage "$TMP/icon_s.png"
magick -background none -fill "$ORANGE" -font "$FONT_B" -pointsize 60 \
  label:"loroco" "$TMP/word0.png"
glow "$TMP/word0.png" "$TMP/word.png"

# args: raw_card  "headline"  "subtext"  out_name
slide () {
  local card="$1" head="$2" sub="$3" out="$DIR/$4"

  # right: scale card, round corners (flip/flop polygon mask), drop shadow
  magick "$RAW/$card" -resize x${CARD_H} "$TMP/c0.png"
  magick "$TMP/c0.png" -alpha set \( +clone -alpha extract \
      -draw "fill black polygon 0,0 0,$R $R,0 fill white circle $R,$R $R,0" \
      \( +clone -flip \) -compose Multiply -composite \
      \( +clone -flop \) -compose Multiply -composite \) \
    -alpha off -compose CopyOpacity -composite "$TMP/c_r.png"
  magick "$TMP/c_r.png" \( +clone -background black -shadow 62x24+0+18 \) \
    +swap -background none -layers merge +repage "$TMP/c_final.png"

  # left: headline + subtext stacked, left-aligned, then haloed as one block
  magick -background none -fill "$ORANGE" -font "$FONT_B" -pointsize 58 \
    -size ${TEXT_W}x -gravity West caption:"$head" "$TMP/head.png"
  magick -background none -fill "$INK" -font "$FONT_R" -pointsize 30 \
    -size ${TEXT_W}x -gravity West caption:"$sub" "$TMP/sub.png"
  magick -size ${TEXT_W}x26 xc:none "$TMP/gap.png"
  magick "$TMP/head.png" "$TMP/gap.png" "$TMP/sub.png" \
    -background none -gravity West -append "$TMP/block0.png"
  glow "$TMP/block0.png" "$TMP/block.png"

  magick "$TMP/bg.png" \
    "$TMP/c_final.png" -gravity East      -geometry "+${CARD_MARGIN}+6"  -composite \
    "$TMP/icon_s.png"  -gravity NorthWest -geometry "+${TEXT_X}+74"      -composite \
    "$TMP/word.png"    -gravity NorthWest -geometry "+$((TEXT_X+86))+80" -composite \
    "$TMP/block.png"   -gravity West      -geometry "+${TEXT_X}+28"      -composite \
    -background white -alpha remove -alpha off -depth 8 -strip \
    "$out"
  echo "wrote $out  ($(magick identify -format '%wx%h %[channels] %z-bit' "$out"))"
}

slide s-home.png    "All your Chia assets, one view" \
  "XCH, CATs and NFTs with live balances and USD prices the moment you unlock." \
  01-home-1280x800.png

slide s-send.png    "Send XCH & CATs in seconds" \
  "Pick an asset, paste an address, set the fee. Signed locally, never in the cloud." \
  02-send-1280x800.png

slide s-receive.png "Receive with a QR code" \
  "Share your address or generate a fresh one for every payment." \
  03-receive-1280x800.png

slide s-offer.png   "You approve every transaction" \
  "Each dApp request shows exactly what you sign before you allow it." \
  04-approve-1280x800.png

slide s-activity.png "Your full transaction history" \
  "Track every send and receive, block by block." \
  05-activity-1280x800.png

echo "done — 5 store screenshots in $DIR"
