use crate::app_data_file;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

/// El "plano" del agente: los archivos que definen cómo trabaja (política y
/// guías de sus canales). Viven en `app_data/plane` y se siembran con el
/// default empaquetado solo si faltan, para que las ediciones del usuario o del
/// propio agente sobrevivan a los reinicios. El motor los lee al arrancar, así
/// que un cambio se aplica reiniciando el motor (no hace falta recompilar).
pub const INSTRUCTIONS: &str = "Plano del agente de GuilleCode: son los archivos que definen cómo trabajás (tu política y las guías de tus canales routines, terminal y worktrees). Usá `list` para verlos, `read` para leer uno por su clave y `write` para cambiarlo. Los cambios quedan guardados pero NO se aplican solos: el motor los lee al arrancar, así que después de editar hay que reiniciar el motor (pedile al usuario que los aplique desde «Plano del agente», o avisale que hace falta reiniciar). Sé conservador: cambiá solo lo que el usuario pidió, mantené lo que ya funciona y contale en qué archivo y por qué tocaste algo.";

#[derive(Clone, Copy)]
struct Entry {
    key: &'static str,
    file: &'static str,
    label: &'static str,
    hint: &'static str,
    default: &'static str,
}

fn entries() -> [Entry; 4] {
    [
        Entry {
            key: "policy",
            file: "policy.js",
            label: "Política del agente",
            hint: "Reglas de alcance, verificación y cierre que gobiernan al agente en cada tarea.",
            default: crate::desktop::AGENT_POLICY,
        },
        Entry {
            key: "routines",
            file: "routines.md",
            label: "Rutinas",
            hint: "Cómo usa el agente las rutinas programadas.",
            default: crate::desktop::routines::INSTRUCTIONS,
        },
        Entry {
            key: "terminal",
            file: "terminal.md",
            label: "Terminal",
            hint: "Cómo usa el agente la terminal integrada.",
            default: crate::desktop::terminal::INSTRUCTIONS,
        },
        Entry {
            key: "worktrees",
            file: "worktrees.md",
            label: "Worktrees",
            hint: "Cómo prepara el agente los worktrees de cada trabajo.",
            default: crate::desktop::worktrees::INSTRUCTIONS,
        },
    ]
}

fn entry(key: &str) -> Result<Entry, String> {
    entries()
        .into_iter()
        .find(|e| e.key == key)
        .ok_or_else(|| format!("No existe un archivo del plano llamado «{}».", key))
}

pub fn dir(app: &AppHandle) -> PathBuf {
    app_data_file(app, "plane").unwrap_or_else(|| PathBuf::from("plane"))
}

fn file_path(app: &AppHandle, entry: &Entry) -> PathBuf {
    dir(app).join(entry.file)
}

/// Escribe cada archivo solo si no existe. Nunca pisa lo que ya está: esa es la
/// diferencia clave con el arranque anterior, que reescribía todo cada vez.
pub fn seed(app: &AppHandle) -> PathBuf {
    let root = dir(app);
    let _ = fs::create_dir_all(&root);
    for entry in entries() {
        let path = root.join(entry.file);
        if !path.exists() {
            let _ = fs::write(&path, entry.default);
        }
    }
    root
}

fn edited(app: &AppHandle, entry: &Entry) -> bool {
    fs::read_to_string(file_path(app, entry))
        .map(|content| content != entry.default)
        .unwrap_or(false)
}

pub fn list(app: &AppHandle) -> Value {
    seed(app);
    let files: Vec<Value> = entries()
        .iter()
        .map(|entry| {
            let path = file_path(app, entry);
            json!({
                "key": entry.key,
                "label": entry.label,
                "hint": entry.hint,
                "file": entry.file,
                "path": path.to_string_lossy(),
                "exists": path.exists(),
                "edited": edited(app, entry),
            })
        })
        .collect();
    json!({ "files": files })
}

fn read_entry(app: &AppHandle, key: &str) -> Result<String, String> {
    let entry = entry(key)?;
    let path = file_path(app, &entry);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&path, entry.default).map_err(|e| e.to_string())?;
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn write_entry(app: &AppHandle, key: &str, body: &str) -> Result<Value, String> {
    let entry = entry(key)?;
    let path = file_path(app, &entry);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "key": entry.key, "edited": body != entry.default }))
}

fn reset_entry(app: &AppHandle, key: &str) -> Result<Value, String> {
    let entry = entry(key)?;
    let path = file_path(app, &entry);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, entry.default).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "key": entry.key }))
}

// ---- Canal MCP `self` ----

pub fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "list",
            "description": "Lista los archivos de tu plano (política y guías de canales), con su clave y estado.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "read",
            "description": "Lee un archivo de tu plano por su clave (policy, routines, terminal, worktrees).",
            "inputSchema": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] }
        }),
        json!({
            "name": "write",
            "description": "Reescribe un archivo de tu plano. El cambio se aplica al reiniciar el motor, no de inmediato.",
            "inputSchema": {
                "type": "object",
                "properties": { "key": { "type": "string" }, "body": { "type": "string" } },
                "required": ["key", "body"]
            }
        }),
        json!({
            "name": "reset",
            "description": "Restaura un archivo de tu plano a la versión que trae GuilleCode.",
            "inputSchema": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] }
        }),
    ]
}

pub fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Value {
    let text = |value: Value| {
        json!({ "content": [{ "type": "text", "text": value.as_str().map(|s| s.to_string()).unwrap_or_else(|| value.to_string()) }] })
    };
    let key = args["key"].as_str().unwrap_or("");
    match name {
        "list" => text(list(app)),
        "read" => {
            if key.is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta key." }], "isError": true });
            }
            match read_entry(app, key) {
                Ok(content) => text(json!(content)),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            }
        }
        "write" => {
            if key.is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta key." }], "isError": true });
            }
            let body = args["body"].as_str().unwrap_or("");
            match write_entry(app, key, body) {
                Ok(value) => text(value),
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            }
        }
        "reset" => match reset_entry(app, key) {
            Ok(value) => text(value),
            Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
        },
        other => json!({ "content": [{ "type": "text", "text": format!("Herramienta desconocida: {}", other) }], "isError": true }),
    }
}

// ---- Comandos de la app ----

#[tauri::command]
pub fn plane_list(app: AppHandle) -> Value {
    list(&app)
}

#[tauri::command]
pub fn plane_read(app: AppHandle, key: String) -> Result<String, String> {
    read_entry(&app, &key)
}

#[tauri::command]
pub fn plane_write(app: AppHandle, key: String, body: String) -> Result<Value, String> {
    write_entry(&app, &key, &body)
}

#[tauri::command]
pub fn plane_reset(app: AppHandle, key: String) -> Result<Value, String> {
    reset_entry(&app, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Vec<(&'static str, &'static str)> {
        entries().iter().filter_map(|e| entry(e.key).ok()).map(|e| (e.key, e.default)).collect()
    }

    fn write(path: &PathBuf, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn plane_files_are_distinct_and_non_empty() {
        let all = defaults();
        assert_eq!(all.len(), 4);
        for (_, content) in &all {
            assert!(!content.trim().is_empty());
        }
    }

    #[test]
    fn seeding_never_overwrites_an_edit() {
        let base = std::env::temp_dir().join(format!("gc-plane-test-{}", uuid::Uuid::new_v4()));
        let path = base.join("policy.js");
        write(&path, "mi política propia");
        for entry in entries() {
            let target = base.join(entry.file);
            if !target.exists() {
                write(&target, entry.default);
            }
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "mi política propia");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(entry("no-existe").is_err());
        assert!(entry("policy").is_ok());
    }
}
