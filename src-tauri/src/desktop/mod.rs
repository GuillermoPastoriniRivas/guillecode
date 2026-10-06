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
mod routines;
pub(crate) mod terminal;
mod worktrees;
#[cfg(windows)]
mod ocr;
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
    Routines,
    Terminal,
    Worktrees,
    Memory,
}

impl Channel {
    fn name(&self) -> &'static str {
        match self {
            Channel::Desktop => "desktop",
            Channel::Browser => "browser",
            Channel::Routines => "routines",
            Channel::Terminal => "terminal",
            Channel::Worktrees => "worktrees",
            Channel::Memory => "memory",
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub enabled: bool,
    pub paused: bool,
    pub browser: bool,
    pub blocked: Vec<String>,
    pub subagent: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        DesktopConfig { enabled: false, paused: false, browser: true, blocked: DEFAULT_BLOCKED.iter().map(|s| s.to_string()).collect(), subagent: true }
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
    subagent: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    enabled: bool,
    paused: bool,
    browser: bool,
    browser_active: bool,
    subagent: bool,
    subagent_active: bool,
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
    blocked: Option<Vec<String>>,
    subagent: Option<bool>,
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

fn write_skill(app: &AppHandle, subagent: bool) -> Option<PathBuf> {
    let root = app.path().app_data_dir().ok()?.join("skills");
    let dir = root.join("escritorio");
    if subagent {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&root).ok()?;
    } else {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(dir.join("SKILL.md"), SKILL).ok()?;
    }
    std::fs::write(root.join("routines.md"), routines::INSTRUCTIONS).ok()?;
    std::fs::write(root.join("terminal.md"), terminal::INSTRUCTIONS).ok()?;
    std::fs::write(root.join("worktrees.md"), worktrees::INSTRUCTIONS).ok()?;
    Some(root)
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    set_blocked(&config.blocked);
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let port = match mcp::serve(app, token.clone()) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[desktop] {}", e);
            0
        }
    };
    let subagent = config.subagent;
    let skills = write_skill(app, subagent);
    let browser_injected = config.browser;
    if browser_injected {
        browser::prepare(app);
    }
    app.manage(DesktopState { config: Mutex::new(config), port, token, activity: Mutex::new(VecDeque::new()), skills, browser_injected, subagent });
}

const PC_DESCRIPTION: &str = "Maneja la PC del usuario: apps de Windows (Excel, el Explorador de archivos, instaladores, apps de escritorio) y su Chrome con las sesiones iniciadas (Gmail, Meta Business, consolas web). Usalo para cualquier tarea que necesite una interfaz gráfica, ver la pantalla o una web donde el usuario ya inició sesión: vos no tenés esas herramientas. Pasale la tarea completa, con los datos que necesita, y qué tiene que devolverte. Si antes de algo irreversible hace falta que el usuario confirme, te lo devuelve para que le preguntes vos.";

const PC_PROMPT: &str = "Sos el subagente de GuilleCode que maneja la PC del usuario. Recibís una tarea del agente principal; el usuario no ve esta conversación ni te puede contestar.

- Hacé la tarea con las herramientas desktop_* y browser_*, siguiendo la guía de abajo.
- Antes de algo irreversible (enviar, pagar, borrar, publicar, comprar) que la tarea no autorice de forma explícita, no lo hagas: terminá y devolvé qué falta confirmar y qué vas a hacer, para que el agente principal le pregunte al usuario. Esto reemplaza la regla de la guía sobre la herramienta de preguntas.
- Si el control está apagado o pausado, o algo falla dos veces de la misma forma, pará y explicá qué viste.
- Al terminar, respondé con un resumen corto: qué hiciste, cómo quedó la pantalla y los datos que te pidieron. Es lo único que ve el agente principal.

";

fn pc_prompt() -> String {
    let guide = SKILL.trim_start().strip_prefix("---").and_then(|rest| rest.split_once("---")).map(|(_, body)| body).unwrap_or(SKILL);
    format!("{}{}", PC_PROMPT, guide.trim())
}

pub fn opencode_config(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<DesktopState>()?;
    if state.port == 0 {
        return None;
    }
    let mut config = agent_config(&state);
    crate::memory::extend_config(app, &mut config);
    Some(config.to_string())
}

fn agent_config(state: &DesktopState) -> Value {
    let server = |path: &str, timeout: u64| {
        json!({
            "type": "remote",
            "url": format!("http://127.0.0.1:{}/mcp/{}", state.port, path),
            "headers": { "Authorization": format!("Bearer {}", state.token) },
            "oauth": false,
            "timeout": timeout,
        })
    };
    let mut mcp = json!({ "desktop": server("desktop", 120_000), "routines": server("routines", 120_000), "terminal": server("terminal", 660_000), "worktrees": server("worktrees", 120_000), "memory": server("memory", 120_000) });
    if state.browser_injected {
        mcp["browser"] = server("browser", 180_000);
    }
    let mut config = json!({ "mcp": mcp });
    if state.subagent {
        config["permission"] = json!({ "desktop_*": "deny", "browser_*": "deny" });
        config["agent"] = json!({
            "pc": {
                "mode": "subagent",
                "description": PC_DESCRIPTION,
                "prompt": pc_prompt(),
                "permission": { "desktop_*": "allow", "browser_*": "allow", "task": "deny" },
            }
        });
    }
    if let Some(dir) = &state.skills {
        config["skills"] = json!({ "paths": [dir.to_string_lossy()] });
        config["instructions"] = json!([dir.join("routines.md").to_string_lossy(), dir.join("terminal.md").to_string_lossy(), dir.join("worktrees.md").to_string_lossy()]);
    }
    config
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
    listed_reason(w)
}

#[cfg(windows)]
pub fn listed_reason(w: &win::WinInfo) -> Option<String> {
    let process = w.process.to_lowercase();
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
        "ready" if s.connecting => "esperando la conexión con Chrome; aceptá «Permitir» en Chrome si lo pide".into(),
        "ready" if s.connected => format!("Chrome conectado ({} herramientas browser_*)", s.tools),
        "ready" => format!("Chrome DevTools listo, conexión con Chrome sin verificar{}", s.error.map(|e| format!(": {}", e)).unwrap_or_default()),
        "starting" => "arrancando".into(),
        "error" => format!("con error: {}", s.error.unwrap_or_default()),
        _ => "sin iniciar (arranca solo al usarlo)".into(),
    }
}

fn instructions(channel: Channel) -> &'static str {
    match channel {
        Channel::Desktop => "Maneja apps de Windows por accesibilidad. Ciclo: status → windows → snapshot o find (refs [eN]) → click/type/select por ref → leer lo que cambió (cada acción devuelve solo el diff; las refs se mantienen). wait para esperar cargas o diálogos; steps para varias acciones en una llamada. Apps sin árbol: screen_text (OCR, refs [tN]) y click con esa ref; screenshot y click_xy como último recurso. Con la PC bloqueada solo funcionan las acciones por accesibilidad. Para la web usá las herramientas browser_*.",
        Channel::Browser => "Maneja el Chrome real del usuario, con sus sesiones iniciadas, mediante Chrome DevTools MCP autoConnect (sin extensión ni token). Primero browser_list_pages y elegí la pestaña por URL; pasá su pageId en las acciones. browser_take_snapshot da uid para click/fill/fill_form; usá siempre el snapshot más reciente de esa página. Para leer texto o encadenar operaciones DOM usá browser_evaluate_script. Chrome 144+ debe tener habilitado chrome://inspect/#remote-debugging; si pide permiso lo acepta el usuario. Para barra, menús y diálogos nativos, usá desktop_* como respaldo. Si la conexión está denegada, apagada o pausada, no uses el respaldo para eludir esa decisión. Antes de enviar, pagar, borrar o publicar, confirmá con el usuario.",
        Channel::Routines => routines::INSTRUCTIONS,
        Channel::Terminal => terminal::INSTRUCTIONS,
        Channel::Worktrees => worktrees::INSTRUCTIONS,
        Channel::Memory => crate::memory::instructions(),
    }
}

fn tool_list(channel: Channel) -> Vec<Value> {
    match channel {
        #[cfg(windows)]
        Channel::Desktop => tools::definitions(),
        #[cfg(not(windows))]
        Channel::Desktop => Vec::new(),
        Channel::Browser => browser::tools(),
        Channel::Routines => routines::definitions(),
        Channel::Terminal => terminal::definitions(),
        Channel::Worktrees => worktrees::definitions(),
        Channel::Memory => crate::memory::tool_list(),
    }
}

fn browser_summary(name: &str, args: &Value) -> String {
    let pick = |k: &str| args[k].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let what = pick("element").or_else(|| pick("url")).or_else(|| pick("key")).or_else(|| pick("text").map(|t| format!("«{}»", t.chars().take(40).collect::<String>()))).or_else(|| args["pageId"].as_u64().map(|id| format!("pestaña {}", id)));
    match what {
        Some(w) => format!("{} · {}", name, w),
        None => name.to_string(),
    }
}

fn call_tool(app: &AppHandle, channel: Channel, name: &str, args: &Value) -> Value {
    match channel {
        Channel::Routines => routines::call(app, name, args),
        Channel::Terminal => terminal::call(app, name, args),
        Channel::Worktrees => worktrees::call(app, name, args),
        Channel::Memory => crate::memory::call_tool(app, name, args),
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
            if !config(app).browser {
                return json!({ "content": [{ "type": "text", "text": "Las herramientas del navegador están desactivadas." }], "isError": true });
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
                    json!({ "content": [{ "type": "text", "text": format!("El navegador no respondió: {}. Abrí Chrome 144+, habilitá chrome://inspect/#remote-debugging y aceptá el permiso de conexión en Chrome. Podés probarlo en GuilleCode → «Control de la PC».", e) }], "isError": true })
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
        subagent: c.subagent,
        subagent_active: state.subagent,
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
        if let Some(v) = patch.subagent {
            c.subagent = v;
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
    let c = config(app);
    // Turning the control (or the browser) off releases the persistent Node
    // bridge instead of keeping it alive until the app closes.
    if !c.enabled || c.paused || !c.browser { browser::stop(); }
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
pub async fn desktop_browser_restart(app: AppHandle) -> Result<browser::BridgeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gate(&app)?;
        if !config(&app).browser {
            return Err("Activá «Ofrecerle al agente las herramientas del navegador» y reiniciá GuilleCode.".into());
        }
        browser::stop();
        let result = browser::connect();
        record(&app, "browser", "list_pages", "Comprobar la conexión con Chrome", result.is_ok());
        result
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn desktop_browser_setup() -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| win::launch("chrome.exe", "chrome://inspect/#remote-debugging")).await.unwrap();
    #[cfg(not(windows))]
    Err("Abrí chrome://inspect/#remote-debugging en Chrome 144 o posterior.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(subagent: bool) -> DesktopState {
        DesktopState {
            config: Mutex::new(DesktopConfig::default()),
            port: 4242,
            token: "t".into(),
            activity: Mutex::new(VecDeque::new()),
            skills: None,
            browser_injected: true,
            subagent,
        }
    }

    #[test]
    fn subagent_gets_the_pc_tools_and_the_rest_do_not() {
        let config = agent_config(&state(true));
        assert_eq!(config["permission"]["desktop_*"], "deny");
        assert_eq!(config["permission"]["browser_*"], "deny");
        let pc = &config["agent"]["pc"];
        assert_eq!(pc["mode"], "subagent");
        assert_eq!(pc["permission"]["desktop_*"], "allow");
        assert_eq!(pc["permission"]["browser_*"], "allow");
        let prompt = pc["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("Sos el subagente"));
        assert!(prompt.contains("# Manejar la PC del usuario"));
        assert!(!prompt.contains("name: escritorio"));
        assert!(config["mcp"]["desktop"].is_object());
    }

    #[test]
    fn without_subagent_the_tools_stay_with_every_agent() {
        let config = agent_config(&state(false));
        assert!(config.get("permission").is_none());
        assert!(config.get("agent").is_none());
    }

    #[test]
    fn old_configs_turn_the_subagent_on() {
        let config: DesktopConfig = serde_json::from_str(r#"{"enabled":true,"browser":false}"#).unwrap();
        assert!(config.subagent);
    }
}
