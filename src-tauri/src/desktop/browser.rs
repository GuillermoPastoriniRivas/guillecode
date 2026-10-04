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

const PACKAGE: &str = "@playwright/mcp";
const VERSION: &str = "0.0.83";
const BRIDGE_ARGS: &[&str] = &["--extension", "--snapshot-mode", "none", "--timeout-settle", "250"];
const ACTION_TIMEOUT_MS: u64 = 5_000;
const RETRY_TIMEOUT_MS: u64 = 10_000;
const PREFIX: &str = "browser_";
const START_TIMEOUT: Duration = Duration::from_secs(150);
const CALL_TIMEOUT: Duration = Duration::from_secs(110);
const SNAPSHOT_LIMIT: usize = 24_000;
const RESULT_LIMIT: usize = 40_000;
const HINTS: &[(&str, &str)] = &[
    ("browser_snapshot", "En páginas grandes GuilleCode lo recorta por profundidad: para ubicar un elemento preferí browser_find, y para ver una sección pasá target con su ref."),
    ("browser_find", "Es la forma más rápida de ubicar un botón, campo o texto y su ref."),
    ("browser_fill_form", "Llena varios campos en una sola llamada."),
    ("browser_run_code_unsafe", "Usalo para encadenar varias acciones de la página en una sola llamada."),
];

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

fn dir_for(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("browser-bridge"))
}

fn bridge_dir() -> Option<PathBuf> {
    dir_for(crate::proc::app()?)
}

fn installed_cli(dir: &Path) -> Option<PathBuf> {
    let package = dir.join("node_modules").join(PACKAGE);
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(package.join("package.json")).ok()?).ok()?;
    let cli = package.join("cli.js");
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
    installed_cli(dir).ok_or_else(|| "npm terminó pero Playwright MCP no quedó instalado".to_string())
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
    cmd.args(BRIDGE_ARGS).arg("--timeout-action").arg(ACTION_TIMEOUT_MS.to_string());
    if let Some(dir) = dir.filter(|d| d.is_dir()) {
        cmd.arg("--output-dir").arg(dir.join("output")).current_dir(dir);
    }
    cmd
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
    let mut cmd = bridge_command();
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
    let known = bridge().inner.lock().unwrap().tools.iter().any(|t| t["name"].as_str() == Some(name));
    if known {
        name.to_string()
    } else {
        format!("{}{}", PREFIX, name)
    }
}

pub fn call(name: &str, arguments: Value) -> Result<Value, String> {
    ensure()?;
    let tool = original_name(name);
    let mut invoke = |tool: &str, arguments: &Value| request("tools/call", json!({ "name": tool, "arguments": arguments }), CALL_TIMEOUT);
    let result = with_retry(&tool, &arguments, &mut invoke)?;
    Ok(compact(&tool, &arguments, result))
}

type Invoke<'a> = dyn FnMut(&str, &Value) -> Result<Value, String> + 'a;

fn text_of(result: &Value) -> String {
    result["content"].as_array().map(|items| items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn failed(result: &Value) -> bool {
    result["isError"].as_bool().unwrap_or(false)
}

fn timed_out(result: &Value) -> bool {
    failed(result) && text_of(result).contains(&format!("Timeout {}ms exceeded", ACTION_TIMEOUT_MS))
}

fn set_action_timeout(invoke: &mut Invoke, ms: u64) -> bool {
    let code = format!(
        "async (page) => {{ const s = Object.getOwnPropertySymbols(page).find((x) => x.description === 'tabSymbol'); const tab = s && page[s]; if (!tab || !tab.actionTimeoutOptions) return false; tab.actionTimeoutOptions.timeout = {}; return true }}",
        ms
    );
    match invoke("browser_run_code_unsafe", &json!({ "code": code })) {
        Ok(r) => !failed(&r) && text_of(&r).contains("### Result\ntrue"),
        Err(_) => false,
    }
}

fn with_retry(tool: &str, arguments: &Value, invoke: &mut Invoke) -> Result<Value, String> {
    let first = invoke(tool, arguments)?;
    if !timed_out(&first) {
        return Ok(first);
    }
    let raised = set_action_timeout(invoke, RETRY_TIMEOUT_MS);
    let second = invoke(tool, arguments);
    if raised {
        set_action_timeout(invoke, ACTION_TIMEOUT_MS);
    }
    let mut second = second?;
    let retry_secs = (if raised { RETRY_TIMEOUT_MS } else { ACTION_TIMEOUT_MS }) / 1000;
    let note = if failed(&second) {
        format!("[GuilleCode] No respondió en {} s; se reintentó con {} s y volvió a fallar.", ACTION_TIMEOUT_MS / 1000, retry_secs)
    } else {
        format!("[GuilleCode] No respondió en {} s; se reintentó con {} s y funcionó.", ACTION_TIMEOUT_MS / 1000, retry_secs)
    };
    if let Some(item) = second["content"].as_array_mut().and_then(|items| items.iter_mut().find(|i| i["type"] == "text")) {
        let text = item["text"].as_str().unwrap_or_default();
        item["text"] = json!(format!("{}\n\n{}", note, text));
    }
    Ok(second)
}

fn compact(tool: &str, arguments: &Value, mut result: Value) -> Value {
    let by_depth = tool == "browser_snapshot" && arguments.get("depth").is_none();
    if let Some(items) = result["content"].as_array_mut() {
        for item in items.iter_mut().filter(|i| i["type"] == "text") {
            let Some(text) = item["text"].as_str() else { continue };
            let shorter = if by_depth { trim_snapshot(text, SNAPSHOT_LIMIT) } else { None }.or_else(|| truncate(text, RESULT_LIMIT));
            if let Some(shorter) = shorter {
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
        "{}\n\n[GuilleCode] Resultado recortado: tenía {} caracteres y se muestran los primeros {}. Pedí algo más específico: browser_find con un texto más preciso, browser_snapshot con target, o un evaluate que devuelva solo lo necesario.",
        kept,
        text.len(),
        kept.len()
    ))
}

fn trim_snapshot(text: &str, limit: usize) -> Option<String> {
    const OPEN: &str = "```yaml\n";
    if text.len() <= limit {
        return None;
    }
    let start = text.find(OPEN)? + OPEN.len();
    let end = text[start..].rfind("\n```").map(|i| start + i).unwrap_or(text.len());
    let (head, yaml, tail) = (&text[..start], &text[start..end], &text[end..]);
    let lines: Vec<(usize, &str)> = yaml.lines().map(|l| ((l.len() - l.trim_start_matches(' ').len()) / 2, l)).collect();
    let mut sizes: Vec<usize> = Vec::new();
    for (depth, line) in &lines {
        if sizes.len() <= *depth {
            sizes.resize(depth + 1, 0);
        }
        sizes[*depth] += line.len() + 1;
    }
    let budget = limit.saturating_sub(head.len() + tail.len() + 600);
    let mut total = 0;
    let mut depth = 0;
    for (d, size) in sizes.iter().enumerate() {
        if d > 0 && total + size > budget {
            break;
        }
        total += size;
        depth = d;
    }
    let kept = lines.iter().filter(|(d, _)| *d <= depth).map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
    let note = format!(
        "[GuilleCode] El snapshot completo tiene ~{} mil tokens: se muestran solo los primeros {} niveles del árbol, y las líneas que terminan en «:» tienen contenido oculto. Para ver una sección usá browser_snapshot con target=<ref>; para ubicar un texto, botón o campo usá browser_find; para leer el texto de la página usá browser_evaluate con () => document.body.innerText.",
        (text.len() / 4000).max(1),
        depth + 1
    );
    Some(format!("{}\n\n{}{}{}", note, head, cut_at(&kept, budget), tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(yaml: &str) -> String {
        format!("### Page\n- Page URL: https://x\n### Snapshot\n```yaml\n{}\n```\n", yaml)
    }

    fn reply(text: &str, error: bool) -> Value {
        json!({ "content": [{ "type": "text", "text": text }], "isError": error })
    }

    fn timeout_reply(ms: u64) -> Value {
        reply(&format!("### Error\nTimeoutError: browserBackend.callTool: Timeout {}ms exceeded.", ms), true)
    }

    fn scripted(replies: Vec<Value>) -> (std::rc::Rc<std::cell::RefCell<Vec<String>>>, impl FnMut(&str, &Value) -> Result<Value, String>) {
        let calls = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let seen = calls.clone();
        let mut replies = replies.into_iter();
        let invoke = move |tool: &str, args: &Value| {
            let ms = args["code"].as_str().and_then(|c| c.split("timeout = ").nth(1)).and_then(|r| r.split(';').next()).map(|ms| format!("({})", ms)).unwrap_or_default();
            seen.borrow_mut().push(format!("{}{}", tool, ms));
            Ok(replies.next().expect("una respuesta por llamada"))
        };
        (calls, invoke)
    }

    #[test]
    fn actions_that_answer_in_time_run_once() {
        let (calls, mut invoke) = scripted(vec![reply("ok", false)]);
        let r = with_retry("browser_click", &json!({}), &mut invoke).unwrap();
        assert_eq!(text_of(&r), "ok");
        assert_eq!(*calls.borrow(), vec!["browser_click"]);
    }

    #[test]
    fn an_action_timeout_retries_with_ten_seconds_and_restores_five() {
        let raised = reply("### Result\ntrue\n### Ran Playwright code", false);
        let (calls, mut invoke) = scripted(vec![timeout_reply(5000), raised.clone(), reply("clickeado", false), raised]);
        let r = with_retry("browser_click", &json!({ "target": "e3" }), &mut invoke).unwrap();
        assert_eq!(*calls.borrow(), vec!["browser_click", "browser_run_code_unsafe(10000)", "browser_click", "browser_run_code_unsafe(5000)"]);
        assert!(!failed(&r));
        assert!(text_of(&r).starts_with("[GuilleCode] No respondió en 5 s; se reintentó con 10 s y funcionó."));
        assert!(text_of(&r).ends_with("clickeado"));
    }

    #[test]
    fn a_second_timeout_is_reported_as_a_failure() {
        let raised = reply("### Result\ntrue", false);
        let (calls, mut invoke) = scripted(vec![timeout_reply(5000), raised.clone(), timeout_reply(10000), raised]);
        let r = with_retry("browser_type", &json!({}), &mut invoke).unwrap();
        assert_eq!(calls.borrow().len(), 4);
        assert!(failed(&r));
        assert!(text_of(&r).contains("se reintentó con 10 s y volvió a fallar"));
    }

    #[test]
    fn if_the_timeout_cannot_be_raised_it_retries_once_without_restoring() {
        let (calls, mut invoke) = scripted(vec![timeout_reply(5000), reply("### Result\nfalse", false), reply("ok", false)]);
        let r = with_retry("browser_hover", &json!({}), &mut invoke).unwrap();
        assert_eq!(*calls.borrow(), vec!["browser_hover", "browser_run_code_unsafe(10000)", "browser_hover"]);
        assert!(text_of(&r).contains("se reintentó con 5 s y funcionó"));
    }

    #[test]
    fn other_errors_and_navigation_timeouts_are_not_retried() {
        let (calls, mut invoke) = scripted(vec![timeout_reply(60000)]);
        assert!(failed(&with_retry("browser_navigate", &json!({}), &mut invoke).unwrap()));
        assert_eq!(calls.borrow().len(), 1);
        let (calls, mut invoke) = scripted(vec![reply("Ref e9 not found in the current page snapshot", true)]);
        with_retry("browser_click", &json!({}), &mut invoke).unwrap();
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn small_snapshots_pass_untouched() {
        let text = snapshot("- main [ref=e1]:\n  - button \"Ok\" [ref=e2]");
        assert!(trim_snapshot(&text, SNAPSHOT_LIMIT).is_none());
        assert!(truncate(&text, RESULT_LIMIT).is_none());
    }

    #[test]
    fn big_snapshots_keep_the_shallow_levels_and_valid_refs() {
        let mut yaml = String::from("- generic [ref=e1]:\n  - banner [ref=e2]:\n    - link \"Inicio\" [ref=e3]\n  - main [ref=e4]:\n");
        for i in 0..3000 {
            yaml.push_str(&format!("    - paragraph [ref=e{}]:\n      - text: contenido largo número {}\n", i + 10, i));
        }
        let text = snapshot(&yaml);
        let trimmed = trim_snapshot(&text, 4000).unwrap();
        assert!(trimmed.len() <= 4000, "{}", trimmed.len());
        assert!(trimmed.contains("- main [ref=e4]:"));
        assert!(trimmed.contains("[GuilleCode]"));
        assert!(trimmed.contains("Page URL: https://x"));
        assert!(trimmed.trim_end().ends_with("```"));
        assert!(!trimmed.contains("contenido largo"));
    }

    #[test]
    fn explicit_depth_is_respected_and_only_truncated() {
        let big = snapshot(&"- text: ñandú\n".repeat(5000));
        let result = compact("browser_snapshot", &json!({ "depth": 30 }), json!({ "content": [{ "type": "text", "text": big }] }));
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Resultado recortado"));
        assert!(text.len() < RESULT_LIMIT + 400);
    }

    #[test]
    fn other_tools_are_truncated_on_char_boundaries() {
        let text = "ñ".repeat(RESULT_LIMIT);
        let out = truncate(&text, RESULT_LIMIT).unwrap();
        assert!(out.starts_with('ñ'));
        assert!(out.contains("Resultado recortado"));
        let images = compact("browser_take_screenshot", &json!({}), json!({ "content": [{ "type": "image", "data": "x".repeat(RESULT_LIMIT * 2) }] }));
        assert_eq!(images["content"][0]["data"].as_str().unwrap().len(), RESULT_LIMIT * 2);
    }
}
