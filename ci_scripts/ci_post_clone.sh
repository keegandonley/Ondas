#!/bin/sh

set -eu

if ! command -v xcodegen >/dev/null 2>&1; then
    brew install xcodegen
fi

cd "${CI_PRIMARY_REPOSITORY_PATH:?CI_PRIMARY_REPOSITORY_PATH is not set}"
xcodegen generate --spec project.yml
