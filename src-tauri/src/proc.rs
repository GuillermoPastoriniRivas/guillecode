use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Instant;
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
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                self.missing_hint
                    .map(|h| h.to_string())
                    .unwrap_or_else(|| format!("{} no está instalado o no está en el PATH", self.program))
            } else {
                format!("no se pudo ejecutar {}: {}", self.program, e)
            }
        })?;
        if let Some(input) = self.stdin {
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(input.as_bytes())
                    .map_err(|e| format!("no se pudo escribir en {}: {}", self.program, e))?;
            }
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("{} falló: {}", self.program, e))?;
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
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{} no está instalado o no está en el PATH", program)
        } else {
            format!("no se pudo ejecutar {}: {}", program, e)
        }
    })?;
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
