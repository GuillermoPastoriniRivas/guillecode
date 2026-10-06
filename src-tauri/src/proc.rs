use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn install(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

#[derive(Serialize, Clone)]
struct ProcLog {
    tool: String,
    args: Vec<String>,
    cwd: String,
    ok: bool,
    ms: u128,
    output: String,
}

const LOG_OUTPUT_LIMIT: usize = 4000;
pub const MAX_GIT_PROCESSES: usize = 4;
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
static GIT_SLOTS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

struct GitPermit;
impl GitPermit {
    fn acquire(deadline: Instant) -> Result<Self, String> {
        let (lock, changed) = &GIT_SLOTS;
        let mut active = lock.lock().unwrap_or_else(|e| e.into_inner());
        while *active >= MAX_GIT_PROCESSES {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { return Err("git: venció el tiempo de espera en la cola".into()); }
            active = changed.wait_timeout(active, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        *active += 1;
        Ok(Self)
    }
}
impl Drop for GitPermit {
    fn drop(&mut self) {
        let mut active = GIT_SLOTS.0.lock().unwrap_or_else(|e| e.into_inner());
        *active -= 1;
        GIT_SLOTS.1.notify_one();
    }
}

pub fn command_timeout(program: &str, args: &[&str]) -> Duration {
    let git = program == "git" || program.ends_with("git.exe");
    if git && args.iter().any(|a| matches!(*a, "fetch" | "pull" | "push" | "clone")) {
        Duration::from_secs(300)
    } else if !git || args.iter().any(|a| matches!(*a, "commit" | "merge" | "rebase" | "checkout" | "worktree")) {
        Duration::from_secs(120)
    } else { Duration::from_secs(30) }
}

fn drain(mut pipe: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buf = [0u8; 8192];
    let mut exceeded = false;
    loop {
        let n = pipe.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        let take = n.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buf[..take]);
        exceeded |= take < n;
    }
    if exceeded { Err(format!("la salida superó el límite de {} MB", limit / 1024 / 1024)) } else { Ok(bytes) }
}

// A deadline covers stdin, child exit AND pipe EOF. Waiting only for the root
// process is insufficient when a hook leaves a descendant holding stdout.
pub fn capture(cmd: &mut Command, stdin: Option<&str>, timeout: Duration, git: bool) -> Result<Output, String> {
    let deadline = Instant::now() + timeout;
    let _permit = if git { Some(GitPermit::acquire(deadline)?) } else { None };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    hide_console(cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let tree = match crate::process_tree::ProcessTree::attach(child.id()) {
        Ok(tree) => Some(tree),
        Err(e) => {
            // Very short commands may already be gone before OpenProcess.
            if child.try_wait().ok().flatten().is_some() { None }
            else { let _ = child.kill(); let _ = child.wait(); return Err(e); }
        }
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let out_tx = tx.clone();
    let out_reader = std::thread::spawn(move || { let _ = out_tx.send((0, drain(stdout, OUTPUT_LIMIT))); });
    let err_tx = tx.clone();
    let err_reader = std::thread::spawn(move || { let _ = err_tx.send((1, drain(stderr, OUTPUT_LIMIT))); });
    let input = stdin.map(str::to_owned);
    let pipe = child.stdin.take();
    let writer = std::thread::spawn(move || {
        let result = match (pipe, input) { (Some(mut pipe), Some(input)) => pipe.write_all(input.as_bytes()).map_err(|e| e.to_string()), _ => Ok(()) };
        let _ = tx.send((2, result.map(|_| Vec::new())));
    });
    let mut results = [None, None, None];
    let mut status = None;
    let result = loop {
        while let Ok((index, bytes)) = rx.try_recv() { results[index] = Some(bytes); }
        if status.is_none() {
            match child.try_wait() {
                Ok(Some(exit)) => status = Some(exit),
                Ok(None) => {},
                Err(e) => break Err(e.to_string()),
            }
        }
        if status.is_some() && results.iter().all(Option::is_some) {
            let stdout = results[0].take().unwrap();
            let stderr = results[1].take().unwrap();
            let written = results[2].take().unwrap();
            break match (stdout, stderr, written) {
                (Ok(stdout), Ok(stderr), Ok(_)) => Ok(Output { status: status.unwrap(), stdout, stderr }),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => Err(e),
            };
        }
        if Instant::now() >= deadline { break Err(format!("el comando superó {} s y se detuvo su árbol de procesos", timeout.as_secs())); }
        std::thread::sleep(Duration::from_millis(10));
    };
    if let Some(tree) = &tree { tree.terminate(); }
    if status.is_none() { let _ = child.kill(); }
    let _ = child.wait();
    // Terminating the job closes descendant pipe handles too.
    let _ = out_reader.join();
    let _ = err_reader.join();
    let _ = writer.join();
    result
}

fn emit_log(tool: &str, args: &[&str], cwd: &str, ok: bool, started: Instant, output: &str) {
    let Some(app) = APP.get() else { return };
    let mut output = output.trim().to_string();
    if output.len() > LOG_OUTPUT_LIMIT {
        let mut cut = LOG_OUTPUT_LIMIT;
        while !output.is_char_boundary(cut) {
            cut -= 1;
        }
        output.truncate(cut);
        output.push_str("\n…");
    }
    let _ = app.emit(
        "proc://log",
        ProcLog {
            tool: tool.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: cwd.to_string(),
            ok,
            ms: started.elapsed().as_millis(),
            output,
        },
    );
}

pub fn hide_console(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

pub struct Run<'a> {
    pub program: &'a str,
    pub cwd: &'a str,
    pub args: &'a [&'a str],
    pub stdin: Option<&'a str>,
    pub quiet: bool,
    pub missing_hint: Option<&'a str>,
}

impl<'a> Run<'a> {
    pub fn new(program: &'a str, cwd: &'a str, args: &'a [&'a str]) -> Self {
        Run { program, cwd, args, stdin: None, quiet: false, missing_hint: None }
    }

    pub fn stdin(mut self, input: &'a str) -> Self {
        self.stdin = Some(input);
        self
    }

    pub fn quiet(mut self) -> Self {
        self.quiet = true;
        self
    }

    pub fn missing_hint(mut self, hint: &'a str) -> Self {
        self.missing_hint = Some(hint);
        self
    }

    pub fn exec(self) -> Result<String, String> {
        let dir = Path::new(self.cwd);
        if !dir.is_dir() {
            return Err(format!("la carpeta no existe: {}", self.cwd));
        }
        let started = Instant::now();
        let mut cmd = Command::new(self.program);
        cmd.current_dir(dir)
            .args(self.args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("NO_COLOR", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        hide_console(&mut cmd);
        let out = capture(&mut cmd, self.stdin, command_timeout(self.program, self.args), self.program == "git")
            .map_err(|e| {
                let message = format!("{}: {}{}", self.program, e, self.missing_hint.map(|h| format!(" ({})", h)).unwrap_or_default());
                emit_log(self.program, self.args, self.cwd, false, started, &message);
                message
            })?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let ok = out.status.success();
        if !self.quiet || !ok {
            let shown = if ok { stdout.as_str() } else { stderr.as_str() };
            emit_log(self.program, self.args, self.cwd, ok, started, shown);
        }
        if !ok {
            if stderr.is_empty() {
                let trimmed = stdout.trim();
                if !trimmed.is_empty() {
                    return Err(trimmed.to_string());
                }
                return Err(format!("{} terminó con error (exit {:?})", self.program, out.status.code()));
            }
            return Err(stderr);
        }
        Ok(stdout)
    }
}

pub fn exec_bytes(program: &str, cwd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Err(format!("la carpeta no existe: {}", cwd));
    }
    let started = Instant::now();
    let mut cmd = Command::new(program);
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    hide_console(&mut cmd);
    let out = capture(&mut cmd, None, command_timeout(program, args), program == "git").map_err(|e| format!("{}: {}", program, e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        emit_log(program, args, cwd, false, started, &stderr);
        return Err(if stderr.is_empty() {
            format!("{} terminó con error (exit {:?})", program, out.status.code())
        } else {
            stderr
        });
    }
    Ok(out.stdout)
}

pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_git_commands_get_a_short_deadline_and_network_ones_a_long_one() {
        assert_eq!(command_timeout("git", &["merge-base", "a", "b"]), Duration::from_secs(30));
        assert_eq!(command_timeout("git", &["rev-list", "--count", "a...b"]), Duration::from_secs(30));
        assert_eq!(command_timeout("git", &["fetch", "origin"]), Duration::from_secs(300));
        assert_eq!(command_timeout("git", &["merge", "x"]), Duration::from_secs(120));
        assert_eq!(command_timeout("npm", &["install"]), Duration::from_secs(120));
    }

    #[test]
    #[cfg(windows)]
    fn a_command_wedged_past_its_deadline_is_killed_with_its_tree() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 30 127.0.0.1 > NUL"]);
        let started = Instant::now();
        let result = capture(&mut cmd, None, Duration::from_millis(700), false);
        let message = result.expect_err("el comando largo debía vencer");
        assert!(message.contains("superó"), "{}", message);
        assert!(started.elapsed() < Duration::from_secs(10), "el deadline no acotó la espera");
    }
}
