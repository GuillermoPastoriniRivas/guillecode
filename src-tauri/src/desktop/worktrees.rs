use crate::features::{self, CreateArgs, UpdateArgs};
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "Los worktrees de GuilleCode los crea y prepara el agente. Al iniciar un trabajo, si el destino no está definido, preguntá como máximo si se trabaja en Principal o en un worktree; no pidas al usuario nombres de ramas, carpetas, base ni comandos de preparación. Principal es la carpeta original, no necesariamente la rama main. Usá worktree_list con la ruta absoluta del proyecto de ESTA conversación para descubrir repos, worktrees y contexto; reutilizá el worktree de la conversación si ya estás en uno. Para crear usá worktree_create: elegí la base real del trabajo según el repo y las instrucciones (por ejemplo origin/develop), no asumas main ni confundas el upstream de publicación origin/feature/... con la base. Conservá la referencia remota exacta; develop local puede diferir de origin/develop. El tool registra rama base y commit inicial y no cambia la carpeta abierta ni cierra terminales. Trabajá siempre sobre la root devuelta con rutas y cwd explícitos: crear no mueve automáticamente esta conversación al worktree. Prepará dependencias y pruebas en la terminal integrada con ese cwd; no declares el entorno listo sin verificar el resultado. Si creaste el worktree con Git u otra herramienta, usá worktree_register_base con su path, base real y baseOid si conocés el commit inicial. También podés registrar la base de un worktree existente al recuperarla de evidencia; no inventes su origen. GuilleCode mostrará sus cambios para que el usuario los supervise sin abrir esa carpeta. No integres, borres ni publiques cambios por el mero hecho de crear un worktree.";

pub fn definitions() -> Vec<Value> {
    let project = json!({ "type": "string", "minLength": 1, "description": "Ruta absoluta del repo o carpeta de proyecto de esta conversación" });
    vec![
        json!({ "name": "worktree_list", "description": "Descubre los worktrees del proyecto, sus repos, ramas, base real y actividad Git. No cambia la carpeta abierta. Consultar antes de crear.", "inputSchema": { "type": "object", "properties": { "project": project }, "required": ["project"], "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "worktree_create", "description": "Crea un worktree en repo/.worktrees y registra su base exacta y commit inicial para supervisarlo. El agente elige nombre/rama/base. No activa la carpeta ni mueve la conversación; usar la root devuelta para archivos y terminales.", "inputSchema": { "type": "object", "properties": {
            "project": project,
            "label": { "type": "string", "minLength": 1, "description": "Nombre breve del trabajo, elegido por el agente" },
            "branch": { "type": "string", "minLength": 1, "description": "Rama propia, por ejemplo feature/login-google" },
            "base": { "type": "string", "minLength": 1, "description": "Referencia base real y exacta, por ejemplo origin/develop" },
            "existing": { "type": "boolean", "description": "Usar una rama local existente; false por defecto" },
            "copy": { "type": "array", "items": { "type": "string" }, "description": "Archivos ignorados a copiar. Omitido copia los sugeridos (.env/configuración local); [] no copia nada" }
        }, "required": ["project", "label", "branch", "base"], "additionalProperties": false } }),
        json!({ "name": "worktree_register_base", "description": "Registra la base real de un worktree creado por Git u otro agente, sin cambiar de carpeta ni tocar sus archivos. Permite supervisarlo contra origin/develop u otra referencia exacta.", "inputSchema": { "type": "object", "properties": {
            "project": project,
            "path": { "type": "string", "minLength": 1, "description": "Path del worktree, tal como lo devuelve worktree_list" },
            "base": { "type": "string", "minLength": 1, "description": "Rama base respaldada por evidencia, no upstream de publicación" },
            "baseOid": { "type": "string", "minLength": 1, "description": "Commit inicial si se conoce. Omitir si no se puede recuperar; no usar el tip actual como si fuera el inicial" }
        }, "required": ["project", "path", "base"], "additionalProperties": false } }),
    ]
}

fn project(args: &Value) -> Result<&str, String> {
    let project = args["project"].as_str().filter(|p| !p.trim().is_empty()).ok_or("falta el proyecto de esta conversación")?;
    if !std::path::Path::new(project).is_absolute() {
        return Err("el proyecto debe ser una ruta absoluta".into());
    }
    Ok(project)
}

fn execute(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let definition = definitions().into_iter().find(|d| d["name"].as_str() == Some(name))
        .ok_or_else(|| format!("herramienta de worktrees desconocida: {}", name))?;
    let fields = &definition["inputSchema"]["properties"];
    for key in args.as_object().ok_or("los argumentos deben ser un objeto")?.keys() {
        if fields.get(key).is_none() {
            return Err(format!("campo no soportado: {}", key));
        }
    }
    let project = project(args)?;
    match name {
        "worktree_list" => serde_json::to_value(features::build_list(app, project)?).map_err(|e| e.to_string()),
        "worktree_create" => {
            let mut input = args.clone();
            if input.get("copy").is_none() {
                let copy: Vec<String> = features::candidates_sync(project)?.into_iter().filter(|c| c.suggested).map(|c| c.path).collect();
                input["copy"] = json!(copy);
            }
            let input: CreateArgs = serde_json::from_value(input).map_err(|e| format!("worktree inválido: {}", e))?;
            serde_json::to_value(features::create_sync(app, input)?).map_err(|e| e.to_string())
        }
        "worktree_register_base" => {
            let input: UpdateArgs = serde_json::from_value(args.clone()).map_err(|e| format!("base inválida: {}", e))?;
            if input.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).is_none() {
                return Err("falta la rama base real".into());
            }
            features::update_sync(app, input)?;
            Ok(json!({ "registered": true, "path": args["path"], "base": args["base"], "message": "La supervisión usará esta referencia exacta; no se cambió la carpeta activa" }))
        }
        _ => Err(format!("herramienta de worktrees desconocida: {}", name)),
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

    #[test]
    fn worktree_tools_are_available_without_pc_control() {
        let state = super::super::DesktopState {
            config: std::sync::Mutex::new(super::super::DesktopConfig::default()),
            port: 12345,
            token: "test-token".into(),
            activity: std::sync::Mutex::new(std::collections::VecDeque::new()),
            skills: Some(std::path::PathBuf::from("skills")),
            browser_injected: false,
            subagent: true,
        };
        let config = super::super::agent_config(&state);
        assert_eq!(config["mcp"]["worktrees"]["url"], "http://127.0.0.1:12345/mcp/worktrees");
        assert_eq!(config["mcp"]["worktrees"]["headers"]["Authorization"], "Bearer test-token");
        assert!(config["instructions"].as_array().unwrap().iter().any(|p| p.as_str().unwrap().ends_with("worktrees.md")));
        assert_eq!(super::super::tool_list(super::super::Channel::Worktrees).len(), 3);
    }
}
