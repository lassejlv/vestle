# macOS releases

The `macOS release` workflow builds separate Apple Silicon (`arm64`) and Intel
(`x86_64`) downloads on native macOS runners. It uses Developer ID Application
signing, hardened runtime, secure timestamps and Apple notarization. Each release
contains a DMG, a portable ZIP, a signed updater archive of the stapled app,
SHA-256 checksums per CPU, and a combined `latest.json` updater manifest.
No Windows or Linux releases are built.

## Credentials

Configure the `APPLE_TEAM_ID` repository variable and these Actions secrets:

- `APPLE_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application P12, including its private key.
- `APPLE_CERTIFICATE_PASSWORD`: P12 password.
- `APPLE_NOTARY_KEY_P8_BASE64`: base64-encoded App Store Connect Team API private key.
- `APPLE_NOTARY_KEY_ID`: Team API key ID.
- `APPLE_NOTARY_ISSUER_ID`: Team API issuer ID.
- `TAURI_SIGNING_PRIVATE_KEY`: dedicated Tauri updater signing key (separate from the Apple certificate).

The updater public key is embedded in `src-tauri/tauri.conf.json`. Keep the private
key backed up securely outside the repository; installed apps trust that exact key.
This repository's updater key has no passphrase and is protected by restricted
local file permissions and GitHub's encrypted secret storage. If a password is
added, configure `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as a secret too and replace
the workflow's empty password value. Never replace the key casually: existing
installations cannot verify updates signed with an unrelated key.

These credentials are independent of the app name. Signing fails if credentials
are missing or the imported identity does not match the team. Credentials are
imported only after compilation into a temporary keychain; the original keychain
search list is restored and temporary files are removed in an `always()` step.
Never commit credential files. No signing workflow runs on pull requests.

## Test a signed build

Use **Actions → macOS release → Run workflow** after the workflow is on the
default branch. Pushes to the dedicated `release/macos` branch also build signed
artifacts, which allows initial verification before merging. These runs upload
downloads to Actions and never create a GitHub Release.

Each native runner tests the Rust backend, builds the frontend and app, signs and
notarizes the app, staples it, creates/signs/notarizes/staples the DMG, and finally
creates the ZIP and updater `.app.tar.gz`. The archive is signed with the updater
key, binding the app version into the signature. CI verifies that signature using
the public key embedded in the app, then verifies checksums, Apple signatures,
signing team, architecture, hardened runtime, timestamps, notarization tickets and
Gatekeeper for all three formats. Each extracted app runs a daemon smoke test exercising
terminal input/output, resize, disconnect/reconnect, scrollback replay and shutdown.

To verify downloaded Actions artifacts locally:

```sh
APPLE_TEAM_ID=YOUR_TEAM_ID python3 scripts/release/verify-artifacts.py /path/to/downloads arm64
APPLE_TEAM_ID=YOUR_TEAM_ID python3 scripts/release/verify-artifacts.py /path/to/downloads x86_64
```

Runtime smoke tests run only for the host's native architecture; signatures and
notarization can be verified for either architecture on the same Mac. The CI jobs
exercise each architecture on its matching runner. Interactive GUI behavior still
needs a manual check before a release.

## Publish

1. Set the same version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json`, and update the Cargo lockfile if needed.
2. Commit the version change and push a tag such as `v0.1.0` at the intended commit.
3. Both architecture jobs must pass before the publish job runs. The tag must
   exactly match the app version.

The publish job creates a draft, attaches all verified downloads and the updater manifest, then makes the
release public. Tags with a prerelease suffix are marked as prereleases. Existing
public releases are never overwritten; failed draft uploads can be rerun.

Notarization timeouts retain the submission ID. Inspect that submission with
`notarytool info` or `notarytool log` before retrying an upload.

References: [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[GitHub macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Tauri macOS distribution](https://v2.tauri.app/distribute/macos-application-bundle/).

## Automatic updates

Installed macOS release builds check the latest stable GitHub release on startup,
every four hours, and when the window regains focus if a check is due. Newer
versions download in the background. Tauri verifies the archive signature and its
signed version before offering **Restart to update** in a notification and in
Settings → Updates. Installation happens only when the user chooses to restart.
The app never automatically terminates the background daemon; compatible running
agents and terminals reconnect after restart.

Settings also offers manual checks, download progress and retryable errors.
Development builds and browser previews have updates disabled. Network failures,
invalid signatures and a missing release feed are errors, never a successful
“up to date” check. Before the first published release, GitHub has no `latest.json`
to serve. No release or version tag is needed to test the artifact-only workflow.

The manifest maps `darwin-aarch64` and `darwin-x86_64` to distinct immutable,
versioned download URLs. GitHub's latest-release endpoint excludes prereleases.
Both architecture jobs must succeed before the combined manifest is generated,
and every asset is attached to a draft before that release becomes public.
Tauri's build-time `createUpdaterArtifacts` stays disabled: updater archives are
created from the final stapled app by `package-macos.sh` instead.

Local updater checks:

```sh
bun test tests/update-controller.test.ts
python3 -m unittest discover -s scripts/release -p 'test_*.py'
cargo run --locked --manifest-path src-tauri/Cargo.toml --example verify_update -- /path/to/update.app.tar.gz 0.1.0
```
