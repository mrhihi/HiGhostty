use std::path::PathBuf;
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        panic!("HiGhostty only supports macOS");
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("vendor");
    if !vendor.join("libghostty.a").exists() {
        panic!("Run npm run native:bootstrap to build Ghostty 1.3.1 first");
    }
    let mut bridge = cc::Build::new();
    bridge
        .file("native/bridge.m")
        .file("native/files.m")
        .file("native/window.m")
        .include("native")
        .flag("-fobjc-arc")
        .flag("-fblocks")
        .flag("-Wno-unused-parameter")
        .flag("-mmacosx-version-min=13.0");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        bridge.define("HG_DEBUG_INPUT", None);
    }
    bridge.compile("highostty_bridge");
    println!("cargo:rustc-link-search=native={}", vendor.display());
    println!("cargo:rustc-link-lib=static=ghostty");
    for framework in [
        "AppKit",
        "Carbon",
        "CoreText",
        "CoreGraphics",
        "CoreVideo",
        "Quartz",
        "QuartzCore",
        "QuickLookThumbnailing",
        "Metal",
        "MetalKit",
        "IOSurface",
        "IOKit",
        "UniformTypeIdentifiers",
        "UserNotifications",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed=vendor/libghostty.a");
    tauri_build::build();
}
