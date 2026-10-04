use crate::term::{self, Screen, ScreenState};
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const INSTRUCTIONS: &str = "Terminal integrada de GuilleCode (MCP terminal): el usuario ve cada terminal que abrís, en la carpeta que indicás y con el comando escrito tal cual, y puede leer los logs ahí mismo.
- Servidores, watchers y todo proceso que tenga que quedar corriendo (npm run dev, APIs, GQL, docker compose up, túneles): SIEMPRE con terminal_run. Nunca los lances con el shell interno (bash/PowerShell del agente), ni con Start-Process, ni con scripts que los dejen en segundo plano: ese paso queda colgado para siempre.
- Builds, tests, instalaciones, migraciones y scripts largos: preferí terminal_run, así el usuario los ve. Consultas rápidas (git status, listar o leer archivos, buscar) siguen en el shell interno.
- cwd es la ruta absoluta de la carpeta donde corre el comando. El comando es PowerShell en un solo renglón (encadená con ;).
- Para un servidor pasá until con el texto que indica que está listo (ej. «listening|ready in|compiled») y un wait_seconds razonable: te devuelve el control apenas aparece y el proceso sigue a la vista. Si vence el tiempo no se corta nada.
- Logs y errores: terminal_read (lines, grep; wait_seconds/until para esperar). Cortar: terminal_send key=ctrl+c. Reiniciar: ctrl+c y terminal_run con terminal=<id>.
- Reutilizá tus terminales libres (terminal=<id>) en vez de abrir una por comando, y cerrá con terminal_close las que ya no sirven. Las terminales del usuario se pueden leer; no escribas en ellas ni las cortes salvo que te lo pida.";

const DEFAULT_WAIT: u64 = 60;
const MAX_WAIT: u64 = 600;
const DEFAULT_LINES: usize = 120;
const MAX_LINES: usize = 400;
const MAX_CHARS: usize = 24_000;
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(25);
const SETTLE: Duration = Duration::from_millis(1200);
const RECHECK: Duration = Duration::from_millis(250);
const KEYS: &[(&str, &str)] = &[
    ("enter", "\r"),
    ("ctrl+c", "\x03"),
    ("ctrl+d", "\x04"),
    ("ctrl+z", "\x1a"),
    ("esc", "\x1b"),
    ("tab", "\t"),
    ("backspace", "\x7f"),
    ("up", "\x1b[A"),
    ("down", "\x1b[B"),
    ("right", "\x1b[C"),
    ("left", "\x1b[D"),
];

fn prop(kind: &str, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "annotations": { "readOnlyHint": read_only },
    })
}

pub fn definitions() -> Vec<Value> {
    let id = "Id de la terminal (de terminal_run o terminal_list).";
    let wait = "Máximo a esperar en segundos, 0–600. Al vencer no corta nada.";
    let until = "Regex sin distinguir mayúsculas que indica que ya está listo (ej. «listening on|ready in»). Devuelve apenas aparece en la salida del comando.";
    vec![
        tool(
            "terminal_run",
            "Abre una terminal visible en el panel Terminal de GuilleCode (o reutiliza una tuya), se ubica en cwd y escribe command como si lo tipeara el usuario. Espera a que termine, a que aparezca until o a que pasen wait_seconds (por defecto 60); lo que siga corriendo queda vivo en la terminal. Devuelve el id, el estado (código de salida o «sigue corriendo») y la salida del comando. Es la forma de levantar servidores y procesos largos.",
            json!({
                "command": prop("string", "Comando de PowerShell en un solo renglón."),
                "cwd": prop("string", "Ruta absoluta de la carpeta donde correrlo. Obligatoria al abrir una terminal nueva."),
                "title": prop("string", "Nombre corto de la pestaña (ej. «GQL», «front», «tests»)."),
                "terminal": prop("string", "Opcional: id de una terminal tuya que no esté ocupada, para reutilizarla."),
                "until": prop("string", until),
                "wait_seconds": prop("integer", wait),
            }),
            &["command"],
            false,
        ),
        tool(
            "terminal_read",
            "Lee lo que muestra una terminal de GuilleCode (también las que abrió el usuario): las últimas líneas, o las del historial que coinciden con grep. Con wait_seconds espera antes a que termine el comando en curso o a que aparezca until.",
            json!({
                "id": prop("string", id),
                "lines": prop("integer", "Cuántas líneas devolver (por defecto 120, máximo 400)."),
                "grep": prop("string", "Regex sin distinguir mayúsculas: devuelve solo las líneas del historial que coinciden (ej. «error|warn»)."),
                "until": prop("string", until),
                "wait_seconds": prop("integer", wait),
            }),
            &["id"],
            true,
        ),
        tool(
            "terminal_send",
            "Manda una tecla o texto a una terminal. key=ctrl+c corta el proceso en curso (si pregunta «¿Terminar el trabajo por lotes (S/N)?» se confirma solo). text escribe el texto y aprieta Enter salvo submit=false (para responder preguntas del proceso). Devuelve las últimas líneas.",
            json!({
                "id": prop("string", id),
                "key": { "type": "string", "enum": KEYS.iter().map(|(k, _)| *k).collect::<Vec<_>>(), "description": "Tecla especial." },
                "text": prop("string", "Texto a escribir."),
                "submit": prop("boolean", "Apretar Enter después del texto (por defecto true)."),
            }),
            &["id"],
            false,
        ),
        tool(
            "terminal_list",
            "Lista las terminales abiertas en GuilleCode: id, título, carpeta, si la abrió el agente o el usuario, si hay un comando corriendo y su última línea.",
            json!({}),
            &[],
            true,
        ),
        tool(
            "terminal_close",
            "Cierra una terminal que abriste vos y mata todo lo que corría en ella. Las del usuario no se pueden cerrar.",
            json!({ "id": prop("string", id) }),
            &["id"],
            false,
        ),
    ]
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    let result = match name {
        "terminal_run" => run(app, args),
        "terminal_read" => read(app, args),
        "terminal_send" => send(app, args),
        "terminal_list" => Ok(list(app)),
        "terminal_close" => close(app, args),
        other => Err(format!("herramienta desconocida: {}", other)),
    };
    match result {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
        Err(error) => json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
    }
}

fn text_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}

fn seconds(args: &Value, default: u64) -> u64 {
    args["wait_seconds"].as_f64().map(|s| s.max(0.0) as u64).unwrap_or(default).min(MAX_WAIT)
}

fn pattern(args: &Value, key: &str) -> Result<Option<Regex>, String> {
    match text_arg(args, key) {
        None => Ok(None),
        Some(p) => RegexBuilder::new(p).case_insensitive(true).build().map(Some).map_err(|e| format!("{} no es una regex válida: {}", key, e)),
    }
}

fn norm(path: &str) -> String {
    let long = std::fs::canonicalize(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string());
    long.trim_start_matches(r"\\?\").replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn inside(root: &str, path: &str) -> bool {
    !root.is_empty() && (path == root || path.starts_with(&format!("{}/", root)))
}

fn window_for(app: &AppHandle, cwd: &str) -> String {
    let target = norm(cwd);
    let mut best: Option<(usize, String)> = None;
    for label in app.webview_windows().keys() {
        let project = crate::windows::project_of(app, label);
        if project.is_empty() {
            continue;
        }
        let mut roots = vec![project.clone()];
        roots.extend(crate::features::feature_roots(app, &project).into_iter().map(|(root, _)| root));
        for root in roots {
            let root = norm(&root);
            if inside(&root, &target) && best.as_ref().map(|(len, _)| root.len() > *len).unwrap_or(true) {
                best = Some((root.len(), label.clone()));
            }
        }
    }
    best.map(|(_, label)| label).unwrap_or_else(|| crate::windows::MAIN.to_string())
}

fn wait_until(screen: &Screen, deadline: Instant, mut done: impl FnMut(&mut ScreenState) -> bool) -> bool {
    let mut state = screen.state.lock().unwrap();
    loop {
        if done(&mut state) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let pause = (deadline - now).min(Duration::from_millis(300));
        state = screen.changed.wait_timeout(state, pause).unwrap().0;
    }
}

fn found(state: &mut ScreenState, until: &Regex) -> Option<String> {
    let lines = match state.capture.as_mut() {
        Some(capture) => capture.lines().into_iter().skip(1).collect::<Vec<_>>(),
        None => state.tail(MAX_LINES),
    };
    lines.iter().find_map(|line| until.find(line).map(|m| m.as_str().to_string()))
}

fn clip(lines: Vec<String>, max: usize) -> String {
    let mut lines = lines;
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let total = lines.len();
    let mut kept: Vec<String> = lines.into_iter().skip(total.saturating_sub(max)).collect();
    let mut chars: usize = kept.iter().map(|l| l.chars().count() + 1).sum();
    while chars > MAX_CHARS && kept.len() > 1 {
        chars -= kept.remove(0).chars().count() + 1;
    }
    let omitted = total - kept.len();
    let body = kept.join("\n");
    if omitted > 0 {
        format!("(se omitieron {} líneas anteriores)\n{}", omitted, body)
    } else if body.is_empty() {
        "(sin salida)".to_string()
    } else {
        body
    }
}

fn describe(app: &AppHandle, id: &str) -> String {
    let state = app.state::<term::TermState>();
    let terms = state.terms.lock().unwrap();
    match terms.get(id) {
        Some(t) => match &t.title {
            Some(title) => format!("Terminal «{}» ({}) en {}", title, id, t.cwd),
            None => format!("Terminal {} en {}", id, t.cwd),
        },
        None => format!("Terminal {}", id),
    }
}

fn ended(code: i32) -> String {
    match code {
        -1073741510 => "se cortó con Ctrl+C".to_string(),
        c => format!("terminó con código {}", c),
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn status_line(state: &ScreenState) -> String {
    if let Some(code) = state.exited {
        return match code {
            Some(c) => format!("La terminal se cerró (código {}).", c),
            None => "La terminal se cerró.".to_string(),
        };
    }
    match state.capture.as_ref() {
        Some(c) if c.finished().is_none() => format!("Corriendo «{}» hace {} s.", c.command, c.started.elapsed().as_secs()),
        Some(c) => match c.finished().flatten() {
            Some(code) => format!("Libre. El último comando («{}») {}.", c.command, ended(code)),
            None => format!("Libre. El último comando («{}») terminó.", c.command),
        },
        None if state.parser.callbacks().prompts > 0 => "Libre (esperando un comando).".to_string(),
        None => "Sin datos de estado (shell sin integración): mirá la salida.".to_string(),
    }
}

fn open(app: &AppHandle, cwd: &str, title: Option<&str>) -> Result<String, String> {
    let label = window_for(app, cwd);
    let id = format!("agent-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let spawned = term::expect_spawn(app, &id);
    let payload = json!({ "id": id, "cwd": cwd, "title": title, "shell": term::agent_shell() });
    if let Err(e) = app.emit_to(label.as_str(), "terminal://agent-open", payload) {
        term::forget_spawn(app, &id);
        return Err(format!("No pude avisarle a la ventana de GuilleCode: {}", e));
    }
    match spawned.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(())) => Ok(id),
        Ok(Err(e)) => Err(format!("No se pudo abrir la terminal: {}", e)),
        Err(_) => {
            term::forget_spawn(app, &id);
            Err("La ventana de GuilleCode no abrió la terminal a tiempo. Revisá que GuilleCode esté abierto con ese proyecto.".to_string())
        }
    }
}

fn run(app: &AppHandle, args: &Value) -> Result<String, String> {
    let command = text_arg(args, "command").ok_or("Falta command.")?;
    if command.contains('\n') || command.contains('\r') {
        return Err("command tiene que ser un solo renglón: encadená los pasos con ; o usá un script.".to_string());
    }
    let wait = seconds(args, DEFAULT_WAIT).max(1);
    let until = pattern(args, "until")?;
    let cwd = text_arg(args, "cwd");
    if let Some(dir) = cwd {
        if !Path::new(dir).is_absolute() || !Path::new(dir).is_dir() {
            return Err(format!("cwd tiene que ser una carpeta absoluta que exista: {}", dir));
        }
    }
    let (id, line) = match text_arg(args, "terminal") {
        Some(existing) => {
            let screen = term::screen_of(app, existing).ok_or_else(|| format!("La terminal {} ya no existe. Abrí otra sin terminal.", existing))?;
            if let Some(c) = screen.state.lock().unwrap().capture.as_ref().filter(|c| c.finished().is_none()) {
                return Err(format!("La terminal {} está ocupada con «{}». Esperá con terminal_read, cortalo con terminal_send key=ctrl+c o abrí otra.", existing, c.command));
            }
            let line = match cwd {
                Some(dir) => format!("Set-Location -LiteralPath '{}'; {}", dir.replace('\'', "''"), command),
                None => command.to_string(),
            };
            let owner = app.state::<term::TermState>().terms.lock().unwrap().get(existing).map(|t| t.owner.clone());
            if let Some(owner) = owner {
                let _ = app.emit_to(owner.as_str(), "terminal://agent-show", json!({ "id": existing }));
            }
            (existing.to_string(), line)
        }
        None => {
            let dir = cwd.ok_or("Falta cwd: la ruta absoluta de la carpeta donde correr el comando.")?;
            (open(app, dir, text_arg(args, "title"))?, command.to_string())
        }
    };
    let screen = term::screen_of(app, &id).ok_or("La terminal se cerró antes de empezar.")?;
    let ready = wait_until(&screen, Instant::now() + PROMPT_TIMEOUT, |s| s.parser.callbacks().prompts > 0 || s.exited.is_some());
    screen.state.lock().unwrap().begin_capture(&line);
    term::write_to(app, &id, format!("{}\r", line).as_bytes())?;
    let started = Instant::now();
    let mut matched: Option<String> = None;
    let mut checked: Option<Instant> = None;
    wait_until(&screen, started + Duration::from_secs(wait), |s| {
        if s.exited.is_some() || s.capture.as_ref().and_then(|c| c.finished()).is_some() {
            return true;
        }
        if let Some(re) = until.as_ref() {
            if checked.map(|t| t.elapsed() >= RECHECK).unwrap_or(true) {
                checked = Some(Instant::now());
                matched = found(s, re);
            }
        }
        matched.is_some()
    });
    let header = describe(app, &id);
    let mut state = screen.state.lock().unwrap();
    let elapsed = started.elapsed().as_secs();
    let finished = state.capture.as_ref().and_then(|c| c.finished());
    let status = if let Some(code) = state.exited {
        format!("La terminal se cerró{}.", code.map(|c| format!(" (código {})", c)).unwrap_or_default())
    } else if let Some(code) = finished {
        match code {
            Some(c) => format!("{} a los {} s.", capitalize(&ended(c)), elapsed),
            None => format!("Terminó en {} s.", elapsed),
        }
    } else if let Some(m) = matched.as_ref() {
        format!("Sigue corriendo: apareció «{}» a los {} s.", m, elapsed)
    } else {
        format!("Sigue corriendo después de {} s.", elapsed)
    };
    let output = state.capture.as_mut().map(|c| c.lines()).unwrap_or_default();
    let mut text = format!("{}\nComando: {}\nEstado: {}", header, line, status);
    if !ready {
        text.push_str("\nAviso: el shell no mostró el prompt a tiempo; el estado puede no detectarse.");
    }
    if finished.is_none() && state.exited.is_none() {
        text.push_str(&format!("\nQueda corriendo a la vista. Logs: terminal_read id={}; cortar: terminal_send id={} key=ctrl+c.", id, id));
    }
    text.push_str("\n\nSalida:\n");
    text.push_str(&clip(output, MAX_LINES));
    Ok(text)
}

fn read(app: &AppHandle, args: &Value) -> Result<String, String> {
    let id = text_arg(args, "id").ok_or("Falta id.")?;
    let screen = term::screen_of(app, id).ok_or_else(|| format!("La terminal {} ya no existe.", id))?;
    let lines = args["lines"].as_u64().map(|n| n as usize).unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES);
    let grep = pattern(args, "grep")?;
    let until = pattern(args, "until")?;
    let wait = seconds(args, 0);
    let mut matched: Option<String> = None;
    let mut checked: Option<Instant> = None;
    if wait > 0 {
        wait_until(&screen, Instant::now() + Duration::from_secs(wait), |s| {
            if let Some(re) = until.as_ref() {
                if checked.map(|t| t.elapsed() >= RECHECK).unwrap_or(true) {
                    checked = Some(Instant::now());
                    matched = found(s, re);
                }
                if matched.is_some() {
                    return true;
                }
            }
            s.exited.is_some() || !s.running() && until.is_none()
        });
    }
    let header = describe(app, id);
    let mut state = screen.state.lock().unwrap();
    let mut text = format!("{}\nEstado: {}", header, status_line(&state));
    if let Some(m) = matched {
        text.push_str(&format!("\nApareció «{}».", m));
    } else if until.is_some() && wait > 0 {
        text.push_str("\nNo apareció until en el tiempo de espera.");
    }
    match grep {
        Some(re) => {
            let hits: Vec<String> = state.history().into_iter().filter(|l| re.is_match(l)).collect();
            text.push_str(&format!("\n\nLíneas que coinciden ({}):\n", hits.len()));
            text.push_str(&clip(hits, lines));
        }
        None => {
            text.push_str("\n\nPantalla:\n");
            text.push_str(&clip(state.tail(lines), lines));
        }
    }
    Ok(text)
}

fn send(app: &AppHandle, args: &Value) -> Result<String, String> {
    let id = text_arg(args, "id").ok_or("Falta id.")?;
    let screen = term::screen_of(app, id).ok_or_else(|| format!("La terminal {} ya no existe.", id))?;
    let key = text_arg(args, "key");
    let text = args["text"].as_str().filter(|t| !t.is_empty());
    if key.is_none() && text.is_none() {
        return Err("Mandá key o text.".to_string());
    }
    let was_running = screen.state.lock().unwrap().running();
    if let Some(t) = text {
        let submit = args["submit"].as_bool().unwrap_or(true);
        let data = format!("{}{}", t.replace("\r\n", "\r").replace('\n', "\r"), if submit { "\r" } else { "" });
        term::write_to(app, id, data.as_bytes())?;
    }
    if let Some(k) = key {
        let bytes = KEYS.iter().find(|(name, _)| name.eq_ignore_ascii_case(k)).map(|(_, b)| *b).ok_or_else(|| format!("Tecla desconocida: {}", k))?;
        term::write_to(app, id, bytes.as_bytes())?;
        if k.eq_ignore_ascii_case("ctrl+c") {
            confirm_batch(app, id, &screen);
        }
    }
    wait_until(&screen, Instant::now() + SETTLE, |s| s.exited.is_some() || (was_running && !s.running()));
    let header = describe(app, id);
    let mut state = screen.state.lock().unwrap();
    Ok(format!("{}\nEstado: {}\n\nPantalla:\n{}", header, status_line(&state), clip(state.tail(40), 40)))
}

fn confirm_batch(app: &AppHandle, id: &str, screen: &Arc<Screen>) {
    let asks = Regex::new(r"\((Y/N|S/N)\)\??\s*$").unwrap();
    let mut answer: Option<&str> = None;
    let was_running = screen.state.lock().unwrap().running();
    wait_until(screen, Instant::now() + Duration::from_millis(1500), |s| {
        if s.exited.is_some() || (was_running && !s.running()) {
            return true;
        }
        let last = s.tail(3).into_iter().last().unwrap_or_default();
        if let Some(c) = asks.captures(&last) {
            answer = Some(if &c[1] == "S/N" { "S\r" } else { "Y\r" });
            return true;
        }
        false
    });
    if let Some(a) = answer {
        let _ = term::write_to(app, id, a.as_bytes());
    }
}

fn list(app: &AppHandle) -> String {
    let entries: Vec<(String, Option<String>, String, bool, String, Arc<Screen>)> = {
        let state = app.state::<term::TermState>();
        let terms = state.terms.lock().unwrap();
        terms.iter().map(|(id, t)| (id.clone(), t.title.clone(), t.cwd.clone(), t.agent, t.owner.clone(), Arc::clone(&t.screen))).collect()
    };
    if entries.is_empty() {
        return "No hay terminales abiertas.".to_string();
    }
    let mut out = Vec::new();
    for (id, title, cwd, agent, owner, screen) in entries {
        let mut state = screen.state.lock().unwrap();
        let last = state.tail(5).into_iter().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
        out.push(format!(
            "- {} · {} · {} · {} · ventana {}\n  {}\n  Última línea: {}",
            id,
            title.unwrap_or_else(|| "(sin título)".to_string()),
            cwd,
            if agent { "abierta por el agente" } else { "del usuario" },
            owner,
            status_line(&state),
            last.chars().take(200).collect::<String>(),
        ));
    }
    out.join("\n")
}

fn close(app: &AppHandle, args: &Value) -> Result<String, String> {
    let id = text_arg(args, "id").ok_or("Falta id.")?;
    let agent = app.state::<term::TermState>().terms.lock().unwrap().get(id).map(|t| t.agent);
    match agent {
        None => Err(format!("La terminal {} ya no existe.", id)),
        Some(false) => Err("Esa terminal la abrió el usuario: no la cierres. Si hay que cortar un proceso, usá terminal_send key=ctrl+c.".to_string()),
        Some(true) => {
            let owner = term::kill_one(app, id).unwrap_or_default();
            let _ = app.emit_to(owner.as_str(), "terminal://agent-closed", json!({ "id": id }));
            Ok(format!("Cerré la terminal {} y lo que corría en ella.", id))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_the_tail_and_reports_omitted_lines() {
        let lines: Vec<String> = (0..10).map(|i| format!("l{}", i)).collect();
        assert_eq!(clip(lines, 3), "(se omitieron 7 líneas anteriores)\nl7\nl8\nl9");
        assert_eq!(clip(vec!["".into(), "".into()], 5), "(sin salida)");
    }

    #[test]
    fn inside_matches_whole_segments_only() {
        assert!(inside("c:/repo", "c:/repo"));
        assert!(inside("c:/repo", "c:/repo/api"));
        assert!(!inside("c:/repo", "c:/repo-2"));
        assert!(!inside("", "c:/repo"));
    }

    #[test]
    fn every_tool_has_a_schema() {
        let names: Vec<String> = definitions().iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["terminal_run", "terminal_read", "terminal_send", "terminal_list", "terminal_close"]);
    }
}
