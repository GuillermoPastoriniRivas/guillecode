fn main() {
  tauri_build::build();
  // Test executables link Tauri's native window/dialog code, so they need a
  // Common Controls v6 manifest (TaskDialogIndirect) that tauri-build only gives
  // the application binary. Cargo cannot scope link args to the library's test
  // binary, so add the manifest globally for tests and suppress the generated
  // manifest on the application binary, which keeps tauri-build's manifest
  // resource (avoiding a duplicate MANIFEST resource -> CVT1100).
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    println!("cargo:rustc-link-arg-bin=app=/MANIFEST:NO");
  }
}
