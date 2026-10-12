use crate::features::{self, UpdateArgs, WorkspaceCreateArgs};
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "En GuilleCode un TRABAJO (feature) es un espacio que agrupa la copia de trabajo de TODOS los repositorios del proyecto (backend, frontend, etc.). El humano solo ve «Principal» y el nombre del trabajo; vos resolvés los worktrees, las ramas y las bases. Al iniciar un trabajo, si el destino no está definido, preguntá como máximo si se trabaja en Principal o en un trabajo separado; nunca pidas nombres de ramas, carpetas, base ni comandos de preparación. Usá worktree_list con la ruta absoluta del proyecto de ESTA conversación para ver los espacios de trabajo (campo `workspaces`), sus repos, ramas y bases reales. Para un trabajo separado usá worktree_create: elegí un nombre breve; el tool crea el worktree de cada repositorio con la MISMA etiqueta, elige por repo la base real (por defecto su defaultBase, por ejemplo origin/develop, nunca asumas main) y lo registra como un único trabajo. No confundas el upstream de publicación origin/feature/... con la base. El tool no cambia la carpeta abierta ni cierra terminales: trabajá con las rutas y el cwd que devuelve. Después prepará el entorno completo (dependencias y configuración) en la terminal integrada siguiendo la receta del proyecto (settings.setup), sin inventar un entorno reducido, y no declares el trabajo listo sin verificar el resultado. Si un trabajo lo creó Git u otra herramienta, usá worktree_register_base con su path y su base real respaldada por evidencia. GuilleCode muestra los cambios de cada repo para que el humano los supervise como en Principal. No integres, borres ni publiques cambios por el mero hecho de crear un trabajo.";

pub fn definitions() -> Vec<Value> {
    let project = json!({ "type": "string", "minLength": 1, "description": "Ruta absoluta del repo o carpeta de proyecto de esta conversación" });
    vec![
        json!({ "name": "worktree_list", "description": "Descubre los espacios de trabajo del proyecto (Principal y cada trabajo), sus repositorios, ramas y base real. No cambia la carpeta abierta. Consultar antes de crear.", "inputSchema": { "type": "object", "properties": { "project": project }, "required": ["project"], "additionalProperties": false }, "annotations": { "readOnlyHint": true } }),
        json!({ "name": "worktree_create", "description": "Crea un trabajo en repo/.worktrees de CADA repositorio del proyecto (o de los indicados), con una rama y una base por repo, y los agrupa bajo un mismo id. El agente elige el nombre. No activa la carpeta ni mueve la conversación; usar las rutas devueltas para archivos y terminales.", "inputSchema": { "type": "object", "properties": {
            "project": project,
            "label": { "type": "string", "minLength": 1, "description": "Nombre breve del trabajo, elegido por el agente" },
            "branch": { "type": "string", "description": "Rama propia, igual en todos los repos (por defecto feature/<label>)" },
            "base": { "type": "string", "description": "Referencia base para todos los repos; omitila para usar la base real de cada repo" },
            "bases": { "type": "object", "description": "Base por repositorio, con la ruta o el nombre del repo como clave (por ejemplo {\"v2GQL\":\"origin/develop\"})", "additionalProperties": { "type": "string" } },
            "repos": { "type": "array", "items": { "type": "string" }, "description": "Subconjunto de repositorios por ruta o nombre; vacío = todos" },
            "existing": { "type": "boolean", "description": "Usar una rama local existente; false por defecto" },
            "copy": { "type": "array", "items": { "type": "string" }, "description": "Archivos ignorados a copiar en cada repo. Omitido copia los sugeridos de cada repo; [] no copia nada" }
        }, "required": ["project", "label"], "additionalProperties": false } }),
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
            let input: WorkspaceCreateArgs = serde_json::from_value(args.clone()).map_err(|e| format!("trabajo inválido: {}", e))?;
            serde_json::to_value(features::workspace_create_sync(app, input)?).map_err(|e| e.to_string())
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
            plane: Some(std::path::PathBuf::from("plane")),
            browser_injected: false,
        };
        let config = super::super::agent_config(&state);
        assert_eq!(config["mcp"]["worktrees"]["url"], "http://127.0.0.1:12345/mcp/worktrees");
        assert_eq!(config["mcp"]["worktrees"]["headers"]["Authorization"], "Bearer test-token");
        assert!(config["instructions"].as_array().unwrap().iter().any(|p| p.as_str().unwrap().ends_with("worktrees.md")));
        assert_eq!(super::super::tool_list(super::super::Channel::Worktrees).len(), 3);
    }
}
