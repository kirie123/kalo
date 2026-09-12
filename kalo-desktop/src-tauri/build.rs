fn main() {
    // Cargo only exposes the target triple to build scripts, but `sidecar.rs`
    // needs it to name the bundled engine/gateway executables exactly the way
    // scripts/build-engine.sh staged them. Forwarding it as a compile-time env
    // keeps both sides deriving the name from the same triple.
    println!(
        "cargo:rustc-env=KALO_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    tauri_build::build()
}
