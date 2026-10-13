use crate::{app_data_file, current_project, remember_main_project, remember_project, term, watch, ServerState};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MAIN: &str = "main";
const FILE: &str = "windows.json";

#[derive(Default)]
pub struct WindowsState {
    projects: Mutex<Vec<(String, String)>>,
    bubbles: Mutex<Vec<Bubble>>,
    exiting: AtomicBool,
}

// Burbuja de chat: una vista de una sola conversación en su propia ventana sin
// bordes y siempre encima. No se persiste: es efímera y no debe reaparecer como
// ventana normal al reabrir. `origin` es la ventana de la que salió, a la que
// vuelve el chat al acoplarla.
#[derive(Clone)]
struct Bubble {
    label: String,
    project: String,
    session: String,
    origin: String,
}

fn bubble_of(app: &AppHandle, label: &str) -> Option<Bubble> {
    app.state::<WindowsState>()
        .bubbles
        .lock()
        .unwrap()
        .iter()
        .find(|b| b.label == label)
        .cloned()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub project: String,
    pub focused: bool,
    pub main: bool,
    pub bubble: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BubbleInfo {
    pub session: String,
    pub origin: String,
}

pub fn project_of(app: &AppHandle, label: &str) -> String {
    if label == MAIN {
        return current_project(app);
    }
    let state = app.state::<WindowsState>();
    if let Some((_, path)) = state.projects.lock().unwrap().iter().find(|(l, _)| l == label) {
        return path.clone();
    }
    bubble_of(app, label).map(|b| b.project).unwrap_or_default()
}

pub fn set_project(app: &AppHandle, label: &str, path: &str) {
    if label == MAIN {
        *app.state::<ServerState>().project.lock().unwrap() = Some(path.to_string());
        remember_main_project(app, path);
        return;
    }
    {
        let state = app.state::<WindowsState>();
        let mut projects = state.projects.lock().unwrap();
        match projects.iter_mut().find(|(l, _)| l == label) {
            Some(entry) => entry.1 = path.to_string(),
            None => projects.push((label.to_string(), path.to_string())),
        }
    }
    persist(app);
}

pub fn all_projects(app: &AppHandle) -> Vec<String> {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty() && !out.iter().any(|q| norm(q) == norm(&p)) {
            out.push(p);
        }
    };
    push(current_project(app));
    for (_, p) in app.state::<WindowsState>().projects.lock().unwrap().iter() {
        push(p.clone());
    }
    for b in app.state::<WindowsState>().bubbles.lock().unwrap().iter() {
        push(b.project.clone());
    }
    out
}

pub fn mark_exiting(app: &AppHandle) {
    if let Some(state) = app.try_state::<WindowsState>() {
        state.exiting.store(true, Ordering::SeqCst);
    }
}

fn persist(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    if state.exiting.load(Ordering::SeqCst) {
        return;
    }
    let paths: Vec<String> = state.projects.lock().unwrap().iter().map(|(_, p)| p.clone()).collect();
    if let Some(file) = app_data_file(app, FILE) {
        let _ = std::fs::write(file, serde_json::to_string_pretty(&paths).unwrap_or_default());
    }
}

fn title_for(path: &str) -> String {
    let name = path.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
    if name.is_empty() {
        "GuilleCode".to_string()
    } else {
        format!("{} — GuilleCode", name)
    }
}

pub fn create(app: &AppHandle, path: Option<String>) -> Result<String, String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        if !Path::new(p).is_dir() {
            return Err(format!("la carpeta no existe: {}", p));
        }
    }
    let label = format!("w-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let project = path.clone().unwrap_or_default();
    app.state::<WindowsState>().projects.lock().unwrap().push((label.clone(), project.clone()));
    if !project.is_empty() {
        remember_project(app, &project);
    }
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title_for(&project))
        .inner_size(1480.0, 920.0)
        .min_inner_size(980.0, 620.0)
        .resizable(true)
        .theme(Some(tauri::Theme::Dark))
        .disable_drag_drop_handler()
        .visible(true)
        .build();
    if let Err(e) = built {
        app.state::<WindowsState>().projects.lock().unwrap().retain(|(l, _)| l != &label);
        return Err(format!("no se pudo abrir la ventana: {}", e));
    }
    persist(app);
    Ok(label)
}

// Ventana "burbuja": una sola conversación, sin bordes y siempre encima, que
// sigue visible aunque la ventana principal esté minimizada u oculta en la
// bandeja. El proyecto se fija al crearla para que server_config devuelva el
// worktree correcto y el chat se conecte al mismo motor.
pub fn create_bubble(app: &AppHandle, project: String, session: String, origin: String, title: Option<String>) -> Result<String, String> {
    let label = format!("bubble-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    app.state::<WindowsState>()
        .bubbles
        .lock()
        .unwrap()
        .push(Bubble { label: label.clone(), project, session, origin });
    let window_title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(window_title.unwrap_or_else(|| "GuilleCode".to_string()))
        .inner_size(380.0, 620.0)
        .min_inner_size(300.0, 340.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .shadow(false)
        .theme(Some(tauri::Theme::Dark))
        .disable_drag_drop_handler()
        .visible(true)
        .build();
    if let Err(e) = built {
        app.state::<WindowsState>().bubbles.lock().unwrap().retain(|b| b.label != label);
        return Err(format!("no se pudo abrir la burbuja: {}", e));
    }
    Ok(label)
}

pub fn forget(app: &AppHandle, label: &str) {
    if label == MAIN {
        return;
    }
    term::kill_owned(app, label);
    watch::stop_window(app, label);
    let state = app.state::<WindowsState>();
    state.bubbles.lock().unwrap().retain(|b| b.label != label);
    let removed = {
        let mut projects = state.projects.lock().unwrap();
        let before = projects.len();
        projects.retain(|(l, _)| l != label);
        before != projects.len()
    };
    if removed {
        persist(app);
    }
}

pub fn restore(app: &AppHandle) {
    let paths: Vec<String> = app_data_file(app, FILE)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let mut opened = vec![norm(&current_project(app))];
    for path in paths {
        if path.is_empty() || !Path::new(&path).is_dir() || opened.contains(&norm(&path)) {
            continue;
        }
        opened.push(norm(&path));
        if let Err(e) = create(app, Some(path)) {
            log::warn!("[ventanas] no se pudo restaurar una ventana: {}", e);
        }
    }
    persist(app);
}

#[tauri::command]
pub async fn window_new(app: AppHandle, path: Option<String>) -> Result<String, String> {
    create(&app, path)
}

#[tauri::command]
pub fn windows_list(app: AppHandle) -> Vec<WindowInfo> {
    let mut out = Vec::new();
    for (label, window) in app.webview_windows() {
        out.push(WindowInfo {
            project: project_of(&app, &label),
            focused: window.is_focused().unwrap_or(false),
            main: label == MAIN,
            bubble: label.starts_with("bubble-"),
            session: bubble_of(&app, &label).map(|b| b.session),
            label,
        });
    }
    out.sort_by(|a, b| b.main.cmp(&a.main).then(a.label.cmp(&b.label)));
    out
}

#[tauri::command]
pub fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    let window = app.get_webview_window(&label).ok_or("esa ventana ya no está abierta")?;
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_quit_begin(app: AppHandle) {
    persist(&app);
    mark_exiting(&app);
}

#[tauri::command]
pub fn window_quit_cancel(app: AppHandle) {
    if let Some(state) = app.try_state::<WindowsState>() {
        state.exiting.store(false, Ordering::SeqCst);
    }
    persist(&app);
}

#[tauri::command]
pub async fn window_bubble(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session: String,
    title: Option<String>,
) -> Result<String, String> {
    let project = project_of(&app, window.label());
    if project.trim().is_empty() {
        return Err("esta ventana no tiene un proyecto abierto".to_string());
    }
    create_bubble(&app, project, session, window.label().to_string(), title)
}

#[tauri::command]
pub fn window_bubble_info(app: AppHandle, window: tauri::WebviewWindow) -> Option<BubbleInfo> {
    bubble_of(&app, window.label()).map(|b| BubbleInfo { session: b.session, origin: b.origin })
}
