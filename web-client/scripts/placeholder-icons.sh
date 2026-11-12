#!/bin/sh
# Makes the PLACEHOLDER install icons in public/icons/ from public/favicon.svg.
# A designer replaces them with real ones (same file names and sizes, or
# update public/manifest.webmanifest and index.html too), then deletes this
# script. Run by hand, once, in a web-client container:
#
#   ./bin/mise run web-client:exec -- sh scripts/placeholder-icons.sh
#
# It renders with resvg through npx, a one-off download into the container's
# temporary npm cache: not a dependency of the app.
set -e

resvg="npx --yes @resvg/resvg-js-cli@2.6.2"
out=public/icons
work=$(mktemp -d)
mkdir -p "$out"

# The favicon's drawing, without its outer <svg> element (48 by 46 units).
inner=$(sed -e 's/^<svg[^>]*>//' -e 's/<\/svg>$//' public/favicon.svg)

# square <file> <size> <background or none> <drawing width as % of the size>
square() {
  w=$(( $2 * $4 / 100 ))
  h=$(( w * 46 / 48 ))
  x=$(( ($2 - w) / 2 ))
  y=$(( ($2 - h) / 2 ))
  bg=""
  [ "$3" = none ] || bg="<rect width=\"$2\" height=\"$2\" fill=\"$3\"/>"
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">%s<svg x="%s" y="%s" width="%s" height="%s" viewBox="0 0 48 46">%s</svg></svg>' \
    "$2" "$2" "$2" "$2" "$bg" "$x" "$y" "$w" "$h" "$inner" >"$work/$1.svg"
  $resvg "$work/$1.svg" "$out/$1.png"
}

# Plain icons: transparent, the drawing nearly edge to edge.
square icon-192 192 none 90
square icon-512 512 none 90
# Maskable: opaque, the drawing inside the central safe zone, since the
# launcher crops the edges to its own shape.
square icon-maskable-512 512 '#ffffff' 60
# iPhone home screen: opaque (iOS fills transparency with black), and iOS
# rounds the corners itself.
square apple-touch-icon-180 180 '#ffffff' 70

rm -r "$work"
ls -l "$out"
