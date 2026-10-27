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
    #[serde(default)]
    resume_tasks: Vec<ResumeTask>,
    #[serde(default)]
    user_request: Option<UserRequest>,
}

#[derive(Deserialize)]
struct UserRequest {
    kind: String,
    question: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeTask {
    task_id: String,
    summary: String,
}

const CIRCULAR_WAIT: &str = "El pedido crea una espera circular entre agentes; el Lead debe separar el contrato de la integración";
const INVALID_RESUME: &str = "El Lead debe dar instrucciones concretas para cada otra tarea suspendida, sin repetir IDs";
const TECHNICAL_ESCALATION: &str = "El Lead derivó un problema técnico al usuario sin una decisión imprescindible. Diagnosticá la causa y proponé resume o tareas de ayuda con wait; una prueba fallida o faltante la resuelve el equipo";

// Pending requests are suggestions, not scheduler edges, but must be included
// when diagnosing a mutual wait before the Lead installs its next decision.
pub(super) fn circular_tasks(r: &Run) -> Vec<String> {
    fn reaches(r: &Run, current: &str, target: &str, seen: &mut HashSet<String>) -> bool {
        if !seen.insert(current.into()) {
            return false;
        }
        let Some(task) = r
            .tasks
            .iter()
            .find(|t| t.id == current && !["completed", "cancelled"].contains(&t.status.as_str()))
        else {
            return false;
        };
        let waits = r
            .coordination
            .iter()
            .filter(|c| {
                c.from_task_id == current
                    && ["pending", "checking", "waiting"].contains(&c.status.as_str())
            })
            .flat_map(|c| &c.task_ids);
        task.dependencies
            .iter()
            .chain(waits)
            .any(|next| next == target || reaches(r, next, target, seen))
    }
    r.tasks
        .iter()
        .filter(|t| reaches(r, &t.id, &t.id, &mut HashSet::new()))
        .map(|t| t.id.clone())
        .collect()
}

fn cycle_summary(r: &Run, ids: &[String]) -> String {
    let names: Vec<_> = ids
        .iter()
        .filter_map(|id| r.tasks.iter().find(|t| &t.id == id))
        .map(|t| t.title.as_str())
        .collect();
    format!("Detecté una espera circular entre {}. Estoy revisando cómo separar el contrato de la integración para que puedan avanzar.", names.join(" y "))
}

// Include runtime waits as well as planned dependencies: two workers must never
// silently wait for one another forever.
pub(super) fn validate_wait(r: &Run, from: &str, targets: &[String]) -> Result<(), String> {
    if targets.iter().any(|id| id == from) {
        return Err(CIRCULAR_WAIT.into());
    }
    if targets
        .iter()
        .any(|id| !r.tasks.iter().any(|t| &t.id == id))
    {
        return Err("Pedido al Lead con una tarea inexistente".into());
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
            return Err(CIRCULAR_WAIT.into());
        }
    }
}

pub(super) fn ready(r: &Run) -> Option<String> {
    if let Some(request) = r
        .coordination
        .iter()
        .find(|c| ["pending", "checking"].contains(&c.status.as_str()))
    {
        return Some(request.id.clone());
    }
    let cycles = circular_tasks(r);
    r.coordination
        .iter()
        .find(|c| {
            c.status == "pending"
                || c.status == "checking"
                || (c.status == "waiting"
                    && (cycles.contains(&c.from_task_id)
                        || c.task_ids.iter().all(|id| {
                            r.tasks.iter().any(|t| {
                                &t.id == id
                                    && ["completed", "blocked", "cancelled"]
                                        .contains(&t.status.as_str())
                            })
                        })))
        })
        .map(|c| c.id.clone())
}

pub(super) fn check(app: &AppHandle, run_id: &str, request_id: &str) -> Result<(), String> {
    loop {
        match check_once(app, run_id, request_id) {
            Err(error) if repairable_decision(&error) => {
                // This is invalid read-only planning, not a failed worker. Ask
                // the Lead to repair it, with a persisted bound across restarts.
                update_run(app, run_id, |r| request_repair(r, request_id, &error))?;
            }
            result => return result,
        }
    }
}

fn repairable_decision(error: &str) -> bool {
    error == CIRCULAR_WAIT || error == TECHNICAL_ESCALATION || error == INVALID_RESUME
        || [
            "Respuesta estructurada inválida",
            "JSON incompleto",
            "El Lead devolvió una respuesta de coordinación inválida",
            "El Lead pidió esperar sin una entrega pendiente",
            "El Lead debe esperar las tareas que acaba de solicitar",
            "Dependencia inválida",
            "IDs de tareas duplicados",
            "Pedido al Lead con una tarea inexistente",
            "Tarea a reanudar inexistente",
            "Solo se pueden separar esperas de tareas suspendidas",
            "La tarea no tiene una espera de coordinación",
        ]
        .iter()
        .any(|prefix| error.starts_with(prefix))
}

fn request_repair(r: &mut Run, request_id: &str, reason: &str) -> Result<(), String> {
    let c = r
        .coordination
        .iter_mut()
        .find(|c| c.id == request_id)
        .ok_or("Pedido inexistente")?;
    if c.replies
        .iter()
        .rev()
        .take_while(|reply| reply["status"] != "recovery_requested")
        .filter(|reply| reply["status"] == "repair_requested")
        .count()
        >= 2
    {
        return Err("El Lead no logró proponer una salida segura después de dos correcciones.".into());
    }
    c.status = "pending".into();
    c.summary = if reason == CIRCULAR_WAIT { "El Lead está corrigiendo una espera circular. Debe separar el contrato de la integración sin reiniciar el trabajo." } else { "El Lead está corrigiendo su respuesta para proponer una solución válida. No necesitás intervenir mientras la revisa." }.into();
    c.replies.push(json!({"at":now(),"sessionId":c.sessions.last(),"status":"repair_requested","summary":c.summary,"reason":evidence::sanitize(reason),"taskIds":c.task_ids}));
    Ok(())
}

// The coordinator has no file-writing tools. Once its session is confirmed
// stopped, a fresh diagnostic turn is safe; the worker itself is not replayed.
// Persist the recovery budget so a restart cannot create an infinite loop.
pub(super) fn recover_after_failure(r: &mut Run, request_id: &str, error: &str, stopped: bool) -> bool {
    if !stopped || r.status != "running" || super::autonomy::requires_user(error) { return false; }
    let Some(c) = r.coordination.iter().find(|c| c.id == request_id) else { return false; };
    let recoveries = c.replies.iter().filter(|reply| reply["status"] == "recovery_requested").count();
    if recoveries >= 2 || c.sessions.len() >= 16 || ["resolved", "cancelled", "blocked"].contains(&c.status.as_str()) { return false; }
    let Some(task) = r.tasks.iter_mut().find(|t| t.id == c.from_task_id) else { return false; };
    if !["waiting_dependency", "blocked"].contains(&task.status.as_str()) { return false; }
    task.status = "waiting_dependency".into();
    task.error = None;
    let task_id = task.id.clone();
    let c = r.coordination.iter_mut().find(|c| c.id == request_id).unwrap();
    c.status = "pending".into();
    c.summary = "El Lead está buscando otra forma de desbloquear al agente. El resto del equipo puede seguir; no necesitás reintentar.".into();
    c.replies.push(json!({"status":"recovery_requested","at":now(),"sessionId":c.sessions.last(),"summary":c.summary,"taskIds":c.task_ids,"reason":evidence::sanitize(error),"attempt":recoveries+1}));
    r.configuration_changes.push(json!({"kind":"automaticCoordinatorRecovery","at":now(),"requestId":request_id,"taskId":task_id,"attempt":recoveries+1}));
    true
}

fn check_once(app: &AppHandle, run_id: &str, request_id: &str) -> Result<(), String> {
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
    let cycles = circular_tasks(&r);
    let cycle_note = if cycles.is_empty() {
        String::new()
    } else {
        cycle_summary(&r, &cycles)
    };
    update_run(app, run_id, |r| {
        let c = r
            .coordination
            .iter_mut()
            .find(|c| c.id == request_id)
            .ok_or("Pedido inexistente")?;
        c.status = "checking".into();
        c.cycle_task_ids = cycles.clone();
        if !cycle_note.is_empty() {
            c.summary = cycle_note.clone();
        }
        if !reuse {
            c.sessions.push(session.clone());
        }
        Ok(())
    })?;
    let prompt = format!("Sos el Lead de coordinación, con herramientas SOLO de lectura. Un agente necesita algo de otro. Revisá los archivos actuales y los estados reales de todas las tareas. Los demás siguen trabajando: no los reinicies ni cambies archivos. Respondé resume solo si el solicitante ya puede continuar con un contrato concreto; wait si falta una entrega, indicando IDs reales; blocked únicamente ante una decisión imprescindible del usuario o un acceso que realmente no puede resolver el equipo. Un fallo técnico o una prueba faltante requieren diagnóstico y corrección del equipo. Si falta trabajo no asignado, creá tareas nuevas para el responsable con writePaths propios; no alteres tareas en ejecución. Separá preparación/contrato de integración; evitá esperas circulares.\nPEDIDO: {}\nESTADO ACTUAL DEL EQUIPO: {}\nHISTORIAL DE COORDINACIÓN: {}\nSKILLS DEL LEAD:\n{}\nRespondé SOLO JSON: {{\"status\":\"resume|wait|blocked\",\"summary\":\"estado comprobado, contrato y respuesta concreta al agente\",\"waitForTaskIds\":[],\"tasks\":[],\"resumeTasks\":[]}}. Las tareas nuevas usan el contrato del plan: id,title,objective,assignedAgentId,repository,dependencies,expectedFiles,writePaths,acceptanceCriteria.",serde_json::to_string(request).unwrap_or_default(),serde_json::to_string(&r.tasks).unwrap_or_default(),serde_json::to_string(&r.coordination).unwrap_or_default(),runner::skills_prompt(&r,&employee));
    let prompt = format!(
        "{}{}\nINTEGRANTES ACTUALES: {}\nCATÁLOGO DE SKILLS: {}",
        prompt,
        super::staffing::prompt(&r.team),
        serde_json::to_string(&r.team.members).unwrap_or_default(),
        serde_json::to_string(&r.skills.iter().map(|s| &s.id).collect::<Vec<_>>())
            .unwrap_or_default()
    );
    let prompt = format!("{}\nDEPENDENCIAS CIRCULARES DETECTADAS (IDs): {}\nSi hay un ciclo o se rechazó tu decisión por crearlo, intervení: acordá un contrato concreto para que un integrante avance en preparación y dejá la integración para después. Podés reanudar otras tareas suspendidas con resumeTasks:[{{taskId:ID,summary:instrucción concreta y contrato para continuar sin esperar al otro}}]. Esto libera únicamente sus esperas de coordinación: conserva sus sesiones, archivos, dependencias del plan y criterios originales. No reanuda tareas activas ni terminadas. Podés crear tareas independientes de contrato con writePaths propios, sin invadir archivos reservados. No afirmes que una dependencia ya está implementada si solo acordaste su contrato. No marques una entrega completa ni elimines criterios para romper un ciclo. Si no hay forma segura sin información del usuario, devolvé blocked y explicá la decisión exacta que falta. Respondé en summary qué separaste y quién puede avanzar; no pidas una microdecisión que puedas resolver con el estado actual.",prompt,serde_json::to_string(&cycles).unwrap_or_default());
    let prompt = format!("{}\nAUTONOMÍA DEL LEAD: Los bloqueos técnicos, errores de herramientas y comprobaciones fallidas de los especialistas se te derivan a vos, no al usuario. Si kind=technical_blocker, leé sus intentos, comandos, revisiones y archivos actuales. Diagnosticar un fallo es parte de tu tarea: no uses blocked solamente porque algo falló. Devolvé resume con una solución concreta (comando de verificación correcto, corrección acotada, contrato o alternativa dentro del alcance), o wait con tareas de ayuda válidas si falta una entrega. El trabajador continuará su sesión desde la evidencia actual sin repetir escrituras o efectos ya observados. Conservá criterios, rutas y permisos. Nunca afirmes haber ejecutado la corrección desde tu sesión de lectura. No uses bash u otras herramientas para eludir una autorización. blocked se reserva para una decisión imprescindible del usuario, credenciales/acceso, permisos reales, un control de PC apagado o cuando ya no existe una salida segura dentro del alcance; explicá exactamente qué necesitás y por qué no lo puede resolver el equipo.", prompt);
    let prompt = format!("{}\nLas preguntas de alcance deben reunirse antes de trabajar. Resolvé las decisiones técnicas y los detalles no especificados con una opción razonable dentro del pedido; registrá las suposiciones y seguí. Si aparece una decisión imprescindible imprevista que solo el usuario puede tomar y no existe alternativa segura, explicá por qué no pudo preverse al principio y, si devolvés blocked, incluí userRequest={{kind:decision,question:pregunta concreta imprescindible}}. No uses esa salida para pedirle ejecutar pruebas, revisar errores, elegir comandos o coordinar agentes: eso es tu trabajo. Para permisos o acceso de cuenta indicá la causa real. Si ya hubo intentos fallidos, cambiá la estrategia o asigná una tarea de diagnóstico/verificación a un especialista con los permisos existentes; no repitas sin cambios la misma instrucción.", prompt);
    let recoveries = request.replies.iter().filter(|reply| reply["status"] == "recovery_requested").count();
    let prompt = if recoveries == 0 { prompt } else {
        format!("{}\nRECUPERACIÓN AUTOMÁTICA DEL LEAD ({}): Tu coordinación anterior falló y el trabajador conserva su sesión y archivos. Revisá las causas de recovery_requested y repair_requested. Cambiá de estrategia: leé el contrato y los resultados existentes, aislá el paso mínimo que permite avanzar y devolvé una instrucción concreta. Si requiere implementación o comprobación adicional, asigná una tarea de ayuda con writePaths propios y esperala. No repitas la decisión rechazada ni solicites al usuario diagnosticar el problema. No repitas efectos del trabajador ni marques pruebas pendientes como aprobadas.", prompt, recoveries)
    };
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
    if !["running", "paused"].contains(&r.status.as_str()) {
        return Err("La ejecución ya no admite cambios de coordinación".into());
    }
    if !["resume", "wait", "blocked"].contains(&decision.status.as_str())
        || decision.summary.trim().is_empty()
    {
        return Err("El Lead devolvió una respuesta de coordinación inválida".into());
    }
    decision.summary = evidence::sanitize(&decision.summary);
    if decision.status == "blocked" && !super::autonomy::requires_user(&decision.summary)
        && !decision.user_request.as_ref().is_some_and(|request| request.kind == "decision" && request.question.trim().len() >= 10)
    {
        return Err(TECHNICAL_ESCALATION.into());
    }
    if decision.status == "blocked" {
        if let Some(request) = &decision.user_request {
            if !request.question.trim().is_empty() {
                decision.summary = format!("{}\nNecesito que decidas: {}", decision.summary, evidence::sanitize(&request.question));
            }
        }
    }
    super::staffing::validate_assignments(&decision.agents, &decision.tasks)?;
    let from = r
        .coordination
        .iter()
        .find(|c| c.id == request_id)
        .ok_or("Pedido inexistente")?
        .from_task_id
        .clone();
    // Models sometimes include the requesting task in resumeTasks as well as
    // status=resume. It is the same requested continuation, not another task.
    // Keep those concrete instructions and use the normal current-task path.
    let mut own_instructions = Vec::new();
    for resume in decision.resume_tasks.iter().filter(|resume| resume.task_id == from) {
        if decision.status != "resume" || resume.summary.trim().is_empty() {
            return Err(INVALID_RESUME.into());
        }
        let instruction = evidence::sanitize(resume.summary.trim());
        if !own_instructions.contains(&instruction) { own_instructions.push(instruction); }
    }
    if !own_instructions.is_empty() {
        decision.summary = format!("{}\n{}", decision.summary, own_instructions.join("\n"));
        decision.resume_tasks.retain(|resume| resume.task_id != from);
    }
    for t in &mut decision.tasks {
        t.status = "pending".into();
        t.attempts.clear();
        t.error = None;
    }
    let mut proposed = r.clone();
    proposed.team = super::staffing::with_agents(&r.team, &decision.agents, &r.skills)?;
    proposed.tasks.extend(decision.tasks.clone());
    let mut resumed = HashSet::new();
    for resume in &decision.resume_tasks {
        if resume.task_id == from
            || resume.summary.trim().is_empty()
            || !resumed.insert(resume.task_id.clone())
        {
            return Err(INVALID_RESUME.into());
        }
        let task = proposed
            .tasks
            .iter_mut()
            .find(|t| t.id == resume.task_id)
            .ok_or("Tarea a reanudar inexistente")?;
        if task.status != "waiting_dependency"
            || task
                .attempts
                .last()
                .is_some_and(|a| a.status != "waiting_dependency" || !a.recovered)
        {
            return Err("Solo se pueden separar esperas de tareas suspendidas; el trabajo activo o terminado se conserva".into());
        }
        let waits: Vec<_> = proposed
            .coordination
            .iter_mut()
            .filter(|c| {
                c.from_task_id == resume.task_id
                    && ["pending", "waiting"].contains(&c.status.as_str())
            })
            .collect();
        if waits.is_empty() {
            return Err(
                "La tarea no tiene una espera de coordinación que el Lead pueda resolver".into(),
            );
        }
        let summary = evidence::sanitize(&resume.summary);
        for c in waits {
            c.status = "resolved".into();
            c.summary = summary.clone();
            c.replies.push(json!({"at":now(),"sessionId":r.coordination.iter().find(|c| c.id == request_id).and_then(|c| c.sessions.last()),"status":"resume","summary":summary,"taskIds":[]}));
        }
        task.status = "pending".into();
        task.error = None;
    }
    validate_plan(
        &Plan {
            agents: vec![],
            tasks: proposed.tasks.clone(),
            evidence_targets: vec![],
        },
        &proposed.team,
    )?;
    if decision.status != "blocked" {
        validate_wait(&proposed, &from, &decision.wait_for_task_ids)?;
    }
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
    let c = proposed
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
    let task = proposed
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
    proposed.configuration_changes.push(json!({"kind":"leadCoordination","at":now(),"requestId":request_id,"status":c.status,"summary":c.summary,"taskIds":c.task_ids,"resumedTaskIds":resumed}));
    *r = proposed;
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
        assert_eq!(
            validate_wait(&r, "front", &["front".into()]).unwrap_err(),
            CIRCULAR_WAIT
        );
        assert!(validate_wait(&r, "back", &["front".into()]).is_err());
        r.tasks[0].status = "completed".into();
        assert!(validate_wait(&r, "front", &["back".into()]).is_ok());
    }

    fn mutual_wait() -> Run {
        let mut r = fixture();
        r.tasks[0].status = "waiting_dependency".into();
        r.coordination.push(serde_json::from_value(json!({"id":"back-req","fromTaskId":"back","message":"Necesito la UI para terminar la API","taskIds":["front"],"status":"pending","summary":"","createdAt":2,"sessions":[]})).unwrap());
        r
    }

    #[test]
    fn cycle_correction_budget_survives_restart_and_does_not_loop_forever() {
        let mut r = mutual_wait();
        request_repair(&mut r, "back-req", CIRCULAR_WAIT).unwrap();
        let mut restored: Run = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        request_repair(&mut restored, "back-req", CIRCULAR_WAIT).unwrap();
        let before = serde_json::to_value(&restored).unwrap();
        assert!(request_repair(&mut restored, "back-req", CIRCULAR_WAIT)
            .unwrap_err()
            .contains("después de dos correcciones"));
        assert_eq!(serde_json::to_value(&restored).unwrap(), before);
    }

    #[test]
    fn malformed_lead_decisions_are_repaired_without_retrying_account_or_permission_errors() {
        for error in ["Respuesta estructurada inválida: expected value", "El Lead devolvió una respuesta de coordinación inválida", "El Lead pidió esperar sin una entrega pendiente"] { assert!(repairable_decision(error)); }
        for error in ["La cuenta alcanzó su límite de uso", "Falta autorización", "Se perdió la conexión con el motor"] { assert!(!repairable_decision(error)); }
        let mut r = fixture();
        request_repair(&mut r, "req", "Respuesta estructurada inválida").unwrap();
        assert_eq!(r.coordination[0].status, "pending");
        assert!(r.coordination[0].summary.contains("No necesitás intervenir"));
        assert!(!r.coordination[0].summary.contains("circular"));
    }

    #[test]
    fn exhausted_coordination_recovers_without_replaying_the_worker() {
        let mut r = fixture();
        let original_tasks = serde_json::to_value(&r.tasks).unwrap();
        request_repair(&mut r, "req", TECHNICAL_ESCALATION).unwrap();
        request_repair(&mut r, "req", TECHNICAL_ESCALATION).unwrap();
        let error = request_repair(&mut r, "req", TECHNICAL_ESCALATION).unwrap_err();
        assert!(recover_after_failure(&mut r, "req", &error, true));
        let mut restored: Run = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(ready(&restored).as_deref(), Some("req"));
        assert_eq!(serde_json::to_value(&restored.tasks).unwrap(), original_tasks);
        assert_eq!(restored.coordination[0].replies.last().unwrap()["status"], "recovery_requested");
        assert!(restored.coordination[0].summary.contains("no necesitás reintentar"));
        request_repair(&mut restored, "req", TECHNICAL_ESCALATION).unwrap();
        request_repair(&mut restored, "req", TECHNICAL_ESCALATION).unwrap();
        assert!(request_repair(&mut restored, "req", TECHNICAL_ESCALATION).is_err());
        assert!(recover_after_failure(&mut restored, "req", &error, true));
        let mut restored: Run = serde_json::from_str(&serde_json::to_string(&restored).unwrap()).unwrap();
        let before = serde_json::to_value(&restored).unwrap();
        assert!(!recover_after_failure(&mut restored, "req", &error, true));
        assert_eq!(serde_json::to_value(&restored).unwrap(), before);
    }

    #[test]
    fn coordinator_recovery_preserves_real_user_gates_and_uncertain_sessions() {
        for reason in ["La cuenta alcanzó su límite de uso", "Falta autorización", "El control de PC está apagado"] {
            let mut r = fixture();
            let before = serde_json::to_value(&r).unwrap();
            assert!(!recover_after_failure(&mut r, "req", reason, true));
            assert_eq!(serde_json::to_value(&r).unwrap(), before);
        }
        let mut r = fixture();
        assert!(!recover_after_failure(&mut r,"req","Respuesta estructurada inválida",false));
        r.coordination[0].status = "blocked".into();
        assert!(!recover_after_failure(&mut r,"req","Decisión externa imprescindible",true));
        r.coordination[0].status = "checking".into();
        r.status = "cancelling".into();
        assert!(!recover_after_failure(&mut r,"req","Respuesta estructurada inválida",true));
    }

    #[test]
    fn technical_block_is_repaired_by_the_lead_instead_of_becoming_a_user_request() {
        let mut r = fixture();
        let before = serde_json::to_value(&r).unwrap();
        let decision: Decision = serde_json::from_value(json!({"status":"blocked","summary":"Falla una prueba de la API; que el usuario la revise."})).unwrap();
        assert_eq!(apply_decision(&mut r,"req",decision).unwrap_err(),TECHNICAL_ESCALATION);
        assert_eq!(serde_json::to_value(&r).unwrap(),before);
        assert!(repairable_decision(TECHNICAL_ESCALATION));
        request_repair(&mut r,"req",TECHNICAL_ESCALATION).unwrap();
        assert_eq!(r.coordination[0].status,"pending");
        assert_eq!(r.tasks[1].status,"waiting_dependency");
        let repaired: Decision = serde_json::from_value(json!({"status":"resume","summary":"El contrato está en api/schema.json. Completá la comprobación con ese contrato, sin repetir la escritura."})).unwrap();
        apply_decision(&mut r,"req",repaired).unwrap();
        assert_eq!(r.tasks[1].status,"pending");
        assert_eq!(r.coordination[0].status,"resolved");
    }

    #[test]
    fn requesting_task_can_resume_with_its_own_concrete_instructions() {
        let mut r = fixture();
        let before = serde_json::to_value(&r.tasks).unwrap();
        let decision: Decision = serde_json::from_value(json!({"status":"resume","summary":"Continuá la implementación.","resumeTasks":[{"taskId":"front","summary":"Usá el contrato actual y ejecutá la prueba HTTP."},{"taskId":"front","summary":"Usá el contrato actual y ejecutá la prueba HTTP."}]})).unwrap();
        apply_decision(&mut r,"req",decision).unwrap();
        assert_eq!(r.tasks[1].status,"pending");
        assert_eq!(r.coordination[0].status,"resolved");
        assert_eq!(r.coordination[0].summary.matches("Usá el contrato actual").count(),1);
        let after = serde_json::to_value(&r.tasks).unwrap();
        assert_eq!(after[0],before[0]);
        for field in ["attempts","writePaths","acceptanceCriteria","dependencies","objective"] { assert_eq!(after[1][field],before[1][field]); }
    }

    #[test]
    fn invalid_resume_instructions_are_repairable_and_never_partially_apply() {
        for value in [
            json!({"status":"resume","summary":"Continuá","resumeTasks":[{"taskId":"back","summary":""}]}),
            json!({"status":"resume","summary":"Continuá","resumeTasks":[{"taskId":"missing","summary":"Verificá el contrato"}]}),
            json!({"status":"wait","summary":"Esperá","waitForTaskIds":["back"],"resumeTasks":[{"taskId":"front","summary":"Seguí"}]})
        ] {
            let mut r = fixture();
            let before = serde_json::to_value(&r).unwrap();
            let error = apply_decision(&mut r,"req",serde_json::from_value(value).unwrap()).unwrap_err();
            assert!(repairable_decision(&error),"{error}");
            assert_eq!(serde_json::to_value(&r).unwrap(),before);
        }
    }

    #[test]
    fn real_account_blocks_and_explicit_user_decisions_remain_visible() {
        let mut r = fixture();
        let decision: Decision = serde_json::from_value(json!({"status":"blocked","summary":"La cuenta alcanzó su límite de uso."})).unwrap();
        apply_decision(&mut r,"req",decision).unwrap();
        assert_eq!(r.tasks[1].status,"blocked");
        let mut r = fixture();
        let decision: Decision = serde_json::from_value(json!({"status":"blocked","summary":"Falta una decisión comercial imprescindible.","userRequest":{"kind":"decision","question":"¿Cuál es la regla de cobro acordada con el cliente?"}})).unwrap();
        apply_decision(&mut r,"req",decision).unwrap();
        assert!(r.tasks[1].error.as_deref().unwrap().contains("¿Cuál es la regla de cobro"));
    }

    #[test]
    fn cycles_include_pending_and_persisted_waits_but_not_their_dependants_or_finished_work() {
        let mut r = mutual_wait();
        let mut downstream = r.tasks[1].clone();
        downstream.id = "integration".into();
        downstream.dependencies = vec!["front".into()];
        downstream.status = "pending".into();
        r.tasks.push(downstream);
        assert_eq!(circular_tasks(&r), vec!["back", "front"]);
        r.coordination[1].status = "waiting".into();
        let restored: Run = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(
            ready(&restored).as_deref(),
            Some("req"),
            "A saved mutual wait must wake the Lead without a completed dependency"
        );
        r.tasks[0].status = "completed".into();
        assert!(circular_tasks(&r).is_empty());
    }

    #[test]
    fn lead_separates_mutual_wait_atomically_and_keeps_sessions_criteria_and_other_work() {
        let mut r = mutual_wait();
        let mut independent = r.tasks[0].clone();
        independent.id = "independent".into();
        independent.status = "running".into();
        r.tasks.push(independent.clone());
        let original = serde_json::to_value(&r.tasks).unwrap();
        let decision = serde_json::from_value(json!({"status":"wait","summary":"Separé el contrato: Backend publica primero la API y Frontend integra después.","waitForTaskIds":["back"],"resumeTasks":[{"taskId":"back","summary":"Implementá el contrato acordado GET /saludo, respuesta {saludo: Hola}. La UI se integra después; conservá tus criterios y comprobaciones originales."}]})).unwrap();
        apply_decision(&mut r, "req", decision).unwrap();
        assert!(circular_tasks(&r).is_empty());
        assert_eq!(r.tasks[0].status, "pending");
        assert_eq!(r.tasks[1].status, "waiting_dependency");
        assert_eq!(r.coordination[1].status, "resolved");
        for (i, task) in r.tasks.iter().enumerate() {
            let after = serde_json::to_value(task).unwrap();
            for field in [
                "attempts",
                "acceptanceCriteria",
                "dependencies",
                "writePaths",
                "objective",
            ] {
                assert_eq!(after[field], original[i][field]);
            }
        }
        assert_eq!(
            serde_json::to_value(&r.tasks[2]).unwrap(),
            serde_json::to_value(independent).unwrap()
        );
        assert!(r.coordination[1].summary.contains("GET /saludo"));
    }

    #[test]
    fn separation_cannot_modify_active_completed_or_unknown_tasks_or_install_another_cycle() {
        let mut r = mutual_wait();
        let mut active = r.tasks[0].clone();
        active.id = "active".into();
        active.status = "running".into();
        r.tasks.push(active);
        let mut done = r.tasks[0].clone();
        done.id = "done".into();
        done.status = "completed".into();
        r.tasks.push(done);
        for ids in [
            vec!["active"],
            vec!["done"],
            vec!["unknown"],
            vec!["back", "active"],
            vec!["back", "back"],
        ] {
            let before = serde_json::to_value(&r).unwrap();
            let resume: Vec<_> = ids
                .into_iter()
                .map(|id| json!({"taskId":id,"summary":"Publicar contrato primero"}))
                .collect();
            let decision = serde_json::from_value(json!({"status":"wait","summary":"Separar","waitForTaskIds":["back"],"resumeTasks":resume})).unwrap();
            assert!(apply_decision(&mut r, "req", decision).is_err());
            assert_eq!(serde_json::to_value(&r).unwrap(), before);
        }
        r.coordination[1].status = "waiting".into();
        let before = serde_json::to_value(&r).unwrap();
        let decision = serde_json::from_value(
            json!({"status":"wait","summary":"Crear otro ciclo","waitForTaskIds":["back"]}),
        )
        .unwrap();
        assert_eq!(
            apply_decision(&mut r, "req", decision).unwrap_err(),
            CIRCULAR_WAIT
        );
        assert_eq!(serde_json::to_value(&r).unwrap(), before);
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
