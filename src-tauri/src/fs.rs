use crate::proc::blocking;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const HEAVY_DIRS: [&str; 12] = [
    "node_modules", "target", "dist", "build", "coverage", "__pycache__", ".next", ".turbo",
    ".venv", "venv", "out", ".gradle",
];
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const MAX_MEDIA_SIZE: u64 = 20 * 1024 * 1024;
const BINARY_SNIFF: usize = 8000;
const MAX_INDEX_FILES: usize = 200_000;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

#[derive(Serialize, Clone)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub heavy: bool,
    pub size: u64,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_dir_sync(dir: &str) -> Result<Vec<FsEntry>, String> {
    let p = Path::new(dir);
    if !p.is_dir() {
        return Err(format!("la carpeta no existe: {}", dir));
    }
    let mut out: Vec<FsEntry> = Vec::new();
    for entry in std::fs::read_dir(p)
        .map_err(|e| format!("no se pudo leer {}: {}", dir, e))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        out.push(FsEntry {
            heavy: is_dir && HEAVY_DIRS.contains(&name.as_str()),
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct FileContent {
    pub content: String,
    pub bom: bool,
    pub size: u64,
    pub mtime: u64,
}

fn read_file_sync(file: &str) -> Result<FileContent, String> {
    let p = Path::new(file);
    if !p.is_file() {
        return Err(format!("el archivo no existe: {}", file));
    }
    let meta = p.metadata().map_err(|e| format!("metadata falló: {}", e))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "archivo demasiado grande para abrir ({:.1} MB)",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("no se pudo leer: {}", e))?;
    let bom = bytes.starts_with(&UTF8_BOM);
    let body = if bom { &bytes[3..] } else { &bytes[..] };
    if body[..body.len().min(BINARY_SNIFF)].contains(&0) {
        return Err("binary".to_string());
    }
    Ok(FileContent {
        content: String::from_utf8_lossy(body).into_owned(),
        bom,
        size: meta.len(),
        mtime: mtime_ms(&meta),
    })
}

fn read_base64_sync(file: &str) -> Result<String, String> {
    let p = Path::new(file);
    let meta = p.metadata().map_err(|e| format!("metadata falló: {}", e))?;
    if meta.len() > MAX_MEDIA_SIZE {
        return Err("archivo demasiado grande para previsualizar".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("no se pudo leer: {}", e))?;
    Ok(encode_base64(&bytes))
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn write_file_sync(file: &str, content: &str, bom: bool) -> Result<u64, String> {
    let p = Path::new(file);
    let parent = p.parent().ok_or("ruta inválida")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("no se pudo crear la carpeta: {}", e))?;
    let tmp = parent.join(format!(
        ".{}.guillecode-{}.tmp",
        p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("no se pudo escribir: {}", e))?;
        if bom {
            f.write_all(&UTF8_BOM).map_err(|e| format!("no se pudo escribir: {}", e))?;
        }
        f.write_all(content.as_bytes()).map_err(|e| format!("no se pudo escribir: {}", e))?;
        f.sync_all().ok();
    }
    if let Err(e) = std::fs::rename(&tmp, p) {
        let direct = std::fs::write(p, [if bom { &UTF8_BOM[..] } else { &[][..] }, content.as_bytes()].concat());
        let _ = std::fs::remove_file(&tmp);
        direct.map_err(|e2| format!("no se pudo guardar ({} / {})", e, e2))?;
    }
    Ok(p.metadata().map(|m| mtime_ms(&m)).unwrap_or(0))
}

#[derive(Serialize, Clone)]
pub struct FsStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

fn stat_sync(file: &str) -> FsStat {
    match Path::new(file).metadata() {
        Ok(m) => FsStat { exists: true, is_dir: m.is_dir(), size: m.len(), mtime: mtime_ms(&m) },
        Err(_) => FsStat { exists: false, is_dir: false, size: 0, mtime: 0 },
    }
}

fn create_file_sync(file: &str) -> Result<(), String> {
    let p = Path::new(file);
    if p.exists() {
        return Err(format!("ya existe: {}", file));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("no se pudo crear la carpeta: {}", e))?;
    }
    std::fs::File::create(p).map(|_| ()).map_err(|e| format!("no se pudo crear: {}", e))
}

fn create_dir_sync(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear la carpeta: {}", e))
}

fn rename_sync(from: &str, to: &str) -> Result<(), String> {
    if Path::new(to).exists() && !from.eq_ignore_ascii_case(to) {
        return Err(format!("ya existe: {}", to));
    }
    if let Some(parent) = Path::new(to).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("no se pudo crear la carpeta: {}", e))?;
    }
    std::fs::rename(from, to).map_err(|e| format!("no se pudo renombrar: {}", e))
}

fn delete_sync(paths: &[String]) -> Result<(), String> {
    for p in paths {
        if Path::new(p).exists() {
            trash::delete(p).map_err(|e| format!("no se pudo mandar a la papelera {}: {}", p, e))?;
        }
    }
    Ok(())
}

fn list_files_sync(root: &str) -> Result<Vec<String>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("la carpeta no existe: {}", root));
    }
    let walker = ignore::WalkBuilder::new(&root_path)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != ".git" && !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && HEAVY_DIRS.contains(&name.as_ref()))
        })
        .build();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(&root_path) {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if files.len() >= MAX_INDEX_FILES {
            break;
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
pub async fn fs_read_dir(dir: String) -> Result<Vec<FsEntry>, String> {
    blocking(move || read_dir_sync(&dir)).await
}

#[tauri::command]
pub async fn fs_read_file(file: String) -> Result<FileContent, String> {
    blocking(move || read_file_sync(&file)).await
}

#[tauri::command]
pub async fn fs_read_base64(file: String) -> Result<String, String> {
    blocking(move || read_base64_sync(&file)).await
}

#[tauri::command]
pub async fn fs_write_file(file: String, content: String, bom: Option<bool>) -> Result<u64, String> {
    blocking(move || write_file_sync(&file, &content, bom.unwrap_or(false))).await
}

#[tauri::command]
pub async fn fs_stat(file: String) -> Result<FsStat, String> {
    blocking(move || Ok(stat_sync(&file))).await
}

#[tauri::command]
pub async fn fs_create_file(file: String) -> Result<(), String> {
    blocking(move || create_file_sync(&file)).await
}

#[tauri::command]
pub async fn fs_create_dir(dir: String) -> Result<(), String> {
    blocking(move || create_dir_sync(&dir)).await
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || rename_sync(&from, &to)).await
}

#[tauri::command]
pub async fn fs_delete(paths: Vec<String>) -> Result<(), String> {
    blocking(move || delete_sync(&paths)).await
}

#[tauri::command]
pub async fn fs_list_files(root: String) -> Result<Vec<String>, String> {
    blocking(move || list_files_sync(&root)).await
}
