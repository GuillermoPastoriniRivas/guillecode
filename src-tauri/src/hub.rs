use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

pub const HIDDEN_ARG: &str = "--hidden";

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn request_quit(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        app.exit(0);
        return;
    }
    show_main(app);
    if app.emit_to("main", "hub://quit", ()).is_err() {
        app.exit(0);
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir GuilleCode", true, None::<&str>)?;
    let new_window = MenuItem::with_id(app, "new-window", "Nueva ventana", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir de GuilleCode", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &new_window, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("GuilleCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "new-window" => {
                if let Err(e) = crate::windows::create(app, None) {
                    log::warn!("[ventanas] {}", e);
                }
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    if !std::env::args().any(|a| a == HIDDEN_ARG) {
        show_main(app);
    }
    Ok(())
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    crate::windows::mark_exiting(&app);
    app.exit(0);
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| e.to_string())?;
    launcher.is_enabled().map_err(|e| e.to_string())
}
