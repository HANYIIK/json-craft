#!/usr/bin/env bash
set -euo pipefail

architecture="${1:?Pass x64 or arm64}"
version="$(node -p 'require("./package.json").version')"
temporary="$(mktemp -d "${RUNNER_TEMP:?}/json-craft-installer-XXXXXX")"
mount="$temporary/mount"
mkdir -p "$mount"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then hdiutil detach "$mount"; fi
  rm -rf "$temporary"
}
trap cleanup EXIT

verify_app() {
  local application="$1"
  python3 scripts/packaging/verify-macos.py "$application" "$architecture"
  if [[ "${REQUIRE_CODE_SIGNING:-false}" == true ]]; then
    codesign -dv --verbose=4 "$application" 2>&1 | grep -F 'Authority=Developer ID Application:'
  fi
  if [[ "${REQUIRE_NOTARIZATION:-false}" == true ]]; then
    xcrun stapler validate "$application"
    spctl --assess --type execute --verbose=4 "$application"
  fi
  node scripts/packaging/smoke-packaged.mjs "$application/Contents/MacOS/JSON Craft" "$architecture"
}

dmg="release/JSON-Craft-$version-macOS-$architecture.dmg"
archive="release/JSON-Craft-$version-macOS-$architecture.zip"
hdiutil verify "$dmg"
hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$dmg"
mounted=true
ditto "$mount/JSON Craft.app" "$temporary/from-dmg/JSON Craft.app"
verify_app "$temporary/from-dmg/JSON Craft.app"
hdiutil detach "$mount"
mounted=false
mkdir "$temporary/from-zip"
ditto -x -k "$archive" "$temporary/from-zip"
verify_app "$temporary/from-zip/JSON Craft.app"
