#!/bin/sh

# Keep the source image aligned with the macOS App Store icon rendition declared
# in AppIcon.appiconset/Contents.json. Asset catalogs otherwise accept a tiny PNG
# without warning and silently scale it into a blurry release icon.
set -eu

ICON="Ondas/Resources/Assets.xcassets/AppIcon.appiconset/OndasIcon-mac-512.png"

if [ ! -f "$ICON" ]; then
    echo "error: missing required icon asset: $ICON" >&2
    exit 1
fi

DIMENSIONS="$(sips -g pixelWidth -g pixelHeight "$ICON")"
WIDTH="$(printf '%s\n' "$DIMENSIONS" | awk -F ': ' '/pixelWidth:/ { print $2 }')"
HEIGHT="$(printf '%s\n' "$DIMENSIONS" | awk -F ': ' '/pixelHeight:/ { print $2 }')"

if [ "$WIDTH" != "512" ] || [ "$HEIGHT" != "512" ]; then
    echo "error: $ICON must be 512x512 pixels; found ${WIDTH:-unknown}x${HEIGHT:-unknown}" >&2
    exit 1
fi

echo "Verified 512x512 macOS app icon."
