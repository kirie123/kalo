#!/usr/bin/env bash
# Build the pi engine from kalo-harness and stage it into the desktop app.
#
# Output: kalo-desktop/src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe
# plus the engine's runtime resources (wasm, theme, assets, ...).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/kalo-harness"
DESKTOP_BIN="$ROOT/kalo-desktop/src-tauri/binaries"
SRC="$HARNESS/packages/coding-agent/binaries/windows-x64"

echo "==> Building harness packages..."
# `npm run build` refreshes the live model catalog first and fails without
# network access; fall back to the bundled snapshot when that happens.
(cd "$HARNESS" && npm run build) || (cd "$HARNESS" && npm run build:offline)

echo "==> Compiling pi.exe (windows-x64)..."
# Note: build-binaries.sh also creates a .zip archive, which fails when the
# `zip` tool is absent (e.g. Git Bash) — the staged directory is already
# complete by then, so tolerate that trailing failure and verify freshness
# instead. --skip-deps keeps the cross-platform clipboard bindings already
# present in node_modules instead of re-downloading them (broken/expensive
# mirrors must not abort the build before the bun compile step).
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
(cd "$HARNESS" && bash scripts/build-binaries.sh --platform windows-x64 --skip-install --skip-deps --skip-build --offline-model-data) || true
if [[ ! -f "$SRC/pi.exe" ]] || [[ "$HARNESS/packages/coding-agent/dist/cli.js" -nt "$SRC/pi.exe" ]] || ! grep -q '"configDir": ".kalo"' "$SRC/package.json"; then
    echo "error: engine compile did not produce a fresh pi.exe in $SRC" >&2
    exit 1
fi

echo "==> Staging into $DESKTOP_BIN ..."
mkdir -p "$DESKTOP_BIN"
(cd "$SRC" && cp -r pi.exe photon_rs_bg.wasm package.json theme assets export-html native node_modules "$DESKTOP_BIN/")
mv -f "$DESKTOP_BIN/pi.exe" "$DESKTOP_BIN/pi-x86_64-pc-windows-msvc.exe"

echo "==> Done: $DESKTOP_BIN/pi-x86_64-pc-windows-msvc.exe"
