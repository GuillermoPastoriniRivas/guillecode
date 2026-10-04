use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

pub struct TermState {
    pub terms: Mutex<HashMap<String, Term>>,
}

pub struct Term {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    owner: String,
}

impl Term {
    fn kill_tree(&self) {
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let mut command = std::process::Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            crate::proc::hide_console(&mut command);
            let _ = command.output();
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[derive(Deserialize, Clone)]
pub struct TermSpawnArgs {
    pub id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

#[derive(Serialize, Clone)]
pub struct ShellInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

fn available_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = find_in_path("pwsh.exe") {
            shells.push(ShellInfo { id: "pwsh".into(), name: "PowerShell 7".into(), path: p.to_string_lossy().into_owned() });
        }
        if let Some(p) = find_in_path("powershell.exe") {
            shells.push(ShellInfo { id: "powershell".into(), name: "Windows PowerShell".into(), path: p.to_string_lossy().into_owned() });
        }
        let git_bash = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file());
        if let Some(p) = git_bash {
            shells.push(ShellInfo { id: "bash".into(), name: "Git Bash".into(), path: p.to_string_lossy().into_owned() });
        }
        let cmd = std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        shells.push(ShellInfo { id: "cmd".into(), name: "Command Prompt".into(), path: cmd });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        shells.push(ShellInfo { id: "default".into(), name: sh.clone(), path: sh });
    }
    shells
}

fn shell_command(requested: Option<String>) -> Result<CommandBuilder, String> {
    let shells = available_shells();
    let chosen = requested
        .and_then(|id| shells.iter().find(|s| s.id == id).cloned())
        .or_else(|| shells.first().cloned())
        .ok_or("no se encontró ningún shell")?;
    let mut cmd = CommandBuilder::new(&chosen.path);
    match chosen.id.as_str() {
        "pwsh" | "powershell" => {
            cmd.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
            ]);
        }
        "cmd" => {
            cmd.args(["/K", "chcp 65001 >nul"]);
        }
        "bash" => {
            cmd.args(["--login", "-i"]);
        }
        _ => {}
    }
    Ok(cmd)
}

fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or(""));
                match e.error_len() {
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(n) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + n);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn terminal_shells() -> Vec<ShellInfo> {
    available_shells()
}

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, TermState>,
    args: TermSpawnArgs,
    on_event: Channel<TermEvent>,
) -> Result<(), String> {
    if !Path::new(&args.cwd).is_dir() {
        return Err(format!("la carpeta no existe: {}", args.cwd));
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: args.rows.unwrap_or(24).max(2),
            cols: args.cols.unwrap_or(80).max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("no se pudo abrir la PTY: {}", e))?;
    let mut cmd = shell_command(args.shell.clone())?;
    cmd.cwd(&args.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("GUILLECODE", "1");
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("no se pudo iniciar el shell: {}", e))?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let pid = child.process_id();
    let writer = pair.master.take_writer().map_err(|e| format!("take_writer: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader: {}", e))?;

    let data_channel = on_event.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut pending);
                    if !text.is_empty() && data_channel.send(TermEvent::Data { data: text }).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let id = args.id.clone();
    let exit_app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        let _ = on_event.send(TermEvent::Exit { code });
        if let Some(state) = exit_app.try_state::<TermState>() {
            state.terms.lock().unwrap().remove(&id);
        }
    });

    state.terms.lock().unwrap().insert(
        args.id,
        Term {
            writer: Mutex::new(writer),
            master: pair.master,
            killer: Mutex::new(killer),
            pid,
            owner: window.label().to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(state: tauri::State<'_, TermState>, id: String, data: String) -> Result<(), String> {
    let guard = state.terms.lock().unwrap();
    let term = guard.get(&id).ok_or("la terminal ya no existe")?;
    let mut writer = term.writer.lock().unwrap();
    writer.write_all(data.as_bytes()).map_err(|e| format!("write falló: {}", e))?;
    writer.flush().map_err(|e| format!("flush falló: {}", e))
}

#[tauri::command]
pub async fn terminal_resize(state: tauri::State<'_, TermState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.terms.lock().unwrap();
    let term = guard.get(&id).ok_or("la terminal ya no existe")?;
    term.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize falló: {}", e))
}

#[tauri::command]
pub async fn terminal_kill(state: tauri::State<'_, TermState>, id: String) -> Result<(), String> {
    let removed = state.terms.lock().unwrap().remove(&id);
    if let Some(term) = removed {
        let _ = tauri::async_runtime::spawn_blocking(move || term.kill_tree()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill_all(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || kill_owned(&app, &label)).await;
    Ok(())
}

pub fn kill_owned(app: &AppHandle, owner: &str) {
    if let Some(state) = app.try_state::<TermState>() {
        let drained: Vec<Term> = {
            let mut terms = state.terms.lock().unwrap();
            let ids: Vec<String> = terms.iter().filter(|(_, t)| t.owner == owner).map(|(id, _)| id.clone()).collect();
            ids.into_iter().filter_map(|id| terms.remove(&id)).collect()
        };
        for term in drained {
            term.kill_tree();
        }
    }
}

pub fn kill_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<TermState>() {
        let drained: Vec<Term> = state.terms.lock().unwrap().drain().map(|(_, t)| t).collect();
        for term in drained {
            term.kill_tree();
        }
    }
}
