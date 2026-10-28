//! App-owned WebView2 surfaces. Remote sites receive no Tauri capabilities.
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use serde_json::{json, Value};

pub(super) fn profile(session: &str) -> Result<PathBuf, String> {
    let id = session.strip_prefix("team:").ok_or("El navegador interno necesita un chat de equipo")?;
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("Identificador del equipo inválido".into());
    }
    crate::proc::app().ok_or("GuilleCode no está iniciado")?.path().app_local_data_dir()
        .map(|p| p.join("internal-browser").join(id)).map_err(|e| e.to_string())
}

pub(super) fn selected(session: &str) -> bool { profile(session).is_ok_and(|p| p.join("enabled").is_file()) }

fn safe_url(input: &str) -> Result<tauri::Url, String> {
    let input = input.trim();
    let input = if input.is_empty() { "about:blank".to_owned() } else if !input.contains("://") && input != "about:blank" { format!("https://{input}") } else { input.to_owned() };
    let url: tauri::Url = input.parse().map_err(|_| "La dirección no es válida")?;
    if !["http", "https"].contains(&url.scheme()) && url.as_str() != "about:blank" { return Err("Usá una página http o https".into()); }
    if !url.username().is_empty() || url.password().is_some() { return Err("Ingresá las credenciales desde la página".into()); }
    Ok(url)
}

pub(super) fn open(app: &tauri::AppHandle, session: &str, url: Option<&str>, new_page: bool) -> Result<Value, String> {
    let dir = profile(session)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = session.strip_prefix("team:").unwrap();
    let prefix = format!("internal-{id}-");
    if !new_page {
        if let Some((_, window)) = app.webview_windows().into_iter().find(|(label, _)| label.starts_with(&prefix)) {
            if let Some(url) = url { window.navigate(safe_url(url)?).map_err(|e| e.to_string())?; }
            let _ = window.unminimize(); let _ = window.show();
            return Ok(json!({"internal":true,"label":window.label()}));
        }
    }
    let initial = url.map(str::to_owned).or_else(|| std::fs::read_to_string(dir.join("last-url")).ok()).unwrap_or_default();
    let initial = safe_url(&initial)?;
    let label = format!("{prefix}{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let saved = dir.join("last-url");
    let popup_app = app.clone();
    let popup_session = session.to_string();
    WebviewWindowBuilder::new(app, &label, WebviewUrl::External(initial))
        .title("Navegador del equipo — GuilleCode")
        .inner_size(1100.0, 780.0).min_inner_size(480.0, 320.0)
        .data_directory(dir.join("profile"))
        .additional_browser_args("--remote-debugging-port=0 --remote-debugging-address=127.0.0.1")
        .focused(false).disable_drag_drop_handler()
        .on_new_window(move |url, _| {
            let handle = popup_app.clone(); let session = popup_session.clone();
            std::thread::spawn(move || { if let Err(e) = open(&handle, &session, Some(url.as_str()), true) { log::warn!("[internal-browser] popup: {e}"); } });
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            let allowed = ["https", "http"].contains(&url.scheme()) || url.as_str() == "about:blank";
            if allowed { let _ = std::fs::write(&saved, url.as_str()); }
            allowed
        })
        .build().map_err(|e| format!("No pude abrir el navegador del equipo: {e}"))?;
    std::fs::write(dir.join("enabled"), "1").map_err(|e| e.to_string())?;
    Ok(json!({"internal":true,"label":label}))
}

#[tauri::command]
pub async fn browser_internal_open(app: tauri::AppHandle, session: String, url: Option<String>) -> Result<Value, String> {
    super::gate(&app)?;
    if !super::config(&app).browser { return Err("Activá las herramientas del navegador en Control de la PC".into()); }
    tauri::async_runtime::spawn_blocking(move || open(&app, &session, url.as_deref(), false)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_internal_control(app: tauri::AppHandle, session: String, action: String) -> Result<(), String> {
    profile(&session)?;
    let prefix = format!("internal-{}-", session.trim_start_matches("team:"));
    let window = app.webview_windows().into_iter().find(|(label,_)| label.starts_with(&prefix)).map(|(_,w)|w).ok_or("Abrí el navegador interno del equipo primero")?;
    match action.as_str() {
        "show" => { let _ = window.unminimize(); window.show().and_then(|_|window.set_focus()).map_err(|e| e.to_string()) },
        "back" => window.eval("history.back()" ).map_err(|e| e.to_string()),
        "forward" => window.eval("history.forward()" ).map_err(|e| e.to_string()),
        "reload" => window.eval("location.reload()" ).map_err(|e| e.to_string()),
        _ => Err("Acción de navegador desconocida".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_privileged_schemes_and_embedded_credentials() {
        for input in ["file:///C:/secret", "javascript://alert(1)", "data://text/html,hi", "https://user:pass@example.org"] { assert!(safe_url(input).is_err(), "{input}"); }
        assert_eq!(safe_url("example.org").unwrap().as_str(), "https://example.org/");
        assert!(safe_url("http://127.0.0.1:4317").is_ok());
    }

    #[cfg(feature = "desktop-e2e")]
    #[test]
    #[ignore = "real isolated WebView2 + Chrome DevTools MCP; installs pinned MCP into test profile"]
    fn internal_browser_native() {
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let _ = stream.read(&mut [0u8; 4096]);
                let html = "<!doctype html><title>Prueba interna GuilleCode</title><h1>Navegador del equipo</h1><button onclick=\"document.querySelector('p').textContent='Hola desde el navegador interno'\">Saludar</button><p>Esperando</p>";
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
            }
        });
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = format!("com.guillecode.internal-test-{}", uuid::Uuid::new_v4().simple());
        context.config_mut().app.windows.clear();
        let mut app = tauri::Builder::default().any_thread().build(context).unwrap();
        crate::proc::install(app.handle().clone());
        let handle = app.handle().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let session = "team:native-browser-test";
                open(&handle, session, Some(&url), false).unwrap();
                let dir = profile(session).unwrap();
                let deadline = Instant::now() + Duration::from_secs(20);
                while !dir.join("profile/EBWebView/DevToolsActivePort").is_file() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(100)); }
                assert!(dir.join("profile/EBWebView/DevToolsActivePort").is_file(), "missing DevToolsActivePort in {}", dir.display());
                let call = |name: &str, args| super::super::browser::call_session("worker", session, name, args).unwrap();
                let listing = call("list_pages", json!({}));
                assert_ne!(listing["isError"], true, "{listing}");
                let text = listing["content"].as_array().unwrap().iter().filter_map(|p|p["text"].as_str()).collect::<Vec<_>>().join("\n");
                let page = text.lines().find_map(|line| line.trim().split_once(": ").and_then(|(id, rest)| rest.contains(&url).then(||id.parse::<u64>().ok()).flatten())).expect(&text);
                let snapshot = call("take_snapshot", json!({"pageId":page}));
                assert_ne!(snapshot["isError"], true, "{snapshot}");
                let snapshot_text = snapshot.to_string();
                assert!(snapshot_text.contains("Saludar"), "{snapshot}");
                let text = snapshot["content"].as_array().unwrap().iter().filter_map(|p|p["text"].as_str()).collect::<Vec<_>>().join("\n");
                let uid = regex::Regex::new(r#"uid=([^\s]+) button "Saludar""#).unwrap().captures(&text).expect(&text)[1].to_owned();
                let clicked = call("click", json!({"pageId":page,"uid":uid}));
                assert_ne!(clicked["isError"], true, "{clicked}");
                let observed = call("evaluate_script", json!({"pageId":page,"function":"() => document.body.innerText"}));
                assert!(observed.to_string().contains("Hola desde el navegador interno"), "{observed}");
                let created = call("new_page", json!({"url": format!("{url}second")}));
                assert_ne!(created["isError"], true, "{created}");
                let listed = call("list_pages", json!({}));
                assert!(listed.to_string().contains("second"), "{listed}");
                let other = "team:other-native-team";
                open(&handle, other, Some("about:blank"), false).unwrap();
                std::thread::sleep(Duration::from_millis(800));
                let separate = super::super::browser::call_session("other-worker", other, "list_pages", json!({})).unwrap();
                assert_ne!(separate["isError"], true, "{separate}");
                assert!(!separate.to_string().contains(&url), "another team must never see the first team's targets: {separate}");
                super::super::browser::stop_all();
                assert_ne!(call("list_pages", json!({}))["isError"], true);
                println!("PASS: real WebView2 isolated profile, MCP listing, snapshot, button click, observed result, new page, two team isolation, bridge reconnection");
            }));
            super::super::browser::stop_all();
            for (_, window) in handle.webview_windows() { let _ = window.destroy(); }
            let _ = tx.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            app.run_iteration(|_, _| {});
            if let Ok(result) = rx.try_recv() { if let Err(e) = result { std::panic::resume_unwind(e); } break; }
            assert!(Instant::now() < deadline, "native browser test timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
