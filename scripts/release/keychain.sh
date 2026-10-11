#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  cleanup)
    [[ -n "${APPLE_SIGNING_DIR:-}" ]] || exit 0
    [[ "$APPLE_SIGNING_DIR" == "${RUNNER_TEMP:?}/apple-signing."* ]] || exit 1
    if [[ -f "$APPLE_SIGNING_DIR/original-keychains.txt" ]]; then
      keychains=()
      while IFS= read -r entry; do keychains+=("$entry"); done < "$APPLE_SIGNING_DIR/original-keychains.txt"
      if [[ ${#keychains[@]} -gt 0 ]]; then security list-keychains -d user -s "${keychains[@]}"; fi
    fi
    if [[ -f "$APPLE_SIGNING_DIR/signing.keychain-db" ]]; then
      security delete-keychain "$APPLE_SIGNING_DIR/signing.keychain-db"
    fi
    rm -rf "$APPLE_SIGNING_DIR"
    exit 0
    ;;
  setup) ;;
  *) echo 'Usage: keychain.sh setup|cleanup' >&2; exit 1 ;;
esac

[[ -n "${GITHUB_ENV:-}" && -n "${RUNNER_TEMP:-}" ]] || exit 1
[[ "${APPLE_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Missing APPLE_TEAM_ID repository variable'; exit 1; }
for name in APPLE_CERTIFICATE_P12_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_NOTARY_KEY_P8_BASE64 APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID; do
  [[ -n "${!name:-}" ]] || { echo "Missing $name credential" >&2; exit 1; }
done
umask 077
signing_dir=$(mktemp -d "$RUNNER_TEMP/apple-signing.XXXXXX")
printf 'APPLE_SIGNING_DIR=%s\n' "$signing_dir" >> "$GITHUB_ENV"
security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"$/\1/' > "$signing_dir/original-keychains.txt"
printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 -D > "$signing_dir/certificate.p12"
printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 -D > "$signing_dir/notary.p8"
/usr/bin/openssl pkey -in "$signing_dir/notary.p8" -noout >/dev/null
keychain="$signing_dir/signing.keychain-db"
password=$(/usr/bin/openssl rand -hex 32)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$signing_dir/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
keychains=("$keychain")
while IFS= read -r entry; do keychains+=("$entry"); done < "$signing_dir/original-keychains.txt"
security list-keychains -d user -s "${keychains[@]}"
identity=$(security find-identity -v -p codesigning "$keychain" | awk -v team="($APPLE_TEAM_ID)" '/Developer ID Application:/ && index($0,team) {print $2}')
[[ "$identity" =~ ^[A-Fa-f0-9]{40}$ ]] || { echo "Expected exactly one Developer ID Application identity for $APPLE_TEAM_ID"; exit 1; }
printf 'APPLE_SIGN_IDENTITY=%s\nAPPLE_SIGNING_KEYCHAIN=%s\nAPPLE_NOTARY_KEY=%s\n' "$identity" "$keychain" "$signing_dir/notary.p8" >> "$GITHUB_ENV"
printf 'APPLE_TEAM_ID=%s\nAPPLE_NOTARY_KEY_ID=%s\nAPPLE_NOTARY_ISSUER_ID=%s\n' "$APPLE_TEAM_ID" "$APPLE_NOTARY_KEY_ID" "$APPLE_NOTARY_ISSUER_ID" >> "$GITHUB_ENV"
echo "Developer ID credentials ready for team $APPLE_TEAM_ID"
