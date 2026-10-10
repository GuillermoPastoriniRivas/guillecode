//! Whisper local (whisper.cpp) para la transcripción de audios sin nube.
//!
//! GuilleCode ya sabe hablar el contrato de OpenAI (`/audio/transcriptions`).
//! Acá empaquetamos el `whisper-server` de whisper.cpp como binario propio,
//! lo levantamos en un puerto local efímero con `--inference-path
//! /v1/audio/transcriptions` y dejamos que `voice.rs` le pegue como si fuera
//! un proveedor OpenAI. El audio viaja como WAV (sin ffmpeg) y los modelos
//! GGML se descargan a la carpeta de datos de la app la primera vez.

use crate::{app_data_file, proc};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Tamaños ofrecidos. Todos son multilingües (sirven para español).
pub const SIZES: [&str; 4] = ["base", "small", "medium", "large-v3-turbo"];
pub const DEFAULT_SIZE: &str = "small";

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const CANCELLED: &str = "__cancel__";

struct Server {
    child: Child,
    port: u16,
    size: String,
}

#[derive(Default)]
pub struct WhisperState {
    server: Mutex<Option<Server>>,
    download: Mutex<Option<Download>>,
}

#[derive(Clone)]
struct Download {
    size: String,
    received: u64,
    total: u64,
    error: Option<String>,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub size: String,
    pub present: bool,
    pub bytes: u64,
    pub total_bytes: u64,
    pub downloading: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperView {
    pub available: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub default_size: String,
    pub models_dir: Option<String>,
    pub models: Vec<ModelView>,
}

pub fn size_bytes(size: &str) -> u64 {
    match size {
        "base" => 147_951_465,
        "small" => 487_601_967,
        "medium" => 1_533_763_059,
        "large-v3-turbo" => 1_624_555_275,
        _ => 0,
    }
}

fn model_name(size: &str) -> String {
    format!("ggml-{}.bin", size)
}

fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app_data_file(app, "whisper")?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn model_path(app: &AppHandle, size: &str) -> Option<PathBuf> {
    Some(model_dir(app)?.join(model_name(size)))
}

pub fn model_present(app: &AppHandle, size: &str) -> bool {
    model_path(app, size).map(|p| p.is_file()).unwrap_or(false)
}

/// Resuelve `whisper-server.exe` junto a los binarios/DLLs que empaquetamos en
/// `binaries/whisper` (dev) o `resources/whisper` (instalado).
fn server_bin(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("whisper").join("whisper-server.exe"));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("whisper").join("whisper-server.exe"));
        candidates.push(res.join("binaries").join("whisper").join("whisper-server.exe"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        candidates.push(dir.join("whisper").join("whisper-server.exe"));
        candidates.push(dir.join("whisper-server.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn available(app: &AppHandle) -> bool {
    server_bin(app).is_some()
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no hay puertos libres: {}", e))
}

/// Asegura que el server local esté corriendo con el modelo pedido y devuelve
/// su puerto. Si ya está vivo con el mismo modelo, lo reutiliza (el modelo
/// queda cargado en RAM); si cambió el tamaño, lo reinicia.
pub fn ensure(app: &AppHandle, size: &str) -> Result<u16, String> {
    let state = app.state::<WhisperState>();
    {
        let mut guard = state.server.lock().unwrap();
        if let Some(server) = guard.as_mut() {
            if matches!(server.child.try_wait(), Ok(None)) && server.size == size {
                return Ok(server.port);
            }
        }
        if let Some(mut server) = guard.take() {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
    let bin = server_bin(app).ok_or_else(|| "El motor de Whisper no está instalado en esta PC".to_string())?;
    let model = model_path(app, size)
        .filter(|p| p.is_file())
        .ok_or_else(|| format!("Falta descargar el modelo de Whisper «{}» (GuilleCode → Audios)", size))?;
    let port = free_port()?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut cmd = Command::new(&bin);
    cmd.arg("-m")
        .arg(&model)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--inference-path")
        .arg("/v1/audio/transcriptions")
        .arg("-t")
        .arg(threads.to_string())
        .arg("-l")
        .arg("auto")
        .arg("-nt")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = bin.parent() {
        cmd.current_dir(dir);
    }
    proc::hide_console(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("No se pudo iniciar Whisper: {}", e))?;
    *state.server.lock().unwrap() = Some(Server { child, port, size: size.to_string() });
    if let Err(e) = wait_ready(port, Duration::from_secs(180)) {
        stop(app);
        return Err(e);
    }
    Ok(port)
}

fn wait_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().map_err(|e| format!("dirección inválida: {}", e))?;
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Whisper tardó demasiado en cargar el modelo".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<WhisperState>() {
        if let Some(mut server) = state.server.lock().unwrap().take() {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

#[tauri::command]
pub fn whisper_status(app: AppHandle) -> WhisperView {
    let state = app.state::<WhisperState>();
    let (running, port) = {
        let mut guard = state.server.lock().unwrap();
        let mut result = (false, None);
        if let Some(server) = guard.as_mut() {
            if matches!(server.child.try_wait(), Ok(None)) {
                result = (true, Some(server.port));
            }
        }
        result
    };
    let download = state.download.lock().unwrap().clone();
    let models = SIZES
        .iter()
        .map(|size| {
            let path = model_path(&app, size);
            let present = path.as_ref().map(|p| p.is_file()).unwrap_or(false);
            let bytes = if present {
                path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };
            let active = download.as_ref().filter(|d| d.size == *size);
            ModelView {
                size: (*size).to_string(),
                present,
                bytes,
                total_bytes: size_bytes(size),
                downloading: active.map(|d| d.error.is_none()).unwrap_or(false),
                error: active.and_then(|d| d.error.clone()),
            }
        })
        .collect();
    WhisperView {
        available: available(&app),
        running,
        port,
        default_size: DEFAULT_SIZE.to_string(),
        models_dir: model_dir(&app).map(|p| p.to_string_lossy().into_owned()),
        models,
    }
}

#[tauri::command]
pub fn whisper_cancel(app: AppHandle) {
    if let Some(state) = app.try_state::<WhisperState>() {
        if let Some(d) = state.download.lock().unwrap().as_ref() {
            d.cancel.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn whisper_download(app: AppHandle, size: String) -> Result<(), String> {
    if !SIZES.contains(&size.as_str()) {
        return Err(format!("Modelo desconocido: {}", size));
    }
    let state = app.state::<WhisperState>();
    {
        let current = state.download.lock().unwrap();
        if let Some(d) = current.as_ref() {
            if d.error.is_none() {
                return Ok(());
            }
        }
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.download.lock().unwrap() = Some(Download { size: size.clone(), received: 0, total: size_bytes(&size), error: None, cancel: cancel.clone() });
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = download_model(&handle, &size, &cancel);
        if let Some(state) = handle.try_state::<WhisperState>() {
            match &result {
                Ok(()) => *state.download.lock().unwrap() = None,
                Err(e) if e == CANCELLED => *state.download.lock().unwrap() = None,
                Err(e) => {
                    if let Some(d) = state.download.lock().unwrap().as_mut() {
                        d.error = Some(e.clone());
                    }
                }
            }
        }
        match result {
            Ok(()) => {
                let _ = handle.emit("whisper:download", serde_json::json!({ "size": size, "done": true }));
            }
            Err(e) if e == CANCELLED => {
                let _ = handle.emit("whisper:download", serde_json::json!({ "size": size, "cancelled": true }));
            }
            Err(e) => {
                let _ = handle.emit("whisper:download", serde_json::json!({ "size": size, "error": e }));
            }
        }
    });
    Ok(())
}

fn download_model(app: &AppHandle, size: &str, cancel: &AtomicBool) -> Result<(), String> {
    let dest = model_path(app, size).ok_or("sin carpeta de modelos")?;
    let tmp = dest.with_extension("part");
    let _ = std::fs::remove_file(&tmp);
    let url = format!("{}/{}", HF_BASE, model_name(size));
    let resp = ureq::get(&url).call().map_err(|e| format!("No se pudo descargar el modelo: {}", e))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or_else(|| size_bytes(size));
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    let mut received: u64 = 0;
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(CANCELLED.to_string());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            if let Some(state) = app.try_state::<WhisperState>() {
                if let Some(d) = state.download.lock().unwrap().as_mut() {
                    d.received = received;
                    d.total = total;
                }
            }
            let _ = app.emit("whisper:download", serde_json::json!({ "size": size, "received": received, "total": total }));
        }
    }
    file.flush().ok();
    drop(file);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn whisper_delete_model(app: AppHandle, size: String) -> Result<(), String> {
    if let Some(path) = model_path(&app, &size) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("part"));
    }
    Ok(())
}
