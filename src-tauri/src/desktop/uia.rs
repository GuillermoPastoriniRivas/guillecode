use super::win::{self, Rect};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;
use uiautomation::core::UICacheRequest;
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIScrollItemPattern, UIScrollPattern, UISelectionItemPattern, UITextPattern, UITogglePattern, UIValuePattern,
    UIWindowPattern,
};
use uiautomation::types::{ExpandCollapseState, Handle, ScrollAmount, TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

const JOB_TIMEOUT: Duration = Duration::from_secs(60);
const PATTERN_WAIT: Duration = Duration::from_millis(2500);
const MAX_REFS: usize = 4000;
const NAME_MAX: usize = 120;
const VALUE_MAX: usize = 200;
const DOCUMENT_PREVIEW: i32 = 400;

const PROPS: &[UIProperty] = &[
    UIProperty::Name,
    UIProperty::ControlType,
    UIProperty::AutomationId,
    UIProperty::IsEnabled,
    UIProperty::HasKeyboardFocus,
    UIProperty::IsOffscreen,
    UIProperty::IsPassword,
    UIProperty::NativeWindowHandle,
    UIProperty::ValueValue,
    UIProperty::ValueIsReadOnly,
    UIProperty::RangeValueValue,
    UIProperty::ToggleToggleState,
    UIProperty::ExpandCollapseExpandCollapseState,
    UIProperty::SelectionItemIsSelected,
    UIProperty::IsInvokePatternAvailable,
    UIProperty::IsValuePatternAvailable,
    UIProperty::IsTogglePatternAvailable,
    UIProperty::IsExpandCollapsePatternAvailable,
    UIProperty::IsSelectionItemPatternAvailable,
    UIProperty::IsTextPatternAvailable,
    UIProperty::IsScrollPatternAvailable,
    UIProperty::IsRangeValuePatternAvailable,
];

const LEAVES: &[&str] = &["text", "image", "separator", "thumb", "progressbar", "scrollbar"];
const STRUCTURAL: &[&str] = &["pane", "group", "custom", "window", "titlebar", "toolbar", "statusbar", "menubar", "list", "tree", "tab", "table", "datagrid", "header", "appbar", "semanticzoom"];
const SELECT_FIRST: &[&str] = &["listitem", "treeitem", "dataitem", "tabitem", "radiobutton"];

type Job = Box<dyn FnOnce(&mut Uia) + Send>;

static WORKER: Mutex<Option<Sender<Job>>> = Mutex::new(None);

struct Remote<T>(T);
unsafe impl<T> Send for Remote<T> {}

fn spawn_worker() -> Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    let _ = std::thread::Builder::new().name("guillecode-uia".into()).spawn(move || {
        let mut uia = match Uia::new() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[desktop] no se pudo iniciar UI Automation: {}", e);
                return;
            }
        };
        for job in rx {
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| job(&mut uia)));
        }
    });
    tx
}

pub fn run<T: Send + 'static>(f: impl FnOnce(&mut Uia) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let job: Job = Box::new(move |uia| {
        let _ = tx.send(f(uia));
    });
    {
        let mut worker = WORKER.lock().unwrap();
        let sender = worker.get_or_insert_with(spawn_worker);
        if let Err(mpsc::SendError(job)) = sender.send(job) {
            let fresh = spawn_worker();
            fresh.send(job).map_err(|_| "no pude iniciar la accesibilidad de Windows".to_string())?;
            *worker = Some(fresh);
        }
    }
    match rx.recv_timeout(JOB_TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            *WORKER.lock().unwrap() = None;
            Err("la app no respondió a tiempo a la accesibilidad de Windows. Las refs anteriores se perdieron: pedí un snapshot nuevo o usá screenshot".into())
        }
        Err(RecvTimeoutError::Disconnected) => {
            *WORKER.lock().unwrap() = None;
            Err("la accesibilidad de Windows falló con esta app; pedí un snapshot nuevo".into())
        }
    }
}

fn err(e: uiautomation::Error) -> String {
    e.to_string()
}

fn detached<P: 'static>(pattern: P, call: impl FnOnce(&P) -> uiautomation::Result<()> + Send + 'static) -> Result<bool, String> {
    let (tx, rx) = mpsc::channel();
    let boxed = Remote((pattern, call));
    std::thread::spawn(move || {
        let moved = boxed;
        let (pattern, call) = moved.0;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let _ = tx.send(call(&pattern).map_err(err));
    });
    match rx.recv_timeout(PATTERN_WAIT) {
        Ok(Ok(())) => Ok(true),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(false),
    }
}

pub struct Entry {
    el: UIElement,
    pub window: isize,
    pub role: String,
    pub name: String,
}

pub struct Activated {
    pub method: &'static str,
    pub pending: bool,
}

#[derive(Default)]
struct Node {
    role: String,
    name: String,
    value: Option<String>,
    enabled: bool,
    focused: bool,
    offscreen: bool,
    password: bool,
    toggle: Option<i32>,
    expand: Option<i32>,
    selected: Option<bool>,
    actionable: bool,
    has_text: bool,
    editable: bool,
}

struct Walk {
    lines: Vec<String>,
    count: usize,
    max: usize,
    depth: usize,
    truncated: bool,
    skip_offscreen: bool,
    hidden: usize,
}

pub struct Uia {
    auto: UIAutomation,
    children: UICacheRequest,
    single: UICacheRequest,
    refs: HashMap<String, Entry>,
    order: VecDeque<String>,
    next: u64,
}

fn clean(text: &str, max: usize) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > max {
        format!("{}…", joined.chars().take(max).collect::<String>())
    } else {
        joined
    }
}

fn quoted(text: &str) -> String {
    text.replace('"', "'")
}

fn cached_string(el: &UIElement, prop: UIProperty) -> Option<String> {
    let v = el.get_cached_property_value(prop).ok()?;
    let s: String = (&v).try_into().ok()?;
    Some(s)
}

fn cached_bool(el: &UIElement, prop: UIProperty) -> Option<bool> {
    let v = el.get_cached_property_value(prop).ok()?;
    (&v).try_into().ok()
}

fn cached_i32(el: &UIElement, prop: UIProperty) -> Option<i32> {
    let v = el.get_cached_property_value(prop).ok()?;
    (&v).try_into().ok()
}

fn cached_f64(el: &UIElement, prop: UIProperty) -> Option<f64> {
    let v = el.get_cached_property_value(prop).ok()?;
    (&v).try_into().ok()
}

fn role_of(el: &UIElement) -> String {
    el.get_cached_control_type().map(|c| format!("{:?}", c).to_lowercase()).unwrap_or_else(|_| "custom".into())
}

fn read_node(el: &UIElement) -> Node {
    let role = role_of(el);
    let flag = |p| cached_bool(el, p).unwrap_or(false);
    let has_value = flag(UIProperty::IsValuePatternAvailable);
    let readonly = cached_bool(el, UIProperty::ValueIsReadOnly).unwrap_or(true);
    let password = flag(UIProperty::IsPassword);
    let has_toggle = flag(UIProperty::IsTogglePatternAvailable);
    let has_expand = flag(UIProperty::IsExpandCollapsePatternAvailable);
    let has_select = flag(UIProperty::IsSelectionItemPatternAvailable);
    let value = if password {
        None
    } else if has_value {
        cached_string(el, UIProperty::ValueValue).filter(|v| !v.trim().is_empty()).map(|v| clean(&v, VALUE_MAX))
    } else if flag(UIProperty::IsRangeValuePatternAvailable) {
        cached_f64(el, UIProperty::RangeValueValue).map(|v| format!("{}", v))
    } else {
        None
    };
    Node {
        name: clean(&cached_string(el, UIProperty::Name).unwrap_or_default(), NAME_MAX),
        value,
        enabled: cached_bool(el, UIProperty::IsEnabled).unwrap_or(true),
        focused: flag(UIProperty::HasKeyboardFocus),
        offscreen: flag(UIProperty::IsOffscreen),
        password,
        toggle: if has_toggle { cached_i32(el, UIProperty::ToggleToggleState) } else { None },
        expand: if has_expand { cached_i32(el, UIProperty::ExpandCollapseExpandCollapseState) } else { None },
        selected: if has_select { cached_bool(el, UIProperty::SelectionItemIsSelected) } else { None },
        actionable: flag(UIProperty::IsInvokePatternAvailable) || has_toggle || has_expand || has_select || (has_value && !readonly),
        has_text: flag(UIProperty::IsTextPatternAvailable),
        editable: has_value && !readonly,
        role,
    }
}

fn describe(node: &Node, reference: &str, indent: usize) -> String {
    let mut line = format!("{}- {}", "  ".repeat(indent), node.role);
    if !node.name.is_empty() {
        line.push_str(&format!(" \"{}\"", quoted(&node.name)));
    }
    line.push_str(&format!(" [{}]", reference));
    if let Some(v) = &node.value {
        if *v != node.name {
            line.push_str(&format!(" value=\"{}\"", quoted(v)));
        }
    }
    let mut states: Vec<&str> = Vec::new();
    if node.password {
        states.push("password");
    }
    if node.editable {
        states.push("editable");
    }
    match node.toggle {
        Some(1) => states.push("checked"),
        Some(0) => states.push("unchecked"),
        Some(2) => states.push("mixed"),
        _ => {}
    }
    match node.expand {
        Some(0) => states.push("collapsed"),
        Some(1) | Some(2) => states.push("expanded"),
        _ => {}
    }
    if node.selected == Some(true) {
        states.push("selected");
    }
    if node.focused {
        states.push("focused");
    }
    if !node.enabled {
        states.push("disabled");
    }
    if node.offscreen {
        states.push("offscreen");
    }
    if !states.is_empty() {
        line.push_str(&format!(" ({})", states.join(", ")));
    }
    line
}

impl Uia {
    fn new() -> Result<Uia, String> {
        let auto = UIAutomation::new().map_err(err)?;
        let control = auto.get_control_view_condition().map_err(err)?;
        let children = auto.create_cache_request().map_err(err)?;
        let single = auto.create_cache_request().map_err(err)?;
        for p in PROPS {
            children.add_property(*p).map_err(err)?;
            single.add_property(*p).map_err(err)?;
        }
        children.set_tree_scope(TreeScope::Children).map_err(err)?;
        children.set_tree_filter(control).map_err(err)?;
        single.set_tree_scope(TreeScope::Element).map_err(err)?;
        Ok(Uia { auto, children, single, refs: HashMap::new(), order: VecDeque::new(), next: 0 })
    }

    fn remember(&mut self, el: UIElement, window: isize, node: &Node) -> String {
        self.next += 1;
        let id = format!("e{}", self.next);
        self.refs.insert(id.clone(), Entry { el, window, role: node.role.clone(), name: node.name.clone() });
        self.order.push_back(id.clone());
        while self.order.len() > MAX_REFS {
            if let Some(old) = self.order.pop_front() {
                self.refs.remove(&old);
            }
        }
        id
    }

    pub fn entry(&self, reference: &str) -> Result<&Entry, String> {
        let key = reference.trim().trim_start_matches('[').trim_end_matches(']').trim();
        let key = if key.starts_with('e') { key.to_string() } else { format!("e{}", key) };
        self.refs.get(&key).ok_or_else(|| format!("no conozco la ref «{}»: pedí un snapshot nuevo de la ventana y usá una ref de ese resultado", reference))
    }

    fn document_preview(&self, el: &UIElement) -> Option<String> {
        let pattern = el.get_pattern::<UITextPattern>().ok()?;
        let text = pattern.get_document_range().ok()?.get_text(DOCUMENT_PREVIEW).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| clean(text, DOCUMENT_PREVIEW as usize))
    }

    fn walk(&mut self, el: &UIElement, window: isize, depth: usize, indent: usize, parent_name: &str, ctx: &mut Walk) {
        if ctx.count >= ctx.max {
            ctx.truncated = true;
            return;
        }
        let mut node = read_node(el);
        if node.offscreen && ctx.skip_offscreen && !node.focused {
            ctx.hidden += 1;
            return;
        }
        if node.value.is_none() && node.has_text && matches!(node.role.as_str(), "document" | "edit") {
            node.value = self.document_preview(el);
        }
        let anonymous = node.name.is_empty() && node.value.is_none();
        let redundant_text = node.role == "text" && (node.name.is_empty() || node.name == parent_name);
        let structural = STRUCTURAL.contains(&node.role.as_str());
        let emit = !redundant_text && (node.actionable || !anonymous) && !(structural && anonymous && !node.actionable);
        let mut next_indent = indent;
        if emit {
            let reference = self.remember(el.clone(), window, &node);
            ctx.lines.push(describe(&node, &reference, indent));
            ctx.count += 1;
            next_indent = indent + 1;
        }
        if depth >= ctx.depth || LEAVES.contains(&node.role.as_str()) || node.password {
            return;
        }
        let Ok(expanded) = el.build_updated_cache(&self.children) else { return };
        let Ok(kids) = expanded.get_cached_children() else { return };
        let name = if emit { node.name.clone() } else { parent_name.to_string() };
        for kid in kids {
            self.walk(&kid, window, depth + 1, next_indent, &name, ctx);
            if ctx.truncated {
                return;
            }
        }
    }

    pub fn snapshot(&mut self, window: isize, root: Option<&str>, max: usize, depth: usize) -> Result<(String, usize), String> {
        let info = win::window(window);
        let start = match root {
            Some(r) => self.entry(r)?.el.clone(),
            None => self.auto.element_from_handle(Handle::from(window)).map_err(err)?,
        };
        let start = start.build_updated_cache(&self.single).map_err(err)?;
        let mut ctx = Walk {
            lines: Vec::new(),
            count: 0,
            max,
            depth,
            truncated: false,
            skip_offscreen: !info.as_ref().map(|i| i.minimized).unwrap_or(false),
            hidden: 0,
        };
        if root.is_some() {
            self.walk(&start, window, 0, 0, "", &mut ctx);
        } else {
            let node = read_node(&start);
            let reference = self.remember(start.clone(), window, &node);
            ctx.lines.push(describe(&node, &reference, 0));
            ctx.count += 1;
            if let Ok(expanded) = start.build_updated_cache(&self.children) {
                if let Ok(kids) = expanded.get_cached_children() {
                    for kid in kids {
                        self.walk(&kid, window, 1, 1, &node.name, &mut ctx);
                        if ctx.truncated {
                            break;
                        }
                    }
                }
            }
        }
        let mut text = ctx.lines.join("\n");
        if ctx.truncated {
            text.push_str(&format!("\n… recortado en {} elementos. Para ver una parte, pedí snapshot con root=<ref de un contenedor>.", ctx.max));
        }
        if ctx.hidden > 0 {
            text.push_str(&format!("\n({} elementos fuera de vista omitidos: usá scroll para verlos.)", ctx.hidden));
        }
        Ok((text, ctx.count))
    }

    pub fn activate(&mut self, reference: &str) -> Result<Option<Activated>, String> {
        let entry = self.entry(reference)?;
        let el = entry.el.clone();
        let role = entry.role.clone();
        let order: &[&str] = if SELECT_FIRST.contains(&role.as_str()) {
            &["select", "toggle", "invoke", "expand", "legacy"]
        } else if role == "checkbox" {
            &["toggle", "invoke", "legacy"]
        } else if role == "combobox" || role == "splitbutton" {
            &["expand", "invoke", "legacy"]
        } else if role == "menuitem" {
            &["invoke", "expand", "legacy"]
        } else {
            &["invoke", "toggle", "expand", "select", "legacy"]
        };
        for step in order {
            let done = match *step {
                "invoke" => match el.get_pattern::<UIInvokePattern>() {
                    Ok(p) => Some(("invoke", detached(p, |p| p.invoke()))),
                    Err(_) => None,
                },
                "toggle" => match el.get_pattern::<UITogglePattern>() {
                    Ok(p) => Some(("toggle", detached(p, |p| p.toggle()))),
                    Err(_) => None,
                },
                "select" => match el.get_pattern::<UISelectionItemPattern>() {
                    Ok(p) => Some(("select", detached(p, |p| p.select()))),
                    Err(_) => None,
                },
                "expand" => match el.get_pattern::<UIExpandCollapsePattern>() {
                    Ok(p) => {
                        let expanded = matches!(p.get_state(), Ok(ExpandCollapseState::Expanded) | Ok(ExpandCollapseState::PartiallyExpanded));
                        if expanded {
                            Some(("collapse", detached(p, |p| p.collapse())))
                        } else {
                            Some(("expand", detached(p, |p| p.expand())))
                        }
                    }
                    Err(_) => None,
                },
                _ => match el.get_pattern::<UILegacyIAccessiblePattern>() {
                    Ok(p) => Some(("default_action", detached(p, |p| p.do_default_action()))),
                    Err(_) => None,
                },
            };
            if let Some((method, result)) = done {
                match result {
                    Ok(finished) => return Ok(Some(Activated { method, pending: !finished })),
                    Err(_) => continue,
                }
            }
        }
        Ok(None)
    }

    pub fn set_value(&mut self, reference: &str, text: &str) -> Result<Option<bool>, String> {
        let el = self.entry(reference)?.el.clone();
        let Ok(pattern) = el.get_pattern::<UIValuePattern>() else { return Ok(None) };
        if pattern.is_readonly().unwrap_or(false) {
            return Ok(None);
        }
        let text = text.to_string();
        match detached(pattern, move |p| p.set_value(&text)) {
            Ok(finished) => Ok(Some(finished)),
            Err(_) => Ok(None),
        }
    }

    pub fn value(&self, reference: &str) -> Option<String> {
        let el = &self.entry(reference).ok()?.el;
        el.get_pattern::<UIValuePattern>().ok()?.get_value().ok()
    }

    pub fn focus(&self, reference: &str) -> Result<(), String> {
        self.entry(reference)?.el.set_focus().map_err(err)
    }

    pub fn scroll_into_view(&self, reference: &str) {
        if let Ok(entry) = self.entry(reference) {
            if let Ok(p) = entry.el.get_pattern::<UIScrollItemPattern>() {
                let _ = p.scroll_into_view();
            }
        }
    }

    pub fn point(&self, reference: &str) -> Result<(i32, i32), String> {
        let entry = self.entry(reference)?;
        if let Ok(Some(p)) = entry.el.get_clickable_point() {
            return Ok((p.get_x(), p.get_y()));
        }
        let r = entry.el.get_bounding_rectangle().map_err(err)?;
        let rect = Rect { left: r.get_left(), top: r.get_top(), right: r.get_right(), bottom: r.get_bottom() };
        if rect.width() <= 0 || rect.height() <= 0 {
            return Err("el elemento no tiene posición en pantalla (está oculto o fuera de vista)".into());
        }
        Ok(rect.center())
    }

    pub fn scroll(&mut self, reference: &str, down: bool, page: bool) -> Result<bool, String> {
        let el = self.entry(reference)?.el.clone();
        let amount = match (down, page) {
            (true, true) => ScrollAmount::LargeIncrement,
            (true, false) => ScrollAmount::SmallIncrement,
            (false, true) => ScrollAmount::LargeDecrement,
            (false, false) => ScrollAmount::SmallDecrement,
        };
        let mut current = Some(el);
        for _ in 0..6 {
            let Some(el) = current.take() else { break };
            if let Ok(p) = el.get_pattern::<UIScrollPattern>() {
                if p.scroll(ScrollAmount::NoAmount, amount).is_ok() {
                    return Ok(true);
                }
            }
            current = self.auto.get_control_view_walker().ok().and_then(|w| w.get_parent(&el).ok());
        }
        Ok(false)
    }

    pub fn select_option(&mut self, reference: &str, option: &str) -> Result<String, String> {
        let el = self.entry(reference)?.el.clone();
        let mut opened = false;
        if let Ok(p) = el.get_pattern::<UIExpandCollapsePattern>() {
            if !matches!(p.get_state(), Ok(ExpandCollapseState::Expanded)) {
                opened = detached(p, |p| p.expand()).unwrap_or(false);
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        let wanted = option.trim().to_lowercase();
        let control = self.auto.get_control_view_condition().map_err(err)?;
        let items = el.find_all(TreeScope::Descendants, &control).map_err(err)?;
        let mut names: Vec<String> = Vec::new();
        let mut exact: Option<UIElement> = None;
        let mut partial: Option<UIElement> = None;
        for item in items {
            if item.get_pattern::<UISelectionItemPattern>().is_err() {
                continue;
            }
            let name = item.get_name().unwrap_or_default();
            let lower = name.trim().to_lowercase();
            if lower == wanted && exact.is_none() {
                exact = Some(item.clone());
            } else if lower.contains(&wanted) && partial.is_none() {
                partial = Some(item.clone());
            }
            if names.len() < 40 && !name.trim().is_empty() {
                names.push(name.trim().to_string());
            }
        }
        let Some(target) = exact.or(partial) else {
            if opened {
                if let Ok(p) = el.get_pattern::<UIExpandCollapsePattern>() {
                    let _ = detached(p, |p| p.collapse());
                }
            }
            return Err(if names.is_empty() {
                format!("no encontré opciones en «{}»", option)
            } else {
                format!("no hay una opción «{}». Las opciones son: {}", option, names.join(" | "))
            });
        };
        let chosen = target.get_name().unwrap_or_default();
        if let Ok(p) = target.get_pattern::<UISelectionItemPattern>() {
            detached(p, |p| p.select())?;
        }
        if let Ok(p) = el.get_pattern::<UIExpandCollapsePattern>() {
            if matches!(p.get_state(), Ok(ExpandCollapseState::Expanded)) {
                let _ = detached(p, |p| p.collapse());
            }
        }
        Ok(chosen)
    }

    pub fn read(&self, reference: &str, max: i32) -> Result<String, String> {
        let el = &self.entry(reference)?.el;
        if el.is_password().unwrap_or(false) {
            return Err("es un campo de contraseña: no leo su contenido".into());
        }
        if let Ok(p) = el.get_pattern::<UITextPattern>() {
            if let Ok(text) = p.get_document_range().and_then(|r| r.get_text(max)) {
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
        }
        if let Ok(p) = el.get_pattern::<UIValuePattern>() {
            if let Ok(v) = p.get_value() {
                if !v.trim().is_empty() {
                    return Ok(v);
                }
            }
        }
        if let Ok(p) = el.get_pattern::<UILegacyIAccessiblePattern>() {
            if let Ok(v) = p.get_value() {
                if !v.trim().is_empty() {
                    return Ok(v);
                }
            }
        }
        let control = self.auto.get_control_view_condition().map_err(err)?;
        let parts: Vec<String> = el
            .find_all(TreeScope::Subtree, &control)
            .map_err(err)?
            .into_iter()
            .filter_map(|e| e.get_name().ok())
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .fold(Vec::new(), |mut acc, n| {
                if acc.last() != Some(&n) {
                    acc.push(n);
                }
                acc
            });
        let text = parts.join("\n");
        Ok(text.chars().take(max.max(0) as usize).collect())
    }

    pub fn owner(&self, reference: &str) -> Result<isize, String> {
        let entry = self.entry(reference)?;
        let live = entry.el.get_native_window_handle().ok().map(|h| {
            let raw: isize = h.into();
            raw
        });
        Ok(live.filter(|h| *h != 0).map(win::root_of).unwrap_or(entry.window))
    }

    pub fn close_window(&self, window: isize) -> Result<bool, String> {
        let el = self.auto.element_from_handle(Handle::from(window)).map_err(err)?;
        match el.get_pattern::<UIWindowPattern>() {
            Ok(p) => detached(p, |p| p.close()).map(|_| true),
            Err(_) => Ok(false),
        }
    }

    pub fn label(&self, reference: &str) -> String {
        self.entry(reference).map(|e| if e.name.is_empty() { e.role.clone() } else { format!("{} «{}»", e.role, e.name) }).unwrap_or_default()
    }
}
