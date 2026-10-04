use super::win::{self, Rect};
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;
use uiautomation::core::{UICacheRequest, UICondition};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIScrollItemPattern, UIScrollPattern, UISelectionItemPattern, UITextPattern, UITogglePattern, UIValuePattern,
    UIWindowPattern,
};
use uiautomation::types::{ExpandCollapseState, Handle, PropertyConditionFlags, ScrollAmount, TreeScope, UIProperty};
use uiautomation::variants::Variant;
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
        win::physical_thread();
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
    rid: Option<String>,
    tick: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub reference: String,
    pub indent: usize,
    pub text: String,
    pub label: String,
    pub parent: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub lines: Vec<Line>,
    pub truncated: bool,
    pub hidden: usize,
    pub max: usize,
}

impl Tree {
    pub fn render(&self, limit: usize) -> String {
        let mut text = self.lines.iter().take(limit).map(|l| format!("{}- {}", "  ".repeat(l.indent), l.text)).collect::<Vec<_>>().join("\n");
        if self.truncated || self.lines.len() > limit {
            text.push_str(&format!("\n… recortado en {} elementos. Para ver una parte, pedí snapshot con root=<ref de un contenedor> o usá find.", limit.min(self.max)));
        }
        if self.hidden > 0 {
            text.push_str(&format!("\n({} elementos fuera de vista omitidos: usá scroll para verlos.)", self.hidden));
        }
        text
    }
}

#[derive(Debug, PartialEq)]
pub enum Delta {
    Same,
    Many,
    Few(String),
}

pub enum Change {
    Full(Tree),
    Delta(Delta, Tree),
}

pub fn compare(old: &Tree, new: &Tree) -> Delta {
    let before: HashMap<&str, &Line> = old.lines.iter().map(|l| (l.reference.as_str(), l)).collect();
    let current: HashMap<&str, &Line> = new.lines.iter().map(|l| (l.reference.as_str(), l)).collect();
    let mut levels: HashMap<&str, usize> = HashMap::new();
    let mut out: Vec<String> = Vec::new();
    for line in &new.lines {
        let r = line.reference.as_str();
        match before.get(r) {
            None => {
                let parent = line.parent.as_deref();
                let level = parent.and_then(|p| levels.get(p)).map(|l| l + 1).unwrap_or(0);
                levels.insert(r, level);
                let mut text = format!("{}+ {}", "  ".repeat(level), line.text);
                if level == 0 {
                    if let Some(p) = parent.and_then(|p| current.get(p)) {
                        text.push_str(&format!("  ← dentro de {}", p.label));
                    }
                }
                out.push(text);
            }
            Some(previous) if previous.text != line.text => out.push(format!("~ {}", line.text)),
            Some(_) => {}
        }
    }
    if !old.truncated && !new.truncated {
        for line in &old.lines {
            if !current.contains_key(line.reference.as_str()) {
                out.push(format!("- {}", line.label));
            }
        }
    }
    if out.is_empty() {
        return Delta::Same;
    }
    if out.len() > (new.lines.len() / 2).max(40) {
        return Delta::Many;
    }
    Delta::Few(out.join("\n"))
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
    lines: Vec<Line>,
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
    by_runtime: HashMap<String, String>,
    used: HashSet<String>,
    last: HashMap<isize, Tree>,
    next: u64,
    tick: u64,
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

fn label_of(node: &Node, reference: &str) -> String {
    let mut line = node.role.clone();
    if !node.name.is_empty() {
        line.push_str(&format!(" \"{}\"", quoted(&clean(&node.name, 60))));
    }
    line.push_str(&format!(" [{}]", reference));
    line
}

fn describe(node: &Node, reference: &str) -> String {
    let mut line = node.role.clone();
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
        Ok(Uia { auto, children, single, refs: HashMap::new(), by_runtime: HashMap::new(), used: HashSet::new(), last: HashMap::new(), next: 0, tick: 0 })
    }

    fn remember(&mut self, el: UIElement, window: isize, node: &Node) -> String {
        self.tick += 1;
        let rid = el.get_runtime_id().ok().filter(|v| !v.is_empty()).map(|v| v.iter().map(|n| n.to_string()).collect::<Vec<_>>().join("."));
        if let Some(existing) = rid.as_ref().and_then(|k| self.by_runtime.get(k)).cloned() {
            if !self.used.contains(&existing) {
                if let Some(entry) = self.refs.get_mut(&existing) {
                    if entry.window == window {
                        entry.el = el;
                        entry.role = node.role.clone();
                        entry.name = node.name.clone();
                        entry.tick = self.tick;
                        self.used.insert(existing.clone());
                        return existing;
                    }
                }
            }
        }
        self.next += 1;
        let id = format!("e{}", self.next);
        if let Some(key) = &rid {
            self.by_runtime.insert(key.clone(), id.clone());
        }
        self.refs.insert(id.clone(), Entry { el, window, role: node.role.clone(), name: node.name.clone(), rid, tick: self.tick });
        self.used.insert(id.clone());
        self.evict();
        id
    }

    fn evict(&mut self) {
        if self.refs.len() <= MAX_REFS {
            return;
        }
        let mut ages: Vec<(u64, String)> = self.refs.iter().map(|(k, e)| (e.tick, k.clone())).collect();
        ages.sort();
        let drop = self.refs.len() - MAX_REFS * 9 / 10;
        for (_, key) in ages.into_iter().take(drop) {
            if let Some(entry) = self.refs.remove(&key) {
                if let Some(rid) = entry.rid {
                    if self.by_runtime.get(&rid) == Some(&key) {
                        self.by_runtime.remove(&rid);
                    }
                }
            }
        }
    }

    pub fn role(&self, reference: &str) -> Option<String> {
        self.entry(reference).ok().map(|e| e.role.clone())
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

    fn walk(&mut self, el: &UIElement, window: isize, depth: usize, indent: usize, parent: (&str, Option<&str>), ctx: &mut Walk) {
        let (parent_name, parent_ref) = parent;
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
        let mut own: Option<String> = None;
        if emit {
            let reference = self.remember(el.clone(), window, &node);
            ctx.lines.push(Line {
                reference: reference.clone(),
                indent,
                text: describe(&node, &reference),
                label: label_of(&node, &reference),
                parent: parent_ref.map(|p| p.to_string()),
            });
            ctx.count += 1;
            next_indent = indent + 1;
            own = Some(reference);
        }
        if depth >= ctx.depth || LEAVES.contains(&node.role.as_str()) || node.password {
            return;
        }
        let Ok(expanded) = el.build_updated_cache(&self.children) else { return };
        let Ok(kids) = expanded.get_cached_children() else { return };
        let name = if emit { node.name.clone() } else { parent_name.to_string() };
        let reference = own.or_else(|| parent_ref.map(|p| p.to_string()));
        for kid in kids {
            self.walk(&kid, window, depth + 1, next_indent, (&name, reference.as_deref()), ctx);
            if ctx.truncated {
                return;
            }
        }
    }

    pub fn snapshot(&mut self, window: isize, root: Option<&str>, max: usize, depth: usize) -> Result<Tree, String> {
        let info = win::window(window);
        let start = match root {
            Some(r) => self.entry(r)?.el.clone(),
            None => self.auto.element_from_handle(Handle::from(window)).map_err(err)?,
        };
        let start = start.build_updated_cache(&self.single).map_err(err)?;
        self.used.clear();
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
            self.walk(&start, window, 0, 0, ("", None), &mut ctx);
        } else {
            let node = read_node(&start);
            let reference = self.remember(start.clone(), window, &node);
            ctx.lines.push(Line { reference: reference.clone(), indent: 0, text: describe(&node, &reference), label: label_of(&node, &reference), parent: None });
            ctx.count += 1;
            if let Ok(expanded) = start.build_updated_cache(&self.children) {
                if let Ok(kids) = expanded.get_cached_children() {
                    for kid in kids {
                        self.walk(&kid, window, 1, 1, (&node.name, Some(&reference)), &mut ctx);
                        if ctx.truncated {
                            break;
                        }
                    }
                }
            }
        }
        let tree = Tree { lines: ctx.lines, truncated: ctx.truncated, hidden: ctx.hidden, max };
        if root.is_none() {
            self.last.insert(window, tree.clone());
        }
        Ok(tree)
    }

    pub fn changes(&mut self, window: isize, max: usize, depth: usize) -> Result<Change, String> {
        let previous = self.last.get(&window).cloned();
        let tree = self.snapshot(window, None, max, depth)?;
        Ok(match previous {
            Some(old) => Change::Delta(compare(&old, &tree), tree),
            None => Change::Full(tree),
        })
    }

    fn search_condition(&self, text: &str) -> Result<UICondition, String> {
        let control = self.auto.get_control_view_condition().map_err(err)?;
        if text.trim().is_empty() {
            return Ok(control);
        }
        let flags = Some(PropertyConditionFlags::All);
        let by = |p: UIProperty| self.auto.create_property_condition(p, Variant::from(text.trim()), flags).map_err(err);
        let any = self.auto.create_or_condition(by(UIProperty::Name)?, by(UIProperty::AutomationId)?).map_err(err)?;
        let any = self.auto.create_or_condition(any, by(UIProperty::ValueValue)?).map_err(err)?;
        self.auto.create_and_condition(control, any).map_err(err)
    }

    pub fn find(&mut self, window: isize, text: &str, role: &str, max: usize) -> Result<(Vec<String>, usize), String> {
        let root = self.auto.element_from_handle(Handle::from(window)).map_err(err)?;
        let condition = self.search_condition(text)?;
        let found = root.find_all_build_cache(TreeScope::Descendants, &condition, &self.single).map_err(err)?;
        let wanted = role.trim().to_lowercase();
        let walker = self.auto.get_control_view_walker().ok();
        self.used.clear();
        let mut lines = Vec::new();
        let mut total = 0;
        for el in found {
            let node = read_node(&el);
            if !wanted.is_empty() && node.role != wanted {
                continue;
            }
            total += 1;
            if lines.len() >= max {
                continue;
            }
            let reference = self.remember(el.clone(), window, &node);
            let mut line = describe(&node, &reference);
            if let Some(parent) = walker.as_ref().and_then(|w| w.get_parent(&el).ok()) {
                let name = parent.get_name().unwrap_or_default();
                if !name.trim().is_empty() {
                    let kind = parent.get_control_type().map(|c| format!("{:?}", c).to_lowercase()).unwrap_or_default();
                    line.push_str(&format!("  ← en {} \"{}\"", kind, quoted(&clean(&name, 60))));
                }
            }
            lines.push(line);
        }
        Ok((lines, total))
    }

    pub fn present(&mut self, window: isize, text: &str) -> Result<Option<String>, String> {
        let root = self.auto.element_from_handle(Handle::from(window)).map_err(err)?;
        let condition = self.search_condition(text)?;
        let Ok(el) = root.find_first_build_cache(TreeScope::Descendants, &condition, &self.single) else { return Ok(None) };
        let node = read_node(&el);
        self.used.clear();
        let reference = self.remember(el, window, &node);
        Ok(Some(describe(&node, &reference)))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn line(reference: &str, text: &str, parent: Option<&str>) -> Line {
        Line { reference: reference.into(), indent: 0, text: format!("{} [{}]", text, reference), label: format!("{} [{}]", text, reference), parent: parent.map(|p| p.into()) }
    }

    fn tree(lines: Vec<Line>) -> Tree {
        Tree { lines, truncated: false, hidden: 0, max: 350 }
    }

    #[test]
    fn same_tree_reports_no_changes() {
        let a = tree(vec![line("e1", "window \"Bloc\"", None), line("e2", "button \"Guardar\"", Some("e1"))]);
        assert_eq!(compare(&a, &a.clone()), Delta::Same);
    }

    #[test]
    fn diff_lists_added_changed_and_removed_with_context() {
        let old = tree(vec![line("e1", "window \"Bloc\"", None), line("e2", "edit \"Texto\" value=\"\"", Some("e1")), line("e3", "button \"Cancelar\"", Some("e1"))]);
        let new = tree(vec![
            line("e1", "window \"Bloc\"", None),
            line("e2", "edit \"Texto\" value=\"hola\"", Some("e1")),
            line("e9", "dialog \"Guardar como\"", Some("e1")),
            line("e10", "button \"Aceptar\"", Some("e9")),
        ]);
        let Delta::Few(text) = compare(&old, &new) else { panic!("se esperaba un diff chico") };
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "~ edit \"Texto\" value=\"hola\" [e2]");
        assert_eq!(lines[1], "+ dialog \"Guardar como\" [e9]  ← dentro de window \"Bloc\" [e1]");
        assert_eq!(lines[2], "  + button \"Aceptar\" [e10]");
        assert_eq!(lines[3], "- button \"Cancelar\" [e3]");
    }

    #[test]
    fn truncated_trees_do_not_report_removals() {
        let old = tree(vec![line("e1", "window", None), line("e2", "button \"A\"", Some("e1"))]);
        let mut new = tree(vec![line("e1", "window", None)]);
        new.truncated = true;
        assert_eq!(compare(&old, &new), Delta::Same);
    }

    #[test]
    fn large_changes_fall_back_to_the_full_tree() {
        let old = tree((0..60).map(|i| line(&format!("e{}", i), "button", None)).collect());
        let new = tree((100..160).map(|i| line(&format!("e{}", i), "button", None)).collect());
        assert_eq!(compare(&old, &new), Delta::Many);
    }
}
