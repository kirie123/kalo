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

export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"

# build-binaries.sh stages the win32 clipboard binding out of the harness's own
# node_modules, but `npm ci` only installs the optional binding matching the
# host platform — on macOS/Linux the win32 one is simply absent. Fetch just that
# package into an isolated prefix (--force bypasses its os/cpu restrictions, and
# --package-lock=false keeps the workspace dependency graph untouched), then drop
# it in place. Without it the staging loop dies on the missing directory and
# silently skips the `native/` console helpers copied right after it.
CLIPBOARD_PKG="@mariozechner/clipboard-win32-x64-msvc"
if [[ ! -d "$HARNESS/node_modules/$CLIPBOARD_PKG" ]]; then
    echo "==> Fetching $CLIPBOARD_PKG (windows-x64 clipboard binding)..."
    CLIPBOARD_VERSION="$(cd "$HARNESS" && node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")"
    CLIPBOARD_TMP="$(mktemp -d)"
    trap 'rm -rf "$CLIPBOARD_TMP"' EXIT
    printf '%s\n' '{"private":true}' > "$CLIPBOARD_TMP/package.json"
    npm install --prefix "$CLIPBOARD_TMP" --include=optional --no-save \
        --package-lock=false --force --ignore-scripts \
        "$CLIPBOARD_PKG@$CLIPBOARD_VERSION"
    mkdir -p "$HARNESS/node_modules/@mariozechner"
    cp -R "$CLIPBOARD_TMP/node_modules/$CLIPBOARD_PKG" "$HARNESS/node_modules/@mariozechner/"
    rm -rf "$CLIPBOARD_TMP"
    trap - EXIT
fi

echo "==> Compiling pi.exe (windows-x64)..."
# Note: build-binaries.sh also creates a .zip archive, which fails when the
# `zip` tool is absent (e.g. Git Bash) — the staged directory is already
# complete by then, so tolerate that trailing failure and verify the staged
# outputs instead. --skip-deps keeps it from re-downloading the full set of
# cross-platform clipboard bindings (broken/expensive mirrors must not abort
# the build before the bun compile step); the one binding this platform needs
# is ensured above.
(cd "$HARNESS" && bash scripts/build-binaries.sh --platform windows-x64 --skip-install --skip-deps --skip-build --offline-model-data) || true
if [[ ! -f "$SRC/pi.exe" ]] || [[ "$HARNESS/packages/coding-agent/dist/cli.js" -nt "$SRC/pi.exe" ]] || ! grep -q '"configDir": ".kalo"' "$SRC/package.json"; then
    echo "error: engine compile did not produce a fresh pi.exe in $SRC" >&2
    exit 1
fi
# The archive step is allowed to fail, so confirm the runtime pieces it copies
# before pi.exe really did land — a partial stage otherwise ships a broken app.
for required in \
    "$SRC/native/win32/prebuilds/win32-x64/win32-console-mode.node" \
    "$SRC/node_modules/@mariozechner/clipboard/clipboard.win32-x64-msvc.node"; do
    if [[ ! -f "$required" ]]; then
        echo "error: engine staging is incomplete, missing $required" >&2
        exit 1
    fi
done

echo "==> Staging into $DESKTOP_BIN ..."
mkdir -p "$DESKTOP_BIN"
(cd "$SRC" && cp -r pi.exe photon_rs_bg.wasm package.json theme assets export-html native node_modules "$DESKTOP_BIN/")
mv -f "$DESKTOP_BIN/pi.exe" "$DESKTOP_BIN/pi-x86_64-pc-windows-msvc.exe"

echo "==> Done: $DESKTOP_BIN/pi-x86_64-pc-windows-msvc.exe"
