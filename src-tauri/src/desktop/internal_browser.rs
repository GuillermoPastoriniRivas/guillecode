//! App-owned WebView2 surfaces. Remote sites receive no Tauri capabilities.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{webview::WebviewBuilder, Manager, WebviewUrl};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page {
    pub label: String,
    pub session: String,
    pub actor: String,
    pub url: String,
    pub marker: String,
    pub claimed: bool,
}
#[derive(Default)]
struct Registry {
    pages: Vec<Page>,
    hosts: HashMap<String, String>,
    generations: HashMap<String, u64>,
}
fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}
#[derive(Clone, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub(super) fn profile(session: &str) -> Result<PathBuf, String> {
    let folder = match session.strip_prefix("team:") {
        Some(id) => {
            if id.is_empty() || id.len() > 80 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                return Err("Identificador del equipo inválido".into());
            }
            id.to_string()
        }
        // Chats normales: cada conversación tiene su propio perfil interno e
        // independiente del Chrome personal. El nombre se deriva del hash para
        // aceptar cualquier id de sesión.
        None => {
            if session.is_empty() || session.len() > 200 {
                return Err("Identificador de chat inválido".into());
            }
            format!("chat-{}", actor_key(session))
        }
    };
    crate::proc::app()
        .ok_or("GuilleCode no está iniciado")?
        .path()
        .app_local_data_dir()
        .map(|p| p.join("internal-browser").join(folder))
        .map_err(|e| e.to_string())
}

pub(super) fn selected(session: &str) -> bool {
    profile(session).is_ok_and(|p| p.join("enabled").is_file())
}

fn safe_url(input: &str) -> Result<tauri::Url, String> {
    let input = input.trim();
    let input = if input.is_empty() {
        "about:blank".to_owned()
    } else if !input.contains("://") && input != "about:blank" {
        format!("https://{input}")
    } else {
        input.to_owned()
    };
    let url: tauri::Url = input.parse().map_err(|_| "La dirección no es válida")?;
    if !["http", "https"].contains(&url.scheme()) && url.as_str() != "about:blank" {
        return Err("Usá una página http o https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Ingresá las credenciales desde la página".into());
    }
    Ok(url)
}

fn actor_key(actor: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(actor.as_bytes()))[..24].to_string()
}

pub(super) fn open_actor(
    app: &tauri::AppHandle,
    session: &str,
    actor: &str,
    url: Option<&str>,
    new_page: bool,
) -> Result<Page, String> {
    let dir = profile(session)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !new_page {
        let prior = registry()
            .lock()
            .unwrap()
            .pages
            .iter()
            .find(|p| {
                p.session == session && p.actor == actor && app.get_webview(&p.label).is_some()
            })
            .cloned();
        if let Some(page) = prior {
            if let Some(url) = url {
                app.get_webview(&page.label)
                    .unwrap()
                    .navigate(safe_url(url)?)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(page);
        }
    }
    let host = registry()
        .lock()
        .unwrap()
        .hosts
        .get(session)
        .cloned()
        .unwrap_or_else(|| "main".into());
    let window = app
        .get_window(&host)
        .ok_or("Abrí el chat del equipo en una ventana de Flufy para usar su navegador")?;
    let marker = format!("about:blank#flufy-{}", uuid::Uuid::new_v4().simple());
    let initial = url
        .map(str::to_owned)
        .or_else(|| std::fs::read_to_string(dir.join(format!("{}.url", actor_key(actor)))).ok())
        .or_else(|| std::fs::read_to_string(dir.join("last-url")).ok())
        .unwrap_or_default();
    let initial = safe_url(&initial)?.to_string();
    let label = format!("internal-{}", uuid::Uuid::new_v4().simple());
    let page = Page {
        label: label.clone(),
        session: session.into(),
        actor: actor.into(),
        url: initial.clone(),
        marker: marker.clone(),
        claimed: false,
    };
    let save = dir.join(format!("{}.url", actor_key(actor)));
    let update_label = label.clone();
    let popup_app = app.clone();
    let popup_session = session.to_string();
    let popup_actor = actor.to_string();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(marker.parse().unwrap()))
        .data_directory(dir.join("profile"))
        .additional_browser_args("--remote-debugging-port=0 --remote-debugging-address=127.0.0.1")
        .focused(false)
        .disable_drag_drop_handler()
        .on_new_window(move |url, _| {
            let app = popup_app.clone();
            let session = popup_session.clone();
            let actor = popup_actor.clone();
            std::thread::spawn(move || {
                if let Err(e) = open_actor(&app, &session, &actor, Some(url.as_str()), true)
                    .and_then(|_| super::browser::claim_internal(&session, &actor))
                {
                    log::warn!("[internal-browser] {e}");
                }
            });
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if url.as_str().starts_with("about:blank#flufy-") {
                return true;
            }
            let allowed = safe_url(url.as_str()).is_ok();
            if allowed {
                let _ = std::fs::write(&save, url.as_str());
                if let Some(page) = registry()
                    .lock()
                    .unwrap()
                    .pages
                    .iter_mut()
                    .find(|p| p.label == update_label)
                {
                    page.url = url.to_string();
                }
            }
            allowed
        });
    // Offscreen until the React host selects this view. Background agents never
    // move focus or replace the page the user is currently watching.
    let view = window
        .add_child(
            builder,
            tauri::PhysicalPosition::new(-20000., -20000.),
            tauri::PhysicalSize::new(1100., 750.),
        )
        .map_err(|e| e.to_string())?;
    view.set_position(tauri::PhysicalPosition::new(-20000., -20000.))
        .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    registry().lock().unwrap().pages.push(page.clone());
    std::fs::write(dir.join("enabled"), "1").map_err(|e| e.to_string())?;
    Ok(page)
}

pub(super) fn claim(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let page = registry()
        .lock()
        .unwrap()
        .pages
        .iter()
        .find(|p| p.label == label)
        .cloned()
        .ok_or("La página ya no existe")?;
    if !page.claimed {
        app.get_webview(label)
            .ok_or("La vista se cerró")?
            .navigate(safe_url(&page.url)?)
            .map_err(|e| e.to_string())?;
        if let Some(p) = registry()
            .lock()
            .unwrap()
            .pages
            .iter_mut()
            .find(|p| p.label == label)
        {
            p.claimed = true;
        }
    }
    Ok(())
}

pub(super) fn pending(session: &str, actor: &str) -> Vec<Page> {
    registry()
        .lock()
        .unwrap()
        .pages
        .iter()
        .filter(|p| p.session == session && p.actor == actor && !p.claimed)
        .cloned()
        .collect()
}

#[tauri::command]
pub async fn browser_internal_open(
    app: tauri::AppHandle,
    window: tauri::Window,
    session: String,
    url: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    super::gate(&app)?;
    if !super::config(&app).browser {
        return Err("Activá las herramientas del navegador en Control de la PC".into());
    }
    profile(&session)?;
    registry()
        .lock()
        .unwrap()
        .hosts
        .insert(session.clone(), window.label().into());
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(label) = label {
            let page = registry()
                .lock()
                .unwrap()
                .pages
                .iter()
                .find(|p| p.session == session && p.label == label)
                .cloned()
                .ok_or("La página no pertenece a este chat")?;
            if let Some(url) = url {
                app.get_webview(&label)
                    .ok_or("La página se cerró")?
                    .navigate(safe_url(&url)?)
                    .map_err(|e| e.to_string())?;
            }
            return Ok(json!(page));
        }
        let actor = if session.starts_with("team:") { "user".to_string() } else { session.clone() };
        let p = open_actor(&app, &session, &actor, url.as_deref(), false)?;
        super::browser::claim_internal(&session, &actor)?;
        Ok(json!(p))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn browser_internal_pages(app: tauri::AppHandle, session: String) -> Result<Value, String> {
    profile(&session)?;    Ok(json!(registry()
        .lock()
        .unwrap()
        .pages
        .iter()
        .filter(|p| p.session == session && app.get_webview(&p.label).is_some())
        .collect::<Vec<_>>()))
}

#[tauri::command]
pub async fn browser_internal_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    session: String,
    label: Option<String>,
    bounds: Option<Bounds>,
    generation: Option<u64>,
) -> Result<(), String> {
    profile(&session)?;
    static PRESENTATION: Mutex<()> = Mutex::new(());
    let _presentation = PRESENTATION.lock().unwrap();
    let (pages, chosen) = {
        let mut r = registry().lock().unwrap();
        if let Some(generation) = generation {
            let previous = r.generations.entry(window.label().into()).or_default();
            if generation < *previous {
                return Ok(());
            }
            *previous = generation;
        }
        r.hosts.insert(session.clone(), window.label().into());
        let pages = r
            .pages
            .iter()
            .filter(|p| p.session == session)
            .cloned()
            .collect::<Vec<_>>();
        let chosen = label
            .as_ref()
            .and_then(|l| pages.iter().find(|p| &p.label == l))
            .cloned();
        if label.is_some() && chosen.is_none() {
            return Err("La página no pertenece a este chat".into());
        }
        (
            r.pages
                .iter()
                .filter(|p| {
                    app.get_webview(&p.label)
                        .is_some_and(|v| v.window().label() == window.label())
                })
                .cloned()
                .collect::<Vec<_>>(),
            chosen,
        )
    };
    for page in &pages {
        if let Some(view) = app.get_webview(&page.label) {
            view.set_position(tauri::PhysicalPosition::new(-20000., -20000.))
                .map_err(|e| e.to_string())?;
            view.show().map_err(|e| e.to_string())?;
        }
    }
    if let (Some(page), Some(b)) = (chosen, bounds) {
        if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
            || b.width < 1.
            || b.height < 1.
        {
            return Err("Tamaño de navegador inválido".into());
        }
        if let Some(view) = app.get_webview(&page.label) {
            if view.window().label() != window.label() {
                view.reparent(
                    &app.get_window(window.label())
                        .ok_or("La ventana se cerró")?,
                )
                .map_err(|e| e.to_string())?;
            }
            view.set_position(tauri::PhysicalPosition::new(b.x, b.y))
                .map_err(|e| e.to_string())?;
            view.set_size(tauri::PhysicalSize::new(b.width, b.height))
                .map_err(|e| e.to_string())?;
            view.show().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_internal_off(app: tauri::AppHandle, session: String) -> Result<(), String> {
    let dir = profile(&session)?;
    let _ = std::fs::remove_file(dir.join("enabled"));
    let labels: Vec<String> = registry()
        .lock()
        .unwrap()
        .pages
        .iter()
        .filter(|p| p.session == session)
        .map(|p| p.label.clone())
        .collect();
    for label in labels {
        if let Some(view) = app.get_webview(&label) {
            let _ = view.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_internal_control(
    app: tauri::AppHandle,
    session: String,
    label: String,
    action: String,
) -> Result<(), String> {
    profile(&session)?;
    if !registry()
        .lock()
        .unwrap()
        .pages
        .iter()
        .any(|p| p.session == session && p.label == label)
    {
        return Err("La página no pertenece a este chat".into());
    }
    let view = app.get_webview(&label).ok_or("La página se cerró")?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("Acción desconocida".into()),
    };
    view.eval(script).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_privileged_schemes_and_credentials() {
        for url in [
            "file:///C:/secret",
            "javascript://alert(1)",
            "https://a:b@example.com",
        ] {
            assert!(safe_url(url).is_err());
        }
        assert!(safe_url("http://127.0.0.1:4317/").is_ok());
    }
    #[cfg(feature = "desktop-e2e")]
    #[test]
    #[ignore = "real WebView2 child surfaces and real MCP, ten independent agent pages"]
    fn embedded_browser_native() {
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", server.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in server.incoming().flatten() {
                let _ = stream.read(&mut [0; 4096]);
                let html="<title>Embedded QA</title><button onclick=\"document.querySelector('p').textContent='Hola interno'\">Saludar</button><p>Esperando</p>";
                let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n{}",html.len(),html);
            }
        });
        let mut context = tauri::generate_context!();
        context.config_mut().identifier =
            format!("com.flufy.browser-test-{}", uuid::Uuid::new_v4().simple());
        context.config_mut().app.windows.clear();
        let mut app = tauri::Builder::default()
            .any_thread()
            .build(context)
            .unwrap();
        crate::proc::install(app.handle().clone());
        let host = tauri::WebviewWindowBuilder::new(
            app.handle(),
            "main",
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("Flufy embedded browser QA")
        .build()
        .unwrap();
        let app_handle = app.handle().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let session = "team:embedded-qa";
                // Views open hidden inside one host, not as desktop windows.
                let mut views = Vec::new();
                for n in 0..10 {
                    views.push(
                        open_actor(
                            &app_handle,
                            session,
                            &format!("worker-{n}"),
                            Some(&format!("{url}?worker={n}")),
                            false,
                        )
                        .unwrap(),
                    );
                }
                assert_eq!(
                    app_handle.windows().len(),
                    1,
                    "browser pages must not create external windows"
                );
                // Adding a child changes a WebviewWindow into a multi-webview Window.
                // IPC commands must accept Window; WebviewWindow extraction now fails.
                assert!(app_handle.get_webview_window("main").is_none());
                assert!(app_handle.get_window("main").is_some());
                let jobs = (0..10)
                    .map(|n| {
                        std::thread::spawn(move || {
                            let actor = format!("worker-{n}");
                            let call = |name, args| {
                                super::super::browser::call_session_recovery(
                                    &actor, session, name, args, true,
                                )
                                .unwrap()
                            };
                            let listed = call("list_pages", json!({}));
                            assert_ne!(listed["isError"], true, "{listed}");
                            let text = listed["content"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .filter_map(|p| p["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n");
                            let entries = text
                                .lines()
                                .filter_map(|l| {
                                    l.trim()
                                        .split_once(": ")
                                        .and_then(|(id, _)| id.parse::<u64>().ok())
                                })
                                .collect::<Vec<_>>();
                            assert_eq!(
                                entries.len(),
                                1,
                                "each agent sees only its own page: {text}"
                            );
                            let id = entries[0];
                            let snap = call("take_snapshot", json!({"pageId":id}));
                            assert_ne!(snap["isError"], true, "{snap}");
                            let text = snap["content"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .filter_map(|p| p["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n");
                            let uid = regex::Regex::new(r#"uid=([^\s]+) button "Saludar""#)
                                .unwrap()
                                .captures(&text)
                                .expect(&text)[1]
                                .to_string();
                            let clicked = call("click", json!({"pageId":id,"uid":uid}));
                            assert_ne!(clicked["isError"], true, "{clicked}");
                            let observed = call(
                                "evaluate_script",
                                json!({"pageId":id,"function":"() => document.body.innerText"}),
                            );
                            assert!(observed.to_string().contains("Hola interno"), "{observed}");
                            (actor, id)
                        })
                    })
                    .collect::<Vec<_>>();
                let ids = jobs
                    .into_iter()
                    .map(|j| j.join().unwrap())
                    .collect::<Vec<_>>();
                let rejected = super::super::browser::call_session_recovery(
                    &ids[0].0,
                    session,
                    "navigate_page",
                    json!({"pageId":ids[1].1,"url":"https://example.org"}),
                    true,
                )
                .unwrap();
                assert_eq!(
                    rejected["isError"], true,
                    "foreign agent pages must be rejected: {rejected}"
                );
                tauri::async_runtime::block_on(browser_internal_view(
                    app_handle.clone(),
                    app_handle.get_window(host.label()).unwrap(),
                    session.into(),
                    Some(views[0].label.clone()),
                    Some(Bounds {
                        x: 20.,
                        y: 80.,
                        width: 800.,
                        height: 500.,
                    }),
                    None,
                ))
                .unwrap();
                tauri::async_runtime::block_on(browser_internal_view(
                    app_handle.clone(),
                    app_handle.get_window(host.label()).unwrap(),
                    session.into(),
                    None,
                    None,
                    None,
                ))
                .unwrap();
                super::super::browser::stop_all();
                let reconnected = super::super::browser::call_session_recovery(
                    &ids[0].0,
                    session,
                    "list_pages",
                    json!({}),
                    true,
                )
                .unwrap();
                assert_ne!(reconnected["isError"], true, "{reconnected}");
                assert_eq!(app_handle.windows().len(), 1);
                println!("PASS: ten embedded pages, ten agent tool sessions, independent clicks and observations, foreign-page rejection, show/hide, reconnection, no external browser windows");
            }));
            super::super::browser::stop_all();
            let _ = host.destroy();
            let _ = tx.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            app.run_iteration(|_, _| {});
            if let Ok(r) = rx.try_recv() {
                if let Err(e) = r {
                    std::panic::resume_unwind(e)
                }
                break;
            }
            assert!(Instant::now() < deadline, "native test timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
