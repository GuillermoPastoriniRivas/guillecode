use super::ocr;
use super::stream::clipboard;
use super::uia::{self, Change, Delta};
use super::win::{self, Button, Rect, WinInfo};
use super::{blocked_reason, gate, listed_reason, record, ToolResult};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const SNAPSHOT_MAX: usize = 350;
const AFTER_MAX: usize = 220;
const POPUP_MAX: usize = 120;
const DEPTH: usize = 40;
const SHOT_SIDE: u32 = 1280;
const READ_MAX: i32 = 20000;
const FIND_MAX: usize = 25;
const WAIT_DEFAULT: u64 = 15;
const WAIT_MAX: u64 = 90;
const OCR_LINES: usize = 150;
const OCR_HITS: usize = 20;
const CLIPBOARD_MAX: usize = 20000;
const STEPS_MAX: usize = 20;
const ZOOM_MAX: f64 = 3.0;

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

#[derive(Clone)]
struct TextRef {
    window: isize,
    offset: Rect,
    text: String,
}

#[derive(Default)]
struct Texts {
    refs: HashMap<String, TextRef>,
    next: u64,
}

fn texts() -> &'static Mutex<Texts> {
    static TEXTS: OnceLock<Mutex<Texts>> = OnceLock::new();
    TEXTS.get_or_init(|| Mutex::new(Texts::default()))
}

struct Acted {
    window: WinInfo,
    before: Vec<isize>,
    done: String,
    summary: String,
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
    let reference = "La ref del elemento: [eN] de snapshot o find, o [tN] de screen_text (ej. «e14», «t3»).";
    let element = "Descripción corta del elemento para el registro que ve el usuario (ej. «botón Guardar»).";
    let button = json!({ "type": "string", "enum": ["left", "right", "middle"], "description": "Botón (por defecto left). right abre el menú contextual." });
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
            "Árbol de accesibilidad de una ventana: cada control con rol, nombre, valor, estado y una ref [eN] para actuar sobre él. Es la forma principal de ver una app: más rápida y precisa que una captura. Una ref sigue valiendo mientras el elemento exista; después de cada acción recibís solo lo que cambió.",
            json!({
                "window": prop("string", window),
                "root": prop("string", "Opcional: ref de un contenedor para ver solo esa parte cuando la ventana es muy grande."),
                "max_elements": prop("integer", "Opcional: tope de elementos (por defecto 350)."),
            }),
            &["window"],
            true,
        ),
        tool(
            "find",
            "Busca elementos en una ventana por texto (nombre, id o valor, sin distinguir mayúsculas) y/o por rol, sin recorrer todo el árbol, y devuelve sus refs. Usalo en ventanas grandes (Excel, Outlook, el Explorador) o cuando el snapshot sale recortado.",
            json!({
                "window": prop("string", window),
                "text": prop("string", "Texto a buscar (alcanza con una parte)."),
                "role": prop("string", "Opcional: rol exacto, ej. «button», «edit», «listitem», «menuitem», «hyperlink», «checkbox», «tabitem»."),
                "max": prop("integer", "Opcional: tope de resultados (por defecto 25)."),
            }),
            &["window"],
            true,
        ),
        tool(
            "click",
            "Activa un elemento por su ref. Con [eN] usa accesibilidad (invocar, marcar, seleccionar, desplegar), que funciona con la PC bloqueada y sin mover el mouse; si el control no lo permite, hace clic real. Con [tN] (de screen_text) hace clic real con el mouse en el centro de ese texto. Devuelve lo que cambió en la ventana.",
            json!({
                "ref": prop("string", reference),
                "element": prop("string", element),
                "button": button,
                "double": prop("boolean", "Doble clic (necesita la sesión desbloqueada)."),
            }),
            &["ref"],
            false,
        ),
        tool(
            "type",
            "Escribe texto. Con ref [eN]: mode «replace» (por defecto) reemplaza el contenido del campo; «append» agrega al final y conserva lo que había (para documentos; empezá el texto con un salto de línea si querés una línea nueva); «insert» escribe donde está el cursor. Sin ref: escribe donde está el foco de la ventana (window, o la del frente); sirve en apps sin árbol de accesibilidad, después de un click. Cuando escribe con el teclado, pega el texto con Ctrl+V y deja el portapapeles como estaba. Devuelve lo que cambió.",
            json!({
                "ref": prop("string", "Opcional: ref [eN] del campo."),
                "text": prop("string", "El texto a escribir."),
                "mode": { "type": "string", "enum": ["replace", "append", "insert"], "description": "Cómo escribir cuando hay ref (por defecto replace)." },
                "window": prop("string", "Opcional, solo sin ref: la ventana donde teclear."),
                "submit": prop("boolean", "Apretar Enter después (necesita la sesión desbloqueada)."),
                "keystrokes": prop("boolean", "Tipear tecla por tecla en vez de pegar con Ctrl+V. Solo para apps que no aceptan pegar (algunas consolas o juegos)."),
                "element": prop("string", element),
            }),
            &["text"],
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
            "Aprieta teclas o atajos en la ventana indicada (o en la que está al frente). Formato: «ctrl+s», «enter», «alt+f4», «ctrl+shift+t»; varias separadas por espacio: «ctrl+a delete». Para escribir texto usá type. Necesita la sesión desbloqueada.",
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
            "Desplaza el contenido del elemento (o de su contenedor más cercano) para ver lo que está fuera de vista. Devuelve lo que apareció y lo que salió de la vista.",
            json!({
                "ref": prop("string", reference),
                "direction": { "type": "string", "enum": ["down", "up"] },
                "page": prop("boolean", "Una página entera en vez de un paso."),
            }),
            &["ref", "direction"],
            false,
        ),
        tool(
            "wait",
            "Espera hasta que aparezca (o desaparezca, con gone=true) un texto o elemento en una ventana, o, si pasás solo window, hasta que se abra o se cierre esa ventana. Usalo en vez de pedir snapshots repetidos: cargas, instaladores, exportaciones, diálogos que tardan. También sirve para confirmar que una acción hizo efecto.",
            json!({
                "window": prop("string", "La ventana donde buscar el texto, o la ventana a esperar (parte del título o nombre de la app)."),
                "text": prop("string", "Opcional: texto o nombre del elemento a esperar dentro de la ventana."),
                "gone": prop("boolean", "Esperar a que desaparezca en vez de a que aparezca."),
                "timeout": prop("integer", "Segundos (por defecto 15, máximo 90)."),
            }),
            &["window"],
            true,
        ),
        tool(
            "screenshot",
            "Captura una ventana (o toda la pantalla si no pasás window) para verificar cómo se ve o cuando el árbol de accesibilidad no alcanza. Con region hace zoom en una zona de la última captura de esa ventana. Necesita la sesión desbloqueada. Las coordenadas de click_xy son las de la última imagen.",
            json!({
                "window": prop("string", window),
                "region": {
                    "type": "object",
                    "description": "Opcional: zona a ampliar (hasta ×3), en píxeles de la última captura de esa ventana.",
                    "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "width": { "type": "number" }, "height": { "type": "number" } },
                    "required": ["x", "y", "width", "height"],
                },
            }),
            &[],
            true,
        ),
        tool(
            "screen_text",
            "Lee con OCR el texto visible de una ventana, también en apps sin árbol de accesibilidad (canvas, escritorio remoto, juegos, PDFs escaneados), y da una ref [tN] por cada bloque de texto. Hacé click con esa ref para tocar ese texto con el mouse: es más preciso que click_xy. Con find devuelve solo los bloques que contienen ese texto. Trae la ventana al frente y necesita la sesión desbloqueada.",
            json!({ "window": prop("string", window), "find": prop("string", "Opcional: texto a ubicar (sin distinguir mayúsculas ni tildes).") }),
            &["window"],
            true,
        ),
        tool(
            "click_xy",
            "Último recurso: clic en coordenadas de la última captura de esa ventana (x, y en píxeles de la imagen). Antes probá con refs o con screen_text. Necesita la sesión desbloqueada.",
            json!({
                "window": prop("string", window),
                "x": prop("number", "X en la imagen."),
                "y": prop("number", "Y en la imagen."),
                "button": button,
                "double": prop("boolean", "Doble clic."),
                "element": prop("string", element),
            }),
            &["window", "x", "y"],
            false,
        ),
        tool(
            "clipboard",
            "Lee o escribe el texto del portapapeles de la PC. Para pegar texto largo: write y después press_key «ctrl+v». Para sacar datos de una app que no expone su texto: seleccionarlo, press_key «ctrl+c» y read.",
            json!({ "action": { "type": "string", "enum": ["read", "write"] }, "text": prop("string", "El texto, solo con write.") }),
            &["action"],
            false,
        ),
        tool(
            "steps",
            "Hace varias acciones seguidas en una sola llamada, por ejemplo completar un formulario. Cada acción es un objeto con «do» (click, type, select, press_key, scroll, click_xy, wait o clipboard) y los mismos parámetros de esa herramienta. Usá refs del último resultado. Se detiene en el primer error y al final devuelve lo que cambió.",
            json!({
                "actions": {
                    "type": "array",
                    "maxItems": STEPS_MAX,
                    "items": {
                        "type": "object",
                        "properties": { "do": { "type": "string", "enum": ["click", "type", "select", "press_key", "scroll", "click_xy", "wait", "clipboard"] } },
                        "required": ["do"],
                    },
                    "description": "Ej.: [{\"do\":\"type\",\"ref\":\"e12\",\"text\":\"Ana\"},{\"do\":\"click\",\"ref\":\"e15\"}]",
                },
            }),
            &["actions"],
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
    let matches = matching(&list, q);
    match matches.as_slice() {
        [] => Err(format!("no hay ninguna ventana que coincida con «{}». Ventanas abiertas:\n{}", q, windows_text(&list))),
        [one] => Ok((*one).clone()),
        many => Ok(many.iter().find(|w| w.foreground).copied().unwrap_or(many[0]).clone()),
    }
}

fn matching<'a>(list: &'a [WinInfo], query: &str) -> Vec<&'a WinInfo> {
    let q = query.trim();
    if let Some(id) = q.strip_prefix('w').and_then(|n| n.parse::<isize>().ok()) {
        return list.iter().filter(|w| w.hwnd == id).collect();
    }
    let lower = q.to_lowercase();
    list.iter()
        .filter(|w| w.title.to_lowercase().contains(&lower) || w.process.to_lowercase() == lower || w.process.to_lowercase().trim_end_matches(".exe") == lower)
        .collect()
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

fn header(w: &WinInfo) -> String {
    format!("Ventana w{} \"{}\" ({})", w.hwnd, w.title.replace('"', "'"), w.process)
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
        "No puedo {}: la PC está bloqueada (o hay un aviso de UAC), así que Windows no acepta mouse ni teclado simulados. Seguí con acciones por accesibilidad (click, type, select, read, snapshot, find) o pedile al usuario que desbloquee la PC.",
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
    let tree = uia::run(move |u| u.snapshot(hwnd, root.as_deref(), max, DEPTH))?;
    Ok(format!("{}\n{}", header(window), tree.render(max)))
}

fn window_changes(window: &WinInfo) -> String {
    let hwnd = window.hwnd;
    match uia::run(move |u| u.changes(hwnd, SNAPSHOT_MAX, DEPTH)) {
        Ok(Change::Delta(Delta::Same, _)) => format!("{}: sin cambios en el árbol de accesibilidad.", header(window)),
        Ok(Change::Delta(Delta::Few(diff), _)) => format!("{} — cambios desde el último vistazo (+ nuevo, ~ cambió, - ya no está; las demás refs siguen valiendo):\n{}", header(window), diff),
        Ok(Change::Delta(Delta::Many, tree)) | Ok(Change::Full(tree)) => format!("{}\n{}", header(window), tree.render(AFTER_MAX)),
        Err(e) => format!("(No pude leer la ventana después de actuar: {})", e),
    }
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
        Some(t) => {
            out.push_str("\n\n");
            out.push_str(&window_changes(&t));
        }
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

fn snapshot_ids() -> Vec<isize> {
    win::windows().iter().map(|x| x.hwnd).collect()
}

fn text_key(reference: &str) -> Option<String> {
    let key = reference.trim().trim_start_matches('[').trim_end_matches(']').trim();
    let digits = key.strip_prefix('t')?;
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| key.to_string())
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> ToolResult {
    win::physical_thread();
    if name != "status" {
        if let Err(e) = gate(app) {
            return fail(e);
        }
    }
    let (result, summary) = dispatch(app, name, args);
    if !matches!(name, "status" | "windows" | "steps") {
        record(app, "desktop", name, &summary, !result.error);
    }
    result
}

fn dispatch(app: &AppHandle, name: &str, args: &Value) -> (ToolResult, String) {
    let outcome = match name {
        "status" => Ok((status_text(app), String::new())),
        "windows" => Ok((text(windows_text(&win::windows())), String::new())),
        "snapshot" => do_snapshot(args),
        "find" => do_find(args),
        "read" => do_read(args),
        "wait" => do_wait(args),
        "screenshot" => do_screenshot(args),
        "screen_text" => do_screen_text(args),
        "clipboard" => do_clipboard(args),
        "steps" => do_steps(app, args),
        "launch" => do_launch(args),
        other => act(other, args).map(|a| {
            let summary = a.summary.clone();
            (after_action(&a.window, &a.before, a.done), summary)
        }),
    };
    match outcome {
        Ok((result, summary)) => (result, summary),
        Err(e) => (fail(e), format!("{} falló", name)),
    }
}

fn act(name: &str, args: &Value) -> Result<Acted, String> {
    match name {
        "click" => act_click(args),
        "type" => act_type(args),
        "select" => act_select(args),
        "press_key" => act_press(args),
        "scroll" => act_scroll(args),
        "click_xy" => act_click_xy(args),
        "focus_window" => act_focus(args),
        "close_window" => act_close(args),
        other => Err(format!("no existe la herramienta «{}»", other)),
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
                "BLOQUEADA → no hay mouse, teclado, capturas ni OCR; usá snapshot/find/click/type/select/read (accesibilidad)"
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

fn do_find(args: &Value) -> Result<(ToolResult, String), String> {
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let needle = arg(args, "text").to_string();
    let role = arg(args, "role").to_string();
    if needle.is_empty() && role.is_empty() {
        return Err("pasá text, role o los dos".into());
    }
    let max = args["max"].as_u64().map(|n| n.clamp(1, 100) as usize).unwrap_or(FIND_MAX);
    let hwnd = w.hwnd;
    let (n, r) = (needle.clone(), role.clone());
    let (lines, total) = uia::run(move |u| u.find(hwnd, &n, &r, max))?;
    let what = match (needle.is_empty(), role.is_empty()) {
        (false, false) => format!("«{}» con rol {}", needle, role),
        (false, true) => format!("«{}»", needle),
        _ => format!("rol {}", role),
    };
    let summary = format!("buscó {} · {}", what, w.title);
    if total == 0 {
        return Ok((text(format!("No encontré elementos con {} en «{}». Si la app no expone su interfaz por accesibilidad, probá screen_text.", what, w.title)), summary));
    }
    let more = if total > lines.len() { format!(" (muestro {}; afiná la búsqueda o pasá max)", lines.len()) } else { String::new() };
    Ok((text(format!("{} elemento(s) con {} en «{}»{}:\n{}", total, what, w.title, more, lines.join("\n"))), summary))
}

fn act_click(args: &Value) -> Result<Acted, String> {
    let reference = arg(args, "ref").to_string();
    if let Some(key) = text_key(&reference) {
        return act_click_text(args, &key);
    }
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let label = {
        let r = reference.clone();
        uia::run(move |u| Ok(u.label(&r)))?
    };
    let target = describe_target(args, &label);
    let summary = format!("clic en {} · {}", target, w.title);
    let before = snapshot_ids();
    let button = button_of(args);
    let double = args["double"].as_bool().unwrap_or(false);
    if matches!(button, Button::Left) && !double {
        let r = reference.clone();
        if let Some(done) = uia::run(move |u| u.activate(&r))? {
            let note = if done.pending { " (la app sigue procesando: probablemente abrió un diálogo)" } else { "" };
            return Ok(Acted { window: w, before, done: format!("Hecho por accesibilidad ({}) sobre {}{}.", done.method, target, note), summary });
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
    Ok(Acted { window: w, before, done: format!("Clic con el mouse en {} ({}, {}).", target, x, y), summary })
}

fn act_click_text(args: &Value, key: &str) -> Result<Acted, String> {
    needs_desktop("hacer clic sobre un texto de la pantalla")?;
    let found = texts().lock().unwrap().refs.get(key).cloned();
    let tref = found.ok_or_else(|| format!("no conozco la ref de texto «{}»: pedí screen_text de nuevo", key))?;
    let w = win::window(tref.window).ok_or("la ventana de ese texto ya no existe: pedí `windows`")?;
    allowed(&w)?;
    let before = snapshot_ids();
    win::focus(w.hwnd)?;
    let bounds = win::bounds(w.hwnd);
    let area = Rect { left: bounds.left + tref.offset.left, top: bounds.top + tref.offset.top, right: bounds.left + tref.offset.right, bottom: bounds.top + tref.offset.bottom };
    let (x, y) = area.center();
    if !bounds.contains(x, y) || !win::on_screen(x, y) {
        return Err("ese texto quedó fuera de la ventana: pedí screen_text de nuevo".into());
    }
    if win::window_at(x, y) != win::root_of(w.hwnd) {
        return Err("hay otra ventana tapando ese texto: traé la ventana al frente o pedí screen_text de nuevo".into());
    }
    win::click(x, y, button_of(args), args["double"].as_bool().unwrap_or(false))?;
    let target = describe_target(args, &format!("«{}»", tref.text));
    Ok(Acted { window: w.clone(), before, done: format!("Clic con el mouse sobre el texto {}.", target), summary: format!("clic en {} · {}", target, w.title) })
}

fn act_type(args: &Value) -> Result<Acted, String> {
    let reference = arg(args, "ref").to_string();
    let content = args["text"].as_str().unwrap_or("").to_string();
    let submit = args["submit"].as_bool().unwrap_or(false);
    let mode = arg(args, "mode").to_lowercase();
    let keystrokes = args["keystrokes"].as_bool().unwrap_or(false);
    if reference.is_empty() {
        return act_type_at_focus(args, &content, submit, keystrokes);
    }
    if text_key(&reference).is_some() {
        return Err("type necesita una ref de accesibilidad [eN]: para escribir sobre un texto de la pantalla, hacé click en la ref [tN] y después type sin ref".into());
    }
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let (label, role) = {
        let r = reference.clone();
        uia::run(move |u| Ok((u.label(&r), u.role(&r).unwrap_or_default())))?
    };
    let target = describe_target(args, &label);
    let summary = format!("escribió en {} · {}", target, w.title);
    let before = snapshot_ids();
    let mut done = match mode.as_str() {
        "append" => append_text(&w, &reference, &content, &target, keystrokes)?,
        "insert" => {
            needs_desktop("escribir en la posición del cursor")?;
            win::focus(w.hwnd)?;
            let r = reference.clone();
            uia::run(move |u| u.focus(&r))?;
            std::thread::sleep(Duration::from_millis(80));
            enter_text(&content, keystrokes)?;
            format!("Escribí en la posición del cursor de {}.", target)
        }
        "" | "replace" => {
            if role == "document" && mode.is_empty() {
                let r = reference.clone();
                let current = uia::run(move |u| Ok(u.value(&r)))?.unwrap_or_default();
                if !current.trim().is_empty() {
                    return Err(format!(
                        "{} ya tiene texto ({} caracteres) y escribir sin mode lo reemplazaría entero. Revisá en el título de la ventana que sea el documento correcto. Usá mode «append» para agregar al final, «insert» para escribir donde está el cursor, o «replace» si de verdad querés reemplazar todo.",
                        target,
                        current.chars().count()
                    ));
                }
            }
            replace_text(&w, &reference, &content, &target, &role, mode == "replace", keystrokes)?
        }
        other => return Err(format!("mode «{}» no existe: usá replace, append o insert", other)),
    };
    if submit {
        needs_desktop("apretar Enter")?;
        let r = reference.clone();
        let _ = uia::run(move |u| u.focus(&r));
        win::press("enter")?;
        done.push_str(" Apreté Enter.");
    }
    Ok(Acted { window: w, before, done, summary })
}

fn replace_text(w: &WinInfo, reference: &str, content: &str, target: &str, role: &str, explicit: bool, keystrokes: bool) -> Result<String, String> {
    let (r, c) = (reference.to_string(), crlf(content));
    let by_pattern = uia::run(move |u| u.set_value(&r, &c))?;
    let keyboard = |why: &str| -> Result<String, String> {
        if role == "document" && !explicit {
            return Err(format!(
                "{} es un documento y no acepta texto por accesibilidad: escribir con el teclado borraría todo su contenido. Usá mode «append» para agregar al final, «insert» para escribir donde está el cursor, o «replace» si de verdad querés reemplazar todo.",
                target
            ));
        }
        needs_desktop(why)?;
        type_with_keyboard(w, reference, content, keystrokes)?;
        Ok(format!("Escribí con el teclado en {}.", target))
    };
    match by_pattern {
        Some(_) => {
            let r = reference.to_string();
            match uia::run(move |u| Ok(u.value(&r)))? {
                Some(v) if same_text(&v, content) || content.is_empty() => Ok(format!("Escribí por accesibilidad en {}.", target)),
                Some(_) => keyboard("escribir con el teclado (el campo no aceptó el valor por accesibilidad)"),
                None => Ok(format!("Escribí por accesibilidad en {}.", target)),
            }
        }
        None => keyboard("escribir con el teclado (el campo no acepta texto por accesibilidad)"),
    }
}

fn append_text(w: &WinInfo, reference: &str, content: &str, target: &str, keystrokes: bool) -> Result<String, String> {
    if crate::machine::interactive() {
        win::focus(w.hwnd)?;
        let r = reference.to_string();
        uia::run(move |u| u.focus(&r))?;
        std::thread::sleep(Duration::from_millis(80));
        win::press("ctrl+end")?;
        enter_text(content, keystrokes)?;
        return Ok(format!("Agregué el texto al final de {} con el teclado.", target));
    }
    let r = reference.to_string();
    let current = uia::run(move |u| Ok(u.value(&r)))?.ok_or("La PC está bloqueada y ese control no permite agregar texto por accesibilidad: pedile al usuario que la desbloquee.")?;
    if current.chars().count() > 100_000 {
        return Err("El contenido es demasiado largo para agregarle texto por accesibilidad con la PC bloqueada.".into());
    }
    let expected = format!("{}{}", current.replace("\r\n", "\n").replace('\r', "\n"), content);
    let (r, c) = (reference.to_string(), crlf(&expected));
    if uia::run(move |u| u.set_value(&r, &c))?.is_none() {
        return Err("ese control no permite agregar texto por accesibilidad".into());
    }
    let r = reference.to_string();
    match uia::run(move |u| Ok(u.value(&r)))? {
        Some(v) if same_text(&v, &expected) => Ok(format!("Agregué el texto al final de {} por accesibilidad.", target)),
        _ => Err(format!("Intenté agregar el texto en {} pero no pude verificar el resultado: leelo con read antes de seguir.", target)),
    }
}

fn act_type_at_focus(args: &Value, content: &str, submit: bool, keystrokes: bool) -> Result<Acted, String> {
    needs_desktop("teclear")?;
    let w = if arg(args, "window").is_empty() {
        win::window(win::foreground()).ok_or("no hay ninguna ventana al frente")?
    } else {
        resolve_window(arg(args, "window"))?
    };
    allowed(&w)?;
    let before = snapshot_ids();
    if !w.foreground {
        win::focus(w.hwnd)?;
    }
    enter_text(content, keystrokes)?;
    let mut done = format!("Tecleé {} caracteres en «{}», donde estaba el cursor.", content.chars().count(), w.title);
    if submit {
        win::press("enter")?;
        done.push_str(" Apreté Enter.");
    }
    let summary = format!("tecleó «{}» · {}", content.chars().take(40).collect::<String>(), w.title);
    Ok(Acted { window: w, before, done, summary })
}

fn crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn same_text(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace("\r\n", "\n").replace('\r', "\n").trim_end().to_string();
    norm(a) == norm(b)
}

fn type_with_keyboard(w: &WinInfo, reference: &str, content: &str, keystrokes: bool) -> Result<(), String> {
    win::focus(w.hwnd)?;
    let r = reference.to_string();
    uia::run(move |u| u.focus(&r))?;
    std::thread::sleep(Duration::from_millis(80));
    win::press("ctrl+a")?;
    if content.is_empty() {
        return win::press("delete");
    }
    enter_text(content, keystrokes)
}

fn enter_text(content: &str, keystrokes: bool) -> Result<(), String> {
    if keystrokes || content.chars().count() <= 1 {
        return win::type_text(content);
    }
    let saved = clipboard::save().ok();
    clipboard::write(content)?;
    std::thread::sleep(Duration::from_millis(40));
    let pasted = win::press("ctrl+v");
    std::thread::sleep(Duration::from_millis(400));
    if let Some(previous) = saved {
        let _ = clipboard::restore(previous);
    }
    pasted
}

fn act_select(args: &Value) -> Result<Acted, String> {
    let reference = arg(args, "ref").to_string();
    let option = arg(args, "option").to_string();
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let summary = format!("eligió «{}» · {}", option, w.title);
    let before = snapshot_ids();
    let (r, o) = (reference.clone(), option.clone());
    let chosen = uia::run(move |u| u.select_option(&r, &o))?;
    Ok(Acted { window: w, before, done: format!("Elegí «{}».", chosen), summary })
}

fn act_press(args: &Value) -> Result<Acted, String> {
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
    let before = snapshot_ids();
    if !w.foreground {
        win::focus(w.hwnd)?;
    }
    win::press(&keys)?;
    let summary = format!("teclas {} · {}", keys, w.title);
    Ok(Acted { done: format!("Apreté {} en «{}».", keys, w.title), window: w, before, summary })
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

fn act_scroll(args: &Value) -> Result<Acted, String> {
    let reference = arg(args, "ref").to_string();
    let down = arg(args, "direction") != "up";
    let page = args["page"].as_bool().unwrap_or(false);
    let w = window_of_ref(&reference)?;
    allowed(&w)?;
    let before = snapshot_ids();
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
    let summary = format!("scroll · {}", w.title);
    Ok(Acted { done: format!("Desplacé hacia {}.", if down { "abajo" } else { "arriba" }), window: w, before, summary })
}

fn do_wait(args: &Value) -> Result<(ToolResult, String), String> {
    let query = arg(args, "window").to_string();
    let needle = arg(args, "text").to_string();
    let gone = args["gone"].as_bool().unwrap_or(false);
    let limit = Duration::from_secs(args["timeout"].as_u64().unwrap_or(WAIT_DEFAULT).clamp(1, WAIT_MAX));
    if query.is_empty() {
        return Err("falta window: la ventana a esperar o donde buscar el texto".into());
    }
    let start = Instant::now();
    let seconds = |s: Instant| format!("{:.1} s", s.elapsed().as_secs_f64());
    if needle.is_empty() {
        loop {
            let list = win::windows();
            let found: Vec<WinInfo> = matching(&list, &query).into_iter().cloned().collect();
            if gone && found.is_empty() {
                return Ok((text(format!("Se cerró «{}» (esperé {}).", query, seconds(start))), format!("esperó que se cierre «{}»", query)));
            }
            if !gone {
                if let Some(w) = found.iter().find(|w| w.foreground).or(found.first()) {
                    let summary = format!("esperó «{}»", w.title);
                    if let Err(reason) = allowed(w) {
                        return Ok((text(format!("Apareció {} (esperé {}), pero {}", window_line(w), seconds(start), reason)), summary));
                    }
                    let tree = snapshot_text(w, None, AFTER_MAX).unwrap_or_else(|e| format!("(no pude leerla todavía: {})", e));
                    return Ok((text(format!("Apareció {} (esperé {}).\n\n{}", window_line(w), seconds(start), tree)), summary));
                }
            }
            if start.elapsed() >= limit {
                return Err(if gone {
                    format!("Pasaron {} s y «{}» sigue abierta.", limit.as_secs(), query)
                } else {
                    format!("Pasaron {} s y no apareció ninguna ventana que coincida con «{}». Ventanas:\n{}", limit.as_secs(), query, windows_text(&list))
                });
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    let w = resolve_window(&query)?;
    allowed(&w)?;
    let summary = format!("esperó «{}» · {}", needle, w.title);
    loop {
        if !win::exists(w.hwnd) {
            return Err(format!("La ventana «{}» se cerró mientras esperaba «{}».", w.title, needle));
        }
        let (hwnd, n) = (w.hwnd, needle.clone());
        let found = uia::run(move |u| u.present(hwnd, &n))?;
        match (&found, gone) {
            (Some(line), false) => return Ok((text(format!("Apareció en «{}» después de {}:\n{}", w.title, seconds(start), line)), summary)),
            (None, true) => return Ok((text(format!("«{}» ya no está en «{}» ({}).", needle, w.title, seconds(start))), summary)),
            _ => {}
        }
        if start.elapsed() >= limit {
            return Err(if gone {
                format!("Pasaron {} s y «{}» sigue en «{}».", limit.as_secs(), needle, w.title)
            } else {
                format!("Pasaron {} s y «{}» no apareció en «{}». Si es texto dentro de un documento o de una imagen, probá read o screen_text.", limit.as_secs(), needle, w.title)
            });
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn do_screenshot(args: &Value) -> Result<(ToolResult, String), String> {
    needs_desktop("capturar la pantalla")?;
    let query = arg(args, "window");
    let region = &args["region"];
    let (encoded, key, label, origin) = if region.is_object() {
        if query.is_empty() {
            return Err("region necesita window: el zoom es sobre la última captura de esa ventana".into());
        }
        let w = resolve_window(query)?;
        allowed(&w)?;
        let frame = frame_of(w.hwnd).ok_or("primero pedí screenshot de esa ventana sin region: la zona se mide sobre esa imagen")?;
        let num = |k: &str| region[k].as_f64().filter(|v| v.is_finite());
        let (Some(x), Some(y), Some(rw), Some(rh)) = (num("x"), num("y"), num("width"), num("height")) else { return Err("region necesita x, y, width y height".into()) };
        if rw <= 0.0 || rh <= 0.0 {
            return Err("width y height de region tienen que ser mayores que 0".into());
        }
        let area = Rect {
            left: frame.origin.0 + (x / frame.scale).floor() as i32,
            top: frame.origin.1 + (y / frame.scale).floor() as i32,
            right: frame.origin.0 + ((x + rw) / frame.scale).ceil() as i32,
            bottom: frame.origin.1 + ((y + rh) / frame.scale).ceil() as i32,
        };
        let shot = win::capture_window(w.hwnd)?;
        let part = win::crop(&shot, area).ok_or("esa zona cae fuera de la ventana: revisá la captura")?;
        let encoded = win::encode_zoomed(&part, SHOT_SIDE, 80, ZOOM_MAX)?;
        let label = format!("una zona de «{}» (×{:.1})", w.title, encoded.scale);
        (encoded, w.hwnd, label, part.origin)
    } else if query.is_empty() {
        let shot = win::capture_screen()?;
        (win::encode(&shot, SHOT_SIDE, 75)?, 0isize, "toda la pantalla".to_string(), shot.origin)
    } else {
        let w = resolve_window(query)?;
        allowed(&w)?;
        let shot = win::capture_window(w.hwnd)?;
        (win::encode(&shot, SHOT_SIDE, 75)?, w.hwnd, format!("«{}»", w.title), shot.origin)
    };
    remember_frame(key, Frame { origin, scale: encoded.scale });
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

fn do_screen_text(args: &Value) -> Result<(ToolResult, String), String> {
    needs_desktop("leer el texto de la pantalla")?;
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    if !w.foreground {
        win::focus(w.hwnd)?;
        std::thread::sleep(Duration::from_millis(200));
    }
    let shot = win::capture_window(w.hwnd)?;
    let lines = ocr::recognize(&shot)?;
    let bounds = win::bounds(w.hwnd);
    let needle = arg(args, "find").to_string();
    let summary = if needle.is_empty() { format!("leyó la pantalla de «{}»", w.title) } else { format!("buscó «{}» en la pantalla de «{}»", needle, w.title) };
    let mut store = texts().lock().unwrap();
    store.refs.retain(|_, t| t.window != w.hwnd);
    let mut add = |store: &mut Texts, label: &str, rect: Rect| -> String {
        store.next += 1;
        let key = format!("t{}", store.next);
        let offset = Rect { left: rect.left - bounds.left, top: rect.top - bounds.top, right: rect.right - bounds.left, bottom: rect.bottom - bounds.top };
        store.refs.insert(key.clone(), TextRef { window: w.hwnd, offset, text: label.to_string() });
        key
    };
    let listing = |store: &mut Texts, add: &mut dyn FnMut(&mut Texts, &str, Rect) -> String, limit: usize| -> Vec<String> {
        lines
            .iter()
            .take(limit)
            .map(|line| ocr::segments(line).into_iter().map(|(label, rect)| format!("[{}] {}", add(store, &label, rect), label)).collect::<Vec<_>>().join(" · "))
            .collect()
    };
    let hint = "Hacé click con la ref [tN] para tocar el centro de ese texto con el mouse. Las refs de texto valen mientras la ventana no se mueva ni cambie.";
    if lines.is_empty() {
        return Ok((text(format!("No reconocí texto en «{}».", w.title)), summary));
    }
    if !needle.is_empty() {
        let hits = ocr::locate(&lines, &needle);
        if hits.is_empty() {
            let all = listing(&mut store, &mut add, 60);
            return Ok((text(format!("No veo «{}» en «{}». Texto visible:\n{}\n\n{}", needle, w.title, all.join("\n"), hint)), summary));
        }
        let found: Vec<String> = hits.iter().take(OCR_HITS).map(|(label, rect)| format!("[{}] {}", add(&mut store, label, *rect), label)).collect();
        return Ok((text(format!("«{}» aparece {} vez/veces en «{}»:\n{}\n\n{}", needle, hits.len(), w.title, found.join("\n"), hint)), summary));
    }
    let all = listing(&mut store, &mut add, OCR_LINES);
    let more = if lines.len() > OCR_LINES { format!("\n… y {} líneas más: usá find para ubicar un texto.", lines.len() - OCR_LINES) } else { String::new() };
    Ok((text(format!("Texto visible en «{}» (OCR, {} líneas):\n{}{}\n\n{}", w.title, lines.len(), all.join("\n"), more, hint)), summary))
}

fn act_click_xy(args: &Value) -> Result<Acted, String> {
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
    let before = snapshot_ids();
    win::focus(w.hwnd)?;
    if win::window_at(sx, sy) != win::root_of(w.hwnd) {
        return Err("hay otra ventana tapando ese punto: traé la ventana al frente y capturala de nuevo".into());
    }
    win::click(sx, sy, button_of(args), args["double"].as_bool().unwrap_or(false))?;
    let target = describe_target(args, &format!("({}, {})", x, y));
    let summary = format!("clic en {} · {}", target, w.title);
    Ok(Acted { window: w, before, done: format!("Clic por coordenadas en {}.", target), summary })
}

fn do_clipboard(args: &Value) -> Result<(ToolResult, String), String> {
    match arg(args, "action") {
        "read" => {
            let content = clipboard::read()?;
            if content.is_empty() {
                return Ok((text("El portapapeles no tiene texto."), "leyó el portapapeles".into()));
            }
            let total = content.chars().count();
            let mut shown: String = content.chars().take(CLIPBOARD_MAX).collect();
            if total > CLIPBOARD_MAX {
                shown.push_str(&format!("\n… (recortado: el portapapeles tiene {} caracteres)", total));
            }
            Ok((text(shown), "leyó el portapapeles".into()))
        }
        "write" => {
            let content = args["text"].as_str().ok_or("falta text para escribir en el portapapeles")?;
            clipboard::write(content)?;
            Ok((text(format!("Copié {} caracteres al portapapeles. Para pegarlos: press_key «ctrl+v» en la ventana.", content.chars().count())), "copió texto al portapapeles".into()))
        }
        _ => Err("action tiene que ser read o write".into()),
    }
}

fn first_text(result: &ToolResult) -> String {
    result.content.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n")
}

fn do_steps(app: &AppHandle, args: &Value) -> Result<(ToolResult, String), String> {
    let list = args["actions"].as_array().ok_or("falta actions: una lista de acciones")?;
    if list.is_empty() || list.len() > STEPS_MAX {
        return Err(format!("actions tiene que tener entre 1 y {} acciones", STEPS_MAX));
    }
    let before = snapshot_ids();
    let mut log: Vec<String> = Vec::new();
    let mut last: Option<WinInfo> = None;
    let mut failure: Option<String> = None;
    for (i, step) in list.iter().enumerate() {
        let name = arg(step, "do").to_string();
        let outcome: Result<(String, Option<WinInfo>, String), String> = match name.as_str() {
            "click" | "type" | "select" | "press_key" | "scroll" | "click_xy" => act(&name, step).map(|a| (a.done, Some(a.window), a.summary)),
            "wait" => do_wait(step).map(|(r, s)| (first_text(&r), None, s)),
            "clipboard" => do_clipboard(step).map(|(r, s)| (first_text(&r), None, s)),
            other => Err(format!("«{}» no se puede usar en steps", other)),
        };
        match outcome {
            Ok((done, window, summary)) => {
                record(app, "desktop", &name, &summary, true);
                log.push(format!("{}. {}", i + 1, done));
                if window.is_some() {
                    last = window;
                }
            }
            Err(e) => {
                record(app, "desktop", &name, &format!("{} falló", name), false);
                failure = Some(format!("{}. {} falló: {}\nNo hice las {} acciones que faltaban.", i + 1, name, e, list.len() - i - 1));
                break;
            }
        }
        if i + 1 < list.len() {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    let mut done = log.join("\n");
    if let Some(f) = &failure {
        if !done.is_empty() {
            done.push('\n');
        }
        done.push_str(f);
    }
    let mut result = match last {
        Some(w) => after_action(&w, &before, done),
        None => text(done),
    };
    result.error = failure.is_some();
    Ok((result, String::new()))
}

fn act_focus(args: &Value) -> Result<Acted, String> {
    needs_desktop("traer ventanas al frente")?;
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let before = snapshot_ids();
    win::focus(w.hwnd)?;
    let summary = format!("trajo al frente «{}»", w.title);
    Ok(Acted { done: format!("«{}» está al frente.", w.title), window: w, before, summary })
}

fn act_close(args: &Value) -> Result<Acted, String> {
    let w = resolve_window(arg(args, "window"))?;
    allowed(&w)?;
    let before = snapshot_ids();
    let hwnd = w.hwnd;
    let by_pattern = uia::run(move |u| u.close_window(hwnd)).unwrap_or(false);
    if !by_pattern && !win::post_close(hwnd) {
        return Err("Windows no aceptó cerrar esa ventana".into());
    }
    let summary = format!("cerró «{}»", w.title);
    Ok(Acted { done: format!("Pedí cerrar «{}».", w.title), window: w, before, summary })
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
    let before = snapshot_ids();
    let titles: Vec<String> = win::windows().iter().map(|w| w.title.clone()).collect();
    let extra = arg(args, "args").to_string();
    win::launch(&target, &extra)?;
    let hint = [target.as_str(), extra.as_str()]
        .iter()
        .map(|s| s.trim().trim_matches('"'))
        .filter(|s| s.contains('\\') || s.contains('/'))
        .filter_map(|s| std::path::Path::new(s).file_stem().map(|n| n.to_string_lossy().to_lowercase()))
        .find(|n| n.chars().count() >= 3);
    let mut opened: Option<WinInfo> = None;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        let now = win::windows();
        if let Some(w) = now.iter().filter(|w| !before.contains(&w.hwnd)).max_by_key(|w| w.foreground) {
            opened = Some(w.clone());
            break;
        }
        if let Some(name) = &hint {
            if let Some(w) = now.iter().find(|w| w.title.to_lowercase().contains(name.as_str()) && !titles.contains(&w.title)) {
                opened = Some(w.clone());
                break;
            }
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
                "blocked": listed_reason(w).is_some(),
            })
        })
        .collect();
    json!(list)
}

pub fn screen_jpeg(window: Option<&str>, max_side: u32) -> Result<Vec<u8>, String> {
    win::physical_thread();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_refs_are_recognized_with_or_without_brackets() {
        assert_eq!(text_key("t12").as_deref(), Some("t12"));
        assert_eq!(text_key("[t3]").as_deref(), Some("t3"));
        assert_eq!(text_key("e12"), None);
        assert_eq!(text_key("t"), None);
        assert_eq!(text_key("tx1"), None);
    }

    #[test]
    fn newlines_are_sent_as_crlf_and_compared_loosely() {
        assert_eq!(crlf("a\nb\r\nc"), "a\r\nb\r\nc");
        assert!(same_text("a\rb\r", "a\nb"));
    }

    fn out(result: &ToolResult) -> String {
        first_text(result)
    }

    fn reference_in(text: &str, prefix: char) -> String {
        let start = text.find(&format!("[{}", prefix)).expect("sin ref") + 1;
        let end = start + text[start..].find(']').unwrap();
        text[start..end].to_string()
    }

    fn ours(id: &str, stem: &str) {
        let hwnd: isize = id[1..].parse().unwrap();
        let title = win::window(hwnd).map(|w| w.title).unwrap_or_default();
        assert!(title.contains(stem), "la ventana dejó de mostrar el archivo de prueba: «{}»", title);
    }

    fn cleanup(stem: &str) {
        win::physical_thread();
        let file = std::env::temp_dir().join(format!("{}.txt", stem));
        let list = win::windows();
        let Some(w) = list.iter().find(|w| w.title.contains(stem)) else {
            let _ = std::fs::remove_file(&file);
            return;
        };
        let id = format!("w{}", w.hwnd);
        if w.title.starts_with('*') {
            let _ = act("press_key", &json!({ "keys": "ctrl+s", "window": id }));
            std::thread::sleep(Duration::from_millis(1200));
        }
        if win::window(w.hwnd).map(|x| x.title.contains(stem) && !x.title.starts_with('*')).unwrap_or(false) {
            let _ = act("press_key", &json!({ "keys": "ctrl+w", "window": id }));
        }
        std::thread::sleep(Duration::from_millis(800));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    #[ignore]
    fn notepad_cleanup() {
        cleanup(&std::env::var("GC_E2E_STEM").expect("GC_E2E_STEM"));
    }

    #[test]
    #[ignore]
    fn notepad_end_to_end() {
        let stem = format!("guillecode-e2e-{}", uuid::Uuid::new_v4().simple());
        let s = stem.clone();
        let result = std::panic::catch_unwind(move || notepad_flow(&s));
        cleanup(&stem);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    fn notepad_flow(stem: &str) {
        win::physical_thread();
        let stem = stem.to_string();
        let clock = Instant::now();
        let lap = |what: &str, body: &str| println!("\n===== {} ({} ms)\n{}", what, clock.elapsed().as_millis(), body);
        let path = std::env::temp_dir().join(format!("{}.txt", stem));
        std::fs::write(&path, "linea uno\r\n").unwrap();
        let _ = do_launch(&json!({ "app": "notepad", "args": format!("\"{}\"", path.display()) }));
        let (opened, _) = do_wait(&json!({ "window": stem, "timeout": 15 })).unwrap();
        let opened = out(&opened);
        lap("launch + wait", &opened[..opened.len().min(400)]);
        let id = opened.split_whitespace().find(|t| t.starts_with('w') && t.len() > 1 && t[1..].chars().all(|c| c.is_ascii_digit())).unwrap().to_string();
        ours(&id, &stem);
        let (found, _) = do_find(&json!({ "window": id, "role": "document" })).unwrap();
        let found = out(&found);
        lap("find document", &found);
        let doc = reference_in(&found, 'e');
        let refused = act("type", &json!({ "ref": doc, "text": "pisado" }));
        lap("type sin mode sobre documento con texto", &refused.as_ref().err().cloned().unwrap_or_default());
        assert!(refused.is_err());
        ours(&id, &stem);
        let a = act("type", &json!({ "ref": doc, "text": "hola\nmundo", "mode": "replace" })).unwrap();
        lap("type replace", &out(&after_action(&a.window, &a.before, a.done)));
        ours(&id, &stem);
        let user_clipboard = clipboard::save().unwrap();
        clipboard::write("sentinela").unwrap();
        let a = act("type", &json!({ "ref": doc, "text": "\nchau Guardado", "mode": "append" })).unwrap();
        lap("type append", &out(&after_action(&a.window, &a.before, a.done)));
        let kept = clipboard::read().unwrap_or_default();
        clipboard::restore(user_clipboard).unwrap();
        assert_eq!(kept, "sentinela", "pegar no dejó el portapapeles como estaba");
        let (read, _) = do_read(&json!({ "ref": doc })).unwrap();
        let read = out(&read);
        assert!(same_text(&read, "hola\nmundo\nchau Guardado"), "{:?}", read);
        let (waited, _) = do_wait(&json!({ "window": id, "text": "chau", "timeout": 3 })).unwrap();
        lap("wait", &out(&waited));
        let missing = do_wait(&json!({ "window": id, "text": "no-existe-xyz", "timeout": 1 }));
        assert!(missing.is_err());
        let (all, _) = do_screen_text(&json!({ "window": id })).unwrap();
        lap("screen_text", &out(&all));
        if let Ok(p) = std::env::var("GC_E2E_SHOT") {
            let hwnd: isize = id[1..].parse().unwrap();
            std::fs::write(p, win::encode(&win::capture_window(hwnd).unwrap(), 1600, 85).unwrap().jpeg).unwrap();
        }
        let (seen, _) = do_screen_text(&json!({ "window": id, "find": "mundo" })).unwrap();
        let seen = out(&seen);
        lap("screen_text find", &seen);
        assert!(seen.contains("[t"), "el OCR no encontró el texto");
        ours(&id, &stem);
        let a = act("click", &json!({ "ref": reference_in(&seen, 't') })).unwrap();
        lap("click [tN]", &out(&after_action(&a.window, &a.before, a.done)));
        let (caret, _) = do_wait(&json!({ "window": id, "text": "Line 2,", "timeout": 3 })).unwrap();
        lap("cursor después del clic", &out(&caret));
        let original = clipboard::save().unwrap();
        do_clipboard(&json!({ "action": "write", "text": "desde el portapapeles" })).unwrap();
        let (back, _) = do_clipboard(&json!({ "action": "read" })).unwrap();
        clipboard::restore(original).unwrap();
        assert_eq!(out(&back), "desde el portapapeles");
        let (shot, _) = do_screenshot(&json!({ "window": id })).unwrap();
        lap("screenshot", &out(&shot));
        let (zoom, _) = do_screenshot(&json!({ "window": id, "region": { "x": 0, "y": 0, "width": 200, "height": 100 } })).unwrap();
        lap("screenshot region", &out(&zoom));
        ours(&id, &stem);
        let (steps, _) = steps_without_app(&json!({ "actions": [
            { "do": "press_key", "keys": "ctrl+home", "window": id },
            { "do": "type", "ref": doc, "text": ">> ", "mode": "insert" },
            { "do": "wait", "window": id, "text": ">> hola", "timeout": 3 },
        ] }));
        let steps = out(&steps);
        lap("steps", &steps);
        assert!(!steps.contains("falló"), "{}", steps);
        ours(&id, &stem);
        act("press_key", &json!({ "keys": "ctrl+s", "window": id })).unwrap();
        let hwnd: isize = id[1..].parse().unwrap();
        for _ in 0..50 {
            if win::window(hwnd).map(|w| !w.title.starts_with('*')).unwrap_or(true) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let saved = std::fs::read_to_string(&path).unwrap_or_default();
        lap("guardado en disco", &saved);
        assert!(same_text(&saved, ">> hola\nmundo\nchau Guardado"), "{:?}", saved);
        ours(&id, &stem);
        act("press_key", &json!({ "keys": "ctrl+w", "window": id })).unwrap();
        let closed = do_wait(&json!({ "window": stem, "gone": true, "timeout": 5 }));
        lap("cerró la pestaña", &format!("{:?}", closed.as_ref().map(|r| out(&r.0))));
        assert!(closed.is_ok());
    }

    fn steps_without_app(args: &Value) -> (ToolResult, String) {
        let before = snapshot_ids();
        let mut log = Vec::new();
        let mut last = None;
        for step in args["actions"].as_array().unwrap() {
            let name = arg(step, "do").to_string();
            match name.as_str() {
                "wait" => log.push(do_wait(step).map(|r| first_text(&r.0)).unwrap_or_else(|e| format!("falló: {}", e))),
                _ => match act(&name, step) {
                    Ok(a) => {
                        log.push(a.done);
                        last = Some(a.window);
                    }
                    Err(e) => log.push(format!("falló: {}", e)),
                },
            }
        }
        (after_action(&last.unwrap(), &before, log.join("\n")), String::new())
    }

    #[test]
    fn steps_schema_lists_every_supported_action() {
        let defs = definitions();
        let steps = defs.iter().find(|d| d["name"] == "steps").unwrap();
        let kinds = steps["inputSchema"]["properties"]["actions"]["items"]["properties"]["do"]["enum"].as_array().unwrap();
        assert_eq!(kinds.len(), 8);
        assert!(defs.iter().all(|d| d["inputSchema"]["type"] == "object"));
    }
}
