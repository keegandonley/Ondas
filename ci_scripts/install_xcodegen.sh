#!/bin/sh

# Download the exact XcodeGen release used by local CI and Xcode Cloud. The SHA-256
# is GitHub's digest for the xcodegen.zip asset in yonaskolb/XcodeGen 2.45.4.
set -eu

XCODEGEN_VERSION="2.45.4"
XCODEGEN_SHA256="090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef"
INSTALL_ROOT="${1:?usage: install_xcodegen.sh INSTALL_ROOT}"
ARCHIVE="${TMPDIR:-/tmp}/xcodegen-${XCODEGEN_VERSION}.zip"
URL="https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip"

mkdir -p "$INSTALL_ROOT"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$ARCHIVE" "$URL"

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$XCODEGEN_SHA256" ]; then
    echo "error: XcodeGen archive checksum mismatch" >&2
    exit 1
fi

unzip -tq "$ARCHIVE"
unzip -q -o "$ARCHIVE" -d "$INSTALL_ROOT"

XCODEGEN_BIN_DIR="$INSTALL_ROOT/xcodegen/bin"
XCODEGEN="$XCODEGEN_BIN_DIR/xcodegen"
if [ ! -x "$XCODEGEN" ]; then
    echo "error: XcodeGen binary was not present in the verified archive" >&2
    exit 1
fi

INSTALLED_VERSION="$("$XCODEGEN" --version | awk '/^Version:/ { print $2 }')"
if [ "$INSTALLED_VERSION" != "$XCODEGEN_VERSION" ]; then
    echo "error: expected XcodeGen ${XCODEGEN_VERSION}, got ${INSTALLED_VERSION:-unknown}" >&2
    exit 1
fi

printf '%s\n' "$XCODEGEN_BIN_DIR"
