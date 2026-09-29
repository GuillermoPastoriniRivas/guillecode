use crate::oc::{basic_auth, Opencode};
use crate::push::{self, Kind, Notice};
use crate::{ensure_server, remote};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tiny_http::Request;

const HEARTBEAT: Duration = Duration::from_secs(15);
const HELPER_PREFIX: &str = "guillecode·";

const FORWARDED: &[&str] = &[
    "session.created",
    "session.updated",
    "session.deleted",
    "session.status",
    "session.idle",
    "session.error",
    "permission.asked",
    "permission.replied",
    "question.asked",
    "question.replied",
    "question.rejected",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.delta",
    "message.part.removed",
];

#[derive(Clone, Default)]
struct Meta {
    title: String,
    parent: Option<String>,
    directory: String,
}

#[derive(Default)]
struct Mark {
    busy: bool,
    error: Option<String>,
    directory: String,
}

struct Subscriber {
    id: u64,
    session: Option<String>,
    tx: Sender<String>,
}

#[derive(Default)]
pub struct LiveState {
    subscribers: Mutex<Vec<Subscriber>>,
    next_id: Mutex<u64>,
    marks: Mutex<HashMap<String, Mark>>,
    meta: Mutex<HashMap<String, Meta>>,
}

pub fn start(app: &AppHandle) {
    app.manage(LiveState::default());
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = follow(&app) {
            log::warn!("[live] se cortó el stream de opencode: {}", e);
        }
        broadcast(&app, None, &json!({ "type": "resync" }).to_string());
        std::thread::sleep(Duration::from_millis(1500));
    });
}

fn follow(app: &AppHandle) -> Result<(), String> {
    let server = ensure_server(app)?;
    let resp = ureq::get(&format!("{}/global/event", server.url))
        .set("Authorization", &basic_auth(&server))
        .set("Accept", "text/event-stream")
        .call()
        .map_err(|e| e.to_string())?;
    let reader = BufReader::new(resp.into_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else { continue };
        handle(app, &event);
    }
    Err("opencode cerró la conexión".into())
}

fn session_of(props: &Value) -> Option<String> {
    props["sessionID"]
        .as_str()
        .or_else(|| props["info"]["sessionID"].as_str())
        .or_else(|| props["part"]["sessionID"].as_str())
        .map(|s| s.to_string())
}

fn handle(app: &AppHandle, event: &Value) {
    let payload = &event["payload"];
    let kind = payload["type"].as_str().unwrap_or_default();
    let props = &payload["properties"];
    let directory = event["directory"].as_str().unwrap_or_default().to_string();
    if kind == "server.connected" {
        broadcast(app, None, &json!({ "type": "resync" }).to_string());
        return;
    }
    if !FORWARDED.contains(&kind) {
        return;
    }
    track(app, kind, props, &directory);
    let message = json!({ "directory": directory, "type": kind, "properties": props }).to_string();
    let target = if kind.starts_with("message.") { Some(session_of(props).unwrap_or_default()) } else { None };
    broadcast(app, target.as_deref(), &message);
}

fn track(app: &AppHandle, kind: &str, props: &Value, directory: &str) {
    let state = app.state::<LiveState>();
    match kind {
        "session.created" | "session.updated" => {
            let info = &props["info"];
            if let Some(id) = info["id"].as_str() {
                state.meta.lock().unwrap().insert(
                    id.to_string(),
                    Meta {
                        title: info["title"].as_str().unwrap_or_default().to_string(),
                        parent: info["parentID"].as_str().map(|s| s.to_string()),
                        directory: info["directory"].as_str().unwrap_or(directory).to_string(),
                    },
                );
            }
        }
        "session.deleted" => {
            if let Some(id) = props["info"]["id"].as_str() {
                state.meta.lock().unwrap().remove(id);
                state.marks.lock().unwrap().remove(id);
            }
        }
        "session.status" => {
            let Some(id) = props["sessionID"].as_str() else { return };
            if props["status"]["type"].as_str() == Some("idle") {
                finish(app, id, directory);
            } else {
                let mut marks = state.marks.lock().unwrap();
                let mark = marks.entry(id.to_string()).or_default();
                if !mark.busy {
                    mark.error = None;
                }
                mark.busy = true;
                if !directory.is_empty() {
                    mark.directory = directory.to_string();
                }
            }
        }
        "session.idle" => {
            if let Some(id) = props["sessionID"].as_str() {
                finish(app, id, directory);
            }
        }
        "session.error" => {
            let err = &props["error"];
            if err["name"].as_str() == Some("MessageAbortedError") {
                return;
            }
            let Some(id) = props["sessionID"].as_str() else { return };
            let text = err["data"]["message"].as_str().or_else(|| err["name"].as_str()).unwrap_or("error desconocido").to_string();
            state.marks.lock().unwrap().entry(id.to_string()).or_default().error = Some(text.clone());
            notify(app, Kind::Error, id, directory, format!("Falló: {}", text));
        }
        "permission.asked" => {
            let Some(id) = props["sessionID"].as_str() else { return };
            let what = props["permission"].as_str().unwrap_or("una acción");
            let pattern = props["patterns"].as_array().and_then(|p| p.first()).and_then(|p| p.as_str()).unwrap_or_default();
            let body = if pattern.is_empty() { format!("Pide permiso: {}", what) } else { format!("Pide permiso: {} · {}", what, pattern) };
            notify(app, Kind::Attention, id, directory, body);
        }
        "question.asked" => {
            let Some(id) = props["sessionID"].as_str() else { return };
            let question = props["questions"][0]["question"].as_str().unwrap_or("Tiene una pregunta");
            notify(app, Kind::Attention, id, directory, format!("Te pregunta: {}", question));
        }
        _ => {}
    }
}

fn finish(app: &AppHandle, id: &str, directory: &str) {
    let failed = {
        let state = app.state::<LiveState>();
        let mut marks = state.marks.lock().unwrap();
        let mark = marks.entry(id.to_string()).or_default();
        if !mark.busy {
            return;
        }
        mark.busy = false;
        mark.error.is_some()
    };
    if !failed {
        notify(app, Kind::Done, id, directory, String::new());
    }
}

fn meta(app: &AppHandle, id: &str, directory: &str) -> Option<Meta> {
    if let Some(m) = app.state::<LiveState>().meta.lock().unwrap().get(id) {
        return Some(m.clone());
    }
    let server = ensure_server(app).ok()?;
    let info = Opencode::new(&server, directory).get(&format!("/session/{}", id)).ok()?;
    let m = Meta {
        title: info["title"].as_str().unwrap_or_default().to_string(),
        parent: info["parentID"].as_str().map(|s| s.to_string()),
        directory: info["directory"].as_str().unwrap_or(directory).to_string(),
    };
    app.state::<LiveState>().meta.lock().unwrap().insert(id.to_string(), m.clone());
    Some(m)
}

fn last_reply(app: &AppHandle, id: &str, directory: &str) -> Option<String> {
    let server = ensure_server(app).ok()?;
    let messages = Opencode::new(&server, directory).get(&format!("/session/{}/message?limit=1", id)).ok()?;
    let last = messages.as_array()?.last()?;
    let text = last["parts"]
        .as_array()?
        .iter()
        .filter(|p| p["type"] == "text" && p["synthetic"] != true)
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let clean: String = text.chars().filter(|c| !matches!(c, '#' | '*' | '`' | '>' | '|')).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then_some(clean)
}

fn desktop_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

fn project_name(directory: &str) -> String {
    directory.split(['\\', '/']).filter(|s| !s.is_empty()).last().unwrap_or(directory).to_string()
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

fn notify(app: &AppHandle, kind: Kind, id: &str, directory: &str, body: String) {
    if !remote::is_enabled(app) || push::device_count(app) == 0 {
        return;
    }
    let app = app.clone();
    let id = id.to_string();
    let directory = directory.to_string();
    std::thread::spawn(move || {
        if desktop_focused(&app) {
            return;
        }
        let Some(m) = meta(&app, &id, &directory) else { return };
        if m.title.starts_with(HELPER_PREFIX) {
            return;
        }
        let root = match (&m.parent, kind) {
            (Some(_), Kind::Done | Kind::Error) => return,
            (Some(parent), _) => parent.clone(),
            (None, _) => id.clone(),
        };
        let root_meta = if root == id { m.clone() } else { meta(&app, &root, &directory).unwrap_or_else(|| m.clone()) };
        let dir = if root_meta.directory.is_empty() { directory.clone() } else { root_meta.directory.clone() };
        let body = match kind {
            Kind::Done => last_reply(&app, &id, &dir).map(|t| format!("Terminó · {}", t)).unwrap_or_else(|| "Terminó".into()),
            _ => body,
        };
        let title = if root_meta.title.is_empty() { project_name(&dir) } else { format!("{} · {}", root_meta.title, project_name(&dir)) };
        push::send_in_background(
            &app,
            Notice { kind, title, body, tag: root.clone(), url: format!("/?p={}&s={}", encode(&dir), encode(&root)) },
        );
    });
}

pub fn busy_sessions(app: &AppHandle) -> Vec<(String, String)> {
    let state = app.state::<LiveState>();
    let marks = state.marks.lock().unwrap();
    marks.iter().filter(|(_, m)| m.busy && !m.directory.is_empty()).map(|(id, m)| (id.clone(), m.directory.clone())).collect()
}

#[tauri::command]
pub fn live_busy_sessions(app: AppHandle) -> Vec<String> {
    let state = app.state::<LiveState>();
    let marks = state.marks.lock().unwrap();
    marks.iter().filter(|(_, m)| m.busy).map(|(id, _)| id.clone()).collect()
}

pub fn errors(app: &AppHandle) -> Value {
    let marks = app.state::<LiveState>();
    let marks = marks.marks.lock().unwrap();
    let map: serde_json::Map<String, Value> = marks
        .iter()
        .filter_map(|(id, m)| m.error.as_ref().map(|e| (id.clone(), Value::String(e.clone()))))
        .collect();
    Value::Object(map)
}

fn broadcast(app: &AppHandle, session: Option<&str>, message: &str) {
    let state = app.state::<LiveState>();
    let mut subs = state.subscribers.lock().unwrap();
    subs.retain(|s| {
        if let Some(target) = session {
            if s.session.as_deref() != Some(target) {
                return true;
            }
        }
        s.tx.send(message.to_string()).is_ok()
    });
}

pub fn disconnect_all(app: &AppHandle) {
    app.state::<LiveState>().subscribers.lock().unwrap().clear();
}

pub fn stream(app: &AppHandle, req: Request, session: Option<String>) {
    let (tx, rx) = mpsc::channel::<String>();
    let state = app.state::<LiveState>();
    let id = {
        let mut next = state.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    state.subscribers.lock().unwrap().push(Subscriber { id, session, tx });
    let mut out = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n: ok\n\n";
    let mut alive = out.write_all(head.as_bytes()).and_then(|_| out.flush()).is_ok();
    while alive {
        let chunk = match rx.recv_timeout(HEARTBEAT) {
            Ok(first) => {
                let mut chunk = format!("data: {}\n\n", first);
                while let Ok(more) = rx.try_recv() {
                    chunk.push_str(&format!("data: {}\n\n", more));
                }
                chunk
            }
            Err(RecvTimeoutError::Timeout) => ": ping\n\n".to_string(),
            Err(RecvTimeoutError::Disconnected) => break,
        };
        alive = out.write_all(chunk.as_bytes()).and_then(|_| out.flush()).is_ok();
    }
    state.subscribers.lock().unwrap().retain(|s| s.id != id);
}
