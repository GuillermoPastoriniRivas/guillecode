use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

const SCROLLBACK: usize = 1000;
const CAPTURE_SCROLLBACK: usize = 2000;

const POWERSHELL_SETUP: &str = r#"[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $global:__gcPrompt=$function:prompt; $global:__gcCode=$global:LASTEXITCODE; function global:prompt { $ok=$global:?; $n=$global:LASTEXITCODE; $c=if($ok){0}elseif($n -and $n -ne $global:__gcCode){$n}else{1}; $global:__gcCode=$n; $e=[char]27; $b=[char]7; "$e]133;D;$c$b$e]133;A$b" + (& $global:__gcPrompt) }"#;

pub struct TermState {
    pub terms: Mutex<HashMap<String, Term>>,
    pending: Mutex<HashMap<String, Sender<Result<(), String>>>>,
}

impl TermState {
    pub fn new() -> Self {
        TermState { terms: Mutex::new(HashMap::new()), pending: Mutex::new(HashMap::new()) }
    }
}

pub struct Term {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    tree: crate::process_tree::ProcessTree,
    pub owner: String,
    pub cwd: String,
    pub title: Option<String>,
    pub agent: bool,
    pub screen: Arc<Screen>,
}

impl Term {
    fn kill_tree(&self) {
        self.tree.terminate();
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[derive(Default)]
pub struct Marks {
    pub prompts: u64,
    pub finished: u64,
    pub code: Option<i32>,
}

fn mark_code(rest: &[&[u8]]) -> Option<i32> {
    rest.first().and_then(|c| std::str::from_utf8(c).ok()).and_then(|c| c.trim().parse().ok())
}

impl vt100::Callbacks for Marks {
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        match params {
            [b"133", b"A", ..] => self.prompts += 1,
            [b"133", b"D", rest @ ..] => {
                self.finished += 1;
                self.code = mark_code(rest);
            }
            _ => {}
        }
    }
}

#[derive(Default)]
pub struct CaptureMarks {
    pub end: Option<(usize, Option<i32>)>,
}

impl vt100::Callbacks for CaptureMarks {
    fn unhandled_osc(&mut self, screen: &mut vt100::Screen, params: &[&[u8]]) {
        if self.end.is_some() {
            return;
        }
        if let [b"133", b"D", rest @ ..] = params {
            self.end = Some((abs_line(screen), mark_code(rest)));
        }
    }
}

pub struct Capture {
    pub parser: vt100::Parser<CaptureMarks>,
    pub start: usize,
    pub command: String,
    pub started: Instant,
}

impl Capture {
    pub fn finished(&self) -> Option<Option<i32>> {
        self.parser.callbacks().end.map(|(_, code)| code)
    }

    pub fn lines(&mut self) -> Vec<String> {
        let end = match self.parser.callbacks().end {
            Some((line, _)) => line,
            None => cursor_end(self.parser.screen_mut()),
        };
        let start = self.start;
        text_lines(self.parser.screen_mut(), start, end)
    }
}

pub struct ScreenState {
    pub parser: vt100::Parser<Marks>,
    pub capture: Option<Capture>,
    pub exited: Option<Option<u32>>,
    pub received: u64,
    pub last_activity: Instant,
}

impl ScreenState {
    pub fn running(&self) -> bool {
        self.exited.is_none() && self.capture.as_ref().map(|c| c.finished().is_none()).unwrap_or(false)
    }

    pub fn tail(&mut self, max: usize) -> Vec<String> {
        let screen = self.parser.screen_mut();
        let (rows, _) = screen.size();
        let end = cursor_end(screen);
        let mut lines = text_lines(screen, end.saturating_sub(max + usize::from(rows)), end);
        while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
            lines.pop();
        }
        let extra = lines.len().saturating_sub(max);
        lines.drain(..extra);
        lines
    }

    pub fn history(&mut self) -> Vec<String> {
        let screen = self.parser.screen_mut();
        let end = cursor_end(screen);
        text_lines(screen, 0, end)
    }

    pub fn begin_capture(&mut self, command: &str) {
        let (rows, cols) = self.parser.screen().size();
        let mut parser = vt100::Parser::new_with_callbacks(rows, cols, CAPTURE_SCROLLBACK, CaptureMarks::default());
        parser.process(&self.parser.screen().state_formatted());
        let start = abs_line(parser.screen_mut());
        self.capture = Some(Capture { parser, start, command: command.to_string(), started: Instant::now() });
    }

    fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
        if let Some(capture) = self.capture.as_mut() {
            capture.parser.process(bytes);
        }
        self.received += bytes.len() as u64;
        self.last_activity = Instant::now();
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
        if let Some(capture) = self.capture.as_mut() {
            capture.parser.screen_mut().set_size(rows, cols);
        }
    }
}

pub struct Screen {
    pub state: Mutex<ScreenState>,
    pub changed: Condvar,
}

impl Screen {
    fn new(rows: u16, cols: u16) -> Self {
        Screen {
            state: Mutex::new(ScreenState {
                parser: vt100::Parser::new_with_callbacks(rows, cols, SCROLLBACK, Marks::default()),
                capture: None,
                exited: None,
                received: 0,
                last_activity: Instant::now(),
            }),
            changed: Condvar::new(),
        }
    }
}

fn history_len(screen: &mut vt100::Screen) -> usize {
    screen.set_scrollback(usize::MAX);
    let len = screen.scrollback();
    screen.set_scrollback(0);
    len
}

fn abs_line(screen: &mut vt100::Screen) -> usize {
    history_len(screen) + usize::from(screen.cursor_position().0)
}

fn cursor_end(screen: &mut vt100::Screen) -> usize {
    abs_line(screen) + 1
}

fn text_lines(screen: &mut vt100::Screen, from: usize, to: usize) -> Vec<String> {
    let history = history_len(screen);
    let (_, cols) = screen.size();
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut open = false;
    let mut i = from;
    while i < to {
        let page = i.min(history);
        screen.set_scrollback(history - page);
        let visible: Vec<String> = screen.rows(0, cols).collect();
        let first = i - page;
        if first >= visible.len() {
            break;
        }
        for (k, text) in visible.iter().enumerate().skip(first) {
            let abs = page + k;
            if abs >= to {
                break;
            }
            current.push_str(text);
            open = true;
            if !screen.row_wrapped(k as u16) {
                out.push(std::mem::take(&mut current).trim_end().to_string());
                open = false;
            }
            i = abs + 1;
        }
    }
    if open {
        out.push(current.trim_end().to_string());
    }
    screen.set_scrollback(0);
    out
}

#[derive(Deserialize, Clone)]
pub struct TermSpawnArgs {
    pub id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub title: Option<String>,
    pub agent: Option<bool>,
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

pub fn agent_shell() -> Option<String> {
    available_shells().into_iter().find(|s| s.id == "pwsh" || s.id == "powershell").map(|s| s.id)
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
            cmd.args(["-NoLogo", "-NoExit", "-Command", POWERSHELL_SETUP]);
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

pub fn expect_spawn(app: &AppHandle, id: &str) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.state::<TermState>().pending.lock().unwrap().insert(id.to_string(), tx);
    rx
}

pub fn forget_spawn(app: &AppHandle, id: &str) {
    app.state::<TermState>().pending.lock().unwrap().remove(id);
}

pub fn screen_of(app: &AppHandle, id: &str) -> Option<Arc<Screen>> {
    app.state::<TermState>().terms.lock().unwrap().get(id).map(|t| Arc::clone(&t.screen))
}

pub fn write_to(app: &AppHandle, id: &str, data: &[u8]) -> Result<(), String> {
    let state = app.state::<TermState>();
    let guard = state.terms.lock().unwrap();
    let term = guard.get(id).ok_or("la terminal ya no existe")?;
    term.screen.state.lock().unwrap().last_activity = Instant::now();
    let mut writer = term.writer.lock().unwrap();
    writer.write_all(data).map_err(|e| format!("write falló: {}", e))?;
    writer.flush().map_err(|e| format!("flush falló: {}", e))
}

pub fn kill_one(app: &AppHandle, id: &str) -> Option<String> {
    let removed = app.state::<TermState>().terms.lock().unwrap().remove(id)?;
    let owner = removed.owner.clone();
    removed.kill_tree();
    Some(owner)
}

#[cfg(windows)]
fn allow_ctrl_c() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let _ = windows::Win32::System::Console::SetConsoleCtrlHandler(None, false);
    });
}

fn spawn(app: &AppHandle, owner: &str, args: &TermSpawnArgs, on_event: Channel<TermEvent>) -> Result<(), String> {
    #[cfg(windows)]
    allow_ctrl_c();
    if !Path::new(&args.cwd).is_dir() {
        return Err(format!("la carpeta no existe: {}", args.cwd));
    }
    let rows = args.rows.unwrap_or(24).max(2);
    let cols = args.cols.unwrap_or(80).max(10);
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
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
    let tree = match child.process_id().ok_or_else(|| "el shell no devolvió PID".to_string()).and_then(crate::process_tree::ProcessTree::attach) {
        Ok(tree) => tree,
        Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e); }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => { tree.terminate(); let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => { tree.terminate(); let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
    };
    let screen = Arc::new(Screen::new(rows, cols));

    let data_channel = on_event.clone();
    let reader_screen = Arc::clone(&screen);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut detached = false;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reader_screen.state.lock().unwrap().feed(&buf[..n]);
                    reader_screen.changed.notify_all();
                    if detached {
                        continue;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut pending);
                    if !text.is_empty() && data_channel.send(TermEvent::Data { data: text }).is_err() {
                        detached = true;
                    }
                }
            }
        }
    });

    let id = args.id.clone();
    let exit_app = app.clone();
    let exit_screen = Arc::clone(&screen);
    // Publish before starting the waiter: immediately exiting shells must not
    // remove an empty slot and then get inserted as an untracked zombie.
    {
        let state = app.state::<TermState>();
        let mut terms = state.terms.lock().unwrap();
        if terms.contains_key(&id) { tree.terminate(); let _ = child.kill(); let _ = child.wait(); return Err("esa terminal ya existe".into()); }
        terms.insert(id.clone(), Term {
            writer: Mutex::new(writer), master: pair.master, killer: Mutex::new(killer), tree,
            owner: owner.to_string(), cwd: args.cwd.clone(), title: args.title.clone().filter(|t| !t.trim().is_empty()),
            agent: args.agent.unwrap_or(false), screen,
        });
    }
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        exit_screen.state.lock().unwrap().exited = Some(code);
        exit_screen.changed.notify_all();
        let _ = on_event.send(TermEvent::Exit { code });
        if let Some(state) = exit_app.try_state::<TermState>() {
            state.terms.lock().unwrap().remove(&id);
        }
    });

    Ok(())
}

pub fn start_cleanup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        let state = app.state::<TermState>();
        let ids: Vec<String> = {
            let terms = state.terms.lock().unwrap();
            terms.iter().filter_map(|(id, t)| {
                let screen = t.screen.state.lock().unwrap();
                (t.agent && !screen.running() && screen.parser.callbacks().prompts > 0 &&
                    screen.last_activity.elapsed() >= Duration::from_secs(20 * 60) &&
                    t.tree.active_processes().is_some_and(|n| n <= 1)).then(|| id.clone())
            }).collect()
        };
        for id in ids {
            if let Some(owner) = kill_one(&app, &id) {
                use tauri::Emitter;
                let _ = app.emit_to(owner.as_str(), "terminal://agent-closed", serde_json::json!({ "id": id }));
            }
        }
    });
}

#[tauri::command]
pub fn terminal_shells() -> Vec<ShellInfo> {
    available_shells()
}

#[tauri::command]
pub async fn terminal_spawn(app: AppHandle, window: tauri::WebviewWindow, args: TermSpawnArgs, on_event: Channel<TermEvent>) -> Result<(), String> {
    let result = spawn(&app, window.label(), &args, on_event);
    if let Some(waiter) = app.state::<TermState>().pending.lock().unwrap().remove(&args.id) {
        let _ = waiter.send(result.clone());
    }
    result
}

#[tauri::command]
pub async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    write_to(&app, &id, data.as_bytes())
}

#[tauri::command]
pub async fn terminal_resize(state: tauri::State<'_, TermState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let (rows, cols) = (rows.max(2), cols.max(10));
    let screen = {
        let guard = state.terms.lock().unwrap();
        let term = guard.get(&id).ok_or("la terminal ya no existe")?;
        term.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize falló: {}", e))?;
        Arc::clone(&term.screen)
    };
    screen.state.lock().unwrap().resize(rows, cols);
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(rows: u16, cols: u16) -> ScreenState {
        Screen::new(rows, cols).state.into_inner().unwrap()
    }

    #[test]
    fn marks_count_prompts_and_codes() {
        let mut s = screen(10, 40);
        s.feed(b"\x1b]133;D;0\x07\x1b]133;A\x07PS C:\\> ");
        assert_eq!(s.parser.callbacks().prompts, 1);
        s.feed(b"node x\r\nboom\r\n\x1b]133;D;");
        s.feed(b"3\x07\x1b]133;A\x07PS C:\\> ");
        assert_eq!(s.parser.callbacks().prompts, 2);
        assert_eq!(s.parser.callbacks().finished, 2);
        assert_eq!(s.parser.callbacks().code, Some(3));
    }

    #[test]
    fn capture_returns_only_the_command_output() {
        let mut s = screen(5, 40);
        s.feed(b"old 1\r\nold 2\r\n\x1b]133;D;0\x07\x1b]133;A\x07PS C:\\> ");
        s.begin_capture("npm test");
        s.feed(b"npm test\r\n");
        for i in 0..12 {
            s.feed(format!("line {}\r\n", i).as_bytes());
        }
        assert!(s.running());
        s.feed(b"\x1b]133;D;1\x07\x1b]133;A\x07PS C:\\> ");
        assert!(!s.running());
        let capture = s.capture.as_mut().unwrap();
        assert_eq!(capture.finished(), Some(Some(1)));
        let lines = capture.lines();
        assert_eq!(lines.first().map(String::as_str), Some("PS C:\\> npm test"));
        assert_eq!(lines.last().map(String::as_str), Some("line 11"));
        assert_eq!(lines.len(), 13);
    }

    #[test]
    fn capture_of_running_command_grows_until_cursor() {
        let mut s = screen(5, 40);
        s.feed(b"\x1b]133;A\x07PS C:\\> ");
        s.begin_capture("npm run dev");
        s.feed(b"npm run dev\r\nready on 3000\r\n");
        let lines = s.capture.as_mut().unwrap().lines();
        assert_eq!(lines, vec!["PS C:\\> npm run dev", "ready on 3000", ""]);
        assert!(s.running());
    }

    #[test]
    fn tail_joins_wrapped_rows_and_trims_blank_end() {
        let mut s = screen(4, 10);
        s.feed(b"abcdefghijklmno\r\nshort\r\n\r\n");
        assert_eq!(s.tail(10), vec!["abcdefghijklmno", "short"]);
        assert_eq!(s.tail(1), vec!["short"]);
    }

    #[test]
    fn history_reaches_into_scrollback() {
        let mut s = screen(3, 20);
        for i in 0..8 {
            s.feed(format!("row {}\r\n", i).as_bytes());
        }
        let all = s.history();
        assert_eq!(all.first().map(String::as_str), Some("row 0"));
        assert!(all.contains(&"row 7".to_string()));
    }
}
