use crate::routines::{self, Routine};
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "GuilleCode tiene rutinas nativas, visibles y editables en «Mis rutinas». Cuando el usuario pida crear, programar o modificar una rutina o tarea recurrente, usá las herramientas del MCP routines: routine_list, routine_create y routine_update. No la sustituyas por el Programador de tareas de Windows, cron, scripts externos ni edición directa de routines.json, salvo que el usuario pida explícitamente ese mecanismo externo. Listá primero para evitar duplicados y usá el ID para modificar una existente. Indicá el proyecto con su ruta absoluta correspondiente a la conversación (no asumas el proyecto actualmente abierto en otra ventana). Los horarios son de la zona horaria local de esta PC: HH:MM de 24 horas; días 0=lunes a 6=domingo. Si el usuario pide otra zona horaria, aclaralo antes de guardar; no prometas una zona que el scheduler no soporta. Una rutina corre con GuilleCode abierto o en la bandeja y la PC encendida; las ejecuciones generan conversaciones e historial. Solo afirmá que quedó creada después de recibir éxito con ID y nextRun; queda editable en Mis rutinas. No afirmes que fue probada sin ejecutarla y comprobar su resultado. Si una herramienta falla, informá el error; no crees una automatización externa como reemplazo silencioso.";

fn properties() -> Value {
    json!({
        "name": { "type": "string", "description": "Nombre visible en Mis rutinas" },
        "project": { "type": "string", "description": "Ruta absoluta de la carpeta del proyecto de esta conversación" },
        "prompt": { "type": "string", "description": "Instrucciones completas para cada ejecución autónoma" },
        "schedule": { "oneOf": [
            { "type": "object", "properties": { "kind": { "const": "interval", "type": "string" }, "hours": { "type": "integer", "minimum": 1 } }, "required": ["kind", "hours"], "additionalProperties": false },
            { "type": "object", "properties": { "kind": { "const": "daily", "type": "string" }, "time": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" } }, "required": ["kind", "time"], "additionalProperties": false },
            { "type": "object", "properties": { "kind": { "const": "weekly", "type": "string" }, "time": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" }, "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 }, "minItems": 1, "uniqueItems": true } }, "required": ["kind", "time", "days"], "additionalProperties": false }
        ], "description": "Horario local de esta PC; días 0=lunes, 6=domingo" },
        "agent": { "type": ["string", "null"] },
        "model": { "type": ["object", "null"], "properties": { "providerID": { "type": "string" }, "modelID": { "type": "string" } }, "required": ["providerID", "modelID"], "additionalProperties": false },
        "variant": { "type": ["string", "null"] },
        "enabled": { "type": "boolean", "description": "Activa por defecto; false para guardar pausada" }
    })
}

pub fn definitions() -> Vec<Value> {
    let fields = properties();
    let mut update_fields = fields.clone();
    update_fields["id"] = json!({ "type": "string", "minLength": 1 });
    vec![
        json!({ "name": "routine_list", "description": "Consulta las rutinas nativas de GuilleCode, IDs, próxima ejecución e historial. Usar antes de crear para evitar duplicados. Horarios en zona local de la PC.", "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "routine_create", "description": "Crea una rutina nativa visible y editable en Mis rutinas, con ejecución e historial de GuilleCode. Devuelve ID y nextRun (timestamp Unix en milisegundos).", "inputSchema": { "type": "object", "properties": fields, "required": ["name", "project", "prompt", "schedule"], "additionalProperties": false } }),
        json!({ "name": "routine_update", "description": "Modifica o pausa una rutina nativa por ID. Solo enviar los campos a cambiar; conserva historial y campos omitidos. enabled=false pausa; enabled=true reactiva.", "inputSchema": { "type": "object", "properties": update_fields, "required": ["id"], "additionalProperties": false } }),
        json!({ "name": "routine_run_now", "description": "Ejecuta ahora una rutina nativa por ID. El éxito indica que arrancó, no que terminó; consultar routine_list para verificar el resultado y sessionId.", "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "minLength": 1 } }, "required": ["id"], "additionalProperties": false } }),
    ]
}

fn draft(args: &Value, existing: Option<Routine>) -> Result<Routine, String> {
    let fields = properties();
    let object = args.as_object().ok_or("los argumentos deben ser un objeto")?;
    for key in object.keys() {
        if fields.get(key).is_none() && !(existing.is_some() && key == "id") {
            return Err(format!("campo no soportado: {}", key));
        }
    }
    let mut value = existing.map(|r| serde_json::to_value(r).unwrap()).unwrap_or_else(|| json!({}));
    for (key, field) in object {
        value[key] = field.clone();
    }
    serde_json::from_value(value).map_err(|e| format!("rutina inválida: {}", e))
}

fn execute(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "routine_list" => Ok(json!({ "routines": routines::views(app), "timezone": chrono::Local::now().offset().to_string(), "scheduleTimezone": "local", "editableIn": "Mis rutinas" })),
        "routine_create" => {
            let saved = routines::routines_save(app.clone(), draft(args, None)?)?;
            Ok(json!({ "routine": saved, "editableIn": "Mis rutinas", "scheduleTimezone": "local", "timezone": chrono::Local::now().offset().to_string() }))
        }
        "routine_update" => {
            let id = args["id"].as_str().filter(|id| !id.is_empty()).ok_or("falta el ID de la rutina")?;
            let saved = routines::update(app, id, |existing| draft(args, Some(existing)))?;
            Ok(json!({ "routine": saved, "editableIn": "Mis rutinas", "scheduleTimezone": "local" }))
        }
        "routine_run_now" => {
            let id = args["id"].as_str().filter(|id| !id.is_empty()).ok_or("falta el ID de la rutina")?;
            routines::launch(app, id, true)?;
            Ok(json!({ "id": id, "started": true, "message": "Consultá routine_list para verificar el resultado" }))
        }
        _ => Err(format!("herramienta de rutinas desconocida: {}", name)),
    }
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    match execute(app, name, args) {
        Ok(value) => json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false }),
        Err(error) => json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> Value {
        json!({ "name": "Salud NOVORA", "project": ".", "prompt": "Solo diagnóstico", "schedule": { "kind": "weekly", "days": [0,1,2,3,4], "time": "11:30" } })
    }

    #[test]
    fn create_defaults_and_update_preserve_omitted_fields() {
        let mut routine = draft(&input(), None).unwrap();
        assert!(routine.enabled);
        assert!(routine.id.is_empty());
        routine.id = "native-id".into();
        routine.created_at = 123;
        let updated = draft(&json!({ "id": "native-id", "enabled": false }), Some(routine)).unwrap();
        assert!(!updated.enabled);
        assert_eq!(updated.name, "Salud NOVORA");
        assert_eq!(updated.prompt, "Solo diagnóstico");
        assert_eq!(updated.created_at, 123);
    }

    #[test]
    fn agents_cannot_supply_history_or_silently_override_timezone() {
        for key in ["id", "runs", "createdAt", "timezone"] {
            let mut args = input();
            args[key] = json!("unexpected");
            assert!(draft(&args, None).is_err(), "{}", key);
        }
    }

    #[test]
    fn native_tools_are_injected_even_with_pc_and_browser_control_disabled() {
        let state = super::super::DesktopState {
            config: std::sync::Mutex::new(super::super::DesktopConfig::default()),
            port: 12345,
            token: "test-token".into(),
            activity: std::sync::Mutex::new(std::collections::VecDeque::new()),
            skills: Some(std::path::PathBuf::from("skills")),
            browser_injected: false,
            subagent: false,
        };
        let config = super::super::agent_config(&state);
        assert_eq!(config["mcp"]["routines"]["url"], "http://127.0.0.1:12345/mcp/routines");
        assert_eq!(config["mcp"]["routines"]["headers"]["Authorization"], "Bearer test-token");
        assert!(config["mcp"].get("browser").is_none());
        assert!(config["instructions"][0].as_str().unwrap().ends_with("routines.md"));
        let tools = super::super::tool_list(super::super::Channel::Routines);
        assert_eq!(tools.len(), 4);
        assert!(tools.iter().any(|t| t["name"] == "routine_create"));
        assert!(tools.iter().any(|t| t["name"] == "routine_update"));
    }
}
