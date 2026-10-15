//! Durable desktop checkpoints, with a per-session execution epoch. A stopped
//! or superseded turn cannot resume queued input after acquiring the input lock.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub session: String,
    pub run: u64,
    pub objective: String,
    pub status: String,
    pub target: Option<String>,
    pub next: String,
    pub checkpoints: Vec<Checkpoint>,
    pub in_flight: Option<String>,
    pub updated: i64,
    pub started: i64,
    pub first_action: Option<i64>,
    pub actions: usize,
    #[serde(skip)]
    token: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub label: String,
    pub evidence: String,
    pub at: i64,
}

#[derive(Default)]
pub struct Tasks {
    pub records: Mutex<HashMap<String, Task>>,
    pub path: Option<std::path::PathBuf>,
}

#[derive(Clone, Default)]
struct Caller { session: String, run: u64 }
thread_local! { static CALLER: RefCell<Option<Caller>> = const { RefCell::new(None) }; }
pub struct Scope(Option<Caller>);
impl Drop for Scope {
    fn drop(&mut self) { CALLER.with(|c| *c.borrow_mut() = self.0.take()); }
}

pub fn start(app: &AppHandle) {
    let mut tasks: HashMap<String, Task> = crate::app_data_file(app, "desktop-tasks.json")
        .and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    for task in tasks.values_mut() {
        task.token = uuid::Uuid::new_v4().to_string();
        task.run += 1;
        if task.status == "running" { task.status = "interrupted".into(); }
    }
    app.manage(Tasks { records: Mutex::new(tasks), path: crate::app_data_file(app, "desktop-tasks.json") });
}

fn persist(app: &AppHandle, tasks: &HashMap<String, Task>) -> Result<(), String> {
    let path = app.state::<Tasks>().path.clone().ok_or("sin carpeta de datos")?;
    let bytes = serde_json::to_vec_pretty(tasks).map_err(|e| e.to_string())?;
    // Keep a recovery copy; never truncate the only durable checkpoint first.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

fn update(app: &AppHandle, session: &str, f: impl FnOnce(&mut Task) -> Result<(), String>) -> Result<Task, String> {
    if session.is_empty() || session.len() > 200 { return Err("sesión inválida".into()); }
    let state = app.state::<Tasks>();
    let mut all = state.records.lock().unwrap();
    let mut task = all.get(session).cloned().unwrap_or_else(|| Task {
        session: session.into(), token: uuid::Uuid::new_v4().to_string(), status: "idle".into(), ..Default::default()
    });
    if let Some((caller, run)) = identity() {
        if caller == session { validate(&task, run)?; }
    }
    f(&mut task)?;
    task.updated = chrono::Utc::now().timestamp_millis();
    all.insert(session.into(), task.clone());
    persist(app, &all)?;
    let _ = app.emit("desktop://task", &task);
    Ok(task)
}

pub fn get(app: &AppHandle, session: &str) -> Option<Task> { app.state::<Tasks>().records.lock().unwrap().get(session).cloned() }

pub fn begin(app: &AppHandle, session: &str, objective: &str, target: Option<String>) -> Result<Task, String> {
    update(app, session, |t| {
        t.run += 1;
        t.status = "running".into();
        t.started = chrono::Utc::now().timestamp_millis();
        t.first_action = None;
        t.actions = 0;
        // Checkpoints survive corrections/reconnects; the new instruction remains
        // separate from verified facts, and uncertain in-flight work is retained.
        t.objective = objective.chars().take(12000).collect();
        if target.is_some() { t.target = target; }
        Ok(())
    })
}

pub fn cancel(app: &AppHandle, session: &str) -> Result<Task, String> {
    update(app, session, |t| { t.run += 1; t.status = "stopped".into(); Ok(()) })
}

pub fn bind(app: &AppHandle, session: &str) -> Result<Value, String> {
    let task = match get(app, session) { Some(t) => t, None => update(app, session, |_| Ok(()))? };
    Ok(json!({ "token": task.token, "run": task.run, "task": task }))
}

pub fn enter(app: &AppHandle, args: &Value) -> Result<Scope, String> {
    let auth = &args["_guillecode"];
    let token = auth["token"].as_str().ok_or("Falta el enlace de sesión del motor. Reiniciá el motor para cargar el plugin de escritorio.")?;
    let state = app.state::<Tasks>();
    let all = state.records.lock().unwrap();
    let task = all.values().find(|t| t.token == token).ok_or("enlace de sesión vencido: reiniciá el motor")?;
    let run = auth["run"].as_u64().ok_or("falta la generación de la tarea")?;
    validate(task, run)?;
    let caller = Caller { session: task.session.clone(), run };
    Ok(Scope(CALLER.with(|c| c.replace(Some(caller)))))
}

fn validate(task: &Task, run: u64) -> Result<(), String> {
    if task.run != run || task.status == "stopped" { return Err("Tarea detenida o reemplazada. No se ejecutaron más pasos.".into()); }
    Ok(())
}

pub fn observer() -> String { CALLER.with(|c| c.borrow().as_ref().map(|v| v.session.clone()).unwrap_or_default()) }
pub fn identity() -> Option<(String, u64)> { CALLER.with(|c| c.borrow().as_ref().map(|v| (v.session.clone(), v.run))) }
pub fn restore(identity: Option<(String, u64)>) -> Scope {
    Scope(CALLER.with(|c| c.replace(identity.map(|(session, run)| Caller { session, run }))))
}

pub fn check(app: &AppHandle) -> Result<(), String> {
    super::gate(app)?;
    CALLER.with(|c| match c.borrow().as_ref() {
        Some(caller) => get(app, &caller.session).ok_or("sesión perdida".into()).and_then(|t| validate(&t, caller.run)),
        None => Ok(()), // native context acquisition / isolated native tests
    })
}

pub fn current(app: &AppHandle) -> Option<Task> { get(app, &observer()) }

pub fn plan(app: &AppHandle, objective: &str, next: &str) -> Result<Task, String> {
    check(app)?;
    update(app, &observer(), |t| {
        if !objective.trim().is_empty() { t.objective = objective.chars().take(12000).collect(); }
        t.next = next.chars().take(4000).collect();
        t.status = "running".into();
        Ok(())
    })
}

pub fn release_target(app: &AppHandle, session: &str) -> Result<(), String> {
    update(app, session, |t| { t.target = None; Ok(()) }).map(|_| ())
}

pub fn set_target(app: &AppHandle, window: &str) -> Result<(), String> {
    update(app, &observer(), |t| { t.target = Some(window.into()); Ok(()) }).map(|_| ())
}

pub fn checkpoint(app: &AppHandle, label: &str, evidence: &str, next: &str, complete: bool) -> Result<Task, String> {
    check(app)?;
    if label.trim().is_empty() || evidence.trim().is_empty() { return Err("el checkpoint necesita resultado y evidencia verificada".into()); }
    update(app, &observer(), |t| {
        t.checkpoints.push(Checkpoint { label: label.chars().take(500).collect(), evidence: evidence.chars().take(4000).collect(), at: chrono::Utc::now().timestamp_millis() });
        if t.checkpoints.len() > 100 { t.checkpoints.remove(0); }
        t.next = next.chars().take(4000).collect();
        t.in_flight = None;
        t.status = if complete { "completed" } else { "running" }.into();
        Ok(())
    })
}

pub fn flight(app: &AppHandle, action: Option<String>) -> Result<(), String> {
    if observer().is_empty() { return Ok(()); }
    check(app)?;
    update(app, &observer(), |t| {
        if action.is_some() {
            t.first_action.get_or_insert_with(|| chrono::Utc::now().timestamp_millis());
            t.actions += 1;
        }
        t.in_flight = action;
        Ok(())
    }).map(|_| ())
}

pub fn metric(app: &AppHandle, tool: &str, milliseconds: u128, ok: bool) {
    use std::io::Write;
    let Some((session, run)) = identity() else { return };
    let Some(path) = app.state::<Tasks>().path.as_ref().map(|p| p.with_file_name("desktop-metrics.jsonl")) else { return };
    if path.metadata().map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("previous.jsonl"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let task = get(app, &session);
        let row = json!({"at":chrono::Utc::now().timestamp_millis(),"session":session,"run":run,"tool":tool,"ms":milliseconds,"ok":ok,
            "firstActionMs":task.as_ref().and_then(|t| t.first_action.map(|at| at - t.started)), "actions":task.map(|t| t.actions)});
        let _ = writeln!(file, "{}", row);
    }
}

#[tauri::command]
pub fn desktop_task_get(app: AppHandle, session: String) -> Option<Task> { get(&app, &session) }
#[tauri::command]
pub fn desktop_task_cancel(app: AppHandle, session: String) -> Result<Task, String> { cancel(&app, &session) }
#[tauri::command]
pub fn desktop_task_begin(app: AppHandle, session: String, instruction: String) -> Result<Task, String> { begin(&app, &session, &instruction, None) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_and_superseded_work_cannot_execute() {
        let mut task = Task { run: 4, status: "running".into(), ..Default::default() };
        assert!(validate(&task, 4).is_ok());
        assert!(validate(&task, 3).is_err());
        task.status = "stopped".into();
        assert!(validate(&task, 4).is_err());
    }
    #[test]
    fn persisted_checkpoint_does_not_expose_capability() {
        let task = Task { token: "secret".into(), in_flight: Some("guardar".into()), ..Default::default() };
        let value = serde_json::to_string(&task).unwrap();
        assert!(!value.contains("secret"));
        assert!(value.contains("guardar"));
    }
}
