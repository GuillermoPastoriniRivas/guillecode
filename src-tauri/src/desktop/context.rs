//! Context belongs to an external window, not to the foreground chat overlay.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

pub static INPUT_BUSY: AtomicBool = AtomicBool::new(false);
static INPUT: Mutex<()> = Mutex::new(());
pub struct InputGuard { _lock: std::sync::MutexGuard<'static, ()> }
impl Drop for InputGuard { fn drop(&mut self) { INPUT_BUSY.store(false, Ordering::SeqCst); } }
pub fn input() -> InputGuard {
    let lock = INPUT.lock().unwrap_or_else(|p| p.into_inner());
    INPUT_BUSY.store(true, Ordering::SeqCst);
    InputGuard { _lock: lock }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub window: String,
    pub pid: u32,
    pub title: String,
    pub process: String,
    pub bounds: [i32; 4],
}
#[derive(Default)]
struct Context {
    last: Option<Target>,
    pinned: HashMap<String, Target>,
    scenes: HashMap<String, Scene>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub at: i64,
    pub target: Target,
    pub content: String,
    pub selection: String,
    pub browser: Option<Value>,
}
fn state() -> &'static Mutex<Context> {
    static STATE: OnceLock<Mutex<Context>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Context::default()))
}

#[cfg(windows)]
fn target(w: &super::win::WinInfo) -> Target {
    Target { window: format!("w{}", w.hwnd), pid: w.pid, title: w.title.clone(), process: w.process.clone(), bounds: [w.rect.left, w.rect.top, w.rect.right, w.rect.bottom] }
}

pub fn start(app: &AppHandle) {
    #[cfg(windows)] {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut seen = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if super::gate(&app).is_err() { seen = 0; continue; }
                let hwnd = super::win::foreground();
                // Sample metadata only; no screenshots, UIA reads or model calls.
                // Remember input-induced focus too, so releasing input does not
                // turn the executor's last focus into a human-selected target.
                if hwnd == seen { continue; }
                seen = hwnd;
                if INPUT_BUSY.load(Ordering::SeqCst) { continue; }
                if let Some(w) = super::win::window(hwnd).filter(|w| super::blocked_reason(w).is_none()) {
                    state().lock().unwrap().last = Some(target(&w));
                }
            }
        });
    }
}

#[cfg(windows)]
fn live(t: &Target) -> Result<super::win::WinInfo, String> {
    let w = super::tools::resolve_window(&t.window)?;
    if w.pid != t.pid || w.process != t.process { return Err("La aplicación objetivo cambió. Elegí el destino otra vez.".into()); }
    super::tools::allowed(&w)?;
    Ok(w)
}

#[cfg(windows)]
fn selected(app: &AppHandle, session: &str) -> Option<Target> {
    let context = state().lock().unwrap();
    if let Some(t) = context.pinned.get(session) { return Some(t.clone()); }
    if let Some(task) = super::tasks::get(app, session).filter(|t| t.status == "running" || t.status == "interrupted") {
        if let Some(scene) = context.scenes.get(session).filter(|s| Some(&s.target.window) == task.target.as_ref()) { return Some(scene.target.clone()); }
        // A restored task needs a fresh explicit choice; HWNDs can be recycled.
        if task.target.is_some() { return None; }
    }
    context.last.clone()
}

#[cfg(windows)]
pub fn observe(app: &AppHandle, session: &str, window: Option<&str>) -> Result<Scene, String> {
    super::gate(app)?;
    super::win::physical_thread();
    let w = match window {
        Some(id) => { let w = super::tools::resolve_window(id)?; super::tools::allowed(&w)?; w },
        None => live(&selected(app, session).ok_or("Elegí una aplicación en «Viendo» o enfocala antes de escribir en la burbuja.")?)?,
    };
    let hwnd = w.hwnd;
    let observation = super::uia::run_with_timeout(std::time::Duration::from_millis(2500), move |u| {
        let tree = u.snapshot(hwnd, None, 180, 30)?;
        Ok((tree.render(180), u.selection(hwnd).unwrap_or_default(), u.browser_url(hwnd)))
    });
    let (content, selection, url) = match observation {
        Ok(result) => result,
        Err(e) => (format!("Accesibilidad no disponible: {}. Usá screenshot/screen_text.", e), String::new(), None),
    };
    let browser = if w.process.eq_ignore_ascii_case("chrome.exe") {
        Some(super::browser::context_for_url(url.as_deref()))
    } else { None };
    let scene = Scene { id: uuid::Uuid::new_v4().to_string(), at: chrono::Utc::now().timestamp_millis(), target: target(&w), content, selection, browser };
    state().lock().unwrap().scenes.insert(session.into(), scene.clone());
    if super::tasks::observer() == session { super::tasks::set_target(app, &scene.target.window)?; }
    Ok(scene)
}

#[cfg(windows)]
pub fn bound_window() -> Result<super::win::WinInfo, String> {
    if let Some(scene) = state().lock().unwrap().scenes.get(&super::tasks::observer()).cloned() {
        return live(&scene.target);
    }
    // No observed scene (e.g. a manual desktop chat): behave as before and use
    // the window that is in front.
    super::win::window(super::win::foreground()).ok_or("no hay ninguna ventana al frente".into())
}

#[cfg(windows)]
pub fn validate_scene(session: &str, id: &str) -> Result<Scene, String> {
    let scene = state().lock().unwrap().scenes.get(session).filter(|s| s.id == id).cloned().ok_or("Escena vencida: usá observe otra vez.")?;
    let w = live(&scene.target)?;
    if target(&w) != scene.target { return Err("La ventana cambió de título o geometría: observá otra vez antes de actuar.".into()); }
    if !scene.content.starts_with("Accesibilidad no disponible:") {
        let current = super::uia::run(move |u| u.snapshot(w.hwnd, None, 180, 30))?.render(180);
        if current != scene.content { return Err("La interfaz cambió desde la observación: usá observe y resolvé de nuevo los controles.".into()); }
    }
    Ok(scene)
}

/// Hide only overlays we own and restore without activation, including on error.
/// A capture exclusion flag alone does not make the underlying pixels clickable.
pub struct Overlays(Vec<tauri::WebviewWindow>);
impl Overlays {
    pub fn hide(app: &AppHandle) -> Self {
        let windows: Vec<_> = app.webview_windows().into_iter()
            .filter(|(label, w)| label.starts_with("bubble-") && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
            .filter_map(|(_, w)| w.hide().ok().map(|_| w)).collect();
        if !windows.is_empty() { std::thread::sleep(std::time::Duration::from_millis(40)); }
        Self(windows)
    }
}
impl Drop for Overlays {
    fn drop(&mut self) {
        for w in &self.0 {
            #[cfg(windows)]
            if let Ok(hwnd) = w.hwnd() {
                unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(windows::Win32::Foundation::HWND(hwnd.0), windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
            }
            #[cfg(not(windows))]
            let _ = w.show();
        }
    }
}

fn get(app: &AppHandle, session: &str) -> Value {
    #[cfg(windows)] {
        let enabled = super::gate(app).is_ok();
        let chosen = selected(app, session);
        let error = chosen.as_ref().and_then(|t| live(t).err());
        let chosen = chosen.and_then(|t| live(&t).ok().map(|w| target(&w)));
        let choices: Vec<_> = if enabled { super::win::windows().iter().filter(|w| super::blocked_reason(w).is_none()).map(target).collect() } else { vec![] };
        return json!({ "target": chosen, "choices": choices, "pinned": state().lock().unwrap().pinned.contains_key(session), "enabled": enabled, "error": error });
    }
    #[cfg(not(windows))]
    json!({ "enabled": false, "target": null, "choices": [] })
}

#[tauri::command]
pub async fn desktop_context_get(app: AppHandle, session: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || get(&app, &session)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_context_select(app: AppHandle, session: String, window: Option<String>) -> Result<(), String> {
    super::gate(&app)?;
    #[cfg(windows)] {
        let choice = window.map(|id| super::tools::resolve_window(&id).and_then(|w| { super::tools::allowed(&w)?; Ok(target(&w)) })).transpose()?;
        let mut s = state().lock().unwrap();
        if let Some(t) = choice { s.pinned.insert(session.clone(), t); } else {
            s.pinned.remove(&session);
            s.scenes.remove(&session);
            drop(s);
            super::tasks::release_target(&app, &session)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_context_prepare(app: AppHandle, session: String, instruction: String, image: bool) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::gate(&app)?;
        let _input = input();
        #[cfg(windows)] {
            let chosen = selected(&app, &session);
            if chosen.is_none() {
                let task = super::tasks::begin(&app, &session, &instruction, None)?;
                return Ok(json!({ "scene": null, "task": task, "image": null, "imageError": "No hay aplicación externa seleccionada. Elegí una ventana con desktop_windows o abrí la aplicación solicitada." }));
            }
            let chosen = chosen.unwrap();
            live(&chosen)?;
            let task = super::tasks::begin(&app, &session, &instruction, Some(chosen.window.clone()))?;
            let _observer = super::tasks::restore(Some((session.clone(), task.run)));
            let scene = observe(&app, &session, Some(&chosen.window))?;
            let mut result = json!({ "scene": scene, "task": task, "image": null });
            if image && crate::machine::interactive() {
                let _overlays = Overlays::hide(&app);
                let w = live(&scene.target)?;
                match super::win::capture_window(w.hwnd).and_then(|s| super::win::encode(&s, 960, 70)) {
                    Ok(encoded) => {
                        use base64::Engine;
                        result["image"] = json!(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(encoded.jpeg)));
                    }
                    Err(e) => result["imageError"] = json!(e),
                }
            }
            return Ok(result);
        }
        #[cfg(not(windows))]
        Err("El contexto de escritorio requiere Windows".into())
    }).await.map_err(|e| e.to_string())?
}
