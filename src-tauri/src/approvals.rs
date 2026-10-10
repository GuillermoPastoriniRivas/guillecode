use crate::app_data_file;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct ApprovalConfig {
    auto_approve: bool,
}

pub struct ApprovalState {
    config: Mutex<ApprovalConfig>,
}

fn load(app: &AppHandle) -> ApprovalConfig {
    app_data_file(app, "approvals.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &ApprovalConfig) {
    if let Some(path) = app_data_file(app, "approvals.json") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    save(app, &config);
    app.manage(ApprovalState { config: Mutex::new(config) });
}

pub fn auto_approve(app: &AppHandle) -> bool {
    app.state::<ApprovalState>().config.lock().unwrap().auto_approve
}

#[tauri::command]
pub fn approvals_get(app: AppHandle) -> bool {
    auto_approve(&app)
}

#[tauri::command]
pub fn approvals_set(app: AppHandle, auto_approve: bool) -> bool {
    app.state::<ApprovalState>().config.lock().unwrap().auto_approve = auto_approve;
    save(&app, &ApprovalConfig { auto_approve });
    auto_approve
}
