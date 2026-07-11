#!/bin/sh

# Embeds the macOS menu-bar agent as a login-item helper — but ONLY in menu-bar builds
# (ONDAS_INCLUDE_MENUBAR=YES, i.e. the Debug and Distribute configs) and only for the Mac (Catalyst)
# variant. The App Store build (Release) ships without it, so the archive stays App-Store-eligible.
#
# Runs as a build phase before the app's own code-signing, so the outer signature seals the agent.

set -eu

if [ "${ONDAS_INCLUDE_MENUBAR:-NO}" != "YES" ]; then
    echo "note: menu-bar agent not embedded (ONDAS_INCLUDE_MENUBAR != YES)"
    exit 0
fi

if [ "${IS_MACCATALYST:-NO}" != "YES" ]; then
    echo "note: menu-bar agent is Mac-only; skipping for this platform"
    exit 0
fi

AGENT="${BUILT_PRODUCTS_DIR}/OndasMenuBar.app"
if [ ! -d "${AGENT}" ]; then
    # In an ARCHIVE build the agent has SKIP_INSTALL=YES, so Xcode drops it under
    # ArchiveIntermediates/<scheme>/IntermediateBuildFilesPath/UninstalledProducts/macosx/ — a
    # sibling of BUILD_DIR (BuildProductsPath), NOT under it. Search the archive intermediates root
    # (OBJROOT) and BUILD_DIR's parent, in addition to the plain-build locations, so both build and
    # archive resolve the agent. Ordered most-specific first.
    for root in "${OBJROOT:-}" "${BUILD_DIR%/*}" "${SYMROOT:-}" "${BUILD_DIR:-}"; do
        [ -n "${root}" ] && [ -d "${root}" ] || continue
        found="$(find "${root}" -name OndasMenuBar.app -type d 2>/dev/null | head -1)"
        if [ -n "${found}" ]; then
            AGENT="${found}"
            break
        fi
    done
fi
if [ -z "${AGENT}" ] || [ ! -d "${AGENT}" ]; then
    echo "error: OndasMenuBar.app not found to embed" >&2
    exit 1
fi
echo "note: embedding agent from ${AGENT}"

DEST="${TARGET_BUILD_DIR}/${CONTENTS_FOLDER_PATH}/Library/LoginItems"
mkdir -p "${DEST}"
rm -rf "${DEST}/OndasMenuBar.app"
cp -R "${AGENT}" "${DEST}/"

# Re-sign the embedded agent with this build's identity (keeping its own entitlements) so the app's
# signature is valid. Distribution export re-signs everything again with the real certificate.
if [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" \
        --preserve-metadata=entitlements,flags,runtime "${DEST}/OndasMenuBar.app"
fi

echo "Embedded menu-bar agent at ${DEST}/OndasMenuBar.app"
