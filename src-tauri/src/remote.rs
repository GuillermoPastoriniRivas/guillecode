use crate::oc::basic_auth;
use crate::proc::hide_console;
use crate::{app_data_file, desktop, ensure_server, features, live, machine, push, recent_project_list, routines, usage, voice};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Cursor, Read};
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Request, Response, Server, StatusCode};

const DEFAULT_PORT: u16 = 7430;
const INDEX: &str = "pwa.html";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RemoteConfig {
    enabled: bool,
    port: u16,
    token: String,
}

pub struct RemoteState {
    config: Mutex<RemoteConfig>,
    server: Mutex<Option<Arc<Server>>>,
    error: Mutex<Option<String>>,
    prefs: Mutex<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    enabled: bool,
    running: bool,
    port: u16,
    token: String,
    tailscale_ip: Option<String>,
    tailscale_name: Option<String>,
    urls: Vec<String>,
    pwa_ready: bool,
    push_devices: usize,
    error: Option<String>,
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn load_config(app: &AppHandle) -> RemoteConfig {
    app_data_file(app, "remote.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| RemoteConfig { enabled: false, port: DEFAULT_PORT, token: new_token() })
}

fn save_config(app: &AppHandle, config: &RemoteConfig) {
    if let Some(path) = app_data_file(app, "remote.json") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

fn load_prefs(app: &AppHandle) -> serde_json::Value {
    app_data_file(app, "remote_prefs.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

pub fn is_enabled(app: &AppHandle) -> bool {
    app.state::<RemoteState>().config.lock().unwrap().enabled
}

pub fn access_valid(app: &AppHandle, token: &str) -> bool {
    let state = app.state::<RemoteState>();
    let config = state.config.lock().unwrap();
    config.enabled && !token.is_empty() && config.token == token
}

fn read_json(req: &mut Request) -> serde_json::Value {
    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null)
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == name).then(|| v.to_string())
    })
}

fn allowed_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback() || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback() || (s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0) || v6.to_ipv4_mapped().map(|m| allowed_peer(IpAddr::V4(m))).unwrap_or(false)
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn respond_json(req: Request, status: u16, body: serde_json::Value) {
    let data = serde_json::to_vec(&body).unwrap_or_default();
    let resp = Response::new(
        StatusCode(status),
        vec![header("Content-Type", "application/json"), header("Cache-Control", "no-store")],
        Cursor::new(data.clone()),
        Some(data.len()),
        None,
    );
    let _ = req.respond(resp);
}

fn respond_bytes(req: Request, content_type: &str, data: Vec<u8>) {
    let len = data.len();
    let resp = Response::new(StatusCode(200), vec![header("Content-Type", content_type), header("Cache-Control", "no-store")], Cursor::new(data), Some(len), None);
    let _ = req.respond(resp);
}

fn pwa_dir(app: &AppHandle) -> Option<PathBuf> {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist-pwa");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(source.clone());
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("dist-pwa"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        candidates.push(dir.join("dist-pwa"));
    }
    candidates.push(source);
    candidates.into_iter().find(|p| p.join(INDEX).is_file())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn serve_static(app: &AppHandle, req: Request, path: &str) {
    let Some(root) = pwa_dir(app) else {
        let _ = req.respond(Response::from_string("La app del celular no está compilada: corré npm run build:pwa").with_status_code(503));
        return;
    };
    let rel = path.trim_start_matches('/');
    let safe = Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)));
    let mut file = if rel.is_empty() || !safe { root.join(INDEX) } else { root.join(rel) };
    if !file.is_file() {
        file = root.join(INDEX);
    }
    let Ok(data) = std::fs::read(&file) else {
        let _ = req.respond(Response::from_string("no encontrado").with_status_code(404));
        return;
    };
    let cache = if file.ends_with(INDEX) || file.ends_with("sw.js") { "no-cache" } else { "public, max-age=604800" };
    let resp = Response::new(
        StatusCode(200),
        vec![header("Content-Type", content_type(&file)), header("Cache-Control", cache)],
        Cursor::new(data.clone()),
        Some(data.len()),
        None,
    );
    let _ = req.respond(resp);
}

fn proxy(app: &AppHandle, mut req: Request, target_path: &str) {
    if crate::updates::installing(app) && req.method().as_str() != "GET" {
        return respond_json(req, 503, json!({ "error": "GuilleCode se está actualizando. Reintentá cuando vuelva a abrirse." }));
    }
    let server = match ensure_server(app) {
        Ok(s) => s,
        Err(e) => return respond_json(req, 502, json!({ "error": e })),
    };
    let method = req.method().as_str().to_string();
    let mut body = Vec::new();
    let _ = req.as_reader().read_to_end(&mut body);
    let mut upstream = ureq::request(&method, &format!("{}{}", server.url, target_path))
        .set("Authorization", &basic_auth(&server))
        .timeout(Duration::from_secs(120));
    for h in req.headers() {
        let name = h.field.as_str().as_str().to_ascii_lowercase();
        if name == "content-type" || name == "accept" || name == "x-opencode-directory" {
            upstream = upstream.set(&name, h.value.as_str());
        }
    }
    let result = if body.is_empty() && method != "POST" && method != "PATCH" && method != "PUT" {
        upstream.call()
    } else {
        upstream.send_bytes(&body)
    };
    let resp = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return respond_json(req, 502, json!({ "error": e.to_string() })),
    };
    let status = resp.status();
    let ctype = resp.header("content-type").unwrap_or("application/json").to_string();
    let reader = resp.into_reader();
    let out = Response::new(StatusCode(status), vec![header("Content-Type", &ctype), header("Cache-Control", "no-store")], reader, None, None);
    let _ = req.respond(out);
}

fn hub_api(app: &AppHandle, mut req: Request, url: &str, path: &str) {
    let method = req.method().as_str().to_string();
    #[cfg(windows)]
    if path.starts_with("/hub/desktop/stream") {
        if method == "GET" && path == "/hub/desktop/stream/displays" {
            return respond_json(req, 200, desktop::stream::displays_json());
        }
        if method == "GET" && path == "/hub/desktop/stream" {
            let target = query_param(url, "target").filter(|s| !s.is_empty());
            let video = query_param(url, "mode").as_deref() != Some("jpeg");
            let max = query_param(url, "max").and_then(|s| s.parse().ok()).unwrap_or(1600);
            let fps = query_param(url, "fps").and_then(|s| s.parse().ok()).unwrap_or(30);
            return desktop::stream::serve(app, req, target, video, max, fps);
        }
        if method == "POST" && matches!(path, "/hub/desktop/stream/ack" | "/hub/desktop/stream/input") {
            let mut bytes = Vec::new();
            if Read::take(req.as_reader(), 65_537).read_to_end(&mut bytes).is_err() || bytes.len() > 65_536 {
                return respond_json(req, 413, json!({"error":"Lote demasiado grande"}));
            }
            let body = match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => v,
                Err(_) => return respond_json(req, 400, json!({"error":"JSON inválido"})),
            };
            let token = req.headers().iter().find(|h| h.field.equiv("Authorization")).and_then(|h| h.value.as_str().strip_prefix("Bearer ")).unwrap_or_default().to_string();
            let result = if path.ends_with("/ack") { desktop::stream::acknowledge(&body) } else { desktop::stream::control(app, &body, &token) };
            return match result {
                Ok(v) => respond_json(req, 200, v),
                Err(e) => respond_json(req, 409, json!({"error":e})),
            };
        }
    }
    if method == "GET" && path == "/hub/events" {
        return live::stream(app, req, query_param(url, "session").filter(|s| !s.is_empty()));
    }
    if method == "GET" && path == "/hub/info" {
        let current = ensure_server(app).map(|c| c.worktree).unwrap_or_default();
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let mut projects: Vec<String> = Vec::new();
        let mut labels = serde_json::Map::new();
        let mut bases = crate::windows::all_projects(app);
        bases.extend(recent_project_list(app));
        for base in bases.into_iter().filter(|p| !p.is_empty()) {
            if projects.iter().any(|q| norm(q) == norm(&base)) {
                continue;
            }
            let name = base.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
            projects.push(base.clone());
            for (root, label) in features::feature_roots(app, &base) {
                if projects.iter().any(|q| norm(q) == norm(&root)) {
                    continue;
                }
                labels.insert(root.clone(), json!(format!("{} · {}", name, label)));
                projects.push(root);
            }
        }
        let prefs = app.state::<RemoteState>().prefs.lock().unwrap().clone();
        return respond_json(
            req,
            200,
            json!({
                "current": current,
                "projects": projects,
                "labels": labels,
                "routines": routines::views(app),
                "errors": live::errors(app),
                "prefs": prefs,
                "voice": voice::ready(app),
                "desktop": desktop::status(app),
            }),
        );
    }
    if method == "GET" && path == "/hub/desktop" {
        return respond_json(req, 200, json!(desktop::status(app)));
    }
    if method == "POST" && path == "/hub/desktop" {
        let body = read_json(&mut req);
        return respond_json(req, 200, json!(desktop::apply_remote(app, &body)));
    }
    if method == "POST" && path == "/hub/desktop/stop" {
        let aborted = desktop::stop_all(app);
        return respond_json(req, 200, json!({ "aborted": aborted, "desktop": desktop::status(app) }));
    }
    if method == "GET" && path == "/hub/desktop/windows" {
        return respond_json(req, 200, desktop::windows_json());
    }
    if method == "GET" && path == "/hub/desktop/screen" {
        let window = query_param(url, "window").map(|w| w.replace("%20", " "));
        let max = query_param(url, "max").and_then(|m| m.parse::<u32>().ok()).unwrap_or(1600);
        return match desktop::screen_jpeg(window.as_deref(), max) {
            Ok(jpeg) => respond_bytes(req, "image/jpeg", jpeg),
            Err(e) => respond_json(req, 409, json!({ "error": e })),
        };
    }
    if method == "POST" && path.starts_with("/hub/routines/") && path.ends_with("/run") {
        let id = path.trim_start_matches("/hub/routines/").trim_end_matches("/run");
        return match routines::launch(app, id, true) {
            Ok(()) => respond_json(req, 200, json!({ "ok": true })),
            Err(e) => respond_json(req, 409, json!({ "error": e })),
        };
    }
    if method == "GET" && path == "/hub/usage" {
        let limits = app.state::<RemoteState>().prefs.lock().unwrap()["usageLimits"].clone();
        return match usage::go_snapshot() {
            Ok(g) => respond_json(req, 200, json!({ "provider": usage::GO_PROVIDER, "go": g, "limits": limits })),
            Err(e) => respond_json(req, 200, json!({ "provider": usage::GO_PROVIDER, "go": null, "limits": limits, "error": e })),
        };
    }
    if method == "GET" && path == "/hub/usage/chatgpt" {
        return match usage::chatgpt_snapshot() {
            Ok(u) => respond_json(req, 200, json!({ "usage": u })),
            Err(e) => respond_json(req, 200, json!({ "usage": null, "error": e })),
        };
    }
    if method == "GET" && path == "/hub/usage/chatgpt/resets" {
        return match usage::chatgpt_resets_snapshot() {
            Ok(r) => respond_json(req, 200, json!({ "resets": r })),
            Err(e) => respond_json(req, 200, json!({ "resets": null, "error": e })),
        };
    }
    if method == "POST" && path == "/hub/usage/chatgpt/resets/use" {
        let body = read_json(&mut req);
        let request_id = body["requestId"].as_str().unwrap_or_default();
        return match usage::chatgpt_use_reset_now(request_id, body["creditId"].as_str()) {
            Ok(outcome) => respond_json(req, 200, json!(outcome)),
            Err(e) => respond_json(req, 502, json!({ "error": e })),
        };
    }
    if method == "POST" && path == "/hub/transcribe" {
        let mime = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Content-Type"))
            .map(|h| h.value.as_str().to_string())
            .unwrap_or_default();
        let mut audio = Vec::new();
        let _ = Read::take(req.as_reader(), voice::MAX_BYTES as u64 + 1).read_to_end(&mut audio);
        if !voice::ready(app) {
            return respond_json(req, 409, json!({ "error": "Falta configurar la transcripción en la PC: GuilleCode → «Conectar el celular» → Audios" }));
        }
        return match voice::transcribe(app, &audio, &mime) {
            Ok(text) => respond_json(req, 200, json!({ "text": text })),
            Err(e) => respond_json(req, 502, json!({ "error": e })),
        };
    }
    if method == "GET" && path == "/hub/push/key" {
        return respond_json(req, 200, json!({ "key": push::public_key(app) }));
    }
    if method == "POST" && path == "/hub/push/subscribe" {
        let body = read_json(&mut req);
        return match push::subscribe(app, &body) {
            Ok(v) => respond_json(req, 200, v),
            Err(e) => respond_json(req, 400, json!({ "error": e })),
        };
    }
    if method == "POST" && path == "/hub/push/unsubscribe" {
        let body = read_json(&mut req);
        push::unsubscribe(app, body["endpoint"].as_str().unwrap_or_default());
        return respond_json(req, 200, json!({ "ok": true }));
    }
    if method == "POST" && path == "/hub/push/test" {
        let body = read_json(&mut req);
        let endpoint = body["endpoint"].as_str().unwrap_or_default().to_string();
        let notice = push::Notice {
            kind: push::Kind::Test,
            title: "GuilleCode".into(),
            body: "Así te va a llegar el aviso cuando el agente termine o te necesite.".into(),
            tag: "test".into(),
            url: "/".into(),
        };
        return match push::send(app, notice, Some(&endpoint)) {
            Ok(0) => respond_json(req, 404, json!({ "error": "este celular no está suscripto: volvé a activar las notificaciones" })),
            Ok(_) => respond_json(req, 200, json!({ "ok": true })),
            Err(e) => respond_json(req, 502, json!({ "error": e })),
        };
    }
    respond_json(req, 404, json!({ "error": "no existe" }))
}

fn handle(app: &AppHandle, req: Request) {
    let peer_ok = req.remote_addr().map(|a| allowed_peer(a.ip())).unwrap_or(false);
    if !peer_ok {
        let _ = req.respond(Response::from_string("solo por Tailscale o desde esta PC").with_status_code(403));
        return;
    }
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let needs_token = path.starts_with("/oc/") || path.starts_with("/hub/");
    if needs_token {
        let config = app.state::<RemoteState>().config.lock().unwrap().clone();
        if !config.enabled {
            return respond_json(req, 403, json!({"error":"El acceso remoto está apagado"}));
        }
        let token = config.token;
        let sent = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Authorization"))
            .map(|h| h.value.as_str().trim_start_matches("Bearer ").to_string())
            .unwrap_or_default();
        if sent != token {
            return respond_json(req, 401, json!({ "error": "token inválido: volvé a escanear el QR desde GuilleCode" }));
        }
    }
    if let Some(rest) = url.strip_prefix("/oc") {
        proxy(app, req, rest)
    } else if path.starts_with("/hub/") {
        hub_api(app, req, &url, &path)
    } else {
        serve_static(app, req, &path)
    }
}

fn start_server(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    if state.server.lock().unwrap().is_some() {
        return Ok(());
    }
    let port = state.config.lock().unwrap().port;
    let server = Arc::new(Server::http(("0.0.0.0", port)).map_err(|e| format!("no se pudo abrir el puerto {}: {}", port, e))?);
    *state.server.lock().unwrap() = Some(server.clone());
    let app_handle = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app_handle.clone();
            std::thread::spawn(move || handle(&app, req));
        }
    });
    Ok(())
}

fn stop_server(app: &AppHandle) {
    #[cfg(windows)]
    desktop::stream::disconnect_all();
    if let Some(server) = app.state::<RemoteState>().server.lock().unwrap().take() {
        server.unblock();
    }
    live::disconnect_all(app);
}

const TAILSCALE_PATHS: &[&str] = &["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"];

fn tailscale(args: &[&str]) -> Option<String> {
    TAILSCALE_PATHS.iter().find_map(|bin| {
        let mut cmd = Command::new(bin);
        cmd.args(args);
        hide_console(&mut cmd);
        let out = cmd.output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
}

fn serving_https(port: u16) -> bool {
    tailscale(&["serve", "status", "--json"])
        .map(|s| s.contains(&format!("127.0.0.1:{}", port)) || s.contains(&format!("localhost:{}", port)))
        .unwrap_or(false)
}

fn status(app: &AppHandle) -> RemoteStatus {
    let state = app.state::<RemoteState>();
    let config = state.config.lock().unwrap().clone();
    let running = state.server.lock().unwrap().is_some();
    let error = state.error.lock().unwrap().clone();
    let tailscale_ip = tailscale(&["ip", "-4"]).and_then(|s| s.lines().next().map(|l| l.trim().to_string())).filter(|s| !s.is_empty());
    let tailscale_name = tailscale(&["status", "--json"])
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["Self"]["DNSName"].as_str().map(|n| n.trim_end_matches('.').to_string()))
        .filter(|s| !s.is_empty());
    let mut urls = Vec::new();
    let https = tailscale_name.as_ref().map(|name| format!("https://{}/?t={}", name, config.token));
    let https_first = https.is_some() && serving_https(config.port);
    if https_first {
        urls.extend(https.clone());
    }
    if let Some(ip) = &tailscale_ip {
        urls.push(format!("http://{}:{}/?t={}", ip, config.port, config.token));
    }
    if !https_first {
        urls.extend(https);
    }
    urls.push(format!("http://localhost:{}/?t={}", config.port, config.token));
    RemoteStatus {
        enabled: config.enabled,
        running,
        port: config.port,
        token: config.token,
        tailscale_ip,
        tailscale_name,
        urls,
        pwa_ready: pwa_dir(app).is_some(),
        push_devices: push::device_count(app),
        error,
    }
}

pub fn start(app: &AppHandle) {
    let config = load_config(app);
    save_config(app, &config);
    let enabled = config.enabled;
    let prefs = load_prefs(app);
    app.manage(RemoteState { config: Mutex::new(config), server: Mutex::new(None), error: Mutex::new(None), prefs: Mutex::new(prefs) });
    if enabled {
        if let Err(e) = start_server(app) {
            *app.state::<RemoteState>().error.lock().unwrap() = Some(e);
        }
    }
    machine::keep_awake(enabled);
}

#[tauri::command]
pub async fn remote_status(app: AppHandle) -> RemoteStatus {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.unwrap()
}

#[tauri::command]
pub async fn remote_set_enabled(app: AppHandle, enabled: bool) -> RemoteStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RemoteState>();
        state.config.lock().unwrap().enabled = enabled;
        save_config(&app, &state.config.lock().unwrap());
        *state.error.lock().unwrap() = None;
        if enabled {
            if let Err(e) = start_server(&app) {
                *state.error.lock().unwrap() = Some(e);
            }
        } else {
            stop_server(&app);
        }
        machine::keep_awake(enabled);
        status(&app)
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn remote_regenerate_token(app: AppHandle) -> RemoteStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RemoteState>();
        state.config.lock().unwrap().token = new_token();
        save_config(&app, &state.config.lock().unwrap());
        live::disconnect_all(&app);
        #[cfg(windows)]
        desktop::stream::disconnect_all();
        status(&app)
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn remote_set_prefs(app: AppHandle, prefs: serde_json::Value) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RemoteState>();
        let mut current = state.prefs.lock().unwrap();
        match (current.as_object_mut(), prefs.as_object()) {
            (Some(existing), Some(incoming)) => {
                for (key, value) in incoming {
                    existing.insert(key.clone(), value.clone());
                }
            }
            _ => *current = prefs,
        }
        if let Some(path) = app_data_file(&app, "remote_prefs.json") {
            let _ = std::fs::write(path, serde_json::to_string_pretty(&*current).unwrap_or_default());
        }
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn remote_push_test(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let notice = push::Notice {
            kind: push::Kind::Test,
            title: "GuilleCode".into(),
            body: "Prueba desde la PC: así te llega el aviso cuando el agente termina o te necesita.".into(),
            tag: "test".into(),
            url: "/".into(),
        };
        push::send(&app, notice, None)
    })
    .await
    .unwrap()
}

#[tauri::command]
pub fn remote_qr(text: String) -> Result<String, String> {
    let code = QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(svg::Color("#0a0d13"))
        .light_color(svg::Color("#ffffff"))
        .build())
}
