use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct WatchState {
    watchers: Mutex<HashMap<String, (String, Debouncer<RecommendedWatcher>)>>,
}

pub fn stop_window(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<WatchState>() {
        state.watchers.lock().unwrap().remove(label);
    }
}

pub fn stop_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<WatchState>() {
        state.watchers.lock().unwrap().clear();
    }
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
    if parts.iter().position(|p| p == crate::features::WORKTREES_DIR).is_some_and(|pos| parts.len() > pos + 2) {
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
pub fn watch_start(app: AppHandle, window: tauri::WebviewWindow, state: tauri::State<WatchState>, root: String) -> Result<(), String> {
    let label = window.label().to_string();
    let emit_label = label.clone();
    let root_path = Path::new(&root).to_path_buf();
    if !root_path.is_dir() {
        return Err(format!("la carpeta no existe: {}", root));
    }
    let emit_root = root.clone();
    let classify_root = root_path.clone();
    let external = external_git_dirs(&root_path);
    let classify_external = external.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(DEBOUNCE_MS), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = Vec::new();
        let mut git = false;
        for event in events {
            if let Some(signal) = classify_git_dir(&classify_external, &event.path) {
                git |= signal;
                continue;
            }
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
        let _ = app.emit_to(emit_label.as_str(), "fs://changed", FsChanged { root: emit_root.clone(), paths, git });
    })
    .map_err(|e| format!("no se pudo crear el watcher: {}", e))?;
    debouncer
        .watcher()
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| format!("no se pudo observar {}: {}", root, e))?;
    for dir in &external {
        let _ = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive);
        let refs = dir.join("refs");
        if refs.is_dir() {
            let _ = debouncer.watcher().watch(&refs, RecursiveMode::Recursive);
        }
    }
    state.watchers.lock().unwrap().insert(label, (root, debouncer));
    Ok(())
}

fn resolve_git_dir(dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let text = std::fs::read_to_string(dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let path = PathBuf::from(target);
    Some(if path.is_absolute() { path } else { dot_git.parent()?.join(path) })
}

fn external_git_dirs(root: &Path) -> Vec<PathBuf> {
    let Some(dot_git) = root.ancestors().map(|a| a.join(".git")).find(|p| p.exists()) else { return Vec::new() };
    let Some(git_dir) = resolve_git_dir(&dot_git) else { return Vec::new() };
    let mut dirs = vec![git_dir.clone()];
    if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
        let common = PathBuf::from(common.trim());
        dirs.push(if common.is_absolute() { common } else { git_dir.join(common) });
    }
    let root_key = path_key(&plain(root.canonicalize().unwrap_or_else(|_| root.to_path_buf())));
    dirs.into_iter()
        .filter_map(|d| d.canonicalize().ok().map(plain))
        .filter(|d| {
            let k = path_key(d);
            k != root_key && !k.starts_with(&format!("{}/", root_key))
        })
        .fold(Vec::new(), |mut acc, d| {
            if !acc.contains(&d) {
                acc.push(d);
            }
            acc
        })
}

fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn classify_git_dir(dirs: &[PathBuf], path: &Path) -> Option<bool> {
    let event = path_key(path);
    for dir in dirs {
        let prefix = format!("{}/", path_key(dir));
        let Some(rel) = event.strip_prefix(&prefix) else { continue };
        let mut parts = rel.split('/');
        let first = parts.next().unwrap_or_default();
        let nested = parts.next().is_some();
        return Some(match first {
            "refs" | "packed-refs" => true,
            name => !nested && GIT_SIGNALS.iter().any(|s| s.eq_ignore_ascii_case(name)),
        });
    }
    None
}

#[tauri::command]
pub fn watch_stop(window: tauri::WebviewWindow, state: tauri::State<WatchState>, root: Option<String>) {
    let mut watchers = state.watchers.lock().unwrap();
    let label = window.label();
    if let (Some(requested), Some((watching, _))) = (root.as_deref(), watchers.get(label)) {
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
        if norm(requested) != norm(watching) {
            return;
        }
    }
    watchers.remove(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_folders_are_seen_but_not_their_files() {
        let root = Path::new("C:/repo");
        assert!(matches!(classify(root, Path::new("C:/repo/.worktrees")), Classified::File(_)));
        assert!(matches!(classify(root, Path::new("C:/repo/.worktrees/login")), Classified::File(_)));
        assert!(matches!(classify(root, Path::new("C:/repo/.worktrees/login/src/a.ts")), Classified::Skip));
        assert!(matches!(classify(root, Path::new("C:/repo/src/a.ts")), Classified::File(_)));
        let inside = Path::new("C:/repo/.worktrees/login");
        assert!(matches!(classify(inside, Path::new("C:/repo/.worktrees/login/src/a.ts")), Classified::File(_)));
    }
}
