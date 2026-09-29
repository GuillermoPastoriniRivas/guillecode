use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::path::{Component, Path};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct WatchState {
    pub current: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

#[derive(Serialize, Clone)]
struct FsChanged {
    root: String,
    paths: Vec<String>,
    git: bool,
}

const NOISY_DIRS: [&str; 9] = [
    "node_modules", "target", ".next", ".turbo", "__pycache__", ".venv", "coverage", ".gradle", ".cache",
];
const GIT_SIGNALS: [&str; 5] = ["HEAD", "index", "FETCH_HEAD", "MERGE_HEAD", "ORIG_HEAD"];
const DEBOUNCE_MS: u64 = 220;

enum Classified {
    Skip,
    Git,
    File(String),
}

fn classify(root: &Path, path: &Path) -> Classified {
    let Ok(rel) = path.strip_prefix(root) else { return Classified::Skip };
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if let Some(pos) = parts.iter().position(|p| p == ".git") {
        let inside = &parts[pos + 1..];
        let is_signal = match inside {
            [one] => GIT_SIGNALS.contains(&one.as_str()),
            [first, ..] => first == "refs",
            [] => false,
        };
        return if is_signal { Classified::Git } else { Classified::Skip };
    }
    if parts.iter().any(|p| NOISY_DIRS.contains(&p.as_str())) {
        return Classified::Skip;
    }
    if let Some(name) = parts.last() {
        if name.contains(".guillecode-") && name.ends_with(".tmp") {
            return Classified::Skip;
        }
    }
    Classified::File(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn watch_start(app: AppHandle, state: tauri::State<WatchState>, root: String) -> Result<(), String> {
    let root_path = Path::new(&root).to_path_buf();
    if !root_path.is_dir() {
        return Err(format!("la carpeta no existe: {}", root));
    }
    let emit_root = root.clone();
    let classify_root = root_path.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = Vec::new();
        let mut git = false;
        for event in events {
            match classify(&classify_root, &event.path) {
                Classified::Skip => {}
                Classified::Git => git = true,
                Classified::File(p) => {
                    if !paths.contains(&p) {
                        paths.push(p);
                    }
                }
            }
        }
        if paths.is_empty() && !git {
            return;
        }
        let _ = app.emit("fs://changed", FsChanged { root: emit_root.clone(), paths, git });
    })
    .map_err(|e| format!("no se pudo crear el watcher: {}", e))?;
    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("no se pudo observar {}: {}", root, e))?;
    *state.current.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
pub fn watch_stop(state: tauri::State<WatchState>) {
    state.current.lock().unwrap().take();
}
