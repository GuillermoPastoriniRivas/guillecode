mod capture;
mod attachments;
mod capabilities;
mod coordination;
mod conversation;
pub mod domain;
mod errors;
mod evidence;
mod folder_snapshot;
#[cfg(all(test, feature = "desktop-e2e"))]
mod integration;
#[cfg(all(test, feature = "desktop-e2e"))]
mod restart_tests;
mod retention;
mod runner;
mod skills;
mod staffing;

use domain::*;
use rusqlite::{params, Connection};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct TeamsState {
    store: Mutex<Store>,
    controls: Mutex<()>,
    error: Option<String>,
}

fn empty() -> Store {
    Store {
        schema_version: 2,
        teams: vec![],
        skills: catalog(),
        chats: vec![],
    }
}

fn db(app: &AppHandle) -> Result<Connection, String> {
    let path = crate::app_data_file(app, "teams.sqlite")
        .ok_or("No se pudo localizar la carpeta de datos")?;
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS team_store (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);").map_err(|e| e.to_string())?;
    Ok(db)
}

fn read_db(db: &Connection) -> Result<Store, String> {
    let data = db.query_row("SELECT document FROM team_store WHERE id=1", [], |r| {
        r.get::<_, String>(0)
    });
    let mut store = match data {
        Ok(data) => serde_json::from_str::<Store>(&data)
            .map_err(|e| format!("No se puede leer teams.sqlite: {}", e))?,
        Err(rusqlite::Error::QueryReturnedNoRows) => empty(),
        Err(e) => return Err(e.to_string()),
    };
    if ![1, 2].contains(&store.schema_version) {
        return Err("Versión de Equipos IA no compatible. Se preservó el archivo original".into());
    }
    store.schema_version = 2;
    skills::upgrade(&mut store);
    Ok(store)
}

fn write_db(db: &mut Connection, store: &Store) -> Result<(), String> {
    let data = serde_json::to_string(store).map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO team_store(id, document) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", params![data]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn read(app: &AppHandle) -> Result<Store, String> {
    let state = app.state::<TeamsState>();
    if let Some(e) = &state.error {
        return Err(e.clone());
    }
    let result = state.store.lock().map_err(|e| e.to_string())?.clone();
    Ok(result)
}

fn owns_session(c: &Chat, session: &str) -> bool {
    !session.is_empty() && (c.messages.iter().any(|m| m.session_id.as_deref() == Some(session)) || c.runs.iter().any(|r| {
                    r.plan_session_id.as_deref() == Some(session)
                        || r.closing_sessions.iter().any(|id| id == session)
                        || r.coordination
                            .iter()
                            .any(|c| c.sessions.iter().any(|id| id == session))
                        || r.tasks.iter().flat_map(|t| &t.attempts).any(|a| {
                            a.session_id.as_deref() == Some(session)
                                || a.review_session_id.as_deref() == Some(session)
                        })
                }))
}

pub fn is_team_session(app: &AppHandle, session: &str) -> bool {
    app.try_state::<TeamsState>().and_then(|state| state.store.lock().ok().map(|s|
        s.chats.iter().any(|c| owns_session(c, session)))).unwrap_or(false)
}

/// The native session registry, never model arguments, assigns every team
/// session to the single Chrome workspace selected for its chat.
pub(crate) fn browser_session(app: &AppHandle, session: &str) -> String {
    app.try_state::<TeamsState>().and_then(|state| state.store.lock().ok().and_then(|s|
        browser_owner(&s, session)))
        .unwrap_or_else(|| session.to_string())
}

fn browser_owner(store: &Store, session: &str) -> Option<String> {
    store.chats.iter().find(|c| owns_session(c, session)).map(|c| format!("team:{}", c.id))
}

pub fn busy(app: &AppHandle) -> bool {
    app.try_state::<TeamsState>()
        .and_then(|state| {
            state.store.lock().ok().map(|s| {
                s.chats.iter().any(|c| c.messages.iter().any(|m| m.status == "pending")) || s.chats
                    .iter()
                    .flat_map(|c| &c.runs)
                    .any(|r| active(&r.status) || runner::unsettled(r))
            })
        })
        .unwrap_or(false)
}

pub fn update<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<TeamsState>();
    if let Some(e) = &state.error {
        return Err(e.clone());
    }
    let mut guard = state.store.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let result = f(&mut next)?;
    write_db(&mut db(app)?, &next)?;
    *guard = next;
    drop(guard);
    let _ = app.emit("team://changed", ());
    Ok(result)
}

pub fn run(app: &AppHandle, id: &str) -> Result<Run, String> {
    read(app)?
        .chats
        .into_iter()
        .flat_map(|c| c.runs)
        .find(|r| r.id == id)
        .ok_or("Ejecución inexistente".into())
}

pub fn update_run<T>(
    app: &AppHandle,
    id: &str,
    f: impl FnOnce(&mut Run) -> Result<T, String>,
) -> Result<T, String> {
    update(app, |s| {
        let r = s
            .chats
            .iter_mut()
            .flat_map(|c| c.runs.iter_mut())
            .find(|r| r.id == id)
            .ok_or("Ejecución inexistente")?;
        f(r)
    })
}

pub fn start(app: &AppHandle) {
    let loaded = db(app).and_then(|d| read_db(&d));
    let (mut store, error) = match loaded {
        Ok(s) => (s, None),
        Err(e) => {
            log::error!("[teams] {}", e);
            (empty(), Some(e))
        }
    };
    recover(&mut store);
    app.manage(TeamsState {
        store: Mutex::new(store),
        controls: Mutex::new(()),
        error,
    });
    if let Err(e) = update(app, |_| Ok(())) {
        log::error!("[teams] {}", e);
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = retention::sweep(&handle) {
            log::warn!("[teams-retention] {}", e);
        }
        std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
    });
}

fn recover(store: &mut Store) {
    // Recovery never replays a prompt. Explicit resume reconciles each recorded session first.
    for chat in &mut store.chats {
        for m in &mut chat.messages {
            if m.status == "pending" {
                m.status = "interrupted".into();
                m.text = "La aplicación se cerró antes de terminar esta respuesta. Podés volver a preguntar; tu mensaje quedó guardado y no se repitió ninguna operación.".into();
            }
        }
        for r in &mut chat.runs {
            if active(&r.status) {
                r.status = "blocked".into();
                r.error = Some("El proceso se interrumpió. Inspeccioná las sesiones y reanudá para reconciliar el motor sin repetir operaciones automáticamente.".into());
            }
        }
    }
}

fn canonical(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Carpeta no disponible: {} ({})", path, e))?;
    if !p.is_dir() {
        return Err("Se esperaba una carpeta".into());
    }
    Ok(p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

#[tauri::command]
pub fn teams_state(app: AppHandle) -> Result<Store, String> {
    read(&app)
}

#[tauri::command]
pub fn team_chat_send(app: AppHandle, chat_id: String, text: String, images: Option<Vec<ImageInput>>) -> Result<String, String> {
    conversation::send(app, chat_id, text, images.unwrap_or_default())
}

#[tauri::command]
pub async fn team_chat_cancel(app: AppHandle, chat_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || conversation::cancel(&app, &chat_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn team_image_read(app: AppHandle, image_id: String) -> Result<String, String> {
    let store = read(&app)?;
    let image = store.chats.iter().flat_map(|c| c.messages.iter().flat_map(|m| &m.images).chain(c.runs.iter().flat_map(|r| &r.images)))
        .find(|i| i.id == image_id).ok_or("Esta imagen no pertenece a un chat de equipos")?;
    attachments::data_url(&app, image)
}

#[tauri::command]
pub fn teams_save(app: AppHandle, mut team: Team) -> Result<Team, String> {
    team.project_root = canonical(&team.project_root)?;
    team.allowed_repositories = team
        .allowed_repositories
        .iter()
        .map(|p| canonical(p))
        .collect::<Result<_, _>>()?;
    team.allowed_repositories.sort_by_key(|p| p.to_lowercase());
    team.allowed_repositories.dedup_by(|a, b| same_path(a, b));
    update(&app, |s| {
        validate_team(&team, &s.skills)?;
        if team.id.is_empty() {
            team.id = id();
        }
        team.updated_at = now();
        s.teams.retain(|t| t.id != team.id);
        s.teams.push(team.clone());
        Ok(team)
    })
}

#[tauri::command]
pub fn teams_delete(app: AppHandle, id: String) -> Result<(), String> {
    update(&app, |s| {
        s.teams.retain(|t| t.id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn team_skills_save(app: AppHandle, mut skill: Skill) -> Result<Skill, String> {
    if skill.name.trim().is_empty()
        || skill.instructions.trim().is_empty()
        || skill.instructions.len() > 32_000
    {
        return Err("La skill necesita nombre e instrucciones (máximo 32 KB)".into());
    }
    update(&app, |s| {
        if skill.id.is_empty() {
            skill.id = id();
        }
        skill.version = s
            .skills
            .iter()
            .filter(|v| v.id == skill.id)
            .map(|v| v.version)
            .max()
            .unwrap_or(0)
            + 1;
        s.skills.push(skill.clone());
        Ok(skill)
    })
}

#[tauri::command]
pub fn team_chats_create(app: AppHandle, team_id: String) -> Result<Chat, String> {
    update(&app, |s| {
        let team = s
            .teams
            .iter()
            .find(|t| t.id == team_id)
            .ok_or("Equipo inexistente")?
            .clone();
        let chat = Chat {
            messages: vec![],
            id: id(),
            title: team.name.clone(),
            archived: false,
            team,
            skills: s.skills.clone(),
            created_at: now(),
            runs: vec![],
        };
        s.chats.push(chat.clone());
        Ok(chat)
    })
}

#[tauri::command]
pub fn team_chats_auto(
    app: AppHandle,
    project_root: String,
    model: ModelRef,
    variant: Option<String>,
) -> Result<Chat, String> {
    let root = canonical(&project_root)?;
    update(&app, |s| {
        let lead_id = id();
        let refs = s
            .skills
            .iter()
            .filter(|skill| {
                ["team-lead", "comportamientos"].contains(&skill.id.as_str())
                    && !s
                        .skills
                        .iter()
                        .any(|v| v.id == skill.id && v.version > skill.version)
            })
            .map(|skill| SkillRef {
                id: skill.id.clone(),
                version: skill.version,
            })
            .collect();
        let team = Team {
            autonomous: true,
            id: id(),
            name: "Modo equipo".into(),
            project_root: root.clone(),
            allowed_repositories: vec![root.clone()],
            lead_agent_id: lead_id.clone(),
            members: vec![Employee {
                id: lead_id,
                name: "Lead".into(),
                role: "Lead".into(),
                model,
                variant,
                skill_refs: refs,
                instructions: String::new(),
                tools: [
                    "read",
                    "glob",
                    "grep",
                    "edit",
                    "write",
                    "apply_patch",
                    "bash",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
                max_concurrent_tasks: 1,
            }],
            max_parallel_tasks: staffing::MAX_WORKERS,
            max_retries_per_task: 1,
            updated_at: now(),
            evidence_targets: vec![],
            limits: Limits::default(),
        };
        validate_team(&team, &s.skills)?;
        let chat = Chat {
            messages: vec![],
            id: id(),
            title: "Modo equipo".into(),
            archived: false,
            team,
            skills: s.skills.clone(),
            created_at: now(),
            runs: vec![],
        };
        s.chats.push(chat.clone());
        Ok(chat)
    })
}

#[tauri::command]
pub fn team_chats_edit(
    app: AppHandle,
    id: String,
    title: String,
    archived: bool,
) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 160 {
        return Err("Título inválido".into());
    }
    update(&app, |s| {
        let c = s
            .chats
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or("Chat inexistente")?;
        c.title = title;
        c.archived = archived;
        Ok(())
    })
}

#[tauri::command]
pub fn team_runs_start(app: AppHandle, chat_id: String, goal: String) -> Result<String, String> {
    start_run(app, chat_id, goal, vec![], None)
}

fn start_run(app: AppHandle, chat_id: String, goal: String, images: Vec<ChatImage>, source_reply: Option<&str>) -> Result<String, String> {
    if goal.trim().is_empty() || goal.len() > 64_000 {
        return Err("Ingresá un objetivo (máximo 64 KB)".into());
    }
    if crate::updates::installing(&app) {
        return Err("Esperá a que finalice la actualización".into());
    }
    let chat = read(&app)?
        .chats
        .into_iter()
        .find(|c| c.id == chat_id)
        .ok_or("Chat inexistente")?;
    evidence::validate_folders(&chat.team.allowed_repositories)?;
    let run_id = id();
    let dir = crate::app_data_file(&app, "comportamientos")
        .ok_or("Sin carpeta de datos")?
        .join(&run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    update(&app, |s| {
        let c = s
            .chats
            .iter()
            .find(|c| c.id == chat_id)
            .ok_or("Chat inexistente")?;
        if crate::updates::installing(&app) {
            return Err("Esperá a que finalice la actualización".into());
        }
        if c.archived {
            return Err("Restaurá el chat antes de continuar".into());
        }
        if source_reply.is_some_and(|id| !c.messages.iter().any(|m| m.id == id && m.status == "pending")) {
            return Err("Pedido del Lead detenido o ya finalizado; no se inició una ejecución nueva".into());
        }
        validate_team(&c.team, &c.skills)?;
        for r in s.chats.iter().flat_map(|c| &c.runs) {
            if (active(&r.status) || runner::unsettled(r))
                && (r
                    .team
                    .allowed_repositories
                    .iter()
                    .any(|a| c.team.allowed_repositories.iter().any(|b| overlaps(a, b))))
            {
                return Err(format!("Hay un equipo o una sesión pendiente en estos repositorios: {}. Reanudá o cancelá esa ejecución primero", r.id));
            }
        }
        let c = s
            .chats
            .iter_mut()
            .find(|c| c.id == chat_id)
            .ok_or("Chat inexistente")?;
        let prior = c
            .runs
            .last()
            .map(|r| {
                format!(
                    "\n\nEntrega previa ({}): {}\nFeedback actual: ",
                    r.id, r.summary
                )
            })
            .unwrap_or_default();
        c.runs.push(Run {
            images: images.clone(),
            guidance: vec![],
            chat_summary: None,
            id: run_id.clone(),
            goal: format!("{}{}", prior, goal),
            team: c.team.clone(),
            skills: c.skills.clone(),
            status: "planning".into(),
            started_at: now(),
            finished_at: None,
            plan_session_id: None,
            closing_sessions: vec![],
            closing_reviews: vec![],
            configuration_changes: vec![],
            coordination: vec![],
            tasks: vec![],
            summary: String::new(),
            error: None,
            evidence_dir: dir.to_string_lossy().into(),
            artifacts: vec![],
            baseline: vec![],
            notified: false,
            capture_targets: c.team.evidence_targets.clone(),
            observations: vec![],
            recovered_plan: None,
            session_usage: Default::default(),
            evidence_expired_at: None,
        });
        Ok(())
    })?;
    runner::launch(&app, &run_id);
    Ok(run_id)
}

#[tauri::command]
pub async fn team_runs_control(
    app: AppHandle,
    run_id: String,
    action: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || control(&app, &run_id, &action))
        .await
        .map_err(|e| e.to_string())?
}

fn control(app: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    // Two retries must never launch two schedulers for the same run. Keep control
    // reconciliation serialized independently from short persistence checkpoints.
    let state = app.state::<TeamsState>();
    let _control = state.controls.lock().map_err(|e| e.to_string())?;
    let r = run(app, id)?;
    match action {
        "pause" if matches!(r.status.as_str(), "running" | "planning") => {
            update_run(app, id, |r| {
                r.status = "paused".into();
                Ok(())
            })?;
        }
        "cancel" if active(&r.status) || r.status == "blocked" => {
            if r.status == "blocked" {
                runner::reconcile(app, &r, true)?;
            }
            update_run(app, id, |r| {
                r.status = if r.status == "blocked" {
                    "cancelled"
                } else {
                    "cancelling"
                }
                .into();
                if r.status == "cancelled" {
                    r.finished_at = Some(now());
                    for task in &mut r.tasks {
                        if task.status != "completed" {
                            task.status = "cancelled".into();
                        }
                    }
                }
                r.error = Some(
                    "Cancelación solicitada. Los cambios ya aplicados se conservan; revisá los archivos y la evidencia."
                        .into(),
                );
                Ok(())
            })?;
        }
        "resume" if r.status == "paused" => {
            update_run(app, id, |r| {
                r.status = if r.tasks.is_empty() {
                    "planning"
                } else {
                    "running"
                }
                .into();
                Ok(())
            })?;
        }
        "retry" if r.status == "blocked" || r.status == "failed" => {
            runner::reconcile(app, &r, false)?;
            update(app, |s| {
                let current = s
                    .chats
                    .iter()
                    .flat_map(|c| &c.runs)
                    .find(|v| v.id == id)
                    .ok_or("Ejecución inexistente")?;
                if s.chats.iter().flat_map(|c| &c.runs).any(|v| {
                    v.id != id
                        && (active(&v.status) || runner::unsettled(v))
                        && v.team.allowed_repositories.iter().any(|a| {
                            current
                                .team
                                .allowed_repositories
                                .iter()
                                .any(|b| overlaps(a, b))
                        })
                }) {
                    return Err("Otro equipo está usando estas carpetas".into());
                }
                let r = s
                    .chats
                    .iter_mut()
                    .flat_map(|c| &mut c.runs)
                    .find(|v| v.id == id)
                    .ok_or("Ejecución inexistente")?;
                for t in &mut r.tasks {
                    if t.status != "completed" {
                        t.status = if r
                            .coordination
                            .iter()
                            .any(|c| c.from_task_id == t.id && c.status != "resolved")
                        {
                            "waiting_dependency"
                        } else {
                            "pending"
                        }
                        .into();
                        t.error = None;
                    }
                }
                for c in &mut r.coordination {
                    if c.status == "blocked" {
                        c.status = "pending".into();
                    }
                }
                r.status = if r.tasks.is_empty() {
                    "planning"
                } else {
                    "running"
                }
                .into();
                r.error = None;
                Ok(())
            })?;
            runner::launch(app, id);
        }
        "approve" if r.status == "awaiting_manual_qa" => {
            update_run(app, id, |r| {
                r.status = "qa_approved".into();
                Ok(())
            })?;
        }
        _ => return Err("Esta acción no corresponde al estado actual".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn team_tasks_reassign(
    app: AppHandle,
    run_id: String,
    task_id: String,
    employee: Employee,
) -> Result<(), String> {
    update_run(&app, &run_id, |r| {
        if r.status != "blocked" || runner::unsettled(r) {
            return Err("Solo se reasignan tareas bloqueadas sin sesiones pendientes".into());
        }
        let t = r
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or("Tarea inexistente")?;
        if t.status == "completed" {
            return Err("La tarea ya terminó".into());
        }
        // Keep the chat's snapshot; record an explicit run-level configuration revision.
        let member = r
            .team
            .members
            .iter_mut()
            .find(|m| m.id == employee.id)
            .ok_or("Empleado inexistente")?;
        r.configuration_changes.push(serde_json::json!({"at":now(),"taskId":task_id,"beforeAgentId":t.assigned_agent_id,"agentId":employee.id,"beforeModel":member.model,"model":employee.model,"variant":employee.variant}));
        member.model = employee.model;
        member.variant = employee.variant;
        t.assigned_agent_id = member.id.clone();
        Ok(())
    })
}

#[tauri::command]
pub fn team_runs_model(
    app: AppHandle,
    run_id: String,
    agent_id: String,
    model: ModelRef,
    variant: Option<String>,
) -> Result<(), String> {
    if model.provider_id.is_empty() || model.model_id.is_empty() {
        return Err("Seleccioná un modelo disponible".into());
    }
    update_run(&app, &run_id, |r| {
        if r.status != "blocked" || runner::unsettled(r) {
            return Err("Reconfigurá solo una ejecución bloqueada sin sesiones pendientes".into());
        }
        let employee = r
            .team
            .members
            .iter_mut()
            .find(|a| a.id == agent_id)
            .ok_or("Empleado inexistente")?;
        r.configuration_changes.push(serde_json::json!({"at":now(),"agentId":agent_id,"beforeModel":employee.model,"model":model,"variant":variant}));
        employee.model = model;
        employee.variant = variant;
        Ok(())
    })
}

#[tauri::command]
pub fn team_runs_limits(app: AppHandle, run_id: String, limits: Limits) -> Result<(), String> {
    validate_limits(&limits)?;
    update_run(&app, &run_id, |r| {
        if r.status != "blocked" || runner::unsettled(r) {
            return Err(
                "Ajustá límites solo con la ejecución bloqueada y las sesiones detenidas".into(),
            );
        }
        r.configuration_changes
            .push(serde_json::json!({"at":now(),"beforeLimits":r.team.limits,"limits":limits}));
        r.team.limits = limits;
        Ok(())
    })
}

#[tauri::command]
pub fn team_evidence_read(app: AppHandle, run_id: String, path: String) -> Result<String, String> {
    let r = run(&app, &run_id)?;
    if !r
        .artifacts
        .iter()
        .any(|a| a.relative_path == path && a.status == "captured")
    {
        return Err("Artefacto no registrado".into());
    }
    let file = evidence::safe_path(&r.evidence_dir, &path, true)?;
    if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > (4 * evidence::LIMIT) as u64 {
        return Err("Archivo demasiado grande".into());
    }
    std::fs::read_to_string(file)
        .map(|s| evidence::sanitize(&s))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn team_evidence_image(
    app: AppHandle,
    run_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let r = run(&app, &run_id)?;
    let observation = r
        .observations
        .iter()
        .find(|o| o.artifact_path.as_deref() == Some(&path) && o.status == "captured")
        .ok_or("Captura no registrada")?;
    let file = evidence::safe_path(&r.evidence_dir, &path, true)?;
    let bytes = capture::png(&file)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if observation.sha256.as_deref() != Some(&hash) {
        return Err(
            "La captura cambió desde su registro; no se presenta como evidencia verificada".into(),
        );
    }
    Ok(
        serde_json::json!({"mime":"image/png","data":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":hash}),
    )
}

#[tauri::command]
pub fn team_evidence_open(app: AppHandle, run_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let r = run(&app, &run_id)?;
    app.opener()
        .open_path(r.evidence_dir, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chrome_workspace_belongs_to_chat_across_lead_workers_and_restart() {
        let team = domain::tests::team();
        let agent = team.members[0].clone();
        let chat: Chat = serde_json::from_value(serde_json::json!({"id":"chat","title":"Original","team":team,"skills":[],"archived":false,"createdAt":1,
            "messages":[{"id":"m","role":"assistant","text":"","createdAt":1,"status":"pending","runId":null,"sessionId":"conversation"}],
            "runs":[{"id":"r","goal":"goal","team":team,"skills":[],"status":"running","startedAt":1,"planSessionId":"plan","closingSessions":["closing"],
                "tasks":[{"id":"t","title":"browse","objective":"browse","assignedAgentId":agent.id,"repository":"C:/demo","dependencies":[],"expectedFiles":[],"acceptanceCriteria":["observed"],
                    "attempts":[{"id":"a","agent":agent,"sessionId":"worker","reviewSessionId":"review","startedAt":1,"status":"running","summary":"","commands":[]}]}],
                "summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false}]})).unwrap();
        let mut store = empty(); store.chats.push(chat);
        for session in ["conversation", "worker", "review", "plan", "closing"] {
            assert_eq!(browser_owner(&store, session).as_deref(), Some("team:chat"));
        }
        assert_eq!(browser_owner(&store, "normal-chat"), None);
        assert_eq!(browser_owner(&store, ""), None);
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)").unwrap();
        write_db(&mut db, &store).unwrap();
        let mut reopened = read_db(&db).unwrap(); recover(&mut reopened);
        assert_eq!(browser_owner(&reopened, "worker").as_deref(), Some("team:chat"));
        assert_eq!(browser_owner(&reopened, "conversation").as_deref(), Some("team:chat"));
    }
    #[test]
    fn persistence_is_versioned_and_keeps_skills() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)")
            .unwrap();
        let mut store = empty();
        store.skills[0].version = 2;
        write_db(&mut db, &store).unwrap();
        assert_eq!(read_db(&db).unwrap().skills[0].version, 2);
        store.schema_version = 900;
        write_db(&mut db, &store).unwrap();
        assert!(read_db(&db).is_err());
    }
    #[test]
    fn schema_one_migrates_without_losing_snapshot_or_history() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)")
            .unwrap();
        let mut team = serde_json::to_value(domain::tests::team()).unwrap();
        team.as_object_mut().unwrap().remove("evidenceTargets");
        team.as_object_mut().unwrap().remove("limits");
        let legacy = serde_json::json!({"schemaVersion":1,"teams":[team.clone()],"skills":catalog(),"chats":[{"id":"chat","title":"Original","team":team,"skills":[],"archived":false,"createdAt":12,"runs":[{"id":"original-run","goal":"Original goal","team":team,"skills":[],"status":"awaiting_manual_qa","startedAt":12,"finishedAt":13,"planSessionId":null,"tasks":[],"summary":"Entrega original","error":null,"evidenceDir":"original","artifacts":[],"baseline":[],"notified":true}]}]});
        db.execute("INSERT INTO team_store VALUES(1,?1)", [legacy.to_string()])
            .unwrap();
        let migrated = read_db(&db).unwrap();
        assert_eq!(migrated.schema_version, 2);
        assert!(migrated.teams[0].evidence_targets.is_empty());
        let run = &migrated.chats[0].runs[0];
        assert_eq!(run.summary, "Entrega original");
        assert_eq!(run.status, "awaiting_manual_qa");
        assert!(run.notified);
        assert!(run.observations.is_empty());
        assert!(run.session_usage.is_empty());
        write_db(&mut db, &migrated).unwrap();
        assert_eq!(read_db(&db).unwrap().chats[0].runs[0].id, "original-run");
    }
}
