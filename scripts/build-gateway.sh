#!/usr/bin/env bash
# Build the kalo-gateway sidecar and stage it into the desktop app.
#
# Defaults to the host platform; cross-build with --platform <name>.
# Output: kalo-desktop/src-tauri/binaries/kalo-gateway-<target-triple>[.exe]
#
# Naming comes from scripts/platform.sh, the same map build-engine.sh uses, so
# what this stages is exactly what `sidecar::resolve()` looks for at runtime.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/platform.sh"
kalo_platform_init "$@"

GATEWAY="$ROOT/kalo-desktop/gateway"
DESKTOP_BIN="$ROOT/kalo-desktop/src-tauri/binaries"

command -v bun >/dev/null 2>&1 || {
    echo "error: bun is required to compile the gateway (https://bun.sh)" >&2
    exit 1
}

echo "==> Target: $KALO_PLATFORM ($KALO_TRIPLE), host: $KALO_HOST_PLATFORM"

if [[ ! -d "$GATEWAY/node_modules" ]]; then
    echo "==> Installing gateway dependencies..."
    (cd "$GATEWAY" && bun install)
fi

# Typecheck needs the `typescript` devDependency, which ensure-engine.mjs
# deliberately tolerates being absent (offline machine, dead mirror) because
# `bun build --compile` never touches it. So the dev fast path opts out and
# only a manual/CI invocation pays for it.
if [[ " $* " != *" --skip-typecheck "* ]]; then
    echo "==> Type-checking gateway..."
    (cd "$GATEWAY" && bun run typecheck)
fi

# Only pass --target when the host cannot natively produce this output: bun
# downloads a target runtime otherwise, which fails on networks where that
# download is blocked. Same reasoning as kalo-harness/scripts/build-binaries.sh.
target_arg=()
if [[ "$KALO_IS_CROSS" == "1" ]]; then
    target_arg=("--target=$KALO_BUN_TARGET")
fi

mkdir -p "$DESKTOP_BIN"
# bun appends the platform's executable suffix to --outfile itself, so the stem
# is passed bare.
OUT="$DESKTOP_BIN/kalo-gateway-$KALO_TRIPLE"

echo "==> Compiling kalo-gateway ($KALO_PLATFORM)..."
(cd "$GATEWAY" && bun build --compile "${target_arg[@]+"${target_arg[@]}"}" --outfile "$OUT" src/main.ts)

chmod +x "$OUT$KALO_EXE_SUFFIX"
echo "==> Done: $OUT$KALO_EXE_SUFFIX"
