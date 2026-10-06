use crate::proc::hide_console;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

const PACKAGE: &str = "chrome-devtools-mcp";
const VERSION: &str = "1.10.1";
const BRIDGE_ARGS: &[&str] = &[
    "--autoConnect",
    "--no-usage-statistics",
    "--no-performance-crux",
    "--category-memory=false",
    "--category-performance=false",
];
const PREFIX: &str = "browser_";
const START_TIMEOUT: Duration = Duration::from_secs(150);
const CALL_TIMEOUT: Duration = Duration::from_secs(110);
const RESULT_LIMIT: usize = 40_000;
const HINTS: &[(&str, &str)] = &[
    ("list_pages", "Usalo primero para comprobar la conexión y elegir el pageId de la pestaña correcta. Chrome puede pedirle permiso al usuario."),
    ("take_snapshot", "Usá los uid del snapshot más reciente de ese pageId. Preferí verbose=false y no pidas un snapshot después de cada acción."),
    ("fill_form", "Llena varios campos en una sola llamada; pasá pageId y los uid del snapshot."),
    ("evaluate_script", "Para leer una página grande devolvé solo el texto necesario. Usá pageId para no actuar sobre otra pestaña."),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub state: &'static str,
    pub error: Option<String>,
    pub tools: usize,
    pub connected: bool,
    pub connecting: bool,
}

struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    tools: Vec<Value>,
    state: &'static str,
    error: Option<String>,
    connected: bool,
    connecting: bool,
    generation: u64,
}

struct Bridge {
    inner: Mutex<Inner>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next: Mutex<u64>,
    starting: Mutex<()>,
}

fn bridge() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| Bridge {
        inner: Mutex::new(Inner { child: None, stdin: None, tools: Vec::new(), state: "off", error: None, connected: false, connecting: false, generation: 0 }),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next: Mutex::new(0),
        starting: Mutex::new(()),
    })
}

pub fn status() -> BridgeStatus {
    let inner = bridge().inner.lock().unwrap();
    BridgeStatus { state: inner.state, error: inner.error.clone(), tools: inner.tools.len(), connected: inner.connected, connecting: inner.connecting }
}

fn kill_tree(child: &mut Child) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    let _ = cmd.status();
    let _ = child.kill();
    let _ = child.wait();
}

pub fn stop() {
    let b = bridge();
    let mut inner = b.inner.lock().unwrap();
    inner.generation += 1;
    inner.stdin = None;
    if let Some(mut child) = inner.child.take() {
        kill_tree(&mut child);
    }
    inner.state = "off";
    inner.error = None;
    inner.connected = false;
    inner.connecting = false;
    inner.tools.clear();
    b.pending.lock().unwrap().clear();
}

fn send_line(message: &Value) -> Result<(), String> {
    let mut inner = bridge().inner.lock().unwrap();
    let stdin = inner.stdin.as_mut().ok_or("el puente del navegador no está corriendo")?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("no pude hablar con Chrome DevTools: {}", e))
}

fn request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let b = bridge();
    let id = {
        let mut next = b.next.lock().unwrap();
        *next += 1;
        *next
    };
    let (tx, rx) = mpsc::channel();
    b.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = send_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
        b.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    let reply = rx.recv_timeout(timeout).map_err(|_| {
        b.pending.lock().unwrap().remove(&id);
        format!("Chrome DevTools no respondió a {} a tiempo. Si Chrome está esperando permiso, aceptá la conexión y volvé a probar", method)
    })?;
    if let Some(error) = reply.get("error") {
        return Err(error["message"].as_str().unwrap_or("error de Chrome DevTools").to_string());
    }
    Ok(reply["result"].clone())
}

fn dir_for(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("browser-bridge"))
}

fn bridge_dir() -> Option<PathBuf> {
    dir_for(crate::proc::app()?)
}

fn installed_cli(dir: &Path) -> Option<PathBuf> {
    let package = dir.join("node_modules").join(PACKAGE);
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?).ok()?;
    let cli = package.join("build/src/bin/chrome-devtools-mcp.js");
    (manifest["version"].as_str() == Some(VERSION) && cli.is_file()).then_some(cli)
}

fn install(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut dependencies = serde_json::Map::new();
    dependencies.insert(PACKAGE.to_string(), json!(VERSION));
    let manifest = json!({ "private": true, "dependencies": dependencies });
    std::fs::write(dir.join("package.json"), manifest.to_string()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "npm", "install", "--no-audit", "--no-fund", "--loglevel=error"])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("no pude ejecutar npm (¿está instalado Node.js?): {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    installed_cli(dir).ok_or_else(|| "npm terminó pero Chrome DevTools MCP no quedó instalado".to_string())
}

fn ensure_installed(dir: &Path) -> Result<PathBuf, String> {
    static INSTALLING: Mutex<()> = Mutex::new(());
    let _guard = INSTALLING.lock().unwrap();
    match installed_cli(dir) {
        Some(cli) => Ok(cli),
        None => install(dir),
    }
}

pub fn prepare(app: &tauri::AppHandle) {
    let Some(dir) = dir_for(app) else { return };
    std::thread::spawn(move || {
        if let Err(e) = ensure_installed(&dir) {
            log::warn!("[browser] no pude instalar {}@{}: {}", PACKAGE, VERSION, e);
        }
    });
}

fn bridge_command() -> Command {
    let dir = bridge_dir();
    let cli = dir.as_deref().and_then(|d| match ensure_installed(d) {
        Ok(cli) => Some(cli),
        Err(e) => {
            log::warn!("[browser] no pude instalar {}@{}: {}", PACKAGE, VERSION, e);
            None
        }
    });
    let mut cmd = match cli {
        Some(cli) => {
            let mut cmd = Command::new("node");
            cmd.arg(cli);
            cmd
        }
        None => {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "npx", "-y", &format!("{}@{}", PACKAGE, VERSION)]);
            cmd
        }
    };
    cmd.args(BRIDGE_ARGS)
        .env("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS", "1")
        .env("CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY", "1")
        .env_remove("PLAYWRIGHT_MCP_EXTENSION_TOKEN");
    if let Some(dir) = dir.filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    cmd
}

fn launch() -> Result<(), String> {
    let b = bridge();
    let generation = {
        let mut inner = b.inner.lock().unwrap();
        inner.generation += 1;
        inner.state = "starting";
        inner.error = None;
        inner.generation
    };
    let mut cmd = bridge_command();
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("no pude ejecutar Chrome DevTools MCP (requiere Node.js 20.19+ o 22.12+): {}", e))?;
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let stderr = child.stderr.take().ok_or("sin stderr")?;
    let stdin = child.stdin.take().ok_or("sin stdin")?;
    {
        let mut inner = b.inner.lock().unwrap();
        inner.child = Some(child);
        inner.stdin = Some(stdin);
    }
    let pending = b.pending.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
            let Some(id) = message["id"].as_u64() else { continue };
            if message.get("result").is_none() && message.get("error").is_none() {
                continue;
            }
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(message);
            }
        }
        let b = bridge();
        let mut inner = b.inner.lock().unwrap();
        if inner.generation == generation {
            inner.state = "error";
            inner.error.get_or_insert_with(|| "el proceso de Chrome DevTools se cerró".into());
            inner.connected = false;
            inner.connecting = false;
            inner.stdin = None;
            inner.child = None;
            inner.tools.clear();
            b.pending.lock().unwrap().clear();
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            log::info!("[browser] {}", line);
            let b = bridge();
            let mut inner = b.inner.lock().unwrap();
            if inner.generation == generation && inner.state != "ready" {
                inner.error = Some(line);
            }
        }
    });
    let started = Instant::now();
    request(
        "initialize",
        json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "guillecode", "version": env!("CARGO_PKG_VERSION") } }),
        START_TIMEOUT,
    )?;
    send_line(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    let left = START_TIMEOUT.saturating_sub(started.elapsed()).max(Duration::from_secs(20));
    let listed = request("tools/list", json!({}), left)?;
    let tools = listed["tools"].as_array().cloned().unwrap_or_default();
    let mut inner = b.inner.lock().unwrap();
    inner.tools = tools;
    inner.state = "ready";
    inner.error = None;
    Ok(())
}

fn ensure() -> Result<(), String> {
    let b = bridge();
    if b.inner.lock().unwrap().state == "ready" {
        return Ok(());
    }
    let _guard = b.starting.lock().unwrap();
    if b.inner.lock().unwrap().state == "ready" {
        return Ok(());
    }
    stop();
    match launch() {
        Ok(()) => Ok(()),
        Err(e) => {
            let detail = {
                let mut inner = b.inner.lock().unwrap();
                inner.state = "error";
                let detail = inner.error.clone().filter(|d| !d.is_empty()).map(|d| format!("{} ({})", e, d)).unwrap_or(e);
                inner.error = Some(detail.clone());
                detail
            };
            stop_process_only();
            Err(detail)
        }
    }
}

fn stop_process_only() {
    let mut inner = bridge().inner.lock().unwrap();
    inner.stdin = None;
    if let Some(mut child) = inner.child.take() {
        kill_tree(&mut child);
    }
}

pub fn tools() -> Vec<Value> {
    if let Err(e) = ensure() {
        log::warn!("[browser] no se pudo iniciar Chrome DevTools MCP: {}", e);
        return Vec::new();
    }
    bridge()
        .inner
        .lock()
        .unwrap()
        .tools
        .iter()
        .map(|t| {
            let mut t = t.clone();
            let name = t["name"].as_str().unwrap_or_default().to_string();
            if let Some((_, hint)) = HINTS.iter().find(|(tool, _)| *tool == name) {
                t["description"] = json!(format!("{} {}", t["description"].as_str().unwrap_or_default(), hint));
            }
            t["name"] = json!(name.strip_prefix(PREFIX).unwrap_or(&name));
            t
        })
        .collect()
}

pub fn original_name(name: &str) -> String {
    name.strip_prefix(PREFIX).unwrap_or(name).to_string()
}

pub fn call(name: &str, arguments: Value) -> Result<Value, String> {
    ensure()?;
    let tool = original_name(name);
    let generation = {
        let mut inner = bridge().inner.lock().unwrap();
        if !inner.tools.iter().any(|t| t["name"].as_str() == Some(&tool)) {
            return Err(format!("Chrome DevTools no ofrece la herramienta {}", tool));
        }
        inner.connecting = !inner.connected;
        inner.error = None;
        inner.generation
    };
    // No repetir automáticamente una acción: un timeout puede ocurrir después del clic.
    let result = request("tools/call", json!({ "name": tool, "arguments": arguments }), CALL_TIMEOUT);
    {
        let mut inner = bridge().inner.lock().unwrap();
        if inner.generation == generation {
            inner.connecting = false;
            match &result {
                Ok(r) if !failed(r) => inner.connected = true,
                Ok(r) if !inner.connected || connection_failure(&text_of(r)) => {
                    inner.connected = false;
                    inner.error = Some(cut_at(&text_of(r), 1500).to_string());
                }
                Err(e) => {
                    inner.connected = false;
                    inner.error = Some(e.clone());
                }
                _ => {}
            }
        }
    }
    result.map(compact)
}

pub fn connect() -> Result<BridgeStatus, String> {
    let result = call("list_pages", json!({}))?;
    if failed(&result) {
        return Err(text_of(&result));
    }
    Ok(status())
}

fn text_of(result: &Value) -> String {
    result["content"].as_array().map(|items| items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn failed(result: &Value) -> bool {
    result["isError"].as_bool().unwrap_or(false)
}

fn connection_failure(text: &str) -> bool {
    ["Could not connect to Chrome", "Browser disconnected", "Connection closed", "ECONNREFUSED", "DevToolsActivePort"].iter().any(|part| text.contains(part))
}

fn compact(mut result: Value) -> Value {
    if let Some(items) = result["content"].as_array_mut() {
        for item in items.iter_mut().filter(|i| i["type"] == "text") {
            let Some(text) = item["text"].as_str() else { continue };
            if let Some(shorter) = truncate(text, RESULT_LIMIT) {
                item["text"] = json!(shorter);
            }
        }
    }
    result
}

fn cut_at(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn truncate(text: &str, limit: usize) -> Option<String> {
    if text.len() <= limit {
        return None;
    }
    let kept = cut_at(text, limit);
    Some(format!(
        "{}\n\n[GuilleCode] Resultado recortado: tenía {} bytes y se muestran los primeros {}. Usá browser_evaluate_script con pageId para leer solo la sección necesaria; en snapshots preferí verbose=false y en red usá pageSize.",
        kept,
        text.len(),
        kept.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Chrome 144+ with remote debugging enabled and the user's connection approval"]
    fn devtools_end_to_end() {
        stop();
        let listed = tools();
        assert!(listed.iter().any(|t| t["name"] == "list_pages"), "{}", status().error.unwrap_or_default());
        assert!(listed.iter().any(|t| t["name"] == "take_snapshot"));
        assert_eq!(status().state, "ready");
        assert!(!status().connected, "listing MCP tools must not claim Chrome is connected");
        println!("Chrome DevTools ready; allow the new Chrome connection if prompted.");
        let connected = connect();
        let checked = status();
        stop();
        assert!(connected.is_ok(), "{:?}", connected.err());
        assert!(checked.connected);
        assert!(!checked.connecting);
        assert!(checked.error.is_none());
        assert!(!status().connected);
    }

    #[test]
    fn routes_native_devtools_names_without_a_second_browser_prefix() {
        assert_eq!(original_name("list_pages"), "list_pages");
        assert_eq!(original_name("browser_list_pages"), "list_pages");
        assert_eq!(original_name("evaluate_script"), "evaluate_script");
    }

    #[test]
    fn browser_errors_are_distinct_from_stale_element_errors() {
        assert!(connection_failure("Could not connect to Chrome. Check chrome://inspect/#remote-debugging."));
        assert!(!connection_failure("Element with uid 3_4 not found"));
    }

    #[test]
    fn other_tools_are_truncated_on_char_boundaries() {
        let text = "ñ".repeat(RESULT_LIMIT);
        let out = truncate(&text, RESULT_LIMIT).unwrap();
        assert!(out.starts_with('ñ'));
        assert!(out.contains("Resultado recortado"));
        let images = compact(json!({ "content": [{ "type": "image", "data": "x".repeat(RESULT_LIMIT * 2) }] }));
        assert_eq!(images["content"][0]["data"].as_str().unwrap().len(), RESULT_LIMIT * 2);
    }
}
