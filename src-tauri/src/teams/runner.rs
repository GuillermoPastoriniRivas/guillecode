use super::{domain::*, evidence, run, update_run};
use crate::oc::Opencode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

const READ_TOOLS: &[&str] = &["read", "glob", "grep"];
const POLICY: &str = "[GUILLECODE_TEAM_RUN] Sos parte de un equipo solicitado por el usuario. El Lead planifica, delega y revisa; el scheduler controla la concurrencia, permisos y reintentos. No uses subagentes ni herramientas de delegación adicionales: la relación tarea/sesión la administra el runner. Respetá AGENTS.md y los cambios previos del usuario. Releé antes de editar. No borres trabajo ajeno ni hagas reset, clean, push, merge remoto, despliegues o cambios destructivos. No leas secretos ni publiques datos personales. Trabajá solo dentro de la carpeta indicada. Git es opcional: no inicialices un repositorio si la carpeta no lo usa. Las skills son instrucciones, no permisos. No inventes tests, capturas ni resultados. No cambies de carpeta con comandos de shell. Si falta autorización, usá los permisos del motor o reportá el bloqueo. bash es el NOMBRE DE LA HERRAMIENTA de OpenCode, no un requisito de usar Bash como intérprete. En Windows esa herramienta puede ejecutar PowerShell: sus resultados observados son válidos. No exijas instalar Bash/WSL ni envolver comandos válidos en bash.exe. En el JSON de resultado, checks contiene SOLO comandos de verificación satisfactorios copiados exactamente del argumento command de la herramienta, sin explicaciones, código de salida añadido ni Markdown. Los diagnósticos fallidos van en limitations; si falla una comprobación necesaria, el trabajo sigue bloqueado. En cada respuesta JSON agregá chatSummary con done, tested y pending: tres frases breves en español, una por campo, de hasta 180 caracteres cada una. done dice qué hiciste; tested solo qué probaste realmente y su resultado; pending explica qué falta o dice Nada pendiente solo si está comprobado. Si solo planificaste, decí que todavía no implementaste ni probaste. Escribí como en un chat normal, sin puertos, rutas, nombres internos ni repetir el contrato. Los comandos y el razonamiento técnico van en summary/checks para verlos plegados. No ocultes fallos ni presentes pruebas pendientes como aprobadas. Respondé en español.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResult {
    status: String,
    summary: String,
    checks: Vec<String>,
    limitations: Vec<String>,
    #[serde(default)]
    request: Option<DependencyRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DependencyRequest {
    message: String,
    #[serde(default)]
    task_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Closeout {
    #[serde(default, deserialize_with = "optional_chat_summary")]
    chat_summary: Option<ChatSummary>,
    #[serde(default)]
    agents: Vec<AgentProposal>,
    #[serde(flatten)]
    review: Review,
    #[serde(default)]
    tasks: Vec<Task>,
}

fn optional_chat_summary<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<ChatSummary>, D::Error> {
    // A presentation-only brief must not invalidate a valid technical verdict.
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

pub fn unsettled(r: &Run) -> bool {
    r.coordination.iter().any(|c| c.status == "checking")
        || r.tasks.iter().flat_map(|t| &t.attempts).any(|a| {
            a.finished_at.is_none() && (a.session_id.is_some() || a.review_session_id.is_some())
        })
}

fn notify(app: &AppHandle, r: &Run, done: bool) {
    if cfg!(test) {
        let _ = app.emit("team://test-notice", json!({"runId":r.id,"done":done}));
        return;
    }
    let title = format!(
        "GuilleCode — {} {}",
        r.team.name,
        if done {
            "terminó"
        } else {
            "necesita tu atención"
        }
    );
    let body = if done {
        format!(
            "Terminamos. Evidencias: {}. Queda pendiente tu QA manual.",
            r.evidence_dir
        )
    } else {
        r.error
            .as_ref()
            .map(|error| super::errors::message(&json!(error)))
            .unwrap_or_else(|| "Revisá las sesiones del equipo".into())
    };
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
    // Push is optional and uses the existing subscriptions/preferences.
    crate::push::send_in_background(
        app,
        crate::push::Notice {
            kind: if done {
                crate::push::Kind::Done
            } else {
                crate::push::Kind::Attention
            },
            title,
            body,
            tag: format!("team-{}", r.id),
            url: "/".into(),
        },
    );
    let _ = app.emit(
        if done {
            "team://run-completed"
        } else {
            "team://run-blocked"
        },
        json!({"runId":r.id}),
    );
}

pub(super) fn client(app: &AppHandle, repo: &str) -> Result<Opencode, String> {
    Ok(Opencode::new(&crate::ensure_server(app)?, repo))
}

#[cfg(all(test, feature = "desktop-e2e"))]
pub(super) fn test_client(app: &AppHandle, repo: &str) -> Result<Opencode, String> {
    client(app, repo)
}

fn check_model(client: &Opencode, employee: &Employee) -> Result<(), String> {
    let providers = client.get("/config/providers")?;
    check_model_catalog(&providers, employee)
}

fn check_model_catalog(providers: &Value, employee: &Employee) -> Result<(), String> {
    if !crate::accounts::available_models(providers)
        .iter()
        .any(|(p, m)| p == &employee.model.provider_id && m == &employee.model.model_id)
    {
        return Err(format!(
            "El modelo {}/{} de {} no está disponible. Reconectá la cuenta o reasigná el modelo",
            employee.model.provider_id, employee.model.model_id, employee.name
        ));
    }
    if let Some(variant) = employee.variant.as_ref().filter(|s| !s.is_empty()) {
        let supported = providers["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == employee.model.provider_id)
            .and_then(|p| p["models"].get(&employee.model.model_id))
            .and_then(|m| m["variants"].as_object())
            .map(|v| v.contains_key(variant))
            .unwrap_or(false);
        if !supported {
            return Err(format!(
                "Variante no disponible para {}: {}",
                employee.name, variant
            ));
        }
    }
    Ok(())
}

fn ready_tasks(r: &Run, running: &HashSet<String>) -> Result<Vec<String>, String> {
    let mut dispatch = vec![];
    for t in &r.tasks {
        if t.status != "pending"
            || !t.dependencies.iter().all(|dep| {
                r.tasks
                    .iter()
                    .any(|t| &t.id == dep && t.status == "completed")
            })
        {
            continue;
        }
        if running.len() + dispatch.len() >= r.team.max_parallel_tasks {
            break;
        }
        let a = r
            .team
            .members
            .iter()
            .find(|a| a.id == t.assigned_agent_id)
            .ok_or("Empleado inexistente")?;
        let live: Vec<_> = r
            .tasks
            .iter()
            .filter(|v| running.contains(&v.id) || dispatch.contains(&v.id))
            .collect();
        if live.iter().any(|v| task_conflict(v, t))
            || live.iter().filter(|v| v.assigned_agent_id == a.id).count() >= a.max_concurrent_tasks
        {
            continue;
        }
        dispatch.push(t.id.clone());
    }
    Ok(dispatch)
}

pub fn session_permissions(employee: &Employee, readonly: bool) -> Value {
    scoped_permissions(employee, readonly, &[])
}

fn scoped_permissions(employee: &Employee, readonly: bool, paths: &[String]) -> Value {
    let mut rules = vec![json!({"permission":"*","pattern":"*","action":"deny"})];
    let tools: Vec<&str> = if readonly {
        READ_TOOLS.to_vec()
    } else {
        employee.tools.iter().map(String::as_str).collect()
    };
    for tool in tools {
        if !paths.is_empty() && ["write", "edit", "apply_patch"].contains(&tool) {
            for path in paths {
                let path = path.replace('\\', "/");
                let pattern = if path.ends_with('/') {
                    format!("{}**", path)
                } else {
                    path
                };
                rules.push(json!({"permission":"edit","pattern":pattern,"action":"allow"}));
            }
            continue;
        }
        rules.push(json!({"permission": if ["write","edit","apply_patch"].contains(&tool) { "edit" } else {tool}, "pattern":"*", "action":if tool == "bash" {"ask"} else {"allow"}}));
    }
    if !readonly && employee.tools.iter().any(|t| t == "bash") {
        // Exact verification commands only. Extra arguments/operators still use
        // the engine's ask rule; no wildcard shell permission is granted.
        for command in [
            "npm test",
            "npm run test",
            "npm run build",
            "npm run lint",
            "npm run typecheck",
            "npm run test:unit",
            "npm run test:e2e",
            "pnpm test",
            "pnpm run build",
            "pnpm run lint",
            "yarn test",
            "yarn build",
            "cargo test",
            "cargo check",
            "node --test",
            "python -m pytest",
            "pytest",
            "dotnet test",
            "go test ./...",
        ] {
            rules.push(json!({"permission":"bash","pattern":command,"action":"allow"}));
        }
    }
    rules.push(json!({"permission":"external_directory","pattern":"*","action":"deny"}));
    for pattern in [".git/**", "**/.git/**"] {
        rules.push(json!({"permission":"edit","pattern":pattern,"action":"deny"}));
    }
    for pattern in [
        "*.env",
        "*.env.*",
        "**/.env",
        "**/.env.*",
        "**/auth.json",
        "**/credentials.json",
        "*.pem",
        "*.key",
        "**/id_rsa",
        "**/id_ed25519",
    ] {
        rules.push(json!({"permission":"read","pattern":pattern,"action":"deny"}));
        // A sensitive-file rule must not widen a scoped worker's edit access to
        // files owned by another agent. Unscoped sessions keep the normal ask.
        rules.push(json!({"permission":"edit","pattern":pattern,"action":if paths.is_empty() {"ask"} else {"deny"}}));
    }
    Value::Array(rules)
}

pub(super) fn create_session(
    client: &Opencode,
    employee: &Employee,
    title: &str,
    readonly: bool,
) -> Result<String, String> {
    check_model(client, employee)?;
    client.post("/session", json!({"title":format!("Equipo · {}",title), "permission":session_permissions(employee, readonly)}))?["id"].as_str().map(String::from).ok_or("OpenCode no devolvió la sesión".into())
}

pub(super) fn skills_prompt(r: &Run, a: &Employee) -> String {
    a.skill_refs
        .iter()
        .filter_map(|reference| {
            r.skills
                .iter()
                .find(|s| s.id == reference.id && s.version == reference.version)
        })
        .map(|s| {
            format!(
                "{} v{}: {}\nComprobaciones: {}",
                s.name,
                s.version,
                s.instructions,
                s.verification_guidelines.join("; ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn execute(
    app: &AppHandle,
    run_id: &str,
    client: &Opencode,
    session: &str,
    employee: &Employee,
    prompt: &str,
    readonly: bool,
) -> Result<Value, String> {
    enforce_limits(&run(app, run_id)?)?;
    let ids = client.get("/experimental/tool/ids")?;
    let ids = ids
        .as_array()
        .ok_or("No se pudo verificar la lista de herramientas del motor")?;
    let tools: serde_json::Map<String, Value> = ids
        .iter()
        .filter_map(Value::as_str)
        .map(|name| {
            let allowed = if readonly {
                READ_TOOLS.contains(&name)
            } else {
                employee.tools.iter().any(|s| s == name)
            };
            (name.into(), json!(allowed))
        })
        .collect();
    if run(app, run_id)?.status == "cancelling" {
        return Err("Cancelación solicitada antes de enviar".into());
    }
    let guidance = run(app, run_id)?.guidance.join("\n");
    let prompt = format!("{}\nINDICACIONES POSTERIORES DEL USUARIO (aplicar a este paso sin ampliar permisos):\n{}", prompt, guidance);
    let mut body = json!({"agent":"build", "model":employee.model, "system":POLICY, "tools":tools, "parts":[{"type":"text", "text":prompt}]});
    if let Some(v) = employee.variant.as_ref().filter(|v| !v.is_empty()) {
        body["variant"] = json!(v);
    }
    // The session ID has already been durably committed by the caller.
    client.post(&format!("/session/{}/prompt_async", session), body)?;
    let start = Instant::now();
    let mut waiting = false;
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = run(app, run_id)?;
        if state.status == "cancelling" || start.elapsed() > Duration::from_secs(45 * 60) {
            stop(client, session)?;
            return Err(if state.status == "cancelling" {
                "Cancelado. Se conservan los cambios ya aplicados"
            } else {
                "Se alcanzó el límite de 45 minutos por sesión"
            }
            .into());
        }
        let statuses = client.get("/session/status")?;
        let live_messages = client.get(&format!("/session/{}/message", session))?;
        record_usage(app, run_id, session, &live_messages)?;
        if let Err(e) = enforce_limits(&run(app, run_id)?) {
            stop(client, session)?;
            return Err(e);
        }
        if !statuses.is_object() {
            return Err(
                "Estado de sesiones inválido; es necesario reconciliar antes de reintentar".into(),
            );
        }
        let busy = statuses[session]["type"]
            .as_str()
            .map(|s| s != "idle")
            .unwrap_or(false);
        let requests = client.get("/permission")?;
        let awaiting = requests
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["sessionID"] == session);
        if awaiting && !waiting {
            waiting = true;
            update_run(app, run_id, |r| {
                r.error = Some(format!("{} espera un permiso de OpenCode. Abrí su sesión desde Actividad para responder", employee.name));
                Ok(())
            })?;
            notify(app, &run(app, run_id)?, false);
        } else if waiting && !awaiting {
            waiting = false;
            update_run(app, run_id, |r| {
                r.error = None;
                Ok(())
            })?;
        }
        if busy || awaiting {
            continue;
        }
        let messages = client.get(&format!("/session/{}/message", session))?;
        let last = messages
            .as_array()
            .and_then(|v| v.iter().rev().find(|m| m["info"]["role"] == "assistant"));
        if let Some(last) = last {
            if last["info"]["error"].is_object() {
                return Err(super::errors::message(&last["info"]["error"]));
            }
            // An idle/missing status alone is not evidence of a completed response.
            if last["info"]["time"]["completed"].as_i64().is_some()
                && ["stop", "end_turn"].contains(&last["info"]["finish"].as_str().unwrap_or(""))
            {
                return Ok(messages);
            }
            if last["info"]["time"]["completed"].as_i64().is_some()
                && last["info"]["finish"] == "length"
            {
                return Err("El modelo agotó el contexto sin finalizar la tarea".into());
            }
        }
        if start.elapsed() > Duration::from_secs(90) && last.is_none() {
            return Err("La sesión quedó inactiva sin respuesta final".into());
        }
    }
}

fn usage(messages: &Value) -> Value {
    let mut cost = 0.0;
    let mut tokens = 0u64;
    for m in messages
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["info"]["role"] == "assistant")
    {
        cost += m["info"]["cost"].as_f64().unwrap_or(0.0).max(0.0);
        for k in ["input", "output", "reasoning"] {
            tokens = tokens.saturating_add(m["info"]["tokens"][k].as_u64().unwrap_or(0));
        }
    }
    json!({"costUsd":cost,"tokens":tokens,"source":"OpenCode message metadata"})
}
fn record_usage(app: &AppHandle, id: &str, session: &str, messages: &Value) -> Result<(), String> {
    let mut value = usage(messages);
    if run(app, id)?.session_usage.get(session) != Some(&value) {
        update_run(app, id, |r| {
            if let Some(previous) = r.session_usage.get(session) {
                value["costUsd"] = json!(value["costUsd"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .max(previous["costUsd"].as_f64().unwrap_or(0.0)));
                value["tokens"] = json!(value["tokens"]
                    .as_u64()
                    .unwrap_or(0)
                    .max(previous["tokens"].as_u64().unwrap_or(0)));
            }
            r.session_usage.insert(session.into(), value);
            Ok(())
        })?;
    }
    Ok(())
}
fn enforce_limits(r: &Run) -> Result<(), String> {
    let limits = &r.team.limits;
    let cost: f64 = r
        .session_usage
        .values()
        .filter_map(|v| v["costUsd"].as_f64())
        .sum();
    let tokens: u64 = r
        .session_usage
        .values()
        .filter_map(|v| v["tokens"].as_u64())
        .sum();
    if limits
        .max_run_minutes
        .map(|n| now() - r.started_at >= n as i64 * 60_000)
        .unwrap_or(false)
    {
        return Err(
            "Se alcanzó el límite de duración de la ejecución; se conservan sesiones y cambios"
                .into(),
        );
    }
    if limits.max_cost_usd.map(|n| cost >= n).unwrap_or(false)
        || limits.max_tokens.map(|n| tokens >= n).unwrap_or(false)
    {
        return Err(
            "Se alcanzó el presupuesto de la ejecución según el uso informado por OpenCode".into(),
        );
    }
    Ok(())
}

fn stop(client: &Opencode, session: &str) -> Result<(), String> {
    client.post(&format!("/session/{}/abort", session), json!({}))?;
    for _ in 0..15 {
        let states = client.get("/session/status")?;
        if !states.is_object() {
            return Err("No se pudo confirmar la detención".into());
        }
        if states[session].is_null() || states[session]["type"] == "idle" {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(
        "La sesión aún está activa; no se libera la carpeta. Inspeccionala antes de reintentar"
            .into(),
    )
}

pub(super) fn final_text(messages: &Value) -> String {
    messages
        .as_array()
        .and_then(|v| v.iter().rev().find(|m| m["info"]["role"] == "assistant"))
        .map(|m| {
            m["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["type"] == "text" && p["synthetic"] != true)
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub fn observed_commands(messages: &Value) -> Vec<Value> {
    let mut commands: Vec<Value> = Vec::new();
    let mut pending: HashMap<String, (String, usize)> = HashMap::new();
    for p in messages.as_array().into_iter().flatten().flat_map(|m| m["parts"].as_array().into_iter().flatten()) {
        if p["type"] != "tool" || p["state"]["status"] != "completed" { continue; }
        let output = p["state"]["output"].as_str().unwrap_or("");
        if p["tool"] == "bash" {
            commands.push(json!({"command":evidence::sanitize(p["state"]["input"]["command"].as_str().unwrap_or("")), "exitCode":p["state"]["metadata"]["exit"], "output":evidence::sanitize(output), "source":"OpenCode completed tool part", "callId":p["callID"]}));
            continue;
        }
        if p["tool"] != "terminal_terminal_run" && p["tool"] != "terminal_terminal_read" { continue; }
        let Some(receipt) = output.lines().next().and_then(|line| line.strip_prefix(crate::desktop::terminal::RESULT_PREFIX)).and_then(|line| serde_json::from_str::<Value>(line).ok()) else { continue; };
        let (Some(id), Some(executed)) = (receipt["terminalId"].as_str(), receipt["executedCommand"].as_str()) else { continue; };
        let index = if p["tool"] == "terminal_terminal_run" {
            let Some(command) = p["state"]["input"]["command"].as_str() else { continue; };
            if command.trim().is_empty() || receipt["command"] != command.trim() || p["state"]["input"]["terminal"].as_str().is_some_and(|supplied| supplied != id) { continue; }
            let index = commands.len();
            commands.push(json!({"command":evidence::sanitize(command),"exitCode":null,"output":evidence::sanitize(output),"source":"GuilleCode native terminal receipt","callId":p["callID"],"terminalId":id}));
            pending.insert(id.into(), (executed.into(), index));
            index
        } else {
            if p["state"]["input"]["id"] != id { continue; }
            let Some((original, index)) = pending.get(id) else { continue; };
            if original != executed { continue; }
            *index
        };
        if receipt["finished"] == true {
            // No numeric exit status means unknown, never success. A readiness
            // match or timeout while a server runs is not a completed test.
            commands[index]["exitCode"] = receipt["exitCode"].as_i64().map_or(Value::Null, |n| json!(n));
            commands[index]["output"] = json!(evidence::sanitize(output));
        }
    }
    commands
}

fn checks_passed(checks: &[String], commands: &[Value]) -> bool {
    !checks.is_empty()
        && checks.iter().all(|check| {
            commands
                .iter()
                .any(|c| c["command"] == *check && c["exitCode"].as_i64() == Some(0))
        })
}

pub(super) fn lead(r: &Run) -> Result<Employee, String> {
    r.team
        .members
        .iter()
        .find(|m| m.id == r.team.lead_agent_id)
        .cloned()
        .ok_or("Falta Lead".into())
}

fn fallback_plan(r: &Run, reason: &str) -> (Plan, String) {
    let employee = r
        .team
        .members
        .iter()
        .find(|member| {
            member
                .tools
                .iter()
                .any(|tool| matches!(tool.as_str(), "edit" | "write" | "apply_patch"))
        })
        .or_else(|| {
            r.team
                .members
                .iter()
                .find(|member| member.id == r.team.lead_agent_id)
        })
        .expect("validate_team guarantees at least one Lead");
    let task = Task {
        id: "T1".into(),
        title: "Resolver el objetivo del usuario".into(),
        objective: r.goal.clone(),
        assigned_agent_id: employee.id.clone(),
        repository: r.team.allowed_repositories[0].clone(),
        dependencies: vec![],
        expected_files: vec![],
        write_paths: vec![],
        acceptance_criteria: vec![
            "Completar el objetivo y ejecutar las comprobaciones pertinentes".into(),
            "Informar cambios, resultados observados y cualquier limitación real".into(),
        ],
        status: "pending".into(),
        attempts: vec![],
        error: None,
    };
    (
        Plan {
            agents: vec![],
            tasks: vec![task],
            evidence_targets: vec![],
        },
        evidence::sanitize(reason),
    )
}

fn usable_plan(text: &str, r: &Run) -> (Plan, Option<String>) {
    match parse_json::<Plan>(text).and_then(|plan| {
        super::staffing::validate_assignments(&plan.agents, &plan.tasks)?;
        let team = super::staffing::with_agents(&r.team, &plan.agents, &r.skills)?;
        validate_plan(&plan, &team)?;
        Ok(plan)
    }) {
        Ok(plan) => (plan, None),
        Err(reason) => {
            let (plan, reason) = fallback_plan(r, &reason);
            (plan, Some(reason))
        }
    }
}

fn plan(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut r = run(app, id)?;
    evidence::validate_folders(&r.team.allowed_repositories)?;
    if r.baseline.is_empty() {
        r.baseline = evidence::baseline(
            &r.team.allowed_repositories,
            std::path::Path::new(&r.evidence_dir),
        )?;
        evidence::initial(&mut r)?;
        update_run(app, id, |v| {
            v.baseline = r.baseline.clone();
            v.artifacts = r.artifacts.clone();
            Ok(())
        })?;
    }
    let a = lead(&r)?;
    let client = client(app, &r.team.allowed_repositories[0])?;
    let session = if r.recovered_plan.is_some() {
        r.plan_session_id
            .clone()
            .ok_or("Plan recuperado sin sesión")?
    } else {
        create_session(&client, &a, &format!("{} · plan", r.team.name), true)?
    };
    update_run(app, id, |r| {
        r.plan_session_id = Some(session.clone());
        Ok(())
    })?;
    let prompt = format!("{}\n\nActuás como Team Lead. Descubrí convenciones y archivos. Proponé tareas completas asignadas a IDs del equipo según skills y carga; en modo automático podés proponer nuevos especialistas con agents. No modifiques archivos. Cada tarea trabaja en UNA carpeta autorizada; Git puede existir o no y nunca debe inicializarse por este requisito. Frontend, Backend y QA deben avanzar simultáneamente en archivos propios incluso dentro de la misma carpeta. Definí writePaths con archivos relativos o directorios terminados en /; son los únicos lugares que ese agente puede escribir. Repartí archivos compartidos a un único responsable. No agregues dependencias entre Frontend y Backend solo por consumir una API: acordá el contrato en los objetivos y dejá la integración final como tarea dependiente. Usá dependencies solo cuando no existe ningún trabajo útil antes de la entrega. Una tarea sin writePaths reserva toda la carpeta y se ejecuta sola. QA puede preparar pruebas en paralelo y ejecutar la integración al terminar ambos. Si falta QA, asigná comprobaciones a otro miembro o a vos. Cada trabajador debe ejecutar comprobaciones con bash y presentar resultados observados. No pidas aprobación de microtareas.\nOBJETIVO: {}\nEQUIPO: {}\nSKILLS DEL LEAD:\n{}\nBASELINE: {}\nRespondé SOLO JSON válido: {{\"tasks\":[{{\"id\":\"T1\",\"title\":\"…\",\"objective\":\"…\",\"assignedAgentId\":\"ID existente\",\"repository\":\"ruta autorizada exacta\",\"dependencies\":[],\"expectedFiles\":[\"ruta relativa\"],\"writePaths\":[\"ruta relativa o directorio/\"],\"acceptanceCriteria\":[\"comportamiento comprobable y pruebas pertinentes\"]}}]}}", POLICY, r.goal, serde_json::to_string(&r.team).map_err(|e| e.to_string())?, skills_prompt(&r, &a), evidence::sanitize(&serde_json::to_string(&r.baseline).map_err(|e| e.to_string())?));
    let prompt=format!("{}\nSi el proyecto tiene UI web y no hay flujos configurados en el equipo, agregá evidenceTargets al JSON del plan: [{{\"id\":\"flujo-estable\",\"name\":\"Flujo\",\"url\":\"http://localhost:PUERTO/ruta-local-descubierta\",\"width\":1280,\"height\":800,\"maskSelectors\":[],\"actions\":[],\"required\":false}}]. Solo URLs locales observadas en la configuración del repo; no inventes una URL ni levantes servicios desde esta sesión de lectura. Los pasos admiten {{kind:click|fill|wait,selector:selectorCSS,value:opcional}}; no incluyas secretos. El runner captura antes de cualquier escritura y después del trabajo. Si no hay UI, evidenceTargets vacío.",prompt);
    let prompt = format!(
        "{}{}\nCATÁLOGO DE SKILLS: {}",
        prompt,
        super::staffing::prompt(&r.team),
        serde_json::to_string(
            &r.skills
                .iter()
                .map(|s| json!({"id":s.id,"name":s.name}))
                .collect::<Vec<_>>()
        )
        .unwrap_or_default()
    );
    let messages = if let Some(text) = &r.recovered_plan {
        json!([{"info":{"role":"assistant"},"parts":[{"type":"text","text":text}]}])
    } else {
        execute(app, id, &client, &session, &a, &prompt, true)?
    };
    let (mut plan, automatic_recovery) = usable_plan(&final_text(&messages), &r);
    let planned_team = super::staffing::with_agents(&r.team, &plan.agents, &r.skills)?;
    for t in &mut plan.tasks {
        t.status = "pending".into();
        t.attempts.clear();
        t.error = None;
    }
    update_run(app, id, |r| {
        r.team = planned_team;
        r.tasks = plan.tasks;
        if let Some(reason) = automatic_recovery {
            r.configuration_changes.push(json!({
                "kind": "automaticPlanRecovery",
                "at": now(),
                "reason": reason,
                "result": "Se creó una tarea segura con el objetivo original"
            }));
        }
        if r.capture_targets.is_empty() {
            r.capture_targets = plan.evidence_targets;
        }
        if r.status != "paused" && r.status != "cancelling" {
            r.status = "running".into();
        }
        Ok(())
    })
}

fn collect_captures(app: &AppHandle, id: &str, phase: &str) -> Result<(), String> {
    let mut r = run(app, id)?;
    super::capture::collect(&mut r, phase)?;
    update_run(app, id, |current| {
        current.artifacts = r.artifacts;
        current.observations = r.observations;
        Ok(())
    })?;
    if phase == "before" || phase == "after" {
        for target in r.capture_targets.iter().filter(|t| t.required) {
            if !run(app, id)?
                .observations
                .iter()
                .rev()
                .find(|o| o.phase == phase && o.target_id == target.id)
                .map(|o| o.status == "captured")
                .unwrap_or(false)
            {
                return Err(format!(
                    "No se capturó el flujo obligatorio {} {} del trabajo. Iniciá la aplicación local y reintentá",
                    target.name, if phase == "before" { "antes" } else { "después" }
                ));
            }
        }
    }
    Ok(())
}

fn attempt_update(
    app: &AppHandle,
    run_id: &str,
    task_id: &str,
    f: impl FnOnce(&mut Task, &mut Attempt),
) -> Result<(), String> {
    update_run(app, run_id, |r| {
        let t = r
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or("Tarea inexistente")?;
        let mut a = t.attempts.pop().ok_or("Intento inexistente")?;
        f(t, &mut a);
        t.attempts.push(a);
        Ok(())
    })
}

fn worker(app: &AppHandle, run_id: &str, task_id: &str) -> Result<(), String> {
    let r = run(app, run_id)?;
    let t = r
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .ok_or("Tarea inexistente")?
        .clone();
    let a = t
        .attempts
        .last()
        .ok_or("Intento inexistente")?
        .agent
        .clone();
    let client = client(app, &t.repository)?;
    let recovering = t.attempts.last().map(|a| a.recovered).unwrap_or(false);
    let session = if recovering {
        t.attempts
            .last()
            .and_then(|a| a.session_id.clone())
            .ok_or("La sesión recuperada no está registrada")?
    } else {
        check_model(&client, &a)?;
        client.post("/session", json!({"title":format!("Equipo · {} · {} · {}", r.team.name, a.name, t.title), "permission":scoped_permissions(&a, false, &t.write_paths)}))?["id"].as_str().map(String::from).ok_or("OpenCode no devolvió la sesión")?
    };
    attempt_update(app, run_id, task_id, |_, at| {
        at.session_id = Some(session.clone())
    })?;
    let deps: Vec<_> = r
        .tasks
        .iter()
        .filter(|v| t.dependencies.contains(&v.id))
        .map(|v| json!({"task":v.title,"result":v.attempts.last().map(|a| &a.summary)}))
        .collect();
    let feedback = t.attempts.iter().rev().skip(1).map(|a| format!("Sesión previa: {}\nResumen: {}\nFeedback: {}\nComandos ya ejecutados (no repetir sin verificar sus efectos): {}",a.session_id.as_deref().unwrap_or("sin sesión"),a.summary,a.review.as_ref().map(|r|r.summary.as_str()).or(a.error.as_deref()).unwrap_or(""),serde_json::to_string(&a.commands).unwrap_or_default())).collect::<Vec<_>>().join("\n\n");
    let prompt = format!("{}\nROL: {} ({})\nINSTRUCCIONES: {}\nSKILLS HABILITADAS:\n{}\nOBJETIVO GENERAL: {}\nTAREA: {}\nCRITERIOS: {}\nCARPETA AUTORIZADA: {}\nARCHIVOS ESPERADOS (respetar la propiedad de escritura): {}\nCONTRATOS/DEPENDENCIAS: {}\nFEEDBACK PREVIO: {}\nNo alteres los cambios preexistentes. Leé archivos antes de escribirlos. Implementá, ejecutá pruebas pertinentes con bash y revisá resultados. No uses herramientas externas para saltar permisos de bash. Si no podés comprobar, devolvé blocked con motivo. Devolvé SOLO JSON: {{\"status\":\"completed|waiting_dependency|blocked|failed\",\"summary\":\"implementación, archivos modificados y resultados\",\"checks\":[\"comando EXACTO realmente ejecutado\"],\"limitations\":[\"limitaciones reales\"]}}", POLICY, a.name, a.role, a.instructions, skills_prompt(&r,&a), r.goal,t.objective,t.acceptance_criteria.join("; "),t.repository,t.expected_files.join(", "),serde_json::to_string(&deps).map_err(|e| e.to_string())?,feedback);
    let prompt = format!("{}\nESTADO DEL EQUIPO (IDs para pedidos al Lead): {}\nPROPIEDAD DE ESCRITURA: {}\nCOORDINACIÓN CON EL LEAD: {}\nOtros agentes trabajan simultáneamente. Solo escribí en writePaths cuando no esté vacío; no uses bash para modificar archivos ajenos. Podés leer los contratos de otros. Avanzá en todo lo independiente sin esperar a que termine otro agente. Si necesitás algo de otro, devolvé status=waiting_dependency y request={{message:pedido concreto,taskIds:[IDs de tareas relacionadas]}}; no lo trates como fallo. El Lead revisará archivos y el estado real, y continuará ESTA sesión con su respuesta. No inventes contratos como si estuvieran implementados.", prompt, serde_json::to_string(&r.tasks.iter().map(|v| json!({"id":v.id,"title":v.title,"agentId":v.assigned_agent_id,"status":v.status,"writePaths":v.write_paths})).collect::<Vec<_>>()).unwrap_or_default(), serde_json::to_string(&t.write_paths).unwrap_or_default(), serde_json::to_string(&r.coordination).unwrap_or_default());
    let messages = if recovering {
        let history = client.get(&format!("/session/{}/message", session))?;
        if parse_json::<WorkerResult>(&final_text(&history))
            .map(|r| r.status == "completed")
            .unwrap_or(false)
        {
            history
        } else {
            let continuation=format!("{}\nLa aplicación se reinició o el Lead resolvió un pedido. Continuá ESTA sesión desde el estado actual y la historia de herramientas. No repitas efectos ya observados. Releé y verificá, completá solo lo pendiente y devolvé el contrato JSON del resultado.\nCOORDINACIÓN ACTUAL DEL LEAD: {}\nContexto: {}\nTelemetría previa: {}",POLICY,serde_json::to_string(&r.coordination).unwrap_or_default(),prompt,evidence::sanitize(&history.to_string()));
            execute(app, run_id, &client, &session, &a, &continuation, false)?
        }
    } else {
        execute(app, run_id, &client, &session, &a, &prompt, false)?
    };
    let commands = observed_commands(&messages);
    record_usage(app, run_id, &session, &messages)?;
    let result: WorkerResult = parse_json(&final_text(&messages))?;
    let summary = evidence::sanitize(&format!(
        "{}\nLimitaciones: {}",
        result.summary,
        result.limitations.join("; ")
    ));
    attempt_update(app, run_id, task_id, |t, at| {
        at.declared_checks = result.checks.clone();
        at.commands = commands.clone();
        at.summary = summary.clone();
        t.status = "verifying".into();
    })?;
    if result.status == "waiting_dependency" {
        let request = result
            .request
            .ok_or("Falta el pedido concreto para el Lead")?;
        if request.message.trim().is_empty() {
            return Err("Pedido vacío para el Lead".into());
        }
        return update_run(app, run_id, |r| {
            if r.coordination
                .iter()
                .filter(|c| c.from_task_id == task_id)
                .count()
                >= 8
            {
                return Err("El Lead debe revisar un bloqueo que se repitió ocho veces".into());
            }
            // Suggested dependencies are a question for the Lead, not a new
            // execution edge. Only its validated decision may establish a wait.
            r.coordination.push(Coordination {
                id: id(),
                from_task_id: task_id.into(),
                message: evidence::sanitize(&request.message),
                task_ids: request.task_ids,
                status: "pending".into(),
                summary: String::new(),
                created_at: now(),
                sessions: vec![],
                replies: vec![],
            });
            let task = r
                .tasks
                .iter_mut()
                .find(|t| t.id == task_id)
                .ok_or("Tarea inexistente")?;
            task.status = "waiting_dependency".into();
            let attempt = task.attempts.last_mut().ok_or("Intento inexistente")?;
            attempt.status = "waiting_dependency".into();
            attempt.recovered = true;
            Ok(())
        });
    }
    if result.status != "completed" {
        return Err(summary);
    }
    let checks_passed = checks_passed(&result.checks, &commands);
    let reviewer = lead(&r)?;
    let review_session = create_session(
        &client,
        &reviewer,
        &format!("{} · revisión {}", r.team.name, t.title),
        true,
    )?;
    attempt_update(app, run_id, task_id, |_, at| {
        at.review_session_id = Some(review_session.clone())
    })?;
    let diff = evidence::changes(&run(app, run_id)?)?;
    let prompt = format!("{}\nSos el Lead revisor, con herramientas SOLO de lectura. Revisá los archivos actuales, los criterios y la evidencia. No confundas cambios previos del usuario con cambios del equipo. Si los comandos no comprueban lo pedido, pedí correcciones. Cualquier criterio incumplido impide aprobar.\nTAREA: {}\nCRITERIOS: {}\nRESULTADO: {}\nCOMANDOS OBSERVADOS: {}\nDIFF DESDE BASELINE: {}\nRespondé SOLO JSON válido: {{\"status\":\"approved|changes_requested|review_error\",\"summary\":\"veredicto y defectos concretos/criterios comprobados\",\"criteriaSatisfied\":true}}", POLICY,t.objective,t.acceptance_criteria.join("; "),summary,serde_json::to_string(&commands).map_err(|e| e.to_string())?,diff);
    let prompt = format!(
        "{}\nSKILLS DEL LEAD REVISOR:\n{}",
        prompt,
        skills_prompt(&r, &reviewer)
    );
    let response = execute(
        app,
        run_id,
        &client,
        &review_session,
        &reviewer,
        &prompt,
        true,
    )?;
    let mut review = match parse_json::<Review>(&final_text(&response)) {
        Ok(r) if !r.summary.trim().is_empty() => r,
        _ => Review {
            status: ReviewStatus::ReviewError,
            summary: "El Lead devolvió un veredicto inválido; no se considera aprobación".into(),
            criteria_satisfied: false,
        },
    };
    if !checks_passed && !matches!(review.status, ReviewStatus::ReviewError) {
        let successful: Vec<_> = commands
            .iter()
            .filter(|c| c["exitCode"].as_i64() == Some(0))
            .map(|c| c["command"].clone())
            .collect();
        review = Review {status:ReviewStatus::ChangesRequested,summary:format!("Falta una comprobación satisfactoria observada para cada comando declarado. Corregí el contrato del resultado: checks debe copiar SOLO los comandos de verificación que realmente pasaron, sin descripciones ni diagnósticos fallidos. Comandos observados con código 0: {}. No repitas efectos ya ejecutados; si falta una comprobación necesaria, ejecutala y revisá su resultado. {}",serde_json::to_string(&successful).unwrap_or_default(),review.summary),criteria_satisfied:false};
    }
    let approved = matches!(review.status, ReviewStatus::Approved) && review.criteria_satisfied;
    let retry = matches!(review.status, ReviewStatus::ChangesRequested)
        && t.attempts.len() <= r.team.max_retries_per_task;
    attempt_update(app, run_id, task_id, |t, at| {
        at.review = Some(review.clone());
        at.finished_at = Some(now());
        at.status = if approved {
            "completed"
        } else {
            "changes_requested"
        }
        .into();
        t.status = if approved {
            "completed"
        } else if retry {
            "pending"
        } else {
            "blocked"
        }
        .into();
        t.error = if approved {
            None
        } else {
            Some(evidence::sanitize(&review.summary))
        };
    })?;
    // Evidence of attempts is append-only; no revision is overwritten on feedback.
    let mut current = run(app, run_id)?;
    let task = current
        .tasks
        .iter()
        .find(|v| v.id == task_id)
        .ok_or("Tarea inexistente")?;
    let attempt = task.attempts.last().ok_or("Intento inexistente")?;
    let path = format!("revisiones/{}.json", attempt.id);
    let text = serde_json::to_string_pretty(attempt).map_err(|e| e.to_string())?;
    evidence::write(
        &mut current,
        &path,
        "test",
        "report",
        "Sesiones de trabajador y Lead",
        &text,
    )?;
    update_run(app, run_id, |r| {
        for artifact in current.artifacts {
            if !r.artifacts.iter().any(|a| a.id == artifact.id) {
                r.artifacts.push(artifact);
            }
        }
        Ok(())
    })
}

pub fn reconcile(app: &AppHandle, r: &Run, abort: bool) -> Result<(), String> {
    for (repo, session) in r
        .plan_session_id
        .iter()
        .chain(r.closing_sessions.iter())
        .map(|s| (&r.team.allowed_repositories[0], s))
        .chain(r.coordination.iter().flat_map(|c| {
            let repo = r
                .tasks
                .iter()
                .find(|t| t.id == c.from_task_id)
                .map(|t| &t.repository)
                .unwrap_or(&r.team.allowed_repositories[0]);
            c.sessions.iter().map(move |s| (repo, s))
        }))
        .chain(r.tasks.iter().flat_map(|t| {
            t.attempts
                .iter()
                .filter(|a| a.finished_at.is_none())
                .flat_map(move |a| {
                    a.session_id
                        .iter()
                        .chain(a.review_session_id.iter())
                        .map(move |s| (&t.repository, s))
                })
        }))
    {
        let client = client(app, repo)?;
        let state = client.get("/session/status")?;
        if !state.is_object() {
            return Err("No se pudo reconciliar el motor".into());
        }
        // Prove the session still exists, even if status omitted idle sessions.
        client.get(&format!("/session/{}", session))?;
        client.get(&format!("/session/{}/message", session))?;
        let busy = state[session]["type"]
            .as_str()
            .map(|s| s != "idle")
            .unwrap_or(false);
        if busy && !abort {
            return Err(format!(
                "La sesión {} sigue activa. Abrila para inspeccionarla o cancelá la ejecución",
                session
            ));
        }
        if busy {
            stop(&client, session)?;
        }
    }
    if r.tasks.is_empty() && !abort {
        if let Some(session) = &r.plan_session_id {
            let messages = client(app, &r.team.allowed_repositories[0])?
                .get(&format!("/session/{}/message", session))?;
            let text = final_text(&messages);
            if let Ok(plan) = parse_json::<Plan>(&text) {
                if super::staffing::with_agents(&r.team, &plan.agents, &r.skills)
                    .and_then(|team| validate_plan(&plan, &team))
                    .is_ok()
                {
                    update_run(app, &r.id, |r| {
                        r.recovered_plan = Some(text);
                        Ok(())
                    })?;
                }
            }
        }
    }
    // Read tool telemetry before offering a new prompt: an idle session can already
    // have changed files or completed a command before the app was interrupted.
    let mut recovered = vec![];
    for t in &r.tasks {
        for a in &t.attempts {
            if a.finished_at.is_none() {
                if let Some(session) = &a.session_id {
                    let messages = client(app, &t.repository)?
                        .get(&format!("/session/{}/message", session))?;
                    recovered.push((
                        a.id.clone(),
                        evidence::sanitize(&final_text(&messages)),
                        observed_commands(&messages),
                    ));
                }
            }
        }
    }
    update_run(app, &r.id, |r| {
        if abort {
            for c in &mut r.coordination {
                if c.status != "resolved" {
                    c.status = "cancelled".into();
                }
            }
        }
        for t in &mut r.tasks {
            for a in &mut t.attempts {
                if a.finished_at.is_none() {
                    a.finished_at = if abort || a.session_id.is_none() {
                        Some(now())
                    } else {
                        None
                    };
                    a.recovered = !abort && a.session_id.is_some();
                    a.status = if a.recovered {
                        "recovering"
                    } else {
                        "interrupted"
                    }
                    .into();
                    a.error = Some("Sesión reconciliada inactiva. Hay posibles efectos previos: revisar contenido actual y telemetría antes de continuar; no repetir comandos ciegamente".into());
                    if let Some((_, summary, commands)) =
                        recovered.iter().find(|(id, _, _)| id == &a.id)
                    {
                        a.summary = summary.clone();
                        a.commands = commands.clone();
                    }
                }
            }
        }
        Ok(())
    })
}

fn closeout(app: &AppHandle, id: &str) -> Result<bool, String> {
    let r = run(app, id)?;
    let a = lead(&r)?;
    let client = client(app, &r.team.allowed_repositories[0])?;
    let session = create_session(
        &client,
        &a,
        &format!("{} · cierre e integración", r.team.name),
        true,
    )?;
    update_run(app, id, |r| {
        r.closing_sessions.push(session.clone());
        Ok(())
    })?;
    let outcomes: Vec<_> = r.tasks.iter().map(|t| json!({"id":t.id,"title":t.title,"criteria":t.acceptance_criteria,"attempt":t.attempts.last()})).collect();
    let prompt = format!("{}\nSos el Lead de cierre. Verificá que el OBJETIVO GENERAL completo se cumplió y que hay comprobaciones suficientes de integración, incluso sin un empleado QA. Las revisiones individuales no bastan si faltan flujos o contratos. Revisá evidencia observada y archivos de lectura disponibles. No inventes verificaciones. Podés crear tareas de corrección, integración o verificación asignadas a miembros existentes.\nOBJETIVO: {}\nEQUIPO: {}\nENTREGAS Y COMANDOS REALES: {}\nDIFF: {}\nRespondé SOLO JSON: {{\"status\":\"approved|changes_requested|review_error\",\"summary\":\"resumen verificable o defectos concretos\",\"criteriaSatisfied\":true,\"tasks\":[]}}. Si pedís cambios, tasks debe contener tareas NUEVAS con IDs únicos y el mismo contrato del plan: id,title,objective,assignedAgentId,repository,dependencies,expectedFiles,acceptanceCriteria. No apruebes si hay trabajo pendiente. Las capturas no disponibles son una limitación explícita, no prueba visual.",POLICY,r.goal,serde_json::to_string(&r.team).map_err(|e|e.to_string())?,serde_json::to_string(&outcomes).map_err(|e|e.to_string())?,evidence::changes(&r)?);
    let prompt = format!(
        "{}\nOBSERVACIONES REALES DE LOS FLUJOS (antes/después y pasos, no inferidas): {}",
        prompt,
        serde_json::to_string(&r.observations).map_err(|e| e.to_string())?
    );
    let prompt = format!(
        "{}\nSKILLS DEL LEAD DE CIERRE:\n{}",
        prompt,
        skills_prompt(&r, &a)
    );
    let prompt = format!("{}{}", prompt, super::staffing::prompt(&r.team));
    let response = execute(app, id, &client, &session, &a, &prompt, true)?;
    let mut verdict: Closeout = parse_json(&final_text(&response))?;
    verdict.review.summary = evidence::sanitize(&verdict.review.summary);
    if verdict.review.summary.trim().is_empty() {
        return Err("review_error: el cierre no tiene un veredicto explicativo".into());
    }
    let approved = matches!(verdict.review.status, ReviewStatus::Approved)
        && verdict.review.criteria_satisfied
        && verdict.tasks.is_empty();
    let corrections = matches!(verdict.review.status, ReviewStatus::ChangesRequested)
        && !verdict.tasks.is_empty()
        && r.closing_reviews.len() < r.team.max_retries_per_task;
    super::staffing::validate_assignments(&verdict.agents, &verdict.tasks)?;
    if !corrections && !verdict.agents.is_empty() {
        return Err(
            "El Lead solo puede incorporar especialistas junto con tareas de corrección válidas"
                .into(),
        );
    }
    let closing_team = super::staffing::with_agents(&r.team, &verdict.agents, &r.skills)?;
    if corrections {
        for t in &mut verdict.tasks {
            t.status = "pending".into();
            t.attempts.clear();
            t.error = None;
        }
        let mut all = r.tasks.clone();
        all.extend(verdict.tasks.clone());
        validate_plan(
            &Plan {
                agents: vec![],
                tasks: all,
                evidence_targets: vec![],
            },
            &closing_team,
        )?;
    }
    let mut evidence_run = run(app, id)?;
    let record = serde_json::to_string_pretty(
        &json!({"sessionId":session,"review":verdict.review,"tasks":verdict.tasks}),
    )
    .map_err(|e| e.to_string())?;
    evidence::write(
        &mut evidence_run,
        &format!("revisiones/cierre-{}.json", super::domain::id()),
        "test",
        "report",
        "Veredicto final del Lead",
        &record,
    )?;
    update_run(app, id, |r| {
        r.team = closing_team;
        r.closing_reviews.push(verdict.review.clone());
        if approved {
            r.chat_summary = verdict.chat_summary.clone();
        }
        r.artifacts = evidence_run.artifacts;
        if approved {
            r.summary = verdict.review.summary.clone();
        }
        if corrections {
            r.tasks.extend(verdict.tasks);
            r.status = "running".into();
        }
        Ok(())
    })?;
    if !approved && !corrections {
        return Err(format!(
            "Cierre no aprobado (review_error o límite de correcciones): {}",
            verdict.review.summary
        ));
    }
    Ok(approved)
}

pub fn launch(app: &AppHandle, id: &str) {
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        if let Err(e) = schedule(&app, &id) {
            let error = super::errors::message(&json!(e));
            let cancelled = run(&app, &id)
                .ok()
                .filter(|r| r.status == "cancelling")
                .map(|r| reconcile(&app, &r, true).is_ok())
                .unwrap_or(false);
            if let Err(persist_error) = update_run(&app, &id, |r| {
                if r.status != "cancelled" {
                    r.status = if cancelled { "cancelled" } else { "blocked" }.into();
                    r.error = Some(error);
                    if cancelled {
                        r.finished_at = Some(now());
                    }
                }
                Ok(())
            }) {
                log::error!("[teams] {}", persist_error);
            }
            if let Ok(r) = run(&app, &id) {
                notify(&app, &r, false);
            }
        }
    });
}

fn schedule(app: &AppHandle, id: &str) -> Result<(), String> {
    if run(app, id)?.tasks.is_empty() {
        plan(app, id)?;
    }
    if run(app, id)?.tasks.iter().all(|t| t.attempts.is_empty()) {
        collect_captures(app, id, "before")?;
    }
    let mut workers: HashMap<String, std::thread::JoinHandle<Result<(), String>>> = HashMap::new();
    let mut coordinator: Option<(String, std::thread::JoinHandle<Result<(), String>>)> = None;
    loop {
        if coordinator
            .as_ref()
            .map(|(_, h)| h.is_finished())
            .unwrap_or(false)
        {
            let (request_id, handle) = coordinator.take().unwrap();
            if let Err(error) = handle
                .join()
                .unwrap_or_else(|_| Err("Se interrumpió la coordinación del Lead".into()))
            {
                let r = run(app, id)?;
                let c = r
                    .coordination
                    .iter()
                    .find(|c| c.id == request_id)
                    .ok_or("Pedido inexistente")?;
                let task = r
                    .tasks
                    .iter()
                    .find(|t| t.id == c.from_task_id)
                    .ok_or("Tarea inexistente")?;
                let stopped = c
                    .sessions
                    .last()
                    .map(|s| {
                        client(app, &task.repository)
                            .and_then(|client| stop(&client, s))
                            .is_ok()
                    })
                    .unwrap_or(true);
                update_run(app, id, |r| {
                    let c = r
                        .coordination
                        .iter_mut()
                        .find(|c| c.id == request_id)
                        .unwrap();
                    c.summary = super::errors::message(&json!(error));
                    c.status = if stopped { "blocked" } else { "checking" }.into();
                    let t = r.tasks.iter_mut().find(|t| t.id == c.from_task_id).unwrap();
                    t.status = "blocked".into();
                    t.error = Some(c.summary.clone());
                    Ok(())
                })?;
            }
        }
        let finished: Vec<_> = workers
            .iter()
            .filter(|(_, h)| h.is_finished())
            .map(|(id, _)| id.clone())
            .collect();
        for task_id in finished {
            let outcome = workers
                .remove(&task_id)
                .ok_or("Worker inexistente")?
                .join()
                .unwrap_or_else(|_| Err("El trabajador se interrumpió inesperadamente".into()));
            if let Err(error) = outcome {
                let r = run(app, id)?;
                let task = r
                    .tasks
                    .iter()
                    .find(|t| t.id == task_id)
                    .ok_or("Tarea inexistente")?;
                let mut settled = true;
                if let Some(a) = task.attempts.last() {
                    let c = client(app, &task.repository)?;
                    for session in a.session_id.iter().chain(a.review_session_id.iter()) {
                        if stop(&c, session).is_err() {
                            settled = false;
                        }
                    }
                }
                attempt_update(app, id, &task_id, |t, a| {
                    t.status = "blocked".into();
                    t.error = Some(super::errors::message(&json!(error)));
                    a.status = "blocked".into();
                    a.error = t.error.clone();
                    if settled {
                        a.finished_at = Some(now());
                    }
                })?;
            }
        }
        let r = run(app, id)?;
        if let Err(e) = enforce_limits(&r) {
            if workers.is_empty() && coordinator.is_none() {
                return Err(e);
            } else {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        }
        if r.status == "cancelling" && workers.is_empty() && coordinator.is_none() {
            if unsettled(&r) {
                return Err("No se confirmó la detención de todas las sesiones. Revisá Actividad antes de liberar carpetas".into());
            }
            update_run(app, id, |r| {
                r.status = "cancelled".into();
                r.finished_at = Some(now());
                for t in &mut r.tasks {
                    if t.status != "completed" {
                        t.status = "cancelled".into();
                    }
                }
                Ok(())
            })?;
            return Ok(());
        }
        if r.tasks.iter().any(|t| t.status == "blocked")
            && workers.is_empty()
            && coordinator.is_none()
        {
            return Err(r
                .tasks
                .iter()
                .find_map(|t| t.error.clone())
                .unwrap_or("Tarea bloqueada".into()));
        }
        if r.tasks.iter().any(|t| t.status == "blocked") {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        if r.status == "paused" || r.status == "cancelling" {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        if coordinator.is_none() {
            if let Some(request_id) = super::coordination::ready(&r) {
                let app = app.clone();
                let run_id = id.to_string();
                let rid = request_id.clone();
                coordinator = Some((
                    request_id,
                    std::thread::spawn(move || super::coordination::check(&app, &run_id, &rid)),
                ));
            }
        }
        if r.tasks.iter().all(|t| t.status == "completed")
            && workers.is_empty()
            && coordinator.is_none()
        {
            collect_captures(app, id, "after")?;
            if !closeout(app, id)? {
                continue;
            }
            update_run(app, id, |r| {
                r.status = "delivering".into();
                Ok(())
            })?;
            let mut r = run(app, id)?;
            r.summary = format!(
                "Terminamos. {}\n\n{}\n\nQueda pendiente tu QA manual.",
                r.summary,
                r.tasks
                    .iter()
                    .filter_map(|t| t
                        .attempts
                        .last()
                        .map(|a| format!("{}: {}", t.title, a.summary)))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            evidence::deliver(&mut r)?;
            update_run(app, id, |v| {
                v.artifacts = r.artifacts.clone();
                v.summary = r.summary.clone();
                v.finished_at = Some(now());
                v.status = "awaiting_manual_qa".into();
                v.error = None;
                v.notified = true;
                Ok(())
            })?;
            // Persisted before notifying. At-most-once: a crash here can omit a toast, never duplicate it.
            notify(app, &run(app, id)?, true);
            return Ok(());
        }
        let dispatch = ready_tasks(&r, &workers.keys().cloned().collect())?;
        if dispatch.is_empty() && workers.is_empty() && coordinator.is_none() {
            return Err("No hay tareas que puedan avanzar. El Lead debe revisar las dependencias pendientes".into());
        }
        for task_id in dispatch {
            let (app, id) = (app.clone(), id.to_string());
            let started = update_run(&app, &id, |r| {
                if r.status != "running" {
                    return Ok(false);
                }
                let t = r
                    .tasks
                    .iter_mut()
                    .find(|t| t.id == task_id)
                    .ok_or("Tarea inexistente")?;
                let a = r
                    .team
                    .members
                    .iter()
                    .find(|a| a.id == t.assigned_agent_id)
                    .ok_or("Empleado inexistente")?
                    .clone();
                t.status = "running".into();
                if !t
                    .attempts
                    .last()
                    .map(|a| a.recovered && a.finished_at.is_none())
                    .unwrap_or(false)
                {
                    t.attempts.push(Attempt {
                        declared_checks: vec![],
                        id: super::domain::id(),
                        agent: a,
                        session_id: None,
                        review_session_id: None,
                        started_at: now(),
                        finished_at: None,
                        status: "running".into(),
                        summary: String::new(),
                        error: None,
                        review: None,
                        commands: vec![],
                        recovered: false,
                    });
                }
                Ok(true)
            })?;
            if !started {
                continue;
            }
            let tid = task_id.clone();
            workers.insert(task_id, std::thread::spawn(move || worker(&app, &id, &tid)));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn usage_budgets_and_duration_block_from_observed_metadata() {
        let mut r:Run=serde_json::from_value(json!({"id":"run","goal":"goal","team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":now(),"finishedAt":null,"planSessionId":null,"tasks":[],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
        let metadata = usage(
            &json!([{"info":{"role":"user","cost":99,"tokens":{"input":999}}},{"info":{"role":"assistant","cost":0.3,"tokens":{"input":10,"output":5,"reasoning":2}}},{"info":{"role":"assistant","cost":0.2,"tokens":{"input":2,"output":1}}}]),
        );
        assert_eq!(metadata["tokens"], 20);
        assert_eq!(metadata["costUsd"], 0.5);
        r.session_usage.insert("s".into(), metadata);
        r.team.limits.max_tokens = Some(21);
        assert!(enforce_limits(&r).is_ok());
        r.team.limits.max_tokens = Some(20);
        assert!(enforce_limits(&r).is_err());
        r.team.limits.max_tokens = None;
        r.team.limits.max_cost_usd = Some(0.5);
        assert!(enforce_limits(&r).is_err());
        r.team.limits.max_cost_usd = Some(0.6);
        assert!(enforce_limits(&r).is_ok());
        r.team.limits.max_run_minutes = Some(1);
        r.started_at = now() - 61_000;
        assert!(enforce_limits(&r).is_err());
    }
    #[test]
    fn evidence_uses_completed_tool_results_only() {
        let v = json!([{"parts":[{"type":"text","text":"tests passed"},{"type":"tool","tool":"bash","callID":"1","state":{"status":"completed","input":{"command":"npm test"},"metadata":{"exit":1},"output":"failed"}},{"type":"tool","tool":"bash","state":{"status":"running"}}]}]);
        let commands = observed_commands(&v);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["exitCode"], 1);
    }
    #[test]
    fn terminal_checks_require_native_completion_and_same_command() {
        let part = |tool: &str, input: Value, result: Value, tail: &str| json!({"type":"tool","tool":tool,"callID":"native-run","state":{"status":"completed","input":input,"output":format!("{}{}\n{}",crate::desktop::terminal::RESULT_PREFIX,result,tail)}});
        let receipt = |command: &str, finished: bool, code: Value| json!({"terminalId":"agent-one","command":command,"executedCommand":"Set-Location -LiteralPath 'D:/repo'; node qa/check.mjs","finished":finished,"exitCode":code});
        let begin = part("terminal_terminal_run",json!({"command":"node qa/check.mjs"}),receipt("node qa/check.mjs",false,Value::Null),"Sigue corriendo; PASS is only log text");
        let finish = part("terminal_terminal_read",json!({"id":"agent-one"}),receipt("",true,json!(0)),"Estado: terminó con código 0");
        let observed = observed_commands(&json!([{"parts":[begin,finish]}]));
        assert_eq!(observed.len(), 1);
        assert!(checks_passed(&["node qa/check.mjs".into()], &observed));
        assert!(!checks_passed(&["Set-Location -LiteralPath 'D:/repo'; node qa/check.mjs".into()], &observed));
        for (done, code) in [(false,json!(0)),(true,Value::Null),(true,json!(1))] {
            let invalid = part("terminal_terminal_run",json!({"command":"node qa/check.mjs"}),receipt("node qa/check.mjs",done,code),"PASS / terminó con código 0");
            assert!(!checks_passed(&["node qa/check.mjs".into()], &observed_commands(&json!([{"parts":[invalid]}]))));
        }
        let mut other = finish.clone(); other["state"]["input"]["id"] = json!("another-terminal");
        let mut wrong_command = receipt("",true,json!(0)); wrong_command["executedCommand"] = json!("unrelated command");
        let wrong = part("terminal_terminal_read",json!({"id":"agent-one"}),wrong_command,"PASS");
        for invalid in [other, wrong] {
            assert!(!checks_passed(&["node qa/check.mjs".into()], &observed_commands(&json!([{"parts":[begin,invalid]}]))));
        }
        // An orphan read, an arbitrary MCP server or a pasted receipt in logs
        // cannot attest that this worker ran a command successfully.
        assert!(observed_commands(&json!([{"parts":[finish]}])).is_empty());
        let mut forged = part("other_terminal_run",json!({"command":"node qa/check.mjs"}),receipt("node qa/check.mjs",true,json!(0)),"PASS");
        assert!(observed_commands(&json!([{"parts":[forged]}])).is_empty());
        forged["tool"] = json!("terminal_terminal_run");
        forged["state"]["output"] = json!(format!("Salida arbitraria\n{}{}",crate::desktop::terminal::RESULT_PREFIX,receipt("node qa/check.mjs",true,json!(0))));
        assert!(observed_commands(&json!([{"parts":[forged]}])).is_empty());
    }
    #[test]
    fn verification_accepts_observed_windows_commands_and_rejects_false_claims() {
        let command = "node --check backend/server.js; exit $LASTEXITCODE";
        let commands = observed_commands(&json!([{"parts":[
            {"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":command},"metadata":{"exit":0},"output":""}},
            {"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"node qa/check.mjs"},"metadata":{"exit":1},"output":"failed"}},
            {"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"npm test"}}}
        ]}]));
        assert!(checks_passed(&[command.into()], &commands));
        for invalid in [
            vec![],
            vec!["npm test".into()],
            vec!["node qa/check.mjs".into()],
            vec![format!("{} — código 0", command)],
        ] {
            assert!(!checks_passed(&invalid, &commands));
        }
    }
    #[test]
    fn reviewer_cannot_write_or_run_shell() {
        let t = super::super::domain::tests::team();
        let p = session_permissions(&t.members[0], true);
        assert_eq!(p[0]["action"], "deny");
        assert!(!p
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["permission"] == "bash" && r["action"] == "allow"));
    }
    #[test]
    fn disconnected_models_and_unknown_variants_are_rejected() {
        let mut employee = super::super::domain::tests::team().members.remove(0);
        assert!(check_model_catalog(&json!({"providers":[]}), &employee).is_err());
        let catalog = json!({"providers":[{"id":"openai","source":"api","models":{"model":{"id":"model","variants":{"high":{}}}}}]});
        assert!(check_model_catalog(&catalog, &employee).is_ok());
        employee.variant = Some("not-supported".into());
        assert!(check_model_catalog(&catalog, &employee).is_err());
        employee.variant = Some("high".into());
        assert!(check_model_catalog(&catalog, &employee).is_ok());
    }
    #[test]
    fn invalid_or_empty_lead_plan_becomes_one_safe_task() {
        let team = super::super::domain::tests::team();
        let r: Run = serde_json::from_value(json!({"id":"run","goal":"Arreglar el formulario","team":team,"skills":[],"status":"planning","startedAt":0,"finishedAt":null,"planSessionId":null,"tasks":[],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
        for response in ["texto inválido", r#"{"tasks":[]}"#] {
            let (plan, recovery) = usable_plan(response, &r);
            assert!(recovery.is_some());
            assert_eq!(plan.tasks.len(), 1);
            assert_eq!(plan.tasks[0].objective, r.goal);
            assert_eq!(plan.tasks[0].repository, "D:/repo");
            assert!(validate_plan(&plan, &r.team).is_ok());
        }
    }
    #[test]
    fn automatic_plan_staffs_three_parallel_owners_and_survives_recovery() {
        let mut team = super::super::domain::tests::team();
        team.autonomous = true;
        team.max_parallel_tasks = 8;
        let mut r: Run = serde_json::from_value(json!({"id":"run","goal":"Dos servicios y una UI","team":team,"skills":[],"status":"planning","startedAt":0,"finishedAt":null,"planSessionId":null,"tasks":[],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
        let agents = json!([{"id":"back-1","role":"Backend"},{"id":"back-2","role":"Backend"},{"id":"front-1","role":"Frontend"}]);
        let tasks: Vec<_> = ["back-1", "back-2", "front-1"].iter().map(|id| json!({"id":id,"title":id,"objective":"Implementar y comprobar","assignedAgentId":id,"repository":"D:/repo","dependencies":[],"expectedFiles":[],"writePaths":[format!("{}/",id)],"acceptanceCriteria":["check"]})).collect();
        let text = json!({"agents":agents,"tasks":tasks}).to_string();
        let (plan, recovery) = usable_plan(&text, &r);
        assert!(recovery.is_none());
        r.team = super::super::staffing::with_agents(&r.team, &plan.agents, &r.skills).unwrap();
        r.tasks = plan.tasks;
        assert_eq!(
            ready_tasks(&r, &HashSet::new()).unwrap(),
            vec!["back-1", "back-2", "front-1"]
        );
        let restored: Run = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(restored.team.members.len(), 4);
        assert_eq!(ready_tasks(&restored, &HashSet::new()).unwrap().len(), 3);
        // A duplicate roster cannot be installed when a saved plan is seen twice.
        assert!(super::super::staffing::with_agents(&restored.team, &plan.agents, &[]).is_err());
        let mut invalid = tasks.clone();
        invalid[0]["repository"] = json!("D:/other");
        let mut seed = r.clone();
        seed.team = team;
        seed.tasks.clear();
        let (fallback, reason) =
            usable_plan(&json!({"agents":agents,"tasks":invalid}).to_string(), &seed);
        assert!(reason.is_some());
        assert!(fallback.agents.is_empty());
    }
    #[test]
    fn closeout_accepts_brief_without_losing_the_verdict() {
        let close: Closeout = parse_json(r#"{"status":"approved","criteriaSatisfied":true,"summary":"Informe completo","chatSummary":{"done":"Creé el saludo.","tested":"La integración pasó.","pending":"Falta QA manual."},"tasks":[]}"#).unwrap();
        assert_eq!(close.chat_summary.unwrap().tested, "La integración pasó.");
        assert!(matches!(close.review.status, ReviewStatus::Approved));
        let malformed: Closeout = parse_json(r#"{"status":"approved","criteriaSatisfied":true,"summary":"Informe completo","chatSummary":{"done":123},"tasks":[]}"#).unwrap();
        assert!(malformed.chat_summary.is_none());
        assert!(matches!(malformed.review.status, ReviewStatus::Approved));
    }
    #[test]
    fn scheduler_respects_dependencies_repository_locks_and_member_capacity() {
        let mut team = super::super::domain::tests::team();
        team.members[0].max_concurrent_tasks = 2;
        let base = json!({"id":"run","goal":"goal","team":team,"skills":[],"status":"running","startedAt":0,"finishedAt":null,"planSessionId":null,"tasks":[],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false});
        let mut r: Run = serde_json::from_value(base).unwrap();
        let t = |id: &str, repo: &str, deps: Vec<&str>| -> Task {
            serde_json::from_value(json!({"id":id,"title":id,"objective":id,"assignedAgentId":"lead","repository":repo,"dependencies":deps,"expectedFiles":[],"acceptanceCriteria":["check"]})).unwrap()
        };
        r.tasks = vec![
            t("a", "D:/repo", vec![]),
            t("b", "D:/repo/sub", vec![]),
            t("c", "D:/other", vec![]),
            t("d", "D:/third", vec!["a"]),
        ];
        assert_eq!(ready_tasks(&r, &HashSet::new()).unwrap(), vec!["a", "c"]);
        r.team.members[0].max_concurrent_tasks = 1;
        assert_eq!(ready_tasks(&r, &HashSet::new()).unwrap(), vec!["a"]);
        r.tasks[0].status = "running".into();
        assert!(ready_tasks(&r, &HashSet::from(["a".into()]))
            .unwrap()
            .is_empty());
        r.tasks[0].status = "completed".into();
        r.tasks[1].status = "completed".into();
        r.tasks[2].status = "completed".into();
        assert_eq!(ready_tasks(&r, &HashSet::new()).unwrap(), vec!["d"]);
    }

    #[test]
    fn shared_folder_dispatches_disjoint_owners_but_locks_shared_files() {
        let mut r: Run = serde_json::from_value(json!({"id":"r","goal":"g","team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":0,"finishedAt":null,"planSessionId":null,"tasks":[],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
        let mut backend = r.team.members[0].clone();
        backend.id = "backend".into();
        let mut frontend = backend.clone();
        frontend.id = "frontend".into();
        r.team.members.extend([backend, frontend]);
        r.tasks = ["backend", "frontend"].iter().map(|role| serde_json::from_value(json!({"id":role,"title":role,"objective":role,"assignedAgentId":role,"repository":"D:/repo","dependencies":[],"expectedFiles":[],"writePaths":[format!("src/{}/",role)],"acceptanceCriteria":["check"]})).unwrap()).collect();
        assert_eq!(
            ready_tasks(&r, &HashSet::new()).unwrap(),
            vec!["backend", "frontend"]
        );
        r.tasks[1].write_paths.push("src/backend/api.ts".into());
        assert_eq!(ready_tasks(&r, &HashSet::new()).unwrap(), vec!["backend"]);
        r.tasks[1].write_paths.clear();
        assert_eq!(ready_tasks(&r, &HashSet::new()).unwrap(), vec!["backend"]);
    }

    #[test]
    fn scoped_edits_do_not_grant_writes_to_the_whole_project() {
        let mut a = super::super::domain::tests::team().members.remove(0);
        a.tools = vec!["read".into(), "write".into(), "bash".into()];
        let rules = scoped_permissions(&a, false, &["src/web/".into(), "package.json".into()]);
        let allowed: Vec<_> = rules
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["permission"] == "edit" && p["action"] == "allow")
            .map(|p| p["pattern"].as_str().unwrap())
            .collect();
        assert_eq!(allowed, vec!["src/web/**", "package.json"]);
        assert!(!rules
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["permission"] == "edit" && p["action"] == "ask"));
        assert!(!rules
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["permission"] == "bash" && p["pattern"] == "*" && p["action"] == "allow"));
    }
}
