use super::domain::Employee;
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode { ReadOnly, Worker, Conversation, Format }

const READ: &[&str] = &["read", "glob", "grep"];
const WEB: &[&str] = &["webfetch", "websearch"];
const OBSERVE: &[&str] = &[
    "browser_list_pages", "browser_take_snapshot", "browser_take_screenshot",
    "browser_list_console_messages", "browser_get_console_message",
    "browser_list_network_requests", "browser_get_network_request",
    "desktop_status", "desktop_windows", "desktop_snapshot", "desktop_screen_text",
    "desktop_screenshot", "desktop_observe", "desktop_find", "desktop_read",
];

fn allowed(name: &str, employee: &Employee, mode: Mode) -> bool {
    if mode == Mode::Format { return false; }
    if name == "question" && mode == Mode::Worker { return false; }
    if WEB.contains(&name) { return true; }
    if name.starts_with("browser_") || name.starts_with("desktop_") {
        return mode != Mode::ReadOnly || OBSERVE.contains(&name);
    }
    if mode == Mode::Worker { employee.tools.iter().any(|tool| tool == name) }
    else { READ.contains(&name) }
}

pub(super) fn tool_map(ids: &Value, employee: &Employee, mode: Mode) -> Result<Map<String, Value>, String> {
    let mut names: Vec<String> = ids.as_array().ok_or("No se pudo comprobar la lista de herramientas")?
        .iter().filter_map(Value::as_str).map(String::from).collect();
    use crate::desktop::Channel;
    for channel in [Channel::Desktop, Channel::Browser, Channel::Routines, Channel::Terminal,
        Channel::Worktrees, Channel::Memory, Channel::Plane] {
        for tool in crate::desktop::tool_list(channel) {
            if let Some(name) = tool["name"].as_str() { names.push(format!("{}_{}", channel.name(), name)); }
        }
    }
    let mut tools = Map::from_iter([("*".into(), json!(false))]);
    for name in names { tools.insert(name.clone(), json!(allowed(&name, employee, mode))); }
    Ok(tools)
}

pub(super) fn permissions(rules: &mut Vec<Value>, mode: Mode) {
    for name in WEB { rules.push(json!({"permission":name,"pattern":"*","action":"allow"})); }
    if mode == Mode::ReadOnly {
        for name in OBSERVE { rules.push(json!({"permission":name,"pattern":"*","action":"allow"})); }
    } else {
        for name in ["browser_*", "desktop_*"] {
            rules.push(json!({"permission":name,"pattern":"*","action":"allow"}));
        }
    }
}

pub(super) fn instructions(mode: Mode) -> String {
    if mode == Mode::Format { return "Corregí únicamente el JSON solicitado. No ejecutes herramientas ni rehagas el trabajo. Conservá los especialistas y sus tareas independientes; no reemplaces el plan por una tarea genérica del Lead. Devolvé un único objeto JSON sin Markdown ni texto adicional; chatSummary, si corresponde, va dentro de ese mismo objeto.".into(); }
    let scope = "El equipo dispone de búsqueda y lectura web, y de las herramientas nativas browser_* y desktop_* con los mismos controles del chat normal. El control de la PC debe estar encendido y sin pausa. En modo equipo browser_list_pages crea automáticamente una página interna propia para tu sesión. browser_* controla solo tus páginas WebView2 dentro de este chat, aisladas de las de otros agentes aunque compartan el perfil del equipo. browser_new_page crea otra pestaña tuya y devuelve el listado; conservá su pageId. El usuario observa las páginas desde la pestaña Navegador del chat. No se abren ventanas externas ni se toma foco o entrada del sistema. No uses Chrome externo ni desktop_* como sustituto para navegar. Las acciones de escritorio respetan el bloqueo de entrada de la app. Si falta la ventana o el control está apagado, explicá qué debe activar el usuario; no uses shell u otra herramienta para eludirlo. Las acciones y observaciones reales quedan en la sesión del agente. No confundas una captura de referencia con evidencia de una prueba. No hagas envíos, pagos, borrados ni publicaciones salvo instrucción explícita del usuario. Para cambios de archivos se mantiene la propiedad de writePaths y los permisos de bash; las herramientas de PC no los amplían.";
    if mode == Mode::ReadOnly {
        format!("{} En este paso de planificación o revisión solo podés observar el navegador/escritorio; no navegar, hacer clic ni escribir. Usá las observaciones y la evidencia de los trabajadores para revisar los criterios.", scope)
    } else { format!("{} RECUPERACIÓN DEL NAVEGADOR DEL EQUIPO: Si falta o se cerró tu vista, llamá browser_list_pages. Flufy crea una página interna exclusiva para tu sesión sin elegir una página de otro agente. Volvé a navegar a la URL conocida y tomá una observación nueva antes de actuar. No repitas clics ni envíos a ciegas ni reutilices referencias de la página perdida. Si Chrome está desconectado, el control está apagado o el usuario lo pausó, informá exactamente qué acceso falta; no intentes cambiar esas preferencias. Para edición, si una herramienta deniega un archivo, indicá su ruta, la operación y qué writePaths recibiste; pedí al Lead revisar la asignación en lugar de afirmar que no tenés permisos para programar. En tareas puramente de navegación o interfaz sin archivos esperados, verificá el estado final con observaciones reales de herramientas y dejá checks vacío; no inventes comandos ni ejecutes pruebas arbitrarias. Las implementaciones de código siguen requiriendo sus comprobaciones pertinentes.\n{}", scope, crate::desktop::escritorio_prompt()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_tools_work_without_expanding_file_or_delegation_permissions() {
        let employee = super::super::domain::tests::team().members[0].clone();
        for mode in [Mode::Worker, Mode::Conversation] {
            for tool in ["webfetch", "websearch", "browser_navigate_page", "desktop_execute"] {
                assert!(allowed(tool, &employee, mode), "{tool}");
            }
            for tool in ["task", "self_reload", "terminal_terminal_run", "worktrees_create"] {
                assert!(!allowed(tool, &employee, mode), "{tool}");
            }
        }
        let map=tool_map(&serde_json::json!(["read","write","browser_list_pages","desktop_execute"]),&employee,Mode::Format).unwrap();
        assert!(map.values().all(|v|v==false), "Formatting cannot observe or repeat actions");
        assert!(!allowed("bash", &employee, Mode::Conversation));
        assert!(!allowed("edit", &employee, Mode::Conversation));
        assert!(!allowed("edit", &employee, Mode::Worker));
        let mut questioning = employee.clone(); questioning.tools.push("question".into());
        assert!(!allowed("question", &questioning, Mode::Worker));
        assert!(allowed("browser_take_snapshot", &employee, Mode::ReadOnly));
        assert!(!allowed("browser_navigate_page", &employee, Mode::ReadOnly));
        assert!(!allowed("desktop_execute", &employee, Mode::ReadOnly));
        let mut rules = vec![];
        permissions(&mut rules, Mode::ReadOnly);
        assert!(!rules.iter().any(|r| r["permission"] == "browser_*"));
        permissions(&mut rules, Mode::Conversation);
        assert!(rules.iter().any(|r| r["permission"] == "browser_*" && r["action"] == "allow"));
    }
}
