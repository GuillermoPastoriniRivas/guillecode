use crate::oc::Opencode;
use crate::{app_data_file, ensure_server};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const TICK_SECS: u64 = 30;
const POLL_SECS: u64 = 5;
const MAX_RUN_MS: i64 = 45 * 60_000;
const HISTORY_LIMIT: usize = 20;
const SUMMARY_CHARS: usize = 4000;

#[derive(Serialize, Deserialize, Clone)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    Interval { hours: u32 },
    Daily { time: String },
    Weekly { days: Vec<u32>, time: String },
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub session_id: Option<String>,
    pub status: String,
    pub summary: String,
    pub error: Option<String>,
    pub manual: bool,
}

fn enabled_default() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub project: String,
    pub prompt: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub variant: Option<String>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub runs: Vec<RoutineRun>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineView {
    #[serde(flatten)]
    pub routine: Routine,
    pub next_run: Option<i64>,
}

pub struct RoutinesState {
    items: Mutex<Vec<Routine>>,
}

struct Outcome {
    status: &'static str,
    summary: String,
    error: Option<String>,
}

pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn parse_time(t: &str) -> NaiveTime {
    NaiveTime::parse_from_str(t.trim(), "%H:%M").unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap())
}

fn next_at(after: DateTime<Local>, time: NaiveTime, day_ok: impl Fn(u32) -> bool) -> Option<i64> {
    for offset in 0..9 {
        let date = after.date_naive() + ChronoDuration::days(offset);
        if !day_ok(date.weekday().num_days_from_monday()) {
            continue;
        }
        let candidate = Local.from_local_datetime(&date.and_time(time)).earliest()?;
        if candidate > after {
            return Some(candidate.timestamp_millis());
        }
    }
    None
}

pub fn next_run(r: &Routine) -> Option<i64> {
    if !r.enabled {
        return None;
    }
    let after_ms = r.runs.first().map(|x| x.started_at).unwrap_or(r.created_at);
    let after = Local.timestamp_millis_opt(after_ms).single()?;
    match &r.schedule {
        Schedule::Interval { hours } => Some(after_ms + (*hours).max(1) as i64 * 3_600_000),
        Schedule::Daily { time } => next_at(after, parse_time(time), |_| true),
        Schedule::Weekly { days, time } => next_at(after, parse_time(time), |d| days.contains(&d)),
    }
}

fn is_running(r: &Routine) -> bool {
    r.runs.first().map(|x| x.finished_at.is_none()).unwrap_or(false)
}

fn load(app: &AppHandle) -> Vec<Routine> {
    let mut items: Vec<Routine> = app_data_file(app, "routines.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for r in items.iter_mut() {
        if let Some(run) = r.runs.first_mut() {
            if run.finished_at.is_none() {
                run.finished_at = Some(now_ms());
                run.status = "interrumpida".into();
                run.error = Some("GuilleCode se cerró mientras corría".into());
            }
        }
    }
    items
}

fn persist(app: &AppHandle, items: &[Routine]) {
    if let Err(error) = persist_checked(app, items) {
        log::error!("[rutinas] {}", error);
    }
}

fn persist_checked(app: &AppHandle, items: &[Routine]) -> Result<(), String> {
    let path = app_data_file(app, "routines.json").ok_or("no se pudo localizar la carpeta de datos de GuilleCode")?;
    let data = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| format!("no se pudieron guardar las rutinas: {}", e))
}

fn changed(app: &AppHandle) {
    let _ = app.emit("routines://changed", ());
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let body: String = body.chars().take(220).collect();
    let _ = app.notification().builder().title(title).body(if body.is_empty() { " " } else { &body }).show();
}

fn update_run(app: &AppHandle, routine_id: &str, run_id: &str, f: impl FnOnce(&mut RoutineRun)) {
    let state = app.state::<RoutinesState>();
    let mut items = state.items.lock().unwrap();
    if let Some(run) = items
        .iter_mut()
        .find(|r| r.id == routine_id)
        .and_then(|r| r.runs.iter_mut().find(|x| x.id == run_id))
    {
        f(run);
    }
    persist(app, &items);
    drop(items);
    changed(app);
}

fn text_of(message: &Value) -> String {
    message["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text" && !p["synthetic"].as_bool().unwrap_or(false))
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn waiting_on_user(client: &Opencode, session_id: &str) -> bool {
    let mut ids: HashSet<String> = HashSet::from([session_id.to_string()]);
    if let Ok(children) = client.get(&format!("/session/{}/children", session_id)) {
        for c in children.as_array().into_iter().flatten() {
            if let Some(id) = c["id"].as_str() {
                ids.insert(id.to_string());
            }
        }
    }
    ["/permission", "/question"].iter().any(|path| {
        client
            .get(path)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .map(|list| list.iter().any(|x| x["sessionID"].as_str().map(|s| ids.contains(s)).unwrap_or(false)))
            .unwrap_or(false)
    })
}

fn execute(app: &AppHandle, routine: &Routine, run_id: &str) -> Result<Outcome, String> {
    if !std::path::Path::new(&routine.project).is_dir() {
        return Err(format!(
            "La carpeta de la rutina ya no existe ({}). Si era una feature eliminada, editá la rutina y elegí otra carpeta",
            routine.project
        ));
    }
    let server = ensure_server(app)?;
    let client = Opencode::new(&server, &routine.project);
    let models = crate::accounts::available_models(&client.get("/config/providers")?);
    if models.is_empty() {
        return Err("Conectá ChatGPT u OpenCode desde Cuentas de IA antes de ejecutar rutinas".into());
    }
    let model = if let Some(model) = &routine.model {
        models.iter().find(|(p, m)| p == &model.provider_id && m == &model.model_id)
            .ok_or("El modelo de esta rutina ya no está disponible. Elegí otro modelo o reconectá su cuenta en Cuentas de IA")?
    } else {
        &models[0]
    };
    let title = format!("Rutina · {} · {}", routine.name, Local::now().format("%d/%m %H:%M"));
    let session = client.post("/session", json!({ "title": title }))?;
    let session_id = session["id"].as_str().ok_or("opencode no devolvió la sesión")?.to_string();
    update_run(app, &routine.id, run_id, |run| run.session_id = Some(session_id.clone()));
    let mut body = json!({ "parts": [{ "type": "text", "text": routine.prompt }] });
    if let Some(agent) = routine.agent.as_ref().filter(|a| !a.is_empty()) {
        body["agent"] = json!(agent);
    }
    body["model"] = json!({ "providerID": model.0, "modelID": model.1 });
    if let Some(variant) = routine.variant.as_ref().filter(|v| !v.is_empty()) {
        body["variant"] = json!(variant);
    }
    client.post(&format!("/session/{}/prompt_async", session_id), body)?;
    let started = now_ms();
    let mut seen_busy = false;
    let mut warned = false;
    loop {
        std::thread::sleep(Duration::from_secs(POLL_SECS));
        let statuses = client.get("/session/status").unwrap_or(Value::Null);
        let busy = statuses[&session_id]["type"].as_str().map(|t| t != "idle").unwrap_or(false);
        seen_busy |= busy;
        if busy && !warned && waiting_on_user(&client, &session_id) {
            warned = true;
            update_run(app, &routine.id, run_id, |run| run.status = "esperando".into());
            notify(app, &format!("La rutina «{}» espera tu respuesta", routine.name), "Pide un permiso o te hace una pregunta. Abrí GuilleCode o el celular para contestar.");
        }
        if !busy && (seen_busy || now_ms() - started > 20_000) {
            break;
        }
        if now_ms() - started > MAX_RUN_MS {
            let _ = client.post(&format!("/session/{}/abort", session_id), json!({}));
            return Ok(Outcome { status: "timeout", summary: String::new(), error: Some("Superó los 45 minutos y se detuvo".into()) });
        }
    }
    let messages = client.get(&format!("/session/{}/message", session_id))?;
    let last = messages.as_array().and_then(|list| list.iter().rev().find(|m| m["info"]["role"] == "assistant"));
    let summary: String = last.map(text_of).unwrap_or_default().chars().take(SUMMARY_CHARS).collect();
    let error = last.and_then(|m| {
        let e = &m["info"]["error"];
        e["data"]["message"].as_str().or(e["name"].as_str()).map(String::from)
    });
    Ok(Outcome { status: if error.is_some() { "error" } else { "ok" }, summary, error })
}

pub fn launch(app: &AppHandle, id: &str, manual: bool) -> Result<(), String> {
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let routine = {
        let state = app.state::<RoutinesState>();
        let mut items = state.items.lock().unwrap();
        if crate::updates::installing(app) {
            return Err("GuilleCode se está actualizando; intentá cuando vuelva a abrirse".into());
        }
        let routine = items.iter_mut().find(|r| r.id == id).ok_or("no existe esa rutina")?;
        if is_running(routine) {
            return Err("la rutina ya está corriendo".into());
        }
        routine.runs.insert(
            0,
            RoutineRun {
                id: run_id.clone(),
                started_at: now_ms(),
                finished_at: None,
                session_id: None,
                status: "corriendo".into(),
                summary: String::new(),
                error: None,
                manual,
            },
        );
        routine.runs.truncate(HISTORY_LIMIT);
        let snapshot = routine.clone();
        persist(app, &items);
        snapshot
    };
    changed(app);
    let handle = app.clone();
    std::thread::spawn(move || {
        let outcome = execute(&handle, &routine, &run_id).unwrap_or_else(|e| Outcome { status: "error", summary: String::new(), error: Some(e) });
        update_run(&handle, &routine.id, &run_id, |run| {
            run.finished_at = Some(now_ms());
            run.status = outcome.status.into();
            run.summary = outcome.summary.clone();
            run.error = outcome.error.clone();
        });
        let title = match outcome.status {
            "ok" => format!("Rutina lista: {}", routine.name),
            _ => format!("La rutina «{}» falló", routine.name),
        };
        notify(&handle, &title, outcome.error.as_deref().unwrap_or(&outcome.summary));
    });
    Ok(())
}

fn tick(app: &AppHandle) {
    let now = now_ms();
    let due: Vec<String> = {
        let state = app.state::<RoutinesState>();
        let items = state.items.lock().unwrap();
        items
            .iter()
            .filter(|r| r.enabled && !is_running(r) && next_run(r).map(|n| n <= now).unwrap_or(false))
            .map(|r| r.id.clone())
            .collect()
    };
    for id in due {
        if let Err(e) = launch(app, &id, false) {
            log::warn!("[rutinas] no se pudo lanzar {}: {}", id, e);
        }
    }
}

pub fn start(app: &AppHandle) {
    app.manage(RoutinesState { items: Mutex::new(load(app)) });
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(TICK_SECS));
        tick(&handle);
    });
}

pub fn views(app: &AppHandle) -> Vec<RoutineView> {
    let state = app.state::<RoutinesState>();
    let items = state.items.lock().unwrap();
    items.iter().map(|r| RoutineView { routine: r.clone(), next_run: next_run(r) }).collect()
}

#[tauri::command]
pub fn routines_list(app: AppHandle) -> Vec<RoutineView> {
    views(&app)
}

#[tauri::command]
pub fn routines_save(app: AppHandle, routine: Routine) -> Result<RoutineView, String> {
    let state = app.state::<RoutinesState>();
    let mut items = state.items.lock().unwrap();
    let mut candidate = items.clone();
    let saved = save_into(&mut candidate, routine)?;
    persist_checked(&app, &candidate)?;
    *items = candidate;
    drop(items);
    changed(&app);
    let next = next_run(&saved);
    Ok(RoutineView { routine: saved, next_run: next })
}

pub fn update(app: &AppHandle, id: &str, patch: impl FnOnce(Routine) -> Result<Routine, String>) -> Result<RoutineView, String> {
    let state = app.state::<RoutinesState>();
    let mut items = state.items.lock().unwrap();
    let existing = items.iter().find(|r| r.id == id).ok_or("no existe esa rutina")?.clone();
    let mut candidate = items.clone();
    let saved = save_into(&mut candidate, patch(existing)?)?;
    persist_checked(app, &candidate)?;
    *items = candidate;
    drop(items);
    changed(app);
    let next = next_run(&saved);
    Ok(RoutineView { routine: saved, next_run: next })
}

fn validate_schedule(schedule: &Schedule) -> Result<(), String> {
    let valid_time = |time: &str| {
        time.len() == 5 && NaiveTime::parse_from_str(time, "%H:%M").is_ok()
    };
    match schedule {
        Schedule::Interval { hours } if *hours == 0 => Err("el intervalo debe ser de al menos una hora".into()),
        Schedule::Daily { time } | Schedule::Weekly { time, .. } if !valid_time(time) => Err("el horario debe ser HH:MM de 24 horas (hora local de esta PC)".into()),
        Schedule::Weekly { days, .. } if days.is_empty() || days.iter().any(|d| *d > 6) || days.iter().collect::<HashSet<_>>().len() != days.len() => Err("elegí días únicos entre 0 (lunes) y 6 (domingo)".into()),
        _ => Ok(()),
    }
}

fn save_into(items: &mut Vec<Routine>, routine: Routine) -> Result<Routine, String> {
    if routine.name.trim().is_empty() || routine.prompt.trim().is_empty() {
        return Err("la rutina necesita nombre e instrucciones".into());
    }
    if !std::path::Path::new(&routine.project).is_absolute() || !std::path::Path::new(&routine.project).is_dir() {
        return Err(format!("la carpeta del proyecto no existe: {}", routine.project));
    }
    validate_schedule(&routine.schedule)?;
    let saved = if let Some(existing) = items.iter_mut().find(|r| !routine.id.is_empty() && r.id == routine.id) {
        let runs = std::mem::take(&mut existing.runs);
        let created_at = existing.created_at;
        *existing = Routine { runs, created_at, ..routine };
        existing.clone()
    } else {
        if !routine.id.is_empty() {
            return Err("no existe esa rutina; consultá la lista antes de modificarla".into());
        }
        let fresh = Routine {
            id: uuid::Uuid::new_v4().simple().to_string(),
            created_at: now_ms(),
            runs: Vec::new(),
            ..routine
        };
        items.push(fresh.clone());
        fresh
    };
    Ok(saved)
}

#[tauri::command]
pub fn routines_delete(app: AppHandle, id: String) {
    let state = app.state::<RoutinesState>();
    let mut items = state.items.lock().unwrap();
    items.retain(|r| r.id != id);
    persist(&app, &items);
    drop(items);
    changed(&app);
}

#[tauri::command]
pub fn routines_set_enabled(app: AppHandle, id: String, enabled: bool) {
    let state = app.state::<RoutinesState>();
    let mut items = state.items.lock().unwrap();
    if let Some(r) = items.iter_mut().find(|r| r.id == id) {
        r.enabled = enabled;
        if enabled && r.runs.is_empty() {
            r.created_at = now_ms();
        }
    }
    persist(&app, &items);
    drop(items);
    changed(&app);
}

#[tauri::command]
pub fn routines_run_now(app: AppHandle, id: String) -> Result<(), String> {
    launch(&app, &id, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routine() -> Routine {
        Routine { id: String::new(), name: "Salud NOVORA".into(), project: std::env::current_dir().unwrap().to_string_lossy().into(), prompt: "Solo diagnóstico".into(), schedule: Schedule::Weekly { days: vec![0, 1, 2, 3, 4], time: "11:30".into() }, agent: None, model: None, variant: None, enabled: true, created_at: 0, runs: vec![] }
    }

    #[test]
    fn native_create_update_and_unknown_id() {
        let mut items = vec![];
        let created = save_into(&mut items, routine()).unwrap();
        assert!(!created.id.is_empty());
        assert!(next_run(&created).is_some());
        let mut edit = created.clone();
        edit.name = "Nuevo nombre".into();
        edit.enabled = false;
        edit.created_at = 0;
        items[0].runs.push(RoutineRun { id: "run".into(), started_at: now_ms(), finished_at: Some(now_ms()), session_id: Some("session".into()), status: "ok".into(), summary: "diagnóstico".into(), error: None, manual: true });
        let updated = save_into(&mut items, edit).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(updated.runs[0].session_id.as_deref(), Some("session"));
        assert!(next_run(&updated).is_none());
        let mut missing = routine();
        missing.id = "missing".into();
        assert!(save_into(&mut items, missing).is_err());
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn invalid_schedules_are_rejected_instead_of_silently_using_nine_am() {
        for schedule in [Schedule::Interval { hours: 0 }, Schedule::Daily { time: "25:00".into() }, Schedule::Daily { time: "9:00".into() }, Schedule::Weekly { days: vec![], time: "11:30".into() }, Schedule::Weekly { days: vec![7], time: "11:30".into() }, Schedule::Weekly { days: vec![0, 0], time: "11:30".into() }] {
            assert!(validate_schedule(&schedule).is_err());
        }
        assert!(validate_schedule(&routine().schedule).is_ok());
    }
}
