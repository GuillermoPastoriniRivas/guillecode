use super::uia;
use super::win::{self, Button, WinInfo};
use super::{blocked_reason, gate, record, ToolResult};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

const SNAPSHOT_MAX: usize = 350;
const AFTER_MAX: usize = 220;
const POPUP_MAX: usize = 120;
const DEPTH: usize = 40;
const SHOT_SIDE: u32 = 1280;
const READ_MAX: i32 = 20000;

#[derive(Clone, Copy)]
struct Frame {
    origin: (i32, i32),
    scale: f64,
}

static FRAMES: Mutex<Option<HashMap<isize, Frame>>> = Mutex::new(None);

fn remember_frame(window: isize, frame: Frame) {
    FRAMES.lock().unwrap().get_or_insert_with(HashMap::new).insert(window, frame);
}

fn frame_of(window: isize) -> Option<Frame> {
    FRAMES.lock().unwrap().as_ref().and_then(|m| m.get(&window).copied())
}

fn text(t: impl Into<String>) -> ToolResult {
    ToolResult { content: vec![json!({ "type": "text", "text": t.into() })], error: false }
}

fn fail(t: impl Into<String>) -> ToolResult {
    ToolResult { content: vec![json!({ "type": "text", "text": t.into() })], error: true }
}

fn prop(kind: &str, description: &str) -> Value {
    json!({ "type": kind, "description": description })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "annotations": { "readOnlyHint": read_only, "openWorldHint": true },
    })
}

pub fn definitions() -> Vec<Value> {
    let window = "La ventana: su id (ej. «w6818530», de `windows`) o parte de su título o del nombre de la app (ej. «Bloc de notas», «notepad»).";
    let reference = "La ref del elemento sacada del último snapshot (ej. «e14»).";
    let element = "Descripción corta del elemento para el registro que ve el usuario (ej. «botón Guardar»).";
    vec![
        tool(
            "status",
            "Estado de la PC antes de actuar: si la sesión está bloqueada (entonces no hay mouse ni teclado, solo acciones por accesibilidad), si el control está activado o pausado, la batería y la ventana en primer plano. Llamalo primero.",
            json!({}),
            &[],
            true,
        ),
        tool("windows", "Lista las ventanas abiertas del escritorio con su id (wNNN), título, app y cuál está en primer plano.", json!({}), &[], true),
        tool(
            "snapshot",
            "Árbol de accesibilidad de una ventana: cada control con rol, nombre, valor, estado y una ref [eN] para actuar sobre él. Es la forma principal de ver una app: más rápida y precisa que una captura. Las refs cambian en cada snapshot.",
            json!({
                "window": prop("string", window),
                "root": prop("string", "Opcional: ref de un contenedor para ver solo esa parte cuando la ventana es muy grande."),
                "max_elements": prop("integer", "Opcional: tope de elementos (por defecto 350)."),
            }),
            &["window"],
            true,
        ),
        tool(
            "click",
            "Activa un elemento por su ref. Usa accesibilidad (invocar, marcar, seleccionar, desplegar), que funciona aunque la PC esté bloqueada y sin mover el mouse; si el control no lo permite, hace clic real con el mouse. Devuelve el snapshot actualizado.",
            json!({
                "ref": prop("string", reference),
                "element": prop("string", element),
                "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Botón (por defecto left). right abre el menú contextual." },
                "double": prop("boolean", "Doble clic (necesita la sesión desbloqueada)."),
            }),
            &["ref"],
            false,
        ),
        tool(
            "type",
            "Escribe texto en un campo por su ref. Reemplaza el contenido del campo. Si el control lo permite, usa accesibilidad (funciona con la PC bloqueada); si no, hace foco y teclea. Devuelve el snapshot actualizado.",
            json!({
                "ref": prop("string", reference),
                "text": prop("string", "El texto a escribir."),
                "submit": prop("boolean", "Apretar Enter después (necesita la sesión desbloqueada)."),
                "element": prop("string", element),
            }),
            &["ref", "text"],
            false,
        ),
        tool(
            "select",
            "Elige una opción de un combobox o lista por su texto visible. Si no existe, devuelve las opciones disponibles.",
            json!({ "ref": prop("string", reference), "option": prop("string", "El texto de la opción."), "element": prop("string", element) }),
            &["ref", "option"],
            false,
        ),
        tool(
            "press_key",
            "Aprieta teclas o atajos en la ventana indicada (o en la que está al frente). Formato: «ctrl+s», «enter», «alt+f4», «ctrl+shift+t»; varias separadas por espacio: «ctrl+a delete». Necesita la sesión desbloqueada.",
            json!({ "keys": prop("string", "Teclas a apretar."), "window": prop("string", window) }),
            &["keys"],
            false,
        ),
        tool(
            "read",
            "Lee el texto completo de un elemento (un documento, un campo, un panel) por su ref, hasta 20000 caracteres. El snapshot solo muestra un pedazo.",
            json!({ "ref": prop("string", reference), "max_chars": prop("integer", "Opcional: tope de caracteres.") }),
            &["ref"],
            true,
        ),
        tool(
            "scroll",
            "Desplaza el contenido del elemento (o de su contenedor más cercano) para ver lo que está fuera de vista. Después pedí un snapshot.",
            json!({
                "ref": prop("string", reference),
                "direction": { "type": "string", "enum": ["down", "up"] },
                "page": prop("boolean", "Una página entera en vez de un paso."),
            }),
            &["ref", "direction"],
            false,
        ),
        tool(
            "screenshot",
            "Captura una ventana (o toda la pantalla si no pasás window) para verificar cómo se ve o cuando el árbol de accesibilidad no alcanza (canvas, juegos, escritorio remoto). Necesita la sesión desbloqueada. Las coordenadas de click_xy son las de esta imagen.",
            json!({ "window": prop("string", window) }),
            &[],
            true,
        ),
        tool(
            "click_xy",
            "Último recurso: clic en coordenadas de la última captura de esa ventana (x, y en píxeles de la imagen). Usalo solo si el elemento no aparece en el snapshot. Necesita la sesión desbloqueada.",
            json!({
                "window": prop("string", window),
                "x": prop("number", "X en la imagen."),
                "y": prop("number", "Y en la imagen."),
                "button": { "type": "string", "enum": ["left", "right", "middle"] },
                "double": prop("boolean", "Doble clic."),
                "element": prop("string", element),
            }),
            &["window", "x", "y"],
            false,
        ),
        tool("focus_window", "Trae una ventana al frente (y la restaura si estaba minimizada). Necesita la sesión desbloqueada.", json!({ "window": prop("string", window) }), &["window"], false),
        tool(
            "close_window",
            "Cierra una ventana como si tocaras la X, por accesibilidad (funciona con la PC bloqueada). Si la app pregunta si guardar, el diálogo aparece en el resultado para que elijas.",
            json!({ "window": prop("string", window) }),
            &["window"],
            false,
        ),
        tool(
            "launch",
            "Abre una app, archivo o URL como si el usuario lo abriera desde Inicio: «notepad», «calc», «excel», «C:\\ruta\\archivo.xlsx», «ms-settings:». Espera a que aparezca la ventana y devuelve su id.",
            json!({ "app": prop("string", "Nombre, ruta o URI."), "args": prop("string", "Opcional: argumentos.") }),
            &["app"],
            false,
        ),
    ]
}

fn resolve_window(query: &str) -> Result<WinInfo, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("falta la ventana".into());
    }
    let list = win::windows();
    if let Some(id) = q.strip_prefix('w').and_then(|n| n.parse::<isize>().ok()) {
        return win::window(id).or_else(|| list.iter().find(|w| w.hwnd == id).cloned()).ok_or_else(|| format!("la ventana {} ya no existe: pedí `windows` de nuevo", q));
    }
    let lower = q.to_lowercase();
    let matches: Vec<&WinInfo> = list
        .iter()
        .filter(|w| w.title.to_lowercase().contains(&lower) || w.process.to_lowercase() == lower || w.process.to_lowercase().trim_end_matches(".exe") == lower)
        .collect();
    match matches.as_slice() {
        [] => Err(format!("no hay ninguna ventana que coincida con «{}». Ventanas abiertas:\n{}", q, windows_text(&list))),
        [one] => Ok((*one).clone()),
        many => Ok(many.iter().find(|w| w.foreground).copied().unwrap_or(many[0]).clone()),
    }
}

fn window_line(w: &WinInfo) -> String {
    let mut line = format!("- w{} \"{}\" ({})", w.hwnd, w.title.replace('"', "'"), if w.process.is_empty() { "app sin acceso: puede correr como administrador" } else { &w.process });
    let mut tags: Vec<&str> = Vec::new();
    if w.foreground {
        tags.push("al frente");
    }
    if w.minimized {
        tags.push("minimizada");
    }
    if blocked_reason(w).is_some() {
        tags.push("bloqueada para el agente");
    }
    if !tags.is_empty() {
        line.push_str(&format!(" [{}]", tags.join(", ")));
    }
    line
}

fn windows_text(list: &[WinInfo]) -> String {
    if list.is_empty() {
        return "(no hay ventanas visibles)".into();
    }
    list.iter().map(window_line).collect::<Vec<_>>().join("\n")
}

fn allowed(w: &WinInfo) -> Result<(), String> {
    match blocked_reason(w) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

fn needs_desktop(what: &str) -> Result<(), String> {
    if crate::machine::interactive() {
        return Ok(());
    }
    Err(format!(
        "No puedo {}: la PC está bloqueada (o hay un aviso de UAC), así que Windows no acepta mouse ni teclado simulados. Seguí con acciones por accesibilidad (click, type, select, read, snapshot) o pedile al usuario que desbloquee la PC.",
        what
    ))
}

fn window_of_ref(reference: &str) -> Result<WinInfo, String> {
    let r = reference.to_string();
    let hwnd = uia::run(move |u| u.owner(&r))?;
    win::window(hwnd).or_else(|| win::window(win::root_of(hwnd))).ok_or_else(|| "la ventana de ese elemento ya no existe: pedí `windows` y un snapshot nuevo".to_string())
}

fn snapshot_text(window: &WinInfo, root: Option<String>, max: usize) -> Result<String, String> {
    let hwnd = window.hwnd;
    let (tree, _) = uia::run(move |u| u.snapshot(hwnd, root.as_deref(), max, DEPTH))?;
    Ok(format!("Ventana w{} \"{}\" ({})\n{}", window.hwnd, window.title.replace('"', "'"), window.process, tree))
}

fn after_action(window: &WinInfo, before: &[isize], done: String) -> ToolResult {
    std::thread::sleep(Duration::from_millis(450));
    let now = win::windows();
    let fresh: Vec<&WinInfo> = now.iter().filter(|w| !before.contains(&w.hwnd)).collect();
    let mut out = done;
    for w in &fresh {
        out.push_str(&format!("\nSe abrió una ventana nueva: {}", window_line(w)));
    }
    let target = fresh.iter().find(|w| w.foreground).map(|w| (*w).clone()).or_else(|| win::window(window.hwnd));
    let target_hwnd = target.as_ref().map(|t| t.hwnd);
    match target {
        None => out.push_str("\nLa ventana se cerró."),
        Some(t) if blocked_reason(&t).is_some() => out.push_str(&format!("\nQuedó al frente «{}», que está bloqueada para el agente.", t.title)),
        Some(t) => match snapshot_text(&t, None, AFTER_MAX) {
            Ok(tree) => {
                out.push_str("\n\n");
                out.push_str(&tree);
            }
            Err(e) => out.push_str(&format!("\n(No pude leer la ventana después de actuar: {})", e)),
        },
    }
    for popup in fresh.iter().filter(|w| w.pid == window.pid && Some(w.hwnd) != target_hwnd && blocked_reason(w).is_none()) {
        if let Ok(tree) = snapshot_text(popup, None, POPUP_MAX) {
            out.push_str("\n\n");
            out.push_str(&tree);
        }
    }
    text(out)
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args[key].as_str().unwrap_or("").trim()
}

fn button_of(args: &Value) -> Button {
    match arg(args, "button") {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

fn describe_target(args: &Value, fallback: &str) -> String {
    let e = arg(args, "element");
    if e.is_empty() {
        fallback.to_string()
    } else {
        e.to_string()
    }
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> ToolResult {
    if name != "status" {
        if let Err(e) = gate(app) {
            return fail(e);
        }
    }
    let (result, summary) = dispatch(app, name, args);
    if !matches!(name, "status" | "windows") {
        record(app, "desktop", name, &summary, !result.error);
    }
    result
}

fn dispatch(app: &AppHandle, name: &str, args: &Value) -> (ToolResult, String) {
    let outcome = match name {
        "status" => Ok((status_text(app), String::new())),
        "windows" => Ok((text(windows_text(&win::windows())), String::new())),
        "snapshot" => do_snapshot(args),
        "click" => do_click(args),
        "type" => do_type(args),
        "select" => do_select(args),
        "press_key" => do_press(args),
        "read" => do_read(args),
        "scroll" => do_scroll(args),
        "screenshot" => do_screenshot(args),
        "click_xy" => do_click_xy(args),
        "focus_window" => do_focus(args),
        "close_window" => do_close(args),
        "launch" => do_launch(args),
        other => Err(format!("no existe la herramienta «{}»", other)),
    };
    match outcome {
        Ok((result, summary)) => (result, summary),
        Err(e) => (fail(e), format!("{} falló", name)),
    }
}

fn status_text(app: &AppHandle) -> ToolResult {
    let m = crate::machine::status();
    let config = super::config(app);
    let fg = win::window(win::foreground());
    let mut lines = vec![
        format!("Control del escritorio: {}", if !config.enabled { "APAGADO (el usuario tiene que activarlo en GuilleCode o desde el celular)" } else if config.paused { "PAUSADO por el usuario" } else { "activado" }),
        format!(
            "Sesión: {}",
            if m.locked || !m.interactive {
                "BLOQUEADA → no hay mouse, teclado ni capturas; usá snapshot/click/type/select/read (accesibilidad)"
            } else {
                "desbloqueada → funciona todo"
            }
        ),
    ];
    if m.has_battery {
        lines.push(format!("Energía: {}{}", if m.on_battery { "batería" } else { "enchufada" }, m.battery.map(|b| format!(" ({}%)", b)).unwrap_or_default()));
    }
    if let Some(w) = fg {
        lines.push(format!("Al frente: {}", window_line(&w)));
    }
    lines.push(format!("Navegador (Chrome del usuario): {}", super::browser_line()));
    text(lines.join("\n"))
}

fn do_snapshot(args: &Value) -> Result<(ToolResult, String), String> {
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let root = Some(arg(args, "root").to_string()).filter(|r| !r.is_empty());
    let max = args["max_elements"].as_u64().map(|n| n.clamp(20, 1500) as usize).unwrap_or(SNAPSHOT_MAX);
    let tree = snapshot_text(&w, root, max)?;
    Ok((text(tree), format!("miró «{}»", w.title)))
}

fn do_click(args: &Value) -> Result<(ToolResult, String), String> {
    let reference = arg(args, "ref").to_string();
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let label = {
        let r = reference.clone();
        uia::run(move |u| Ok(u.label(&r)))?
    };
    let target = describe_target(args, &label);
    let summary = format!("clic en {} · {}", target, w.title);
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    let button = button_of(args);
    let double = args["double"].as_bool().unwrap_or(false);
    if matches!(button, Button::Left) && !double {
        let r = reference.clone();
        if let Some(done) = uia::run(move |u| u.activate(&r))? {
            let note = if done.pending { " (la app sigue procesando: probablemente abrió un diálogo)" } else { "" };
            return Ok((after_action(&w, &before, format!("Hecho por accesibilidad ({}) sobre {}{}.", done.method, target, note)), summary));
        }
    }
    needs_desktop("hacer clic con el mouse en ese control")?;
    let r = reference.clone();
    uia::run(move |u| {
        u.scroll_into_view(&r);
        Ok(())
    })?;
    win::focus(w.hwnd)?;
    let r = reference.clone();
    let (x, y) = uia::run(move |u| u.point(&r))?;
    if !win::on_screen(x, y) {
        return Err("el elemento está fuera de la pantalla".into());
    }
    win::click(x, y, button, double)?;
    Ok((after_action(&w, &before, format!("Clic con el mouse en {} ({}, {}).", target, x, y)), summary))
}

fn do_type(args: &Value) -> Result<(ToolResult, String), String> {
    let reference = arg(args, "ref").to_string();
    let content = args["text"].as_str().unwrap_or("").to_string();
    let submit = args["submit"].as_bool().unwrap_or(false);
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let label = {
        let r = reference.clone();
        uia::run(move |u| Ok(u.label(&r)))?
    };
    let target = describe_target(args, &label);
    let summary = format!("escribió en {} · {}", target, w.title);
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    let (r, c) = (reference.clone(), content.replace("\r\n", "\n").replace('\n', "\r\n"));
    let by_pattern = uia::run(move |u| u.set_value(&r, &c))?;
    let mut done = match by_pattern {
        Some(_) => {
            let r = reference.clone();
            let now = uia::run(move |u| Ok(u.value(&r)))?;
            match now {
                Some(v) if same_text(&v, &content) || content.is_empty() => format!("Escribí por accesibilidad en {}.", target),
                Some(_) => {
                    needs_desktop("escribir con el teclado (el campo no aceptó el valor por accesibilidad)")?;
                    type_with_keyboard(&w, &reference, &content)?;
                    format!("Escribí con el teclado en {}.", target)
                }
                _ => format!("Escribí por accesibilidad en {}.", target),
            }
        }
        None => {
            needs_desktop("escribir con el teclado (el campo no acepta texto por accesibilidad)")?;
            type_with_keyboard(&w, &reference, &content)?;
            format!("Escribí con el teclado en {}.", target)
        }
    };
    if submit {
        needs_desktop("apretar Enter")?;
        let r = reference.clone();
        let _ = uia::run(move |u| u.focus(&r));
        win::press("enter")?;
        done.push_str(" Apreté Enter.");
    }
    Ok((after_action(&w, &before, done), summary))
}

fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace("\r\n", "\n").replace('\r', "\n").trim_end().to_string();
    norm(a) == norm(b)
}

fn type_with_keyboard(w: &WinInfo, reference: &str, content: &str) -> Result<(), String> {
    win::focus(w.hwnd)?;
    let r = reference.to_string();
    uia::run(move |u| u.focus(&r))?;
    std::thread::sleep(Duration::from_millis(80));
    win::press("ctrl+a")?;
    if content.is_empty() {
        return win::press("delete");
    }
    win::type_text(content)
}

fn do_select(args: &Value) -> Result<(ToolResult, String), String> {
    let reference = arg(args, "ref").to_string();
    let option = arg(args, "option").to_string();
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let summary = format!("eligió «{}» · {}", option, w.title);
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    let (r, o) = (reference.clone(), option.clone());
    let chosen = uia::run(move |u| u.select_option(&r, &o))?;
    Ok((after_action(&w, &before, format!("Elegí «{}».", chosen)), summary))
}

fn do_press(args: &Value) -> Result<(ToolResult, String), String> {
    let keys = arg(args, "keys").to_string();
    needs_desktop("apretar teclas")?;
    let w = if arg(args, "window").is_empty() {
        win::window(win::foreground()).ok_or("no hay ninguna ventana al frente")?
    } else {
        resolve_window(arg(args, "window"))?
    };
    allowed(&w)?;
    let lower = keys.to_lowercase();
    if lower.contains("win+") || lower.contains("meta+") || lower == "win" {
        return Err("no uso la tecla Windows: abrí apps con `launch`".into());
    }
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    if !w.foreground {
        win::focus(w.hwnd)?;
    }
    win::press(&keys)?;
    Ok((after_action(&w, &before, format!("Apreté {} en «{}».", keys, w.title)), format!("teclas {} · {}", keys, w.title)))
}

fn do_read(args: &Value) -> Result<(ToolResult, String), String> {
    let reference = arg(args, "ref").to_string();
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let max = args["max_chars"].as_i64().map(|n| n.clamp(100, READ_MAX as i64) as i32).unwrap_or(READ_MAX);
    let r = reference.clone();
    let content = uia::run(move |u| u.read(&r, max))?;
    let body = if content.trim().is_empty() { "(vacío)".to_string() } else { content };
    Ok((text(body), format!("leyó texto · {}", w.title)))
}

fn do_scroll(args: &Value) -> Result<(ToolResult, String), String> {
    let reference = arg(args, "ref").to_string();
    let down = arg(args, "direction") != "up";
    let page = args["page"].as_bool().unwrap_or(false);
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let r = reference.clone();
    let by_pattern = uia::run(move |u| u.scroll(&r, down, page))?;
    if !by_pattern {
        needs_desktop("desplazar con la rueda del mouse")?;
        let r = reference.clone();
        let (x, y) = uia::run(move |u| u.point(&r))?;
        win::focus(w.hwnd)?;
        let notches = if page { 5 } else { 2 };
        win::wheel(x, y, if down { -notches } else { notches })?;
    }
    Ok((text(format!("Desplacé hacia {}. Pedí un snapshot para ver lo nuevo.", if down { "abajo" } else { "arriba" })), format!("scroll · {}", w.title)))
}

fn do_screenshot(args: &Value) -> Result<(ToolResult, String), String> {
    needs_desktop("capturar la pantalla")?;
    let query = arg(args, "window");
    let (shot, key, label) = if query.is_empty() {
        (win::capture_screen()?, 0isize, "toda la pantalla".to_string())
    } else {
        let w = resolve_window(query)?;
        allowed(&w)?;
        (win::capture_window(w.hwnd)?, w.hwnd, format!("«{}»", w.title))
    };
    let encoded = win::encode(&shot, SHOT_SIDE, 75)?;
    remember_frame(key, Frame { origin: shot.origin, scale: encoded.scale });
    let data = base64::engine::general_purpose::STANDARD.encode(&encoded.jpeg);
    let info = format!(
        "Captura de {} ({}x{} px). Para click_xy usá coordenadas de esta imagen{}.",
        label,
        encoded.width,
        encoded.height,
        if key == 0 { " con window vacío no se puede: capturá una ventana" } else { "" }
    );
    Ok((
        ToolResult { content: vec![json!({ "type": "image", "data": data, "mimeType": "image/jpeg" }), json!({ "type": "text", "text": info })], error: false },
        format!("capturó {}", label),
    ))
}

fn do_click_xy(args: &Value) -> Result<(ToolResult, String), String> {
    needs_desktop("hacer clic por coordenadas")?;
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let frame = frame_of(w.hwnd).ok_or("primero pedí screenshot de esa ventana: las coordenadas tienen que ser de esa imagen")?;
    let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) else { return Err("faltan x e y".into()) };
    let sx = frame.origin.0 + (x / frame.scale).round() as i32;
    let sy = frame.origin.1 + (y / frame.scale).round() as i32;
    let bounds = win::bounds(w.hwnd);
    if !bounds.contains(sx, sy) {
        return Err(format!("({}, {}) cae fuera de la ventana: revisá la captura", x, y));
    }
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    win::focus(w.hwnd)?;
    win::click(sx, sy, button_of(args), args["double"].as_bool().unwrap_or(false))?;
    let target = describe_target(args, &format!("({}, {})", x, y));
    Ok((after_action(&w, &before, format!("Clic por coordenadas en {}.", target)), format!("clic en {} · {}", target, w.title)))
}

fn do_focus(args: &Value) -> Result<(ToolResult, String), String> {
    needs_desktop("traer ventanas al frente")?;
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    win::focus(w.hwnd)?;
    Ok((after_action(&w, &before, format!("«{}» está al frente.", w.title)), format!("trajo al frente «{}»", w.title)))
}

fn do_close(args: &Value) -> Result<(ToolResult, String), String> {
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    let hwnd = w.hwnd;
    let by_pattern = uia::run(move |u| u.close_window(hwnd)).unwrap_or(false);
    if !by_pattern && !win::post_close(hwnd) {
        return Err("Windows no aceptó cerrar esa ventana".into());
    }
    Ok((after_action(&w, &before, format!("Pedí cerrar «{}».", w.title)), format!("cerró «{}»", w.title)))
}

fn do_launch(args: &Value) -> Result<(ToolResult, String), String> {
    let target = arg(args, "app").to_string();
    if target.is_empty() {
        return Err("falta qué abrir".into());
    }
    let lower = target.to_lowercase();
    let forbidden = ["cmd", "powershell", "pwsh", "wt", "regedit", "taskmgr", "mmc", "control"];
    if forbidden.iter().any(|f| lower == *f || lower == format!("{}.exe", f) || lower.ends_with(&format!("\\{}.exe", f))) {
        return Err("no abro consolas ni herramientas del sistema desde el escritorio: para comandos usá la herramienta bash".into());
    }
    let before: Vec<isize> = win::windows().iter().map(|x| x.hwnd).collect();
    win::launch(&target, arg(args, "args"))?;
    let mut opened: Option<WinInfo> = None;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        let now = win::windows();
        if let Some(w) = now.iter().filter(|w| !before.contains(&w.hwnd)).max_by_key(|w| w.foreground) {
            opened = Some(w.clone());
            break;
        }
    }
    let summary = format!("abrió «{}»", target);
    match opened {
        Some(w) => {
            if let Err(e) = allowed(&w) {
                return Ok((text(format!("Se abrió {}, pero {}", window_line(&w), e)), summary));
            }
            std::thread::sleep(Duration::from_millis(600));
            let tree = snapshot_text(&w, None, AFTER_MAX).unwrap_or_else(|e| format!("(no pude leerla todavía: {})", e));
            Ok((text(format!("Se abrió {}\n\n{}", window_line(&w), tree)), summary))
        }
        None => Ok((
            text(format!("Pedí abrir «{}», pero no apareció una ventana nueva en 10 segundos (puede que la app ya estuviera abierta o tarde más). Ventanas:\n{}", target, windows_text(&win::windows()))),
            summary,
        )),
    }
}

pub fn windows_json() -> Value {
    let list: Vec<Value> = win::windows()
        .iter()
        .map(|w| {
            json!({
                "id": format!("w{}", w.hwnd),
                "title": w.title,
                "process": w.process,
                "foreground": w.foreground,
                "minimized": w.minimized,
                "blocked": blocked_reason(w).is_some(),
            })
        })
        .collect();
    json!(list)
}

pub fn screen_jpeg(window: Option<&str>, max_side: u32) -> Result<Vec<u8>, String> {
    if !crate::machine::interactive() {
        return Err("La PC está bloqueada: Windows no deja capturar la pantalla.".into());
    }
    let shot = match window.filter(|w| !w.is_empty()) {
        Some(q) => {
            let w = resolve_window(q)?;
            win::capture_window(w.hwnd)?
        }
        None => win::capture_screen()?,
    };
    Ok(win::encode(&shot, max_side.clamp(320, 2560), 70)?.jpeg)
}
