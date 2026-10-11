#!/usr/bin/env bash
set -euo pipefail
artifact=${1:?Provide the archive to notarize}
auth=(--key "${APPLE_NOTARY_KEY:?}" --key-id "${APPLE_NOTARY_KEY_ID:?}" --issuer "${APPLE_NOTARY_ISSUER_ID:?}")
result=$(mktemp)
trap 'rm -f "$result"' EXIT
# Submit once. A timeout resumes the same submission instead of uploading again.
status=0
xcrun notarytool submit "$artifact" "${auth[@]}" --wait --timeout 20m --output-format json > "$result" || status=$?
submission=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id", ""))' "$result")
[[ -n "$submission" ]] || { cat "$result"; exit 1; }
if [[ $status -ne 0 ]]; then
  xcrun notarytool wait "$submission" "${auth[@]}" --timeout 20m --output-format json > "$result" || {
    xcrun notarytool info "$submission" "${auth[@]}" || true
    echo "Notarization incomplete; inspect existing submission $submission before retrying."
    exit 1
  }
fi
status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$result")
echo "Notarization $submission: $status"
if [[ "$status" != Accepted ]]; then
  xcrun notarytool log "$submission" "${auth[@]}" || true
  exit 1
fi
