use crate::app_data_file;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct ApprovalConfig {
    auto_approve: bool,
    sessions: BTreeMap<String, bool>,
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

fn view(app: &AppHandle) -> Value {
    let state = app.state::<ApprovalState>();
    let config = state.config.lock().unwrap();
    json!({ "autoApprove": config.auto_approve, "sessions": config.sessions })
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    save(app, &config);
    app.manage(ApprovalState { config: Mutex::new(config) });
}

pub fn auto_approve(app: &AppHandle, session: &str) -> bool {
    let state = app.state::<ApprovalState>();
    let config = state.config.lock().unwrap();
    if session.is_empty() {
        return config.auto_approve;
    }
    config.sessions.get(session).copied().unwrap_or(config.auto_approve)
}

#[tauri::command]
pub fn approvals_get(app: AppHandle) -> Value {
    view(&app)
}

#[tauri::command]
pub fn approvals_set(app: AppHandle, auto_approve: bool) -> Value {
    {
        let state = app.state::<ApprovalState>();
        let mut config = state.config.lock().unwrap();
        config.auto_approve = auto_approve;
        save(&app, &config);
    }
    view(&app)
}

#[tauri::command]
pub fn approvals_set_session(app: AppHandle, session: String, enabled: bool) -> Value {
    if !session.is_empty() {
        let state = app.state::<ApprovalState>();
        let mut config = state.config.lock().unwrap();
        config.sessions.insert(session, enabled);
        save(&app, &config);
    }
    view(&app)
}
