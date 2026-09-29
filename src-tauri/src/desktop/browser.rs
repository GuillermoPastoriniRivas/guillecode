use crate::proc::hide_console;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const PACKAGE: &str = "@playwright/mcp@latest";
const PREFIX: &str = "browser_";
const START_TIMEOUT: Duration = Duration::from_secs(150);
const CALL_TIMEOUT: Duration = Duration::from_secs(110);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub state: &'static str,
    pub error: Option<String>,
    pub tools: usize,
}

struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    tools: Vec<Value>,
    state: &'static str,
    error: Option<String>,
    token: String,
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
        inner: Mutex::new(Inner { child: None, stdin: None, tools: Vec::new(), state: "off", error: None, token: String::new(), generation: 0 }),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next: Mutex::new(0),
        starting: Mutex::new(()),
    })
}

pub fn status() -> BridgeStatus {
    let inner = bridge().inner.lock().unwrap();
    BridgeStatus { state: inner.state, error: inner.error.clone(), tools: inner.tools.len() }
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
    inner.stdin = None;
    if let Some(mut child) = inner.child.take() {
        kill_tree(&mut child);
    }
    inner.state = "off";
    inner.tools.clear();
    b.pending.lock().unwrap().clear();
}

pub fn set_token(token: &str) {
    let changed = {
        let mut inner = bridge().inner.lock().unwrap();
        let changed = inner.token != token;
        inner.token = token.to_string();
        changed && inner.child.is_some()
    };
    if changed {
        stop();
    }
}

fn send_line(message: &Value) -> Result<(), String> {
    let mut inner = bridge().inner.lock().unwrap();
    let stdin = inner.stdin.as_mut().ok_or("el puente del navegador no está corriendo")?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("no pude hablar con Playwright: {}", e))
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
        format!("Playwright no respondió a {} a tiempo", method)
    })?;
    if let Some(error) = reply.get("error") {
        return Err(error["message"].as_str().unwrap_or("error de Playwright").to_string());
    }
    Ok(reply["result"].clone())
}

fn launch() -> Result<(), String> {
    let b = bridge();
    let (token, generation) = {
        let mut inner = b.inner.lock().unwrap();
        inner.generation += 1;
        inner.state = "starting";
        inner.error = None;
        (inner.token.clone(), inner.generation)
    };
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "npx", "-y", PACKAGE, "--extension"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !token.is_empty() {
        cmd.env("PLAYWRIGHT_MCP_EXTENSION_TOKEN", &token);
    }
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("no pude ejecutar npx (¿está instalado Node.js?): {}", e))?;
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
            inner.error.get_or_insert_with(|| "el proceso de Playwright se cerró".into());
            inner.stdin = None;
            inner.child = None;
            inner.tools.clear();
        }
        drop(inner);
        b.pending.lock().unwrap().clear();
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
        log::warn!("[browser] no se pudo iniciar Playwright MCP: {}", e);
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
            let name = t["name"].as_str().unwrap_or_default();
            t["name"] = json!(name.strip_prefix(PREFIX).unwrap_or(name));
            t
        })
        .collect()
}

pub fn original_name(name: &str) -> String {
    let known = bridge().inner.lock().unwrap().tools.iter().any(|t| t["name"].as_str() == Some(name));
    if known {
        name.to_string()
    } else {
        format!("{}{}", PREFIX, name)
    }
}

pub fn call(name: &str, arguments: Value) -> Result<Value, String> {
    ensure()?;
    request("tools/call", json!({ "name": original_name(name), "arguments": arguments }), CALL_TIMEOUT)
}
