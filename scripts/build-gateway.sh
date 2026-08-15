#!/usr/bin/env bash
# Build the kalo-gateway sidecar (Feishu IM gateway) from kalo-desktop/gateway
# and stage it into the desktop app.
#
# Output: kalo-desktop/src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe
#
# Requires bun (https://bun.sh) on PATH.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY="$ROOT/kalo-desktop/gateway"
OUT="$ROOT/kalo-desktop/src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe"

command -v bun >/dev/null 2>&1 || {
    echo "error: bun is required to compile the gateway (https://bun.sh)" >&2
    exit 1
}

echo "==> Installing gateway dependencies..."
(cd "$GATEWAY" && bun install)

echo "==> Type-checking gateway..."
(cd "$GATEWAY" && bun run typecheck)

echo "==> Compiling kalo-gateway (bun -> single exe)..."
(cd "$GATEWAY" && bun run build)

if [[ ! -f "$OUT" ]]; then
    echo "error: gateway compile did not produce $OUT" >&2
    exit 1
fi

echo "==> Done: $OUT"
