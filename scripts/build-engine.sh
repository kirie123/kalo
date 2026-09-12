#!/usr/bin/env bash
# Build the pi engine from kalo-harness and stage it into the desktop app.
#
# Defaults to the host platform; cross-build with --platform <name>
# (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64).
#
# Output: kalo-desktop/src-tauri/binaries/pi-<target-triple>[.exe]
# plus the engine's runtime resources (wasm, theme, assets, ...).
#
# Staging is flat and additive on purpose: the platform-specific pieces are
# already namespaced by their own file/directory names (native/darwin vs
# native/win32, clipboard.darwin-arm64.node vs clipboard.win32-x64-msvc.node),
# so products for several platforms coexist in binaries/ without clobbering
# each other. Everything else there (theme, assets, export-html, the wasm) is
# platform-neutral.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/platform.sh"
kalo_platform_init "$@"

HARNESS="$ROOT/kalo-harness"
DESKTOP_BIN="$ROOT/kalo-desktop/src-tauri/binaries"
SRC="$HARNESS/packages/coding-agent/binaries/$KALO_PLATFORM"
PI_NAME="pi$KALO_EXE_SUFFIX"

# The clipboard binding and terminal-input helper that build-binaries.sh stages
# for this platform. Verified after the build so a partial stage cannot ship.
case "$KALO_PLATFORM" in
    darwin-arm64) CLIPBOARD_PKG_SUFFIX="darwin-arm64"; CLIPBOARD_NODE="clipboard.darwin-arm64.node" ;;
    darwin-x64) CLIPBOARD_PKG_SUFFIX="darwin-x64"; CLIPBOARD_NODE="clipboard.darwin-x64.node" ;;
    linux-x64) CLIPBOARD_PKG_SUFFIX="linux-x64-gnu"; CLIPBOARD_NODE="clipboard.linux-x64-gnu.node" ;;
    linux-arm64) CLIPBOARD_PKG_SUFFIX="linux-arm64-gnu"; CLIPBOARD_NODE="clipboard.linux-arm64-gnu.node" ;;
    windows-x64) CLIPBOARD_PKG_SUFFIX="win32-x64-msvc"; CLIPBOARD_NODE="clipboard.win32-x64-msvc.node" ;;
    windows-arm64) CLIPBOARD_PKG_SUFFIX="win32-arm64-msvc"; CLIPBOARD_NODE="clipboard.win32-arm64-msvc.node" ;;
esac
CLIPBOARD_PKG="@mariozechner/clipboard-$CLIPBOARD_PKG_SUFFIX"

# Terminal input native helper; linux ships none.
NATIVE_HELPER=""
case "$KALO_PLATFORM" in
    darwin-*) NATIVE_HELPER="native/darwin/prebuilds/$KALO_PLATFORM/darwin-modifiers.node" ;;
    windows-x64) NATIVE_HELPER="native/win32/prebuilds/win32-x64/win32-console-mode.node" ;;
    windows-arm64) NATIVE_HELPER="native/win32/prebuilds/win32-arm64/win32-console-mode.node" ;;
esac

echo "==> Target: $KALO_PLATFORM ($KALO_TRIPLE), host: $KALO_HOST_PLATFORM"

echo "==> Building harness packages..."
# `npm run build` refreshes the live model catalog first and fails without
# network access; fall back to the bundled snapshot when that happens.
(cd "$HARNESS" && npm run build) || (cd "$HARNESS" && npm run build:offline)

export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"

# build-binaries.sh stages the target's clipboard binding out of the harness's
# own node_modules, but `npm ci` only installs the optional binding matching the
# *host* platform — when cross-building, the target's is simply absent. Fetch
# just that package into an isolated prefix (--force bypasses its os/cpu
# restrictions, and --package-lock=false keeps the workspace dependency graph
# untouched), then drop it in place. Without it the staging loop dies on the
# missing directory and silently skips the `native/` console helpers copied
# right after it. Building for the host needs none of this: npm already
# installed the right binding.
if [[ "$KALO_IS_CROSS" == "1" && ! -d "$HARNESS/node_modules/$CLIPBOARD_PKG" ]]; then
    echo "==> Fetching $CLIPBOARD_PKG ($KALO_PLATFORM clipboard binding)..."
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

echo "==> Compiling $PI_NAME ($KALO_PLATFORM)..."
# Note: build-binaries.sh also creates an archive, which fails when the `zip`
# tool is absent (e.g. Git Bash) — the staged directory is already complete by
# then, so tolerate that trailing failure and verify the staged outputs instead.
# --skip-deps keeps it from re-downloading the full set of cross-platform
# clipboard bindings (broken/expensive mirrors must not abort the build before
# the bun compile step); the one binding this platform needs is ensured above.
(cd "$HARNESS" && bash scripts/build-binaries.sh --platform "$KALO_PLATFORM" --skip-install --skip-deps --skip-build --offline-model-data) || true
if [[ ! -f "$SRC/$PI_NAME" ]] || [[ "$HARNESS/packages/coding-agent/dist/cli.js" -nt "$SRC/$PI_NAME" ]] || ! grep -q '"configDir": ".kalo"' "$SRC/package.json"; then
    echo "error: engine compile did not produce a fresh $PI_NAME in $SRC" >&2
    exit 1
fi
# The archive step is allowed to fail, so confirm the runtime pieces it copies
# before the engine really did land — a partial stage otherwise ships a broken app.
REQUIRED=("$SRC/node_modules/@mariozechner/clipboard/$CLIPBOARD_NODE")
[[ -n "$NATIVE_HELPER" ]] && REQUIRED+=("$SRC/$NATIVE_HELPER")
for required in "${REQUIRED[@]}"; do
    if [[ ! -f "$required" ]]; then
        echo "error: engine staging is incomplete, missing $required" >&2
        exit 1
    fi
done

echo "==> Staging into $DESKTOP_BIN ..."
mkdir -p "$DESKTOP_BIN"
(cd "$SRC" && cp -r "$PI_NAME" photon_rs_bg.wasm package.json theme assets export-html native node_modules "$DESKTOP_BIN/")
mv -f "$DESKTOP_BIN/$PI_NAME" "$DESKTOP_BIN/pi-$KALO_TRIPLE$KALO_EXE_SUFFIX"
# `cp` preserves the exec bit, but an engine staged from an extracted archive on
# a filesystem that drops it would fail at spawn time with a bewildering error.
chmod +x "$DESKTOP_BIN/pi-$KALO_TRIPLE$KALO_EXE_SUFFIX"

echo "==> Done: $DESKTOP_BIN/pi-$KALO_TRIPLE$KALO_EXE_SUFFIX"
