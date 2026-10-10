use crate::{app_data_file, ensure_server, oc::Opencode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "memory-config.json";
const DIGEST_MAX: usize = 7000;
const BODY_MAX: usize = 200_000;
const FIELD_MAX: usize = 4_000;
const CAPTURE_MESSAGES: usize = 60;

pub fn instructions() -> &'static str {
    INSTRUCTIONS
}

const INSTRUCTIONS: &str = "Memoria local de GuilleCode: conocimiento y trabajos compartidos entre chats, ventanas y modelos, guardados solo en esta PC. Usá `memory_search` para encontrar decisiones, convenciones o intentos fallidos antes de asumir; `memory_list` para ver notas y trabajos del proyecto; `memory_read` para leer el detalle; `memory_write` para dejar una decisión, convención o aprendizaje durable (no changelog); `memory_delete` para quitarlo. Si no sabés el `scope`, omitilo: se usa el proyecto de la ventana principal. La memoria se inyecta sola al empezar cada conversación; no hace falta pedirla.";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryConfig {
    pub root: Option<String>,
    pub sessions: BTreeMap<String, bool>,
}

pub struct MemoryState {
    config: Mutex<MemoryConfig>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_file(app, CONFIG_FILE)
}

fn load(app: &AppHandle) -> MemoryConfig {
    config_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &MemoryConfig) {
    if let Some(path) = config_path(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

pub fn root(app: &AppHandle) -> PathBuf {
    let configured = app.state::<MemoryState>().config.lock().unwrap().root.clone();
    match configured.filter(|s| !s.trim().is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app_data_file(app, "memory").unwrap_or_else(|| PathBuf::from("memory")),
    }
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    let root = config
        .root
        .clone()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data_file(app, "memory").unwrap_or_else(|| PathBuf::from("memory")));
    for dir in [root.clone(), root.join("global"), root.join("workspaces")] {
        let _ = fs::create_dir_all(&dir);
    }
    let prefs = root.join("global").join("_preferences.md");
    if !prefs.exists() {
        let _ = fs::write(&prefs, "# Preferencias personales\n\n- (escribí acá las convenciones o preferencias que valgan para todos los proyectos)\n");
    }
    app.manage(MemoryState { config: Mutex::new(config) });
}

pub fn plugin_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app_data_file(app, "memory-plugin")?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("guillecode-memory.js");
    let _ = fs::write(&path, include_str!("memory_plugin.js"));
    Some(path)
}

pub fn extend_config(app: &AppHandle, config: &mut Value) {
    let Some(plugin) = plugin_file(app) else { return };
    let url = format!("file://{}", plugin.to_string_lossy().replace('\\', "/"));
    let root = root(app).to_string_lossy().to_string();
    let config_path = config_path(app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let entry = json!([url, { "root": root, "config": config_path }]);
    match config.get_mut("plugin") {
        Some(Value::Array(list)) => list.push(entry),
        _ => config["plugin"] = json!([entry]),
    }
}

fn collapse(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn slug(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("workspace");
    let trimmed = collapse(base);
    if trimmed.is_empty() { "workspace".to_string() } else { trimmed }
}

fn default_scope(app: &AppHandle) -> String {
    ensure_server(app).map(|c| c.worktree).unwrap_or_default()
}

fn workspace_dir(app: &AppHandle, scope: &str) -> PathBuf {
    root(app).join("workspaces").join(slug(scope))
}

fn notes_dir(app: &AppHandle, scope: &str) -> PathBuf {
    workspace_dir(app, scope).join("notes")
}

fn tasks_dir(app: &AppHandle, scope: &str) -> PathBuf {
    workspace_dir(app, scope).join("tasks")
}

fn ensure_workspace(app: &AppHandle, scope: &str) {
    let dir = workspace_dir(app, scope);
    let _ = fs::create_dir_all(dir.join("notes"));
    let _ = fs::create_dir_all(dir.join("tasks"));
    let overview = dir.join("_overview.md");
    if !overview.exists() {
        let name = scope.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or("Proyecto").to_string();
        let _ = fs::write(&overview, format!("# {}\n\n- (qué es este proyecto, arquitectura y convenciones que el agente debe saber)\n", name));
    }
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn write_text(path: &Path, content: &str) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, content);
}

fn frontmatter(body: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(rest) = body.strip_prefix("---") else { return out };
    let Some(end) = rest.find("\n---") else { return out };
    for line in rest[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            out.insert(key.trim().to_lowercase(), value.trim().trim_matches('"').to_string());
        }
    }
    out
}

fn first_line(body: &str) -> String {
    body.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("---") && !l.contains(':') && !l.starts_with('#'))
        .or_else(|| body.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()))
        .unwrap_or_default()
        .chars()
        .take(140)
        .collect()
}

fn body_of(body: &str) -> String {
    match body.find("\n---") {
        Some(index) => body[index + 4..].trim().to_string(),
        None => body.trim().to_string(),
    }
}

fn note_slug(title: &str) -> String {
    let trimmed = collapse(title);
    if trimmed.is_empty() { format!("nota-{}", chrono::Utc::now().timestamp()) } else { trimmed }
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn session_enabled(app: &AppHandle, session: &str) -> bool {
    if session.is_empty() {
        return true;
    }
    let state = app.state::<MemoryState>();
    let config = state.config.lock().unwrap();
    config.sessions.get(session).copied().unwrap_or(true)
}

pub fn set_session(app: &AppHandle, session: &str, enabled: bool) {
    if session.is_empty() {
        return;
    }
    let state = app.state::<MemoryState>();
    let mut config = state.config.lock().unwrap();
    if enabled {
        config.sessions.remove(session);
    } else {
        config.sessions.insert(session.to_string(), false);
    }
    save(app, &config);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteView {
    id: String,
    title: String,
    kind: String,
    updated: String,
    preview: String,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskView {
    id: String,
    title: String,
    updated: String,
    directory: String,
    progress: String,
    last_user: String,
    source: String,
}

fn note_views(app: &AppHandle, scope: &str) -> Vec<NoteView> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(notes_dir(app, scope)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = read_text(&path);
        let meta = frontmatter(&content);
        out.push(NoteView {
            id: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            title: meta.get("title").cloned().unwrap_or_else(|| first_line(&content)),
            kind: meta.get("type").cloned().unwrap_or_else(|| "nota".to_string()),
            updated: meta.get("updated").cloned().unwrap_or_default(),
            preview: first_line(&body_of(&content)),
            source: meta.get("source").cloned().unwrap_or_else(|| "agent".to_string()),
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

fn task_views(app: &AppHandle, scope: &str) -> Vec<TaskView> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(tasks_dir(app, scope)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        out.push(TaskView {
            id: value["id"].as_str().unwrap_or_default().to_string(),
            title: value["title"].as_str().unwrap_or_default().to_string(),
            updated: value["updatedAt"].as_str().unwrap_or_default().to_string(),
            directory: value["directory"].as_str().unwrap_or_default().to_string(),
            progress: value["progress"].as_str().unwrap_or_default().chars().take(300).collect(),
            last_user: value["lastUser"].as_str().unwrap_or_default().to_string(),
            source: value["source"].as_str().unwrap_or("agent").to_string(),
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

fn render_digest(app: &AppHandle, scope: &str) {
    let prefs = read_text(&root(app).join("global").join("_preferences.md"));
    let overview = read_text(&workspace_dir(app, scope).join("_overview.md"));
    let notes = note_views(app, scope);
    let tasks = task_views(app, scope);
    let prefs_body = body_of(&prefs);
    let overview_body = body_of(&overview);
    let path = workspace_dir(app, scope).join("_digest.md");
    if prefs_body.is_empty() && overview_body.is_empty() && notes.is_empty() && tasks.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("# Memoria local de GuilleCode".into());
    lines.push(String::new());
    lines.push(format!("- **Proyecto:** {} (workspace `{}`)", scope, slug(scope)));
    lines.push(String::new());
    if !prefs_body.is_empty() {
        lines.push("## Preferencias".into());
        lines.push(prefs_body.chars().take(1200).collect());
        lines.push(String::new());
    }
    if !overview_body.is_empty() {
        lines.push(format!("## Proyecto {}", slug(scope)));
        lines.push(overview_body.chars().take(1500).collect());
        lines.push(String::new());
    }
    if !tasks.is_empty() {
        lines.push("## Trabajos recientes".into());
        for task in tasks.iter().take(10) {
            let mut line = format!("- **{}** (act. {})", if task.title.is_empty() { &task.id } else { &task.title }, task.updated);
            if !task.progress.is_empty() {
                line.push_str(&format!(" — {}", task.progress.replace('\n', " ")));
            }
            lines.push(line);
        }
        lines.push(String::new());
    }
    if !notes.is_empty() {
        lines.push("## Notas y decisiones".into());
        for note in notes.iter().take(12) {
            lines.push(format!("- **{}** ({}) — {}", note.title, note.kind, note.preview));
        }
        lines.push(String::new());
    }
    lines.push("Usá `memory_search`, `memory_list` y `memory_read` para el detalle; `memory_write` para dejar una decisión durable.".into());

    let digest = truncate_chars(&lines.join("\n"), DIGEST_MAX);
    write_text(&path, &digest);
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

fn extract_text(parts: &Value) -> String {
    parts
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|p| p["type"] == "text" && p["synthetic"] != true)
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .chars()
        .take(FIELD_MAX)
        .collect()
}

pub fn capture(app: &AppHandle, session: &str) {
    if session.is_empty() || !session_enabled(app, session) {
        return;
    }
    let Ok(server) = ensure_server(app) else { return };
    let directory = server.worktree.clone();
    let client = Opencode::new(&server, &directory);
    let Ok(info) = client.get(&format!("/session/{}", session)) else { return };
    if info["parentID"].is_string() {
        return;
    }
    let scope = info["directory"].as_str().filter(|s| !s.is_empty()).unwrap_or(&directory).to_string();
    if scope.is_empty() {
        return;
    }
    let title = info["title"].as_str().unwrap_or("").to_string();
    if title.starts_with("guillecode·") {
        return;
    }
    let Ok(messages) = client.get(&format!("/session/{}/message?limit={}", session, CAPTURE_MESSAGES)) else { return };
    let Some(list) = messages.as_array() else { return };
    let mut last_user = String::new();
    let mut last_assistant = String::new();
    for message in list {
        let role = message["info"]["role"].as_str().unwrap_or("");
        let text = extract_text(&message["parts"]);
        if text.is_empty() {
            continue;
        }
        if role == "user" {
            last_user = text;
        } else if role == "assistant" {
            last_assistant = text;
        }
    }
    if last_user.is_empty() && last_assistant.is_empty() {
        return;
    }
    ensure_workspace(app, &scope);
    let checkpoint = json!({
        "id": session,
        "title": title,
        "directory": scope,
        "updatedAt": now(),
        "lastUser": last_user,
        "progress": last_assistant,
        "source": "agent",
    });
    write_text(
        &tasks_dir(app, &scope).join(format!("{}.json", slug(session))),
        &serde_json::to_string_pretty(&checkpoint).unwrap_or_default(),
    );
    render_digest(app, &scope);
}

fn walk_md(dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_md(&path, limit, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
            if out.len() >= limit {
                return;
            }
        }
    }
}

fn relative(app: &AppHandle, path: &Path) -> String {
    path.strip_prefix(root(app)).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn search(app: &AppHandle, query: &str) -> Value {
    let tokens: Vec<String> = query.to_lowercase().split_whitespace().map(|t| t.to_string()).filter(|t| t.len() >= 2).collect();
    let mut files = Vec::new();
    walk_md(&root(app), 400, &mut files);
    let mut scored: Vec<(usize, String, String, String)> = Vec::new();
    for path in files {
        let content = read_text(&path);
        let lower = content.to_lowercase();
        let mut score = 0usize;
        for token in &tokens {
            score += lower.matches(token.as_str()).count();
        }
        if score == 0 {
            continue;
        }
        let meta = frontmatter(&content);
        let title = meta.get("title").cloned().unwrap_or_else(|| first_line(&content));
        let snippet: String = content
            .lines()
            .find(|l| tokens.iter().any(|t| l.to_lowercase().contains(t)))
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect();
        scored.push((score, relative(app, &path), title, snippet));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<Value> = scored
        .into_iter()
        .take(20)
        .map(|(score, path, title, snippet)| json!({ "path": path, "title": title, "snippet": snippet, "score": score }))
        .collect();
    json!({ "results": results })
}

fn read_entry(app: &AppHandle, id: &str) -> Value {
    let resolved = resolve(app, id);
    match resolved {
        Some(path) if path.exists() => json!({ "path": relative(app, &path), "content": read_text(&path) }),
        _ => json!({ "error": "no existe" }),
    }
}

fn walk_files(dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, limit, out);
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("md" | "json")) {
            out.push(path);
            if out.len() >= limit {
                return;
            }
        }
    }
}

fn resolve(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let root = root(app);
    let normalized = id.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains(':') {
        return None;
    }
    let direct = root.join(trimmed);
    if direct.is_file() && inside(&root, &direct) {
        return Some(direct);
    }
    if !trimmed.contains("..") {
        let rel = trimmed.to_lowercase();
        let mut files = Vec::new();
        walk_files(&root, 600, &mut files);
        for path in files {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if stem == rel || relative(app, &path).to_lowercase() == rel {
                return Some(path);
            }
        }
    }
    None
}

fn resolve_note(app: &AppHandle, id: &str) -> Option<PathBuf> {
    resolve(app, id).filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
}

/// Comprueba que un archivo existente quede dentro de la raíz (resuelve `..` y symlinks).
fn inside(root: &Path, candidate: &Path) -> bool {
    match (fs::canonicalize(candidate), fs::canonicalize(root)) {
        (Ok(real), Ok(real_root)) => real.starts_with(real_root),
        _ => false,
    }
}

/// Las ediciones de la UI se resuelven en su colección, nunca por un id global ambiguo.
fn existing_memory_file(dir: &Path, id: &str, extension: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || matches!(id, "." | "..") {
        return Err("Id de memoria inválido".into());
    }
    let path = dir.join(format!("{}.{}", id, extension));
    if !path.is_file() || !inside(dir, &path) {
        return Err("No existe esta entrada de memoria en el proyecto".into());
    }
    Ok(path)
}

fn write_memory_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn note_file(dir: &Path, title: &str, id: Option<&str>) -> Result<PathBuf, String> {
    match id {
        Some(id) => existing_memory_file(dir, id, "md"),
        None => {
            let id = note_slug(title);
            let path = dir.join(format!("{}.md", id));
            if path.exists() { existing_memory_file(dir, &id, "md") } else { Ok(path) }
        }
    }
}

fn task_file(app: &AppHandle, scope: &str, id: &str) -> Result<(PathBuf, Value), String> {
    let path = existing_memory_file(&tasks_dir(app, scope), &slug(id), "json")?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value["id"].as_str() != Some(id) {
        return Err("El id del trabajo no coincide con el estado guardado".into());
    }
    Ok((path, value))
}

pub fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "search",
            "description": "Busca en la memoria local de GuilleCode (notas, decisiones, convenciones, intentos fallidos y trabajos).",
            "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
        }),
        json!({
            "name": "list",
            "description": "Lista las notas y trabajos de la memoria del proyecto.",
            "inputSchema": { "type": "object", "properties": { "scope": { "type": "string", "description": "Carpeta del proyecto; si falta, la de la ventana principal" } } }
        }),
        json!({
            "name": "read",
            "description": "Lee el contenido completo de una nota o trabajo por su id o ruta relativa.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
        json!({
            "name": "write",
            "description": "Guarda una nota durable (decisión, convención, gotcha o intento fallido). No uses esto para changelog.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "kind": { "type": "string", "enum": ["decision", "convencion", "gotcha", "failure", "nota"] },
                    "scope": { "type": "string" }
                },
                "required": ["title", "body"]
            }
        }),
        json!({
            "name": "delete",
            "description": "Elimina una nota de la memoria por su id.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
    ]
}

pub fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Value {
    let text = |value: Value| json!({ "content": [{ "type": "text", "text": value.as_str().map(|s| s.to_string()).unwrap_or_else(|| value.to_string()) }] });
    match name {
        "search" => {
            let query = args["query"].as_str().unwrap_or("");
            if query.trim().is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta el parámetro query." }], "isError": true });
            }
            text(search(app, query))
        }
        "list" => {
            let scope = args["scope"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default_scope(app));
            let notes = note_views(app, &scope);
            let tasks = task_views(app, &scope);
            text(json!({
                "scope": scope,
                "notes": notes.iter().map(|n| json!({ "id": n.id, "title": n.title, "kind": n.kind, "updated": n.updated, "preview": n.preview })).collect::<Vec<_>>(),
                "tasks": tasks.iter().map(|t| json!({ "id": t.id, "title": t.title, "updated": t.updated })).collect::<Vec<_>>(),
            }))
        }
        "read" => text(read_entry(app, args["id"].as_str().unwrap_or(""))),
        "write" => {
            let title = args["title"].as_str().unwrap_or("").trim();
            if title.is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta title." }], "isError": true });
            }
            let title: String = title.replace(['\n', '\r'], " ");
            let scope = args["scope"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default_scope(app));
            let kind = args["kind"].as_str().unwrap_or("nota");
            let body = args["body"].as_str().unwrap_or("");
            let id = note_slug(&title);
            let content = format!("---\ntitle: {}\ntype: {}\nupdated: {}\nsource: agent\n---\n\n{}\n", title, kind, now(), truncate_chars(body, BODY_MAX));
            ensure_workspace(app, &scope);
            write_text(&notes_dir(app, &scope).join(format!("{}.md", id)), &content);
            render_digest(app, &scope);
            text(json!({ "ok": true, "id": id, "scope": scope }))
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            match resolve_note(app, id) {
                Some(path) if path.exists() => {
                    let _ = fs::remove_file(&path);
                    for scope in scopes(app) {
                        render_digest(app, &scope);
                    }
                    text(json!({ "ok": true }))
                }
                _ => json!({ "content": [{ "type": "text", "text": "No existe esa nota (solo se pueden borrar notas, no trabajos)." }], "isError": true }),
            }
        }
        other => json!({ "content": [{ "type": "text", "text": format!("Herramienta desconocida: {}", other) }], "isError": true }),
    }
}

fn scopes(app: &AppHandle) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root(app).join("workspaces")) else { return out };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out
}

// ---- Tauri commands ----

#[tauri::command]
pub fn memory_status(app: AppHandle) -> Value {
    let root = root(&app);
    let scopes = scopes(&app);
    let sessions = app.state::<MemoryState>().config.lock().unwrap().sessions.clone();
    json!({ "root": root.to_string_lossy(), "scopes": scopes, "sessions": sessions })
}

pub fn overview(app: &AppHandle, scope: &str) -> Value {
    let scope = if scope.trim().is_empty() { default_scope(app) } else { scope.to_string() };
    let notes = note_views(app, &scope);
    let tasks = task_views(app, &scope);
    let prefs = read_text(&root(app).join("global").join("_preferences.md"));
    json!({
        "scope": scope,
        "slug": slug(&scope),
        "preferences": body_of(&prefs),
        "overview": body_of(&read_text(&workspace_dir(app, &scope).join("_overview.md"))),
        "notes": notes.iter().map(|n| json!({ "id": n.id, "title": n.title, "kind": n.kind, "updated": n.updated, "preview": n.preview, "source": n.source })).collect::<Vec<_>>(),
        "tasks": tasks.iter().map(|t| json!({ "id": t.id, "title": t.title, "updated": t.updated, "directory": t.directory, "progress": t.progress, "lastUser": t.last_user, "source": t.source })).collect::<Vec<_>>(),
    })
}

pub fn hub_state(app: &AppHandle, scope: &str, session: &str) -> Value {
    let mut value = overview(app, scope);
    value["enabled"] = json!(session_enabled(app, session));
    value
}

#[tauri::command]
pub fn memory_overview(app: AppHandle, scope: String) -> Value {
    overview(&app, &scope)
}

#[tauri::command]
pub fn memory_write_note(app: AppHandle, scope: String, title: String, body: String, kind: Option<String>, id: Option<String>) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    if title.trim().is_empty() {
        return Err("Falta el título".into());
    }
    let kind = kind.unwrap_or_else(|| "nota".to_string()).replace(['\n', '\r'], " ");
    let title = title.trim().replace(['\n', '\r'], " ");
    let dir = notes_dir(&app, &scope);
    let path = note_file(&dir, &title, id.as_deref())?;
    let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    ensure_workspace(&app, &scope);
    let content = format!("---\ntitle: {}\ntype: {}\nupdated: {}\nsource: user\n---\n\n{}\n", title.trim(), kind, now(), body.chars().take(BODY_MAX).collect::<String>());
    write_memory_file(&path, &content)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true, "id": id }))
}

#[tauri::command]
pub fn memory_write_overview(app: AppHandle, scope: String, body: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    ensure_workspace(&app, &scope);
    let content = if body.trim().is_empty() { String::new() } else { format!("# {}\n\n{}\n", slug(&scope), body) };
    write_memory_file(&workspace_dir(&app, &scope).join("_overview.md"), &content)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_write_preferences(app: AppHandle, body: String) -> Result<Value, String> {
    let content = if body.trim().is_empty() { String::new() } else { format!("# Preferencias personales\n\n{}\n", body) };
    write_memory_file(&root(&app).join("global").join("_preferences.md"), &content)?;
    for scope in scopes(&app) {
        render_digest(&app, &scope);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_read_note(app: AppHandle, id: String) -> Value {
    read_entry(&app, &id)
}

#[tauri::command]
pub fn memory_delete_note(app: AppHandle, id: String) -> Result<Value, String> {
    match resolve_note(&app, &id) {
        Some(path) if path.exists() => {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            for scope in scopes(&app) {
                render_digest(&app, &scope);
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err("No existe o no es una nota".into()),
    }
}

#[tauri::command]
pub fn memory_write_task(app: AppHandle, scope: String, id: String, title: String, last_user: String, progress: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    let (path, mut value) = task_file(&app, &scope, &id)?;
    value["title"] = json!(truncate_chars(&title, FIELD_MAX));
    value["lastUser"] = json!(truncate_chars(&last_user, BODY_MAX));
    value["progress"] = json!(truncate_chars(&progress, BODY_MAX));
    value["updatedAt"] = json!(now());
    value["source"] = json!("user");
    write_memory_file(&path, &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_delete_task(app: AppHandle, scope: String, id: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    let (path, _) = task_file(&app, &scope, &id)?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_search_cmd(app: AppHandle, query: String) -> Value {
    search(&app, &query)
}

#[tauri::command]
pub fn memory_set_session(app: AppHandle, session: String, enabled: bool) -> Value {
    set_session(&app, &session, enabled);
    json!({ "ok": true, "enabled": enabled })
}

#[tauri::command]
pub fn memory_session_enabled(app: AppHandle, session: String) -> bool {
    session_enabled(&app, &session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_normalizes_directories() {
        assert_eq!(slug("C:\\\\Users\\\\guill\\\\proyecto"), "proyecto");
        assert_eq!(slug("/home/guill/Mi Proyecto/"), "mi-proyecto");
        assert_eq!(slug(""), "workspace");
    }

    #[test]
    fn note_slug_is_stable() {
        assert_eq!(note_slug("Decisión: base de datos"), "decisi-n-base-de-datos");
        assert!(note_slug("!!").starts_with("nota-"));
    }

    #[test]
    fn frontmatter_reads_fields() {
        let body = "---\ntitle: Hola\ntype: decision\nupdated: 2026-01-01\n---\n\ncuerpo";
        let meta = frontmatter(body);
        assert_eq!(meta.get("title").unwrap(), "Hola");
        assert_eq!(body_of(body), "cuerpo");
    }

    #[test]
    fn inside_rejects_escapes() {
        let base = std::env::temp_dir().join(format!("gc-memory-test-{}", std::process::id()));
        let root = base.join("memory");
        let notes = root.join("workspaces/demo/notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("a.md");
        fs::write(&note, "x").unwrap();
        let secret = base.join("secret.txt");
        fs::write(&secret, "x").unwrap();
        assert!(inside(&root, &note));
        assert!(!inside(&root, &secret));
        assert!(!inside(&root, &root.join("..").join("secret.txt")));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn edits_keep_note_identity_and_stay_in_the_selected_project() {
        let base = std::env::temp_dir().join(format!("gc-memory-edit-test-{}", uuid::Uuid::new_v4()));
        let notes = base.join("demo/notes");
        let other = base.join("other/notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(notes.join("original.md"), "nota original").unwrap();
        fs::write(other.join("solo-otro.md"), "nota de otro proyecto").unwrap();
        assert_eq!(note_file(&notes, "Título nuevo", Some("original")).unwrap(), notes.join("original.md"));
        assert!(note_file(&notes, "Título nuevo", Some("solo-otro")).is_err());
        assert!(note_file(&notes, "Título nuevo", Some("../other/notes/solo-otro")).is_err());
        assert!(existing_memory_file(&notes, "C:\\otra-nota", "md").is_err());
        assert!(note_file(&notes, "original", Some("borrada")).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
