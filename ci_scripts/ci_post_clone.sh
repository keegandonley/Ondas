#!/bin/sh

set -eu

# Install XcodeGen. Xcode Cloud's `brew install xcodegen` is unreliable: it fetches package metadata
# from formulae.brew.sh, which failed to connect mid-build and broke the archive (build 31). Download
# a pinned XcodeGen release binary straight from GitHub instead — deterministic version (matches the
# local toolchain), and no dependency on Homebrew's package server.
if ! command -v xcodegen >/dev/null 2>&1; then
    XCODEGEN_VERSION=2.45.4
    curl -fsSL -o /tmp/xcodegen.zip \
        "https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip"
    unzip -q -o /tmp/xcodegen.zip -d /tmp/xcodegen-dist
    export PATH="/tmp/xcodegen-dist/xcodegen/bin:$PATH"
fi

cd "${CI_PRIMARY_REPOSITORY_PATH:?CI_PRIMARY_REPOSITORY_PATH is not set}"
xcodegen generate --spec project.yml
