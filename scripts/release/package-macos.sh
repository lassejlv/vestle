#!/usr/bin/env bash
set -euo pipefail
target=${1:?Provide a Rust target}
arch=${2:?Provide arm64 or x86_64}
: "${TAURI_SIGNING_PRIVATE_KEY:?Missing updater signing key}"
case "$target:$arch" in aarch64-apple-darwin:arm64|x86_64-apple-darwin:x86_64) ;; *) exit 1 ;; esac
app="src-tauri/target/$target/release/bundle/macos/Termy Code.app"
[[ -d "$app" ]] || { echo "Missing $app"; exit 1; }
[[ "$(lipo -archs "$app/Contents/MacOS/termy-code")" == "$arch" ]] || exit 1
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" == "${APP_VERSION:?}" ]] || exit 1
sign=(--force --sign "${APPLE_SIGN_IDENTITY:?}" --keychain "${APPLE_SIGNING_KEYCHAIN:?}" --options runtime --timestamp)
# Sign nested Mach-O code first. This app does not bundle Bun or another JIT runtime.
while IFS= read -r -d '' nested; do
  if file -b "$nested" | grep -q 'Mach-O'; then
    codesign "${sign[@]}" --preserve-metadata=entitlements "$nested"
  fi
done < <(find "$app/Contents" -type f -print0)
while IFS= read -r -d '' nested; do
  codesign "${sign[@]}" --preserve-metadata=entitlements "$nested"
done < <(find "$app/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0)
codesign "${sign[@]}" --preserve-metadata=entitlements "$app"
codesign --verify --deep --strict --verbose=2 "$app"
metadata=$(codesign --display --verbose=4 "$app" 2>&1)
grep -q "TeamIdentifier=${APPLE_TEAM_ID:?}" <<< "$metadata"
grep -q 'flags=.*runtime' <<< "$metadata"
grep -q '^Timestamp=' <<< "$metadata"

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-package.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
ditto -c -k --keepParent "$app" "$scratch/submit.zip"
bash scripts/release/notarize.sh "$scratch/submit.zip"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"

mkdir -p release-artifacts "$scratch/dmg"
stem="Termy-Code-${APP_VERSION}-macos-${arch}"
ditto "$app" "$scratch/dmg/Termy Code.app"
ln -s /Applications "$scratch/dmg/Applications"
hdiutil create -volname 'Termy Code' -srcfolder "$scratch/dmg" -format UDZO -ov "release-artifacts/$stem.dmg"
codesign --force --sign "$APPLE_SIGN_IDENTITY" --keychain "$APPLE_SIGNING_KEYCHAIN" --timestamp "release-artifacts/$stem.dmg"
bash scripts/release/notarize.sh "release-artifacts/$stem.dmg"
xcrun stapler staple "release-artifacts/$stem.dmg"
xcrun stapler validate "release-artifacts/$stem.dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "release-artifacts/$stem.dmg"
# Only archive the final stapled app; ZIP itself cannot carry a stapled ticket.
ditto -c -k --keepParent "$app" "release-artifacts/$stem.zip"
# The updater must receive these exact signed and stapled bytes. Tauri's build-time
# updater archive would be generated before our Developer ID signing pass.
COPYFILE_DISABLE=1 tar -czf "release-artifacts/$stem.app.tar.gz" -C "$(dirname "$app")" 'Termy Code.app'
bun tauri signer sign --app-version "$APP_VERSION" "release-artifacts/$stem.app.tar.gz"
cargo run --locked --manifest-path src-tauri/Cargo.toml --target "$target" --example verify_update -- \
  "release-artifacts/$stem.app.tar.gz" "$APP_VERSION"
(cd release-artifacts && shasum -a 256 "$stem.dmg" "$stem.zip" "$stem.app.tar.gz" "$stem.app.tar.gz.sig" > "$stem.sha256")
