use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub mod accounts;
pub mod approvals;
pub mod desktop;
pub mod features;
pub mod fs;
pub mod gh;
pub mod git;
pub mod hub;
pub mod live;
pub mod machine;
pub mod memory;
pub mod oc;
pub mod plane;
pub mod proc;
pub mod process_tree;
pub mod push;
pub mod remote;
mod responses;
pub mod routines;
pub mod search;
pub mod term;
pub mod usage;
pub mod updates;
pub mod voice;
pub mod watch;
pub mod whisper;
pub mod windows;

const MAX_RECENT_PROJECTS: usize = 12;
const MAIN_PROJECT_FILE: &str = "main_project.txt";

#[derive(Serialize, Clone, Default)]
pub struct ServerConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub worktree: String,
}

pub struct ServerState {
    child: Mutex<Option<EngineChild>>,
    config: Mutex<Option<ServerConfig>>,
    project: Mutex<Option<String>>,
    stopping: AtomicBool,
}

struct EngineChild {
    child: CommandChild,
    tree: process_tree::ProcessTree,
}
impl EngineChild {
    fn pid(&self) -> u32 { self.child.pid() }
    fn kill(self) {
        self.tree.terminate();
        let _ = self.child.kill();
    }
}

pub fn ensure_server(app: &tauri::AppHandle) -> Result<ServerConfig, String> {
    let state = app.state::<ServerState>();
    let mut config = {
        let mut cfg = state.config.lock().unwrap();
        if state.stopping.load(Ordering::SeqCst) {
            return Err("GuilleCode se está cerrando".into());
        }
        if cfg.is_none() {
            *cfg = Some(spawn_server(app, &state, &fallback_cwd(app))?);
        }
        cfg.clone().unwrap()
    };
    config.worktree = current_project(app);
    Ok(config)
}

/// Reinicia el motor para que tome el plano/config nuevos (política, guías de
/// canales, config). El frontend reconecta solo cuando el sidecar cambia de
/// puerto: `startEventStream` llama `resetConnection()` y resuelve `server_config`.
#[tauri::command]
async fn reload_engine(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    let old = {
        // Mismo orden de locks que `spawn_server` y el handler de terminación.
        let mut config = state.config.lock().unwrap();
        let mut child = state.child.lock().unwrap();
        let old = child.take();
        *config = None;
        old
    };
    if let Some(child) = old {
        child.kill();
    }
    Ok(())
}

fn current_project(app: &tauri::AppHandle) -> String {
    let state = app.state::<ServerState>();
    let mut project = state.project.lock().unwrap();
    if project.is_none() {
        let saved = load_saved_worktree(app);
        if !saved.is_empty() {
            remember_main_project(app, &saved);
        }
        *project = Some(saved);
    }
    project.clone().unwrap_or_default()
}

#[tauri::command]
async fn server_config(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<ServerConfig, String> {
    let mut config = ensure_server(&app)?;
    config.worktree = windows::project_of(&app, window.label());
    Ok(config)
}

#[tauri::command]
async fn set_server_worktree(app: tauri::AppHandle, window: tauri::WebviewWindow, path: String) -> Result<ServerConfig, String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("la carpeta no existe: {}", path));
    }
    remember_project(&app, &path);
    windows::set_project(&app, window.label(), &path);
    let mut config = ensure_server(&app)?;
    config.worktree = path;
    Ok(config)
}

pub(crate) fn recent_project_list(app: &tauri::AppHandle) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in load_recent(app) {
        if Path::new(&p).is_dir() && !out.iter().any(|o| same_project(o, &p)) {
            out.push(p);
        }
    }
    out
}

#[tauri::command]
fn recent_projects(app: tauri::AppHandle) -> Vec<String> {
    recent_project_list(&app)
}

fn spawn_server(app: &tauri::AppHandle, state: &ServerState, worktree: &str) -> Result<ServerConfig, String> {
    let port = TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no hay puertos libres: {}", e))?;
    let password = uuid::Uuid::new_v4().simple().to_string();
    let sidecar = resolve_sidecar_path()?;
    let config = responses::configure(app, desktop::opencode_config(app))?;
    let command = app
        .shell()
        .command(sidecar.to_string_lossy().into_owned())
        .args(["serve", "--port", &port.to_string()])
        .current_dir(worktree)
        .env("OPENCODE_SERVER_USERNAME", "opencode")
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .env("OPENCODE_CONFIG_CONTENT", config);
    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("no se pudo iniciar opencode: {}", e))?;
    let pid = child.pid();
    let tree = match process_tree::ProcessTree::attach(pid) {
        Ok(tree) => tree,
        Err(e) => { let _ = child.kill(); return Err(e); }
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::info!("[opencode] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => log::warn!("[opencode] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(payload) => {
                    log::warn!("[opencode] terminado: {:?}", payload);
                    let state = handle.state::<ServerState>();
                    // Match ensure_server's lock order; an old exit event must
                    // not clear a replacement engine that has already started.
                    let mut config = state.config.lock().unwrap();
                    let mut child = state.child.lock().unwrap();
                    if child.as_ref().map(|c| c.pid()) == Some(pid) {
                        child.take();
                        config.take();
                    }
                }
                _ => {}
            }
        }
    });
    *state.child.lock().unwrap() = Some(EngineChild { child, tree });
    Ok(ServerConfig {
        url: format!("http://127.0.0.1:{}", port),
        username: "opencode".into(),
        password,
        worktree: worktree.to_string(),
    })
}

pub(crate) fn app_data_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

fn load_recent(app: &tauri::AppHandle) -> Vec<String> {
    let from_json = app_data_file(app, "recent_projects.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    if !from_json.is_empty() {
        return from_json;
    }
    app_data_file(app, "last_project.txt")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| vec![s])
        .unwrap_or_default()
}

fn same_project(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

fn remember_project(app: &tauri::AppHandle, path: &str) {
    let mut recent = load_recent(app);
    recent.retain(|p| !same_project(p, path));
    recent.insert(0, path.to_string());
    recent.truncate(MAX_RECENT_PROJECTS);
    if let Some(file) = app_data_file(app, "recent_projects.json") {
        let _ = std::fs::write(file, serde_json::to_string_pretty(&recent).unwrap_or_default());
    }
    if let Some(file) = app_data_file(app, "last_project.txt") {
        let _ = std::fs::write(file, path);
    }
}

fn load_saved_worktree(app: &tauri::AppHandle) -> String {
    let main = app_data_file(app, MAIN_PROJECT_FILE)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|p| !p.is_empty() && Path::new(p).is_dir());
    main.unwrap_or_else(|| load_recent(app).into_iter().find(|p| Path::new(p).is_dir()).unwrap_or_default())
}

pub(crate) fn remember_main_project(app: &tauri::AppHandle, path: &str) {
    if let Some(file) = app_data_file(app, MAIN_PROJECT_FILE) {
        let _ = std::fs::write(file, path);
    }
}

fn fallback_cwd(app: &tauri::AppHandle) -> String {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

fn resolve_sidecar_path() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("current_exe falló: {}", e))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("no se pudo resolver la carpeta del exe")?;
    let candidates = [
        exe_dir.join("opencode.exe"),
        exe_dir.join("binaries").join("opencode.exe"),
        exe_dir.join("opencode-x86_64-pc-windows-msvc.exe"),
        exe_dir.join("binaries").join("opencode-x86_64-pc-windows-msvc.exe"),
        exe_dir.join("opencode"),
    ];
    candidates
        .iter()
        .find(|c| c.exists())
        .cloned()
        .ok_or_else(|| format!("no encontré el binario de opencode junto al exe: {:?}", candidates))
}

fn shutdown(app: &tauri::AppHandle) {
    windows::mark_exiting(app);
    {
        // Synchronize with ensure_server BEFORE killing the engine. Live SSE,
        // remote requests and background polling must not spawn it again while
        // cleanup runs and NSIS starts replacing the bundled executable.
        let state = app.state::<ServerState>();
        let mut config = state.config.lock().unwrap();
        state.stopping.store(true, Ordering::SeqCst);
        config.take();
    }
    if let Some(child) = app.state::<ServerState>().child.lock().unwrap().take() {
        child.kill();
    }
    term::kill_all(app);
    watch::stop_all(app);
    whisper::stop(app);
    desktop::shutdown();
    machine::keep_awake(false);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| hub::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![hub::HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            updates::update_check,
            updates::update_download,
            updates::update_install,
            server_config,
            set_server_worktree,
            recent_projects,
            hub::app_quit,
            hub::autostart_get,
            hub::autostart_set,
            routines::routines_list,
            routines::routines_save,
            routines::routines_delete,
            routines::routines_set_enabled,
            routines::routines_run_now,
            remote::remote_status,
            remote::remote_set_enabled,
            remote::remote_regenerate_token,
            remote::remote_qr,
            remote::remote_set_prefs,
            remote::remote_push_test,
            voice::voice_get,
            voice::voice_set,
            voice::voice_test,
            voice::voice_transcribe,
            whisper::whisper_status,
            whisper::whisper_download,
            whisper::whisper_cancel,
            whisper::whisper_delete_model,
            git::git_root,
            git::git_status,
            git::git_log,
            git::git_commit_detail,
            git::git_show_file,
            git::git_show_file_base64,
            git::git_diff_file,
            git::git_branches,
            git::git_checkout,
            git::git_subrepos,
            git::git_stage,
            git::git_stage_all,
            git::git_unstage,
            git::git_unstage_all,
            git::git_discard,
            git::git_apply_patch,
            git::git_ignore_add,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_fetch,
            git::git_stash,
            git::git_blame,
            git::git_default_branch,
            git::git_staged_context,
            git::git_range_context,
            git::git_changes_context,
            git::git_merge_abort,
            git::git_merge_continue,
            features::features_list,
            features::features_create,
            features::features_update,
            features::features_set_settings,
            features::features_copy_candidates,
            features::features_remove_check,
            features::features_remove,
            features::features_merge_preview,
            features::features_merge,
            features::features_update_from_base,
            features::features_diff,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_read_base64,
            fs::fs_write_file,
            fs::fs_stat,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_list_files,
            search::search_text,
            search::search_replace,
            watch::watch_start,
            watch::watch_stop,
            gh::gh_status,
            gh::gh_pr_list,
            gh::gh_pr_view,
            gh::gh_pr_diff,
            gh::gh_pr_create,
            gh::gh_pr_merge,
            gh::gh_pr_checkout,
            gh::gh_pr_comment,
            gh::gh_pr_review,
            gh::gh_pr_ready,
            term::terminal_shells,
            term::terminal_spawn,
            term::terminal_write,
            term::terminal_resize,
            term::terminal_kill,
            term::terminal_kill_all,
            usage::provider_usage,
            usage::chatgpt_usage,
            usage::chatgpt_resets,
            usage::chatgpt_use_reset,
            usage::go_usage,
            accounts::auth_entries,
            accounts::validate_opencode_key,
            accounts::set_opencode_zen,
            desktop::desktop_status,
            desktop::desktop_update,
            desktop::desktop_stop_all,
            desktop::desktop_browser_restart,
            desktop::desktop_browser_setup,
            live::live_busy_sessions,
            approvals::approvals_get,
            approvals::approvals_set,
            approvals::approvals_set_session,
            memory::memory_status,
            memory::memory_overview,
            memory::memory_write_note,
            memory::memory_write_overview,
            memory::memory_write_preferences,
            memory::memory_read_note,
            memory::memory_delete_note,
            memory::memory_write_task,
            memory::memory_delete_task,
            memory::memory_search_cmd,
            memory::memory_set_session,
            memory::memory_session_enabled,
            plane::plane_list,
            plane::plane_read,
            plane::plane_write,
            plane::plane_reset,
            reload_engine,
            windows::window_new,
            windows::windows_list,
            windows::window_focus,
            windows::window_quit_begin,
            windows::window_quit_cancel
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                windows::forget(window.app_handle(), window.label());
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            proc::install(app.handle().clone());
            app.manage(updates::UpdatesState::default());
            app.manage(ServerState { child: Mutex::new(None), config: Mutex::new(None), project: Mutex::new(None), stopping: AtomicBool::new(false) });
            app.manage(windows::WindowsState::default());
            memory::start(app.handle());
            desktop::start(app.handle());
            routines::start(app.handle());
            push::start(app.handle());
            remote::start(app.handle());
            approvals::start(app.handle());
            live::start(app.handle());
            hub::setup(app.handle())?;
            app.manage(whisper::WhisperState::default());
            app.manage(term::TermState::new());
            app.manage(watch::WatchState::default());
            term::start_cleanup(app.handle());
            if !std::env::args().any(|a| a == hub::HIDDEN_ARG) {
                windows::restore(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => windows::mark_exiting(app),
                tauri::RunEvent::Exit => shutdown(app),
                _ => {}
            }
        });
}
