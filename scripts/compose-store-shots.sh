#!/usr/bin/env bash
# compose-store-shots.sh — build polished 1280x800 Chrome Web Store images by
# cropping the popup out of a full screenshot and CENTERING it on a branded
# background, with rounded corners + a soft drop shadow. Output: 24-bit PNG,
# no alpha (store requirement).
#
# Source: chrome-store-screenshots/raw/*.png if present (tight popup crops from
# pw-store-shots.mjs), else the legacy full-window originals in legacy/.
set -euo pipefail

ROOT="/Users/marvin/Projects/Ozone/loroco"
DIR="$ROOT/chrome-store-screenshots"
RAW="$DIR/raw"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

POPUP_W=380          # popup render width in the full screenshots
CARD_H=716           # popup card height on the 1280x800 canvas
RADIUS=26

# branded soft radial gradient (light centre so the card pops, warmer edges)
make_bg () {
  magick -size 1280x1280 radial-gradient:"#FFF1E6"-"#F6B488" \
    -gravity center -extent 1280x800 "$TMP/bg.png"
}

# args: source_png  crop?(1=crop popup region, 0=already a tight crop)  out_name
compose () {
  local src="$1" crop="$2" out="$DIR/$3"

  if [ "$crop" = "1" ]; then
    magick "$src" -crop "${POPUP_W}x800+0+0" +repage "$TMP/pop0.png"
  else
    cp "$src" "$TMP/pop0.png"
  fi

  magick "$TMP/pop0.png" -resize "x${CARD_H}" "$TMP/pop.png"
  local W H
  W=$(magick "$TMP/pop.png" -format %w info:)
  H=$(magick "$TMP/pop.png" -format %h info:)

  # rounded-corner mask, applied via CopyOpacity → transparent corners, no black
  magick -size "${W}x${H}" xc:none -fill white \
    -draw "roundrectangle 0,0,$((W-1)),$((H-1)),${RADIUS},${RADIUS}" "$TMP/mask.png"
  magick "$TMP/pop.png" "$TMP/mask.png" \
    -alpha off -compose CopyOpacity -composite "$TMP/round.png"

  make_bg

  # soft shadow: a blurred dark rounded silhouette drawn straight onto the bg,
  # offset down a touch, then the card on top. No -shadow/-layers (those caused
  # the black-corner artifact).
  local cx cy
  cx=$(( (1280 - W) / 2 ))
  cy=$(( (800 - H) / 2 ))
  magick -size "${W}x${H}" xc:none -fill "black" \
    -draw "roundrectangle 0,0,$((W-1)),$((H-1)),${RADIUS},${RADIUS}" \
    -channel A -evaluate multiply 0.28 +channel -blur 0x18 "$TMP/shadow.png"

  magick "$TMP/bg.png" \
    "$TMP/shadow.png" -gravity NorthWest -geometry "+${cx}+$((cy + 16))" -composite \
    "$TMP/round.png"  -gravity NorthWest -geometry "+${cx}+${cy}" -composite \
    -background white -alpha remove -alpha off -depth 8 -strip \
    "$out"
  echo "wrote $out"
}

if ls "$RAW"/*.png >/dev/null 2>&1; then
  echo "using tight crops in raw/"
  compose "$RAW/01-home.png"    0 01-home-1280x800.png
  compose "$RAW/02-receive.png" 0 02-receive-1280x800.png
  [ -f "$RAW/03-nfts.png" ] && compose "$RAW/03-nfts.png" 0 03-nfts-1280x800.png || true
  compose "$RAW/04-send.png"    0 04-send-1280x800.png
else
  echo "no raw crops — cropping popup region out of legacy originals"
  mkdir -p "$DIR/legacy"
  for f in 04-home 05-send-tab 06-nfts-tab 07-after-reload 08-settings; do
    [ -f "$DIR/$f-1280x800.png" ] && mv "$DIR/$f-1280x800.png" "$DIR/legacy/" || true
  done
  compose "$DIR/legacy/04-home-1280x800.png"     1 01-home-1280x800.png
  compose "$DIR/legacy/05-send-tab-1280x800.png" 1 02-send-1280x800.png
  compose "$DIR/legacy/08-settings-1280x800.png" 1 03-settings-1280x800.png
fi
