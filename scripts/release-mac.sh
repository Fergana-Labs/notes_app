#!/usr/bin/env bash
# Build a signed + notarized macOS DMG for distribution.
#
# Prerequisites:
#   1. Apple Developer ID Application certificate installed in Keychain.
#   2. `.env.local` filled in (copy from `.env.example`).
#
# Usage:
#   ./scripts/release-mac.sh                     # current arch only (faster)
#   ./scripts/release-mac.sh --universal         # universal binary (Intel + Apple Silicon)

set -euo pipefail

# Move to repo root regardless of where the script was invoked from.
cd "$(dirname "$0")/.."

if [[ ! -f .env.local ]]; then
  echo "error: .env.local not found." >&2
  echo "       Copy .env.example to .env.local and fill in your Apple Developer info." >&2
  exit 1
fi

# Load env vars (set -a auto-exports each variable).
set -a
# shellcheck disable=SC1091
source .env.local
set +a

required=(APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
for var in "${required[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "error: $var is not set in .env.local" >&2
    exit 1
  fi
done

# Tauri picks these up automatically when present in the environment:
#   - APPLE_SIGNING_IDENTITY (or signingIdentity in tauri.conf.json) → codesign
#   - APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID → xcrun notarytool
# After notarization Tauri runs `xcrun stapler` and the DMG is ready to ship.

# Make sure the Rust toolchain is reachable.
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -d "$HOME/.rustup/toolchains" ]]; then
    LATEST_TOOLCHAIN=$(ls -1 "$HOME/.rustup/toolchains" | head -n1)
    export PATH="$HOME/.rustup/toolchains/$LATEST_TOOLCHAIN/bin:$PATH"
  fi
fi

UNIVERSAL=0
if [[ "${1:-}" == "--universal" ]]; then
  UNIVERSAL=1
fi

if [[ $UNIVERSAL -eq 1 ]]; then
  rustup target add x86_64-apple-darwin aarch64-apple-darwin
  pnpm tauri build --target universal-apple-darwin
  BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
else
  pnpm tauri build
  BUNDLE_DIR="src-tauri/target/release/bundle"
fi

echo
echo "✓ Build complete."
echo "  DMG: $(ls -1 "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | head -n1)"
echo "  App: $(ls -1d "$BUNDLE_DIR/macos/"*.app 2>/dev/null | head -n1)"
