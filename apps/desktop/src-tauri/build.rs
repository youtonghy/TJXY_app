use std::path::PathBuf;

fn main() {
    configure_libmpv_linking();
    tauri_build::build()
}

fn configure_libmpv_linking() {
    println!("cargo:rerun-if-env-changed=TJXY_LIBMPV_DIR");
    println!("cargo:rerun-if-changed=runtime");

    let target = std::env::var("TARGET").unwrap_or_default();
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let platform_dir = if target == "aarch64-apple-darwin" {
        Some("macos-aarch64")
    } else if target == "x86_64-pc-windows-msvc" {
        Some("windows-x86_64")
    } else if target == "aarch64-pc-windows-msvc" {
        Some("windows-aarch64")
    } else if target == "x86_64-unknown-linux-gnu" {
        Some("linux-x86_64")
    } else if target == "aarch64-unknown-linux-gnu" {
        Some("linux-aarch64")
    } else {
        None
    };

    let configured = std::env::var_os("TJXY_LIBMPV_DIR").map(PathBuf::from);
    let bundled = platform_dir.map(|name| manifest.join("runtime").join(name).join("lib"));
    let lib_dir =
        configured.or_else(|| bundled.filter(|path| path.join(lib_name(&target)).exists()));

    if let Some(lib_dir) = lib_dir {
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        if target.contains("apple-darwin") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Resources/runtime/macos-aarch64/lib");
        }
    } else if target == "aarch64-apple-darwin" {
        let homebrew = PathBuf::from("/opt/homebrew/opt/mpv/lib");
        if homebrew.join("libmpv.2.dylib").exists() {
            println!("cargo:rustc-link-search=native={}", homebrew.display());
        }
    }
}

fn lib_name(target: &str) -> &'static str {
    if target.contains("windows") {
        "mpv-2.dll"
    } else if target.contains("apple-darwin") {
        "libmpv.2.dylib"
    } else {
        "libmpv.so.2"
    }
}
