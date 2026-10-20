use super::{domain::*, evidence, run, runner, update_run};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use tauri::AppHandle;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    #[serde(default)]
    agents: Vec<AgentProposal>,
    status: String,
    summary: String,
    #[serde(default)]
    wait_for_task_ids: Vec<String>,
    #[serde(default)]
    tasks: Vec<Task>,
}

// Include runtime waits as well as planned dependencies: two workers must never
// silently wait for one another forever.
pub(super) fn validate_wait(r: &Run, from: &str, targets: &[String]) -> Result<(), String> {
    if targets
        .iter()
        .any(|id| id == from || !r.tasks.iter().any(|t| &t.id == id))
    {
        return Err(
            "Pedido al Lead con una tarea inexistente o una dependencia de sí misma".into(),
        );
    }
    let mut done = HashSet::new();
    loop {
        let n = done.len();
        for t in &r.tasks {
            let waits: Vec<_> = if t.id == from {
                targets.iter().collect()
            } else {
                r.coordination
                    .iter()
                    .filter(|c| c.from_task_id == t.id && c.status == "waiting")
                    .flat_map(|c| &c.task_ids)
                    .collect()
            };
            if t.status == "completed"
                || t.dependencies
                    .iter()
                    .chain(waits)
                    .all(|d| done.contains(d.as_str()))
            {
                done.insert(t.id.as_str());
            }
        }
        if done.len() == r.tasks.len() {
            return Ok(());
        }
        if n == done.len() {
            return Err("El pedido crea una espera circular entre agentes; el Lead debe separar el contrato de la integración".into());
        }
    }
}

pub(super) fn ready(r: &Run) -> Option<String> {
    r.coordination
        .iter()
        .find(|c| {
            c.status == "pending"
                || c.status == "checking"
                || (c.status == "waiting"
                    && c.task_ids.iter().all(|id| {
                        r.tasks.iter().any(|t| {
                            &t.id == id
                                && ["completed", "blocked", "cancelled"]
                                    .contains(&t.status.as_str())
                        })
                    }))
        })
        .map(|c| c.id.clone())
}

pub(super) fn check(app: &AppHandle, run_id: &str, request_id: &str) -> Result<(), String> {
    let r = run(app, run_id)?;
    let request = r
        .coordination
        .iter()
        .find(|c| c.id == request_id)
        .ok_or("Pedido inexistente")?;
    let employee = runner::lead(&r)?;
    let task = r
        .tasks
        .iter()
        .find(|t| t.id == request.from_task_id)
        .ok_or("Tarea inexistente")?;
    let client = runner::client(app, &task.repository)?;
    // Reconcile an interrupted decision using the same recorded session. A
    // completed response is applied, rather than prompting the Lead a second time.
    let reuse = request.status == "checking" && !request.sessions.is_empty();
    if !reuse && request.sessions.len() >= 16 {
        return Err("El Lead no resolvió el pedido después de 16 revisiones; se conservan las sesiones para inspección".into());
    }
    let session = if reuse {
        request.sessions.last().unwrap().clone()
    } else {
        runner::create_session(
            &client,
            &employee,
            &format!("{} · coordinación {}", r.team.name, task.title),
            true,
        )?
    };
    update_run(app, run_id, |r| {
        let c = r
            .coordination
            .iter_mut()
            .find(|c| c.id == request_id)
            .ok_or("Pedido inexistente")?;
        c.status = "checking".into();
        if !reuse {
            c.sessions.push(session.clone());
        }
        Ok(())
    })?;
    let prompt = format!("Sos el Lead de coordinación, con herramientas SOLO de lectura. Un agente necesita algo de otro. Revisá los archivos actuales y los estados reales de todas las tareas. Los demás siguen trabajando: no los reinicies ni cambies archivos. Respondé resume solo si el solicitante ya puede continuar con un contrato concreto; wait si falta una entrega, indicando IDs reales; blocked si falta información del usuario o hay un fallo. Si falta trabajo no asignado, creá tareas nuevas para el responsable con writePaths propios; no alteres tareas en ejecución. Separá preparación/contrato de integración; evitá esperas circulares.\nPEDIDO: {}\nESTADO ACTUAL DEL EQUIPO: {}\nHISTORIAL DE COORDINACIÓN: {}\nSKILLS DEL LEAD:\n{}\nRespondé SOLO JSON: {{\"status\":\"resume|wait|blocked\",\"summary\":\"estado comprobado, contrato y respuesta concreta al agente\",\"waitForTaskIds\":[],\"tasks\":[]}}. Las tareas nuevas usan el contrato del plan: id,title,objective,assignedAgentId,repository,dependencies,expectedFiles,writePaths,acceptanceCriteria.",serde_json::to_string(request).unwrap_or_default(),serde_json::to_string(&r.tasks).unwrap_or_default(),serde_json::to_string(&r.coordination).unwrap_or_default(),runner::skills_prompt(&r,&employee));
    let prompt = format!(
        "{}{}\nINTEGRANTES ACTUALES: {}\nCATÁLOGO DE SKILLS: {}",
        prompt,
        super::staffing::prompt(&r.team),
        serde_json::to_string(&r.team.members).unwrap_or_default(),
        serde_json::to_string(&r.skills.iter().map(|s| &s.id).collect::<Vec<_>>())
            .unwrap_or_default()
    );
    let previous = if reuse {
        Some(client.get_resilient(&format!("/session/{}/message", session))?)
    } else {
        None
    };
    let decision: Decision = if let Some(decision) = previous
        .as_ref()
        .and_then(|m| parse_json(&runner::final_text(m)).ok())
    {
        decision
    } else {
        parse_json(&runner::final_text(&runner::execute(
            app, run_id, &client, &session, &employee, &prompt, true,
        )?))?
    };
    apply(app, run_id, request_id, decision)
}

fn apply(
    app: &AppHandle,
    run_id: &str,
    request_id: &str,
    decision: Decision,
) -> Result<(), String> {
    update_run(app, run_id, |r| apply_decision(r, request_id, decision))
}

fn apply_decision(r: &mut Run, request_id: &str, mut decision: Decision) -> Result<(), String> {
    if !["resume", "wait", "blocked"].contains(&decision.status.as_str())
        || decision.summary.trim().is_empty()
    {
        return Err("El Lead devolvió una respuesta de coordinación inválida".into());
    }
    decision.summary = evidence::sanitize(&decision.summary);
    super::staffing::validate_assignments(&decision.agents, &decision.tasks)?;
    let from = r
        .coordination
        .iter()
        .find(|c| c.id == request_id)
        .ok_or("Pedido inexistente")?
        .from_task_id
        .clone();
    for t in &mut decision.tasks {
        t.status = "pending".into();
        t.attempts.clear();
        t.error = None;
    }
    let mut proposed = r.clone();
    proposed.team = super::staffing::with_agents(&r.team, &decision.agents, &r.skills)?;
    proposed.tasks.extend(decision.tasks.clone());
    validate_plan(
        &Plan {
            agents: vec![],
            tasks: proposed.tasks.clone(),
            evidence_targets: vec![],
        },
        &proposed.team,
    )?;
    validate_wait(&proposed, &from, &decision.wait_for_task_ids)?;
    if decision.status == "wait" && decision.wait_for_task_ids.is_empty() {
        return Err("El Lead pidió esperar sin una entrega pendiente".into());
    }
    if decision.status == "resume"
        && (!decision.tasks.is_empty() || !decision.wait_for_task_ids.is_empty())
    {
        return Err(
            "El Lead debe esperar las tareas que acaba de solicitar antes de reanudar".into(),
        );
    }
    let delivered = decision.wait_for_task_ids.iter().all(|id| {
        proposed
            .tasks
            .iter()
            .any(|t| &t.id == id && t.status == "completed")
    });
    r.team = proposed.team;
    r.tasks.extend(decision.tasks);
    let c = r
        .coordination
        .iter_mut()
        .find(|c| c.id == request_id)
        .unwrap();
    c.summary = decision.summary.clone();
    c.task_ids = decision.wait_for_task_ids;
    // The dependency may finish during this read-only review. Recheck its
    // delivered state instead of turning that normal race into a failure.
    c.status = match decision.status.as_str() {
        "resume" => "resolved",
        "wait" if delivered => "pending",
        "wait" => "waiting",
        _ => "blocked",
    }
    .into();
    c.replies.push(json!({"at":now(),"sessionId":c.sessions.last(),"status":decision.status,"summary":c.summary,"taskIds":c.task_ids}));
    let task = r
        .tasks
        .iter_mut()
        .find(|t| t.id == from)
        .ok_or("Tarea inexistente")?;
    if decision.status == "resume" {
        task.status = "pending".into();
    }
    if decision.status == "blocked" {
        task.status = "blocked".into();
        task.error = Some(decision.summary);
    }
    r.configuration_changes.push(json!({"kind":"leadCoordination","at":now(),"requestId":request_id,"status":c.status,"summary":c.summary,"taskIds":c.task_ids}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Run {
        serde_json::from_value(json!({"id":"r","goal":"g","team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":0,"finishedAt":null,"planSessionId":null,"tasks":[{"id":"back","title":"API","objective":"API","assignedAgentId":"lead","repository":"D:/repo","dependencies":[],"expectedFiles":[],"writePaths":["api/"],"acceptanceCriteria":["check"],"status":"running"},{"id":"front","title":"UI","objective":"UI","assignedAgentId":"lead","repository":"D:/repo","dependencies":[],"expectedFiles":[],"writePaths":["web/"],"acceptanceCriteria":["check"],"status":"waiting_dependency"}],"coordination":[{"id":"req","fromTaskId":"front","message":"Falta el DTO","taskIds":["back"],"status":"waiting","summary":"Backend sigue trabajando","createdAt":1,"sessions":["lead-check"]}],"summary":"","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap()
    }
    #[test]
    fn pending_delivery_waits_then_rechecks_after_completion_and_restart() {
        let r = fixture();
        assert_eq!(ready(&r), None);
        let mut restored: Run = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(restored.coordination[0].sessions, vec!["lead-check"]);
        restored.tasks[0].status = "completed".into();
        assert_eq!(ready(&restored).as_deref(), Some("req"));
        restored.coordination[0].status = "resolved".into();
        assert_eq!(ready(&restored), None);
    }
    #[test]
    fn runtime_waits_reject_missing_self_and_circular_dependencies() {
        let mut r = fixture();
        assert!(validate_wait(&r, "front", &["back".into()]).is_ok());
        assert!(validate_wait(&r, "front", &["missing".into()]).is_err());
        assert!(validate_wait(&r, "front", &["front".into()]).is_err());
        assert!(validate_wait(&r, "back", &["front".into()]).is_err());
        r.tasks[0].status = "completed".into();
        assert!(validate_wait(&r, "front", &["back".into()]).is_ok());
    }
    #[test]
    fn write_paths_reject_scope_escapes_and_wildcards() {
        for path in [
            "../api",
            "C:/api",
            "/api",
            "api/../../web",
            "api/**",
            "api/./",
            ".",
            "",
            "api/ ",
            "api./",
        ] {
            assert!(!valid_write_path(path), "{}", path);
        }
        for path in ["src/web/", "src\\api\\", "package.json"] {
            assert!(valid_write_path(path), "{}", path);
        }
    }

    #[test]
    fn lead_assigns_missing_contract_without_replacing_active_work() {
        let mut r = fixture();
        let original = serde_json::to_value(&r.tasks[0]).unwrap();
        let decision = serde_json::from_value(json!({"status":"wait","summary":"Backend termina su tarea y publica el contrato faltante en una tarea propia","waitForTaskIds":["contract"],"tasks":[{"id":"contract","title":"Publicar DTO","objective":"Publicar DTO de usuarios","assignedAgentId":"lead","repository":"D:/repo","dependencies":["back"],"expectedFiles":["api/dto.ts"],"writePaths":["api/dto.ts"],"acceptanceCriteria":["DTO comprobado"]}]})).unwrap();
        apply_decision(&mut r, "req", decision).unwrap();
        assert_eq!(r.tasks.len(), 3);
        assert_eq!(serde_json::to_value(&r.tasks[0]).unwrap(), original);
        assert_eq!(r.coordination[0].task_ids, vec!["contract"]);
        assert_eq!(r.coordination[0].status, "waiting");
        assert_eq!(r.tasks[2].status, "pending");
        assert_eq!(r.coordination[0].replies.len(), 1);
    }

    #[test]
    fn completed_delivery_during_lead_review_is_rechecked_not_rejected() {
        let mut r = fixture();
        r.tasks[0].status = "completed".into();
        let decision = serde_json::from_value(json!({"status":"wait","summary":"Backend estaba trabajando","waitForTaskIds":["back"]})).unwrap();
        apply_decision(&mut r, "req", decision).unwrap();
        assert_eq!(r.coordination[0].status, "pending");
        assert_eq!(ready(&r).as_deref(), Some("req"));
        let decision = serde_json::from_value(
            json!({"status":"resume","summary":"DTO disponible: integrar ahora"}),
        )
        .unwrap();
        apply_decision(&mut r, "req", decision).unwrap();
        assert_eq!(r.tasks[1].status, "pending");
        assert_eq!(r.coordination[0].status, "resolved");
        assert_eq!(r.coordination[0].replies.len(), 2);
    }

    #[test]
    fn lead_can_staff_a_missing_contract_and_invalid_additions_are_atomic() {
        let mut r = fixture();
        r.team.autonomous = true;
        let mut task = r.tasks[0].clone();
        task.id = "contract".into();
        task.assigned_agent_id = "back-2".into();
        task.write_paths = vec!["contract/".into()];
        let decision = serde_json::from_value(json!({"status":"wait","summary":"Otro Backend preparará el contrato","waitForTaskIds":["contract"],"agents":[{"id":"back-2","role":"Backend"}],"tasks":[task]})).unwrap();
        apply_decision(&mut r, "req", decision).unwrap();
        assert_eq!(r.team.members.len(), 2);
        assert_eq!(r.tasks[0].status, "running");
        assert_eq!(r.tasks[2].assigned_agent_id, "back-2");
        let before = serde_json::to_value(&r).unwrap();
        for bad in [
            json!({"status":"wait","summary":"Agente sin trabajo","waitForTaskIds":["back"],"agents":[{"id":"idle","role":"Backend"}]}),
            json!({"status":"wait","summary":"Duplicado","waitForTaskIds":["back"],"agents":[{"id":"back-2","role":"Backend"}],"tasks":[task]}),
        ] {
            assert!(apply_decision(&mut r, "req", serde_json::from_value(bad).unwrap()).is_err());
            assert_eq!(serde_json::to_value(&r).unwrap(), before);
        }
    }
    #[test]
    fn lead_cannot_overwrite_an_existing_task_or_install_a_runtime_cycle() {
        let mut r = fixture();
        let before = serde_json::to_value(&r).unwrap();
        let decision = serde_json::from_value(json!({"status":"wait","summary":"Reemplazar API","waitForTaskIds":["back"],"tasks":[r.tasks[0].clone()]})).unwrap();
        assert!(apply_decision(&mut r, "req", decision).is_err());
        assert_eq!(serde_json::to_value(&r).unwrap(), before);
        let decision = serde_json::from_value(
            json!({"status":"wait","summary":"Esperar UI","waitForTaskIds":["front"]}),
        )
        .unwrap();
        assert!(apply_decision(&mut r, "req", decision).is_err());
        assert_eq!(serde_json::to_value(&r).unwrap(), before);
    }
}
