use super::domain::*;
use serde_json::json;

const MAX_HELP_REQUESTS: usize = 3;
const MAX_TOTAL_HELP_REQUESTS: usize = 9;

// Technical diagnosis belongs to the Lead. Authorization, account access and
// user controls are never resolved by silently granting or bypassing them.
pub(super) fn requires_user(reason: &str) -> bool {
    let text = reason.to_lowercase();
    [
        "usage_limit",
        "usage limit",
        "límite de uso",
        "quota",
        "insufficient credits",
        "facturación",
        "falta de saldo",
        "payment required",
        "http 402",
        "invalid_api_key",
        "unauthorized",
        "authentication",
        "volver a conectarse",
        "reconectá la cuenta",
        "reasigná el modelo",
        "variante no disponible",
        "restringido a la aplicación opencode",
        "cuenta conectada no tiene permiso",
        "no está disponible para esta cuenta",
        "modelo elegido no está disponible",
        "modelo no está disponible",
        "espera un permiso",
        "permission denied",
        "permiso denegado",
        "falta autorización",
        "requiere autorización",
        "necesito tu autorización",
        "control está apagado",
        "control de pc está apagado",
        "elegir navegador",
        "ventana elegida",
        "fuera de la carpeta autorizada",
        "carpeta no autorizada",
        "presupuesto de la ejecución",
        "límite de 45 minutos",
        "cancelación",
        "cancelado",
        "blocked by policy",
        "proveedor bloqueó",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

pub(super) fn eligible(r: &Run, task: &Task) -> bool {
    r.status == "running"
        && ["blocked", "failed", "review_error"].contains(&task.status.as_str())
        && task.attempts.iter().all(|a| a.finished_at.is_some())
        && !requires_user(task.error.as_deref().unwrap_or(""))
        && !r.coordination.iter().any(|c| {
            c.from_task_id == task.id && !["resolved", "cancelled"].contains(&c.status.as_str())
        })
}

// Called only after the worker thread has joined and any failed sessions have
// been stopped. A known message boundary distinguishes the requested repair
// from an older completed answer when recovering the same worker session.
pub(super) fn request_help(r: &mut Run, task_id: &str, boundary: Option<Vec<String>>) -> bool {
    let Some(task) = r.tasks.iter().find(|t| t.id == task_id) else {
        return false;
    };
    if !eligible(r, task) {
        return false;
    }
    let reason = task.error.clone().unwrap_or_else(|| "La tarea se detuvo sin explicar una causa. Revisá su actividad y proponé una salida concreta.".into());
    let requests: Vec<_> = r
        .coordination
        .iter()
        .filter(|c| c.from_task_id == task_id && c.kind == "technical_blocker")
        .collect();
    let count = requests.iter().filter(|c| c.message.trim() == reason.trim()).count();
    if count >= MAX_HELP_REQUESTS || requests.len() >= MAX_TOTAL_HELP_REQUESTS {
        let limit = if count >= MAX_HELP_REQUESTS { "El Lead revisó este mismo bloqueo tres veces y sigue sin resolverlo" } else { "El Lead agotó nueve intervenciones de recuperación en esta tarea" };
        let task = r.tasks.iter_mut().find(|t| t.id == task_id).unwrap();
        task.error = Some(format!("{limit}. El trabajo se conserva. Último problema: {}", task.error.as_deref().unwrap_or("No quedó una causa registrada")));
        return false;
    }
    let previous = task.attempts.last().cloned();
    if previous.as_ref().is_some_and(|a| a.session_id.is_some())
        && boundary.as_ref().is_none_or(|ids| ids.is_empty())
    {
        return false; // No confirmed history: keep the failure visible, never replay blindly.
    }
    let task = r.tasks.iter_mut().find(|t| t.id == task_id).unwrap();
    let attempt_id = if let Some(previous) = previous.filter(|a| a.session_id.is_some()) {
        let attempt = Attempt {
            id: id(),
            agent: previous.agent,
            session_id: previous.session_id,
            review_session_id: None,
            started_at: now(),
            finished_at: None,
            status: "waiting_dependency".into(),
            summary: String::new(),
            error: None,
            review: None,
            commands: vec![],
            observations: vec![],
            declared_checks: vec![],
            recovered: true,
            resume_after_message_ids: boundary.unwrap_or_default(),
        };
        let id = attempt.id.clone();
        task.attempts.push(attempt);
        Some(id)
    } else {
        None
    };
    task.status = "waiting_dependency".into();
    task.error = None;
    let request_id = id();
    r.coordination.push(Coordination {
        id: request_id.clone(), kind: "technical_blocker".into(), attempt_id,
        cycle_task_ids: vec![], from_task_id: task_id.into(), message: reason.clone(),
        task_ids: vec![], status: "pending".into(), summary: "El agente pidió ayuda al Lead para resolver un problema técnico. No necesitás intervenir mientras lo revisa.".into(),
        created_at: now(), sessions: vec![], replies: vec![],
    });
    r.configuration_changes.push(json!({"kind":"automaticLeadHelp","at":now(),"requestId":request_id,"taskId":task_id,"attempt":count+1,"reason":reason}));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Run {
        serde_json::from_value(json!({"id":"r","goal":"demo","team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":0,"tasks":[{"id":"back","title":"API","objective":"Implementar API","assignedAgentId":"lead","repository":"D:/repo","dependencies":[],"expectedFiles":["api.js"],"writePaths":["api.js"],"acceptanceCriteria":["Prueba real"],"status":"blocked","error":"Falta ejecutar la comprobación HTTP correcta","attempts":[{"id":"original","agent":super::super::domain::tests::team().members[0],"sessionId":"worker-session","startedAt":0,"finishedAt":1,"status":"blocked","summary":"Trabajo conservado","error":"Falta comprobar","commands":[{"command":"node check.js","exitCode":1}]}]}],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap()
    }
    #[test]
    fn technical_failure_goes_to_lead_without_changing_previous_attempt_or_scope() {
        let mut r = fixture();
        let original = serde_json::to_value(&r.tasks[0]).unwrap();
        assert!(request_help(
            &mut r,
            "back",
            Some(vec!["old-answer".into()])
        ));
        assert_eq!(r.tasks[0].status, "waiting_dependency");
        assert_eq!(
            serde_json::to_value(&r.tasks[0].attempts[0]).unwrap(),
            original["attempts"][0]
        );
        assert_eq!(
            r.tasks[0].attempts[1].session_id.as_deref(),
            Some("worker-session")
        );
        assert_eq!(
            r.tasks[0].attempts[1].resume_after_message_ids,
            vec!["old-answer"]
        );
        assert_eq!(r.tasks[0].acceptance_criteria, vec!["Prueba real"]);
        assert_eq!(r.tasks[0].write_paths, vec!["api.js"]);
        assert_eq!(r.coordination[0].kind, "technical_blocker");
        assert!(!request_help(
            &mut r,
            "back",
            Some(vec!["old-answer".into()])
        ));
    }
    #[test]
    fn user_permissions_accounts_and_uncertain_sessions_are_not_auto_resumed() {
        for reason in [
            "Backend espera un permiso de OpenCode",
            "La cuenta alcanzó su límite de uso",
            "Falta autorización",
            "La cuenta necesita volver a conectarse",
            "El modelo openai/qa-missing de Backend no está disponible. Reconectá la cuenta o reasigná el modelo",
            "El proveedor bloqueó la solicitud",
            "Se alcanzó el presupuesto de la ejecución",
        ] {
            let mut r = fixture();
            r.tasks[0].error = Some(reason.into());
            assert!(
                !request_help(&mut r, "back", Some(vec!["old".into()])),
                "{reason}"
            );
        }
        let mut r = fixture();
        r.tasks[0].attempts[0].finished_at = None;
        assert!(!request_help(&mut r, "back", Some(vec!["old".into()])));
        let mut r = fixture();
        assert!(!request_help(&mut r, "back", None));
        r.status = "cancelling".into();
        assert!(!request_help(&mut r, "back", Some(vec!["old".into()])));
    }
    #[test]
    fn assistance_is_bounded_across_restart_and_human_decisions_stay_visible() {
        let mut r = fixture();
        for _ in 0..MAX_HELP_REQUESTS {
            r.tasks[0].error = Some("Falla la prueba HTTP".into());
            assert!(request_help(&mut r, "back", Some(vec!["old".into()])));
            r.coordination.last_mut().unwrap().status = "resolved".into();
            r.tasks[0].status = "blocked".into();
            r.tasks[0].error = Some("Falla la prueba HTTP".into());
            r.tasks[0].attempts.last_mut().unwrap().finished_at = Some(now());
            r = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        }
        assert!(!request_help(&mut r, "back", Some(vec!["old".into()])));
        let mut r = fixture();
        assert!(request_help(&mut r, "back", Some(vec!["old".into()])));
        r.tasks[0].status = "blocked".into();
        r.tasks[0].attempts.last_mut().unwrap().finished_at = Some(now());
        r.coordination[0].status = "blocked".into();
        assert!(!request_help(&mut r, "back", Some(vec!["old".into()])));
    }

    #[test]
    fn different_technical_problems_have_their_own_repair_budget() {
        let mut r = fixture();
        for index in 0..MAX_TOTAL_HELP_REQUESTS {
            r.tasks[0].error = Some(format!("Falla técnica distinta {index}"));
            assert!(request_help(&mut r, "back", Some(vec![format!("message-{index}")])));
            r.coordination.last_mut().unwrap().status = "resolved".into();
            r.tasks[0].status = "blocked".into();
            r.tasks[0].attempts.last_mut().unwrap().finished_at = Some(now());
            r = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        }
        r.tasks[0].error = Some("Otro problema distinto".into());
        assert!(!request_help(&mut r, "back", Some(vec!["last".into()])));
    }
}
