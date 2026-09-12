#!/usr/bin/env bash
# Shared platform → naming map for the sidecar build scripts.
#
# Sourced by build-engine.sh and build-gateway.sh. Both stage executables that
# `sidecar::resolve()` (kalo-desktop/src-tauri/src/sidecar.rs) later looks up by
# `<stem>-<target-triple><exe-suffix>`, so the triple has to come from one place
# — a mismatch between what the build stages and what Rust asks for is invisible
# until the app tries to spawn the engine and appears as "engine unresponsive".
#
# Usage:
#   source "$(dirname "$0")/platform.sh"
#   kalo_platform_init "$@"        # honours --platform <name>, else host
#
# Exports: KALO_PLATFORM, KALO_TRIPLE, KALO_EXE_SUFFIX, KALO_BUN_TARGET,
#          KALO_HOST_PLATFORM, KALO_IS_CROSS

# Detect the platform this machine can natively produce binaries for.
kalo_host_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        MINGW* | MSYS* | CYGWIN*) os=windows ;;
        *)
            echo "error: unsupported host OS: $(uname -s)" >&2
            return 1
            ;;
    esac
    case "$(uname -m)" in
        arm64 | aarch64) arch=arm64 ;;
        x86_64 | amd64) arch=x64 ;;
        *)
            echo "error: unsupported host arch: $(uname -m)" >&2
            return 1
            ;;
    esac
    printf '%s-%s\n' "$os" "$arch"
}

# Resolve KALO_PLATFORM (from --platform or the host) and derive the rest.
kalo_platform_init() {
    local requested=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --platform)
                requested="${2:-}"
                shift 2 || true
                ;;
            *) shift ;;
        esac
    done

    KALO_HOST_PLATFORM="$(kalo_host_platform)" || return 1
    KALO_PLATFORM="${requested:-$KALO_HOST_PLATFORM}"

    # Triples match Rust/Tauri target-triple spelling, not bun's platform names.
    case "$KALO_PLATFORM" in
        darwin-arm64) KALO_TRIPLE="aarch64-apple-darwin" ;;
        darwin-x64) KALO_TRIPLE="x86_64-apple-darwin" ;;
        linux-x64) KALO_TRIPLE="x86_64-unknown-linux-gnu" ;;
        linux-arm64) KALO_TRIPLE="aarch64-unknown-linux-gnu" ;;
        windows-x64) KALO_TRIPLE="x86_64-pc-windows-msvc" ;;
        windows-arm64) KALO_TRIPLE="aarch64-pc-windows-msvc" ;;
        *)
            echo "error: unknown platform: $KALO_PLATFORM" >&2
            echo "valid: darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64" >&2
            return 1
            ;;
    esac

    if [[ "$KALO_PLATFORM" == windows-* ]]; then
        KALO_EXE_SUFFIX=".exe"
    else
        KALO_EXE_SUFFIX=""
    fi

    KALO_BUN_TARGET="bun-$KALO_PLATFORM"

    if [[ "$KALO_PLATFORM" == "$KALO_HOST_PLATFORM" ]]; then
        KALO_IS_CROSS=0
    else
        KALO_IS_CROSS=1
    fi

    export KALO_PLATFORM KALO_TRIPLE KALO_EXE_SUFFIX KALO_BUN_TARGET \
        KALO_HOST_PLATFORM KALO_IS_CROSS
}
