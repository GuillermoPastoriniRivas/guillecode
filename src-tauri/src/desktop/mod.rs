use crate::machine::{self, MachineStatus};
use crate::oc::Opencode;
use crate::{app_data_file, ensure_server, recent_project_list};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub mod browser;
mod mcp;
#[cfg(windows)]
mod tools;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod win;
#[cfg(windows)]
pub mod stream;

const ACTIVITY_MAX: usize = 80;
const SKILL: &str = include_str!("skill.md");

const DEFAULT_BLOCKED: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "wt.exe",
    "conhost.exe",
    "openconsole.exe",
    "regedit.exe",
    "mmc.exe",
    "taskmgr.exe",
    "consent.exe",
    "credentialuibroker.exe",
    "pickerhost.exe",
    "lockapp.exe",
    "logonui.exe",
    "keepass.exe",
    "keepassxc.exe",
    "1password.exe",
    "bitwarden.exe",
    "lastpass.exe",
    "dashlane.exe",
];

#[derive(Clone, Copy, PartialEq)]
pub enum Channel {
    Desktop,
    Browser,
}

impl Channel {
    fn name(&self) -> &'static str {
        match self {
            Channel::Desktop => "desktop",
            Channel::Browser => "browser",
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub enabled: bool,
    pub paused: bool,
    pub browser: bool,
    pub browser_token: String,
    pub blocked: Vec<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig { enabled: false, paused: false, browser: true, browser_token: String::new(), blocked: DEFAULT_BLOCKED.iter().map(|s| s.to_string()).collect() }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: i64,
    pub channel: String,
    pub tool: String,
    pub summary: String,
    pub ok: bool,
}

pub struct ToolResult {
    pub content: Vec<Value>,
    pub error: bool,
}

pub struct DesktopState {
    config: Mutex<DesktopConfig>,
    port: u16,
    token: String,
    activity: Mutex<VecDeque<Activity>>,
    skills: Option<PathBuf>,
    browser_injected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    enabled: bool,
    paused: bool,
    browser: bool,
    browser_active: bool,
    browser_configured: bool,
    bridge: browser::BridgeStatus,
    blocked: Vec<String>,
    activity: Vec<Activity>,
    machine: MachineStatus,
    available: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPatch {
    enabled: Option<bool>,
    paused: Option<bool>,
    browser: Option<bool>,
    browser_token: Option<String>,
    blocked: Option<Vec<String>>,
}

static BLOCKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn load(app: &AppHandle) -> DesktopConfig {
    app_data_file(app, "desktop.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &DesktopConfig) {
    if let Some(path) = app_data_file(app, "desktop.json") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

fn set_blocked(list: &[String]) {
    *BLOCKED.lock().unwrap() = list.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
}

fn write_skill(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().app_data_dir().ok()?.join("skills");
    let dir = root.join("escritorio");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(dir.join("SKILL.md"), SKILL).ok()?;
    Some(root)
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    set_blocked(&config.blocked);
    browser::set_token(&config.browser_token);
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let port = match mcp::serve(app, token.clone()) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[desktop] {}", e);
            0
        }
    };
    let skills = write_skill(app);
    let browser_injected = config.browser;
    app.manage(DesktopState { config: Mutex::new(config), port, token, activity: Mutex::new(VecDeque::new()), skills, browser_injected });
}

pub fn opencode_config(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<DesktopState>()?;
    if state.port == 0 {
        return None;
    }
    let server = |path: &str, timeout: u64| {
        json!({
            "type": "remote",
            "url": format!("http://127.0.0.1:{}/mcp/{}", state.port, path),
            "headers": { "Authorization": format!("Bearer {}", state.token) },
            "oauth": false,
            "timeout": timeout,
        })
    };
    let mut mcp = json!({ "desktop": server("desktop", 120_000) });
    if state.browser_injected {
        mcp["browser"] = server("browser", 180_000);
    }
    let mut config = json!({ "mcp": mcp });
    if let Some(dir) = &state.skills {
        config["skills"] = json!({ "paths": [dir.to_string_lossy()] });
    }
    Some(config.to_string())
}

pub fn config(app: &AppHandle) -> DesktopConfig {
    app.state::<DesktopState>().config.lock().unwrap().clone()
}

pub fn gate(app: &AppHandle) -> Result<(), String> {
    let c = config(app);
    if !c.enabled {
        return Err("El control de la PC está apagado. Pedile al usuario que lo active (en GuilleCode: comando «Control de la PC»; en el celular: tarjeta «Tu PC») y no intentes otra forma de manejar la interfaz.".into());
    }
    if c.paused {
        return Err("El usuario pausó el control de la PC. Esperá a que lo reanude y no intentes otra forma de manejar la interfaz.".into());
    }
    Ok(())
}

fn own_exe() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase())).unwrap_or_default()
    })
}

#[cfg(windows)]
pub fn blocked_reason(w: &win::WinInfo) -> Option<String> {
    let process = w.process.to_lowercase();
    if w.pid == std::process::id() || (!process.is_empty() && process == own_exe()) {
        return Some("es GuilleCode: el agente no puede manejar su propia ventana".into());
    }
    if BLOCKED.lock().unwrap().iter().any(|b| *b == process) {
        return Some(format!("«{}» ({}) está en la lista de apps bloqueadas para el agente", w.title, w.process));
    }
    None
}

pub fn record(app: &AppHandle, channel: &str, tool: &str, summary: &str, ok: bool) {
    let entry = Activity {
        at: chrono::Utc::now().timestamp_millis(),
        channel: channel.to_string(),
        tool: tool.to_string(),
        summary: if summary.is_empty() { tool.to_string() } else { summary.to_string() },
        ok,
    };
    {
        let state = app.state::<DesktopState>();
        let mut list = state.activity.lock().unwrap();
        list.push_front(entry.clone());
        list.truncate(ACTIVITY_MAX);
    }
    let _ = app.emit("desktop://activity", entry);
}

pub fn browser_line() -> String {
    let s = browser::status();
    match s.state {
        "ready" => format!("listo ({} herramientas browser_*)", s.tools),
        "starting" => "arrancando".into(),
        "error" => format!("con error: {}", s.error.unwrap_or_default()),
        _ => "sin iniciar (arranca solo al usarlo)".into(),
    }
}

fn instructions(channel: Channel) -> &'static str {
    match channel {
        Channel::Desktop => "Maneja apps de Windows por accesibilidad. Ciclo: status → windows → snapshot (refs [eN]) → click/type/select por ref → leer el snapshot que devuelve. screenshot y click_xy solo como respaldo. Con la PC bloqueada solo funcionan las acciones por accesibilidad. Para la web usá las herramientas browser_*. Cargá la skill «escritorio» para las reglas completas.",
        Channel::Browser => "Maneja el Chrome real del usuario (con sus sesiones iniciadas) a través de la extensión de Playwright. Ciclo: snapshot → click/type por ref → verificar. Antes de enviar, pagar, borrar o publicar, confirmá con el usuario.",
    }
}

fn tool_list(channel: Channel) -> Vec<Value> {
    match channel {
        #[cfg(windows)]
        Channel::Desktop => tools::definitions(),
        #[cfg(not(windows))]
        Channel::Desktop => Vec::new(),
        Channel::Browser => browser::tools(),
    }
}

fn browser_summary(name: &str, args: &Value) -> String {
    let pick = |k: &str| args[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let what = pick("element").or_else(|| pick("url")).or_else(|| pick("key")).or_else(|| pick("text").map(|t| format!("«{}»", t.chars().take(40).collect::<String>())));
    match what {
        Some(w) => format!("{} · {}", name, w),
        None => name.to_string(),
    }
}

fn call_tool(app: &AppHandle, channel: Channel, name: &str, args: &Value) -> Value {
    match channel {
        #[cfg(windows)]
        Channel::Desktop => {
            let r = tools::call(app, name, args);
            json!({ "content": r.content, "isError": r.error })
        }
        #[cfg(not(windows))]
        Channel::Desktop => json!({ "content": [{ "type": "text", "text": "El control del escritorio solo funciona en Windows." }], "isError": true }),
        Channel::Browser => {
            if let Err(e) = gate(app) {
                return json!({ "content": [{ "type": "text", "text": e }], "isError": true });
            }
            let summary = browser_summary(name, args);
            match browser::call(name, args.clone()) {
                Ok(result) => {
                    let failed = result["isError"].as_bool().unwrap_or(false);
                    record(app, "browser", name, &summary, !failed);
                    result
                }
                Err(e) => {
                    record(app, "browser", name, &summary, false);
                    json!({ "content": [{ "type": "text", "text": format!("El navegador no respondió: {}. Revisá que Chrome esté abierto y la extensión de Playwright conectada (GuilleCode → «Control de la PC»).", e) }], "isError": true })
                }
            }
        }
    }
}

pub fn status(app: &AppHandle) -> DesktopStatus {
    let state = app.state::<DesktopState>();
    let c = state.config.lock().unwrap().clone();
    let activity: Vec<Activity> = state.activity.lock().unwrap().iter().cloned().collect();
    DesktopStatus {
        enabled: c.enabled,
        paused: c.paused,
        browser: c.browser,
        browser_active: state.browser_injected,
        browser_configured: !c.browser_token.is_empty(),
        bridge: browser::status(),
        blocked: c.blocked.clone(),
        activity,
        machine: machine::status(),
        available: state.port != 0 && cfg!(windows),
    }
}

pub fn apply(app: &AppHandle, patch: DesktopPatch) -> DesktopStatus {
    {
        let state = app.state::<DesktopState>();
        let mut c = state.config.lock().unwrap();
        if let Some(v) = patch.enabled {
            c.enabled = v;
            if v {
                c.paused = false;
            }
        }
        if let Some(v) = patch.paused {
            c.paused = v;
        }
        if let Some(v) = patch.browser {
            c.browser = v;
        }
        if let Some(t) = patch.browser_token {
            c.browser_token = t.trim().to_string();
            browser::set_token(&c.browser_token);
        }
        if let Some(list) = patch.blocked {
            let mut clean: Vec<String> = list.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
            clean.dedup();
            c.blocked = clean;
            set_blocked(&c.blocked);
        }
        save(app, &c);
    }
    let _ = app.emit("desktop://changed", ());
    #[cfg(windows)]
    if gate(app).is_err() {
        stream::release_control();
    }
    status(app)
}

pub fn apply_remote(app: &AppHandle, body: &Value) -> DesktopStatus {
    apply(app, DesktopPatch { enabled: body["enabled"].as_bool(), paused: body["paused"].as_bool(), ..Default::default() })
}

pub fn stop_all(app: &AppHandle) -> usize {
    apply(app, DesktopPatch { paused: Some(true), ..Default::default() });
    let Ok(server) = ensure_server(app) else { return 0 };
    let mut projects = vec![server.worktree.clone()];
    for p in recent_project_list(app) {
        if !projects.iter().any(|q| q.eq_ignore_ascii_case(&p)) {
            projects.push(p);
        }
    }
    let mut targets: Vec<(String, String)> = crate::live::busy_sessions(app);
    for project in projects.iter().filter(|p| !p.is_empty()) {
        let Ok(statuses) = Opencode::new(&server, project).get("/session/status") else { continue };
        let Some(map) = statuses.as_object() else { continue };
        for (id, st) in map {
            if st["type"].as_str().map(|t| t != "idle").unwrap_or(false) && !targets.iter().any(|(t, _)| t == id) {
                targets.push((id.clone(), project.clone()));
            }
        }
    }
    let mut aborted = 0;
    for (id, directory) in targets {
        if Opencode::new(&server, &directory).post(&format!("/session/{}/abort", id), json!({})).is_ok() {
            aborted += 1;
        }
    }
    let detail = match aborted {
        0 => "no había sesiones trabajando".to_string(),
        1 => "1 sesión".to_string(),
        n => format!("{} sesiones", n),
    };
    record(app, "desktop", "stop", &format!("el usuario detuvo todo ({})", detail), true);
    aborted
}

#[cfg(windows)]
pub fn windows_json() -> Value {
    tools::windows_json()
}

#[cfg(not(windows))]
pub fn windows_json() -> Value {
    json!([])
}

#[cfg(windows)]
pub fn screen_jpeg(window: Option<&str>, max_side: u32) -> Result<Vec<u8>, String> {
    tools::screen_jpeg(window, max_side)
}

#[cfg(not(windows))]
pub fn screen_jpeg(_window: Option<&str>, _max_side: u32) -> Result<Vec<u8>, String> {
    Err("solo en Windows".into())
}

pub fn shutdown() {
    #[cfg(windows)]
    stream::disconnect_all();
    browser::stop();
}

#[tauri::command]
pub async fn desktop_status(app: AppHandle) -> DesktopStatus {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.unwrap()
}

#[tauri::command]
pub async fn desktop_update(app: AppHandle, patch: DesktopPatch) -> DesktopStatus {
    tauri::async_runtime::spawn_blocking(move || apply(&app, patch)).await.unwrap()
}

#[tauri::command]
pub async fn desktop_stop_all(app: AppHandle) -> usize {
    tauri::async_runtime::spawn_blocking(move || stop_all(&app)).await.unwrap()
}

#[tauri::command]
pub async fn desktop_browser_restart() -> browser::BridgeStatus {
    tauri::async_runtime::spawn_blocking(move || {
        browser::stop();
        let _ = browser::tools();
        browser::status()
    })
    .await
    .unwrap()
}
