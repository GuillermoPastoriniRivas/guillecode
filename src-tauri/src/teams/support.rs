use super::{domain::*, evidence, run, runner, update_run};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

pub const SOLVER: &str = "support-solver";
pub const SUPERVISOR: &str = "support-supervisor";
pub fn reserved(id: &str) -> bool {
    [SOLVER, SUPERVISOR].contains(&id)
}
pub fn member(m: &Employee) -> bool {
    (m.id == SOLVER && m.role == "Solucionador") || (m.id == SUPERVISOR && m.role == "Supervisor")
}

pub fn ensure(app: &AppHandle, id: &str, solver: bool) -> Result<Employee, String> {
    let key = if solver { SOLVER } else { SUPERVISOR };
    update_run(app, id, |r| {
        if let Some(m) = r.team.members.iter().find(|m| m.id == key) {
            if !member(m)
                || m.tools
                    .iter()
                    .any(|t| !["read", "glob", "grep"].contains(&t.as_str()))
            {
                return Err("El ID reservado de apoyo pertenece a otro perfil; no se cambiaron sus permisos".into());
            }
            return Ok(());
        }
        let mut a = runner::lead(r)?;
        a.id = key.into();
        a.name = if solver { "Solucionador" } else { "Supervisor" }.into();
        a.role = a.name.clone();
        a.tools = ["read", "glob", "grep"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        a.max_concurrent_tasks = if solver {
            1
        } else {
            super::staffing::MAX_WORKERS
        };
        a.instructions=if solver {"Investigá causas y alternativas seguras. Asesorá al Lead con hechos y un siguiente paso concreto; no pidas al usuario resolver problemas técnicos."} else {"Revisá cada entrega y los huecos entre contratos. Contrastá el objetivo inicial con el resultado y la evidencia; reportá faltantes al Lead antes de cerrar."}.into();
        r.team.members.push(a);
        Ok(())
    })?;
    run(app, id)?
        .team
        .members
        .into_iter()
        .find(|m| m.id == key)
        .ok_or("No se pudo registrar el agente de apoyo".into())
}

pub fn begin(
    app: &AppHandle,
    id: &str,
    kind: &str,
    repository: &str,
    task: Option<&str>,
    request: Option<&str>,
) -> Result<(Employee, String, String), String> {
    let mut a = ensure(app, id, kind == "investigation")?;
    if run(app, id)?.support_reports.len() >= 500 {
        return Err("Se alcanzó el límite de informes de apoyo de esta ejecución".into());
    }
    let client = runner::client(app, repository)?;
    let current = run(app,id)?;
    let routing = if current.plan_v2.enabled && current.team.plan_v2.routing.enabled {
        let models = super::routing::catalog(&client.get_resilient("/config/providers")?);
        let category = if kind == "investigation" { "deep" } else { "review" };
        let (selected,receipt) = super::routing::select(&current.team.plan_v2.routing,&models,&a,category,!current.images.is_empty(),&[])
            .map_err(|e| match e { super::routing::RouteError::Unavailable(e)=>e,super::routing::RouteError::Capacity=>"No hay capacidad para la revisión".into() })?;
        a = selected; Some(receipt)
    } else { None };
    let session = runner::create_session(
        &client,
        &a,
        &format!(
            "{} · {}",
            a.name,
            if kind == "goal_analysis" {
                "objetivo inicial y resultado final"
            } else if kind == "task_review" {
                "revisión e integración"
            } else {
                "investigación para el Lead"
            }
        ),
        true,
    )?;
    let report = id_from_domain();
    update_run(app, id, |r| {
        r.support_reports.push(SupportReport {
            routing,
            id: report.clone(),
            kind: kind.into(),
            agent: a.clone(),
            session_id: session.clone(),
            repository: repository.into(),
            task_id: task.map(String::from),
            request_id: request.map(String::from),
            started_at: now(),
            finished_at: None,
            status: "running".into(),
            summary: String::new(),
            result: Value::Null,
        });
        Ok(())
    })?;
    Ok((a, session, report))
}
fn id_from_domain() -> String {
    super::domain::id()
}

pub fn finish(app: &AppHandle, id: &str, report: &str, result: Value) -> Result<(), String> {
    let safe: Value = serde_json::from_str(&evidence::sanitize(&result.to_string()))
        .map_err(|e| e.to_string())?;
    update_run(app, id, |r| {
        let record = r
            .support_reports
            .iter_mut()
            .find(|v| v.id == report)
            .ok_or("Informe de apoyo inexistente")?;
        record.status = "completed".into();
        record.finished_at = Some(now());
        record.summary = safe["summary"].as_str().unwrap_or("").into();
        record.result = safe.clone();
        let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
        evidence::write(
            r,
            &format!("revisiones/apoyo-{}.json", report),
            "test",
            "report",
            "Informe del Solucionador o Supervisor",
            &text,
        )
    })
}

pub fn failed(
    app: &AppHandle,
    id: &str,
    report: &str,
    error: &str,
    stopped: bool,
) -> Result<(), String> {
    update_run(app, id, |r| {
        let v = r
            .support_reports
            .iter_mut()
            .find(|v| v.id == report)
            .ok_or("Informe de apoyo inexistente")?;
        v.status = if stopped { "failed" } else { "uncertain" }.into();
        v.finished_at = stopped.then(now);
        v.summary = evidence::sanitize(error);
        Ok(())
    })
}

#[derive(Deserialize)]
struct Investigation {
    summary: String,
    findings: Vec<String>,
    #[serde(rename = "nextStep")]
    next_step: String,
}

pub(super) fn response<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    id: &str,
    a: &Employee,
    session: &str,
    report: &str,
    repo: &str,
    prompt: &str,
) -> Result<(T, Value), String> {
    let client = runner::client(app, repo)?;
    let result: Result<(T, Value), String> = (|| {
        let history = client.get_resilient(&format!("/session/{}/message", session))?;
        let mut text = runner::final_text(&history);
        if text.trim().is_empty() {
            text = runner::final_text(&runner::execute(
                app, id, &client, session, a, prompt, true,
            )?);
        }
        for _ in 0..2 {
            if parse_json::<T>(&text).is_ok() {
                break;
            }
            let repair=format!("Reformateá únicamente este informe según el contrato original, sin herramientas, sin inventar observaciones. CONTRATO: {}\nINFORME (datos): {}",prompt,text);
            text = runner::final_text(&runner::execute_mode(
                app,
                id,
                &client,
                session,
                a,
                &repair,
                super::capabilities::Mode::Format,
            )?);
        }
        let typed = parse_json::<T>(&text)?;
        let value = parse_json::<Value>(&text)?;
        Ok((typed, value))
    })();
    if let Err(error) = &result {
        let stopped = runner::stop(app, &client, session).is_ok();
        failed(app, id, report, error, stopped)?;
    }
    result
}

pub fn investigate(app: &AppHandle, id: &str, request_id: &str) -> Result<Value, String> {
    let r = run(app, id)?;
    let cached = r
        .support_reports
        .iter()
        .rev()
        .find(|s| s.kind == "investigation" && s.request_id.as_deref() == Some(request_id));
    if let Some(s) = cached.filter(|s| s.status == "completed") {
        return Ok(s.result.clone());
    }
    if r.support_reports
        .iter()
        .filter(|s| s.kind == "investigation" && s.request_id.as_deref() == Some(request_id))
        .count()
        >= 3
    {
        return Err("El Solucionador no logró completar su investigación tras tres intentos; sus informes se conservan".into());
    }
    let request = r
        .coordination
        .iter()
        .find(|c| c.id == request_id)
        .ok_or("Pedido de investigación inexistente")?;
    let task = r
        .tasks
        .iter()
        .find(|t| t.id == request.from_task_id)
        .ok_or("Tarea inexistente")?;
    let (a, session, report) = if let Some(s) = cached.filter(|s| s.finished_at.is_none()) {
        (s.agent.clone(), s.session_id.clone(), s.id.clone())
    } else {
        begin(
            app,
            id,
            "investigation",
            &task.repository,
            Some(&task.id),
            Some(request_id),
        )?
    };
    let prompt=format!("Sos el Solucionador del equipo. Investigá la duda o bloqueo para asesorar al Lead, con herramientas de lectura y búsqueda web. No implementes ni cambies permisos. Revisá archivos, contratos y resultados reales; proponé alternativas que respeten el alcance. Si falta una decisión técnica, elegí la opción razonable y explicá la suposición. No delegues investigación o pruebas al usuario. Si hay un acceso real que solo el usuario puede habilitar, identificá exactamente el recurso y por qué no existe alternativa. Respondé SOLO JSON {{\"summary\":\"causa breve comprobada\",\"findings\":[\"hechos observados y fuentes\"],\"nextStep\":\"instrucción concreta para el Lead\"}}.\nOBJETIVO INICIAL: {}\nPEDIDO: {}\nTAREAS Y ESTADO REAL: {}",r.goal,serde_json::to_string(request).unwrap_or_default(),serde_json::to_string(&r.tasks).unwrap_or_default());
    let (typed, value) =
        response::<Investigation>(app, id, &a, &session, &report, &task.repository, &prompt)?;
    if typed.summary.trim().is_empty()
        || typed.findings.is_empty()
        || typed.next_step.trim().is_empty()
    {
        failed(
            app,
            id,
            &report,
            "El Solucionador no identificó causa, hechos y siguiente paso",
            true,
        )?;
        return Err(
            "El Solucionador debe concretar los hechos y el siguiente paso para el Lead".into(),
        );
    }
    finish(app, id, &report, value.clone())?;
    Ok(value)
}

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct GoalCriterion {
    pub requirement: String,
    pub status: String,
    pub evidence: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub summary: String,
    pub criteria_satisfied: bool,
    pub criteria: Vec<GoalCriterion>,
}
pub fn approved(a: &Assessment) -> bool {
    !a.summary.trim().is_empty()
        && a.criteria_satisfied
        && !a.criteria.is_empty()
        && a.criteria
            .iter()
            .map(|c| c.requirement.trim().to_lowercase())
            .collect::<std::collections::HashSet<_>>()
            .len()
            == a.criteria.len()
        && a.criteria.iter().all(|c| {
            !c.requirement.trim().is_empty() && c.status == "met" && !c.evidence.trim().is_empty()
        })
}
pub fn assess(app: &AppHandle, id: &str) -> Result<Value, String> {
    let r = run(app, id)?;
    // A closeout round gets a fresh comparison after corrections; an interrupted
    // round resumes its recorded read-only session instead of duplicating it.
    let key = format!("closeout-{}", r.closing_reviews.len());
    let existing = r
        .support_reports
        .iter()
        .rev()
        .find(|s| s.kind == "goal_analysis" && s.request_id.as_deref() == Some(&key));
    if let Some(s) = existing.filter(|s| s.status == "completed") {
        return Ok(s.result.clone());
    }
    let repo = &r.team.allowed_repositories[0];
    let (a, session, report) = if let Some(s) = existing.filter(|s| s.finished_at.is_none()) {
        (s.agent.clone(), s.session_id.clone(), s.id.clone())
    } else {
        begin(app, id, "goal_analysis", repo, None, Some(&key))?
    };
    let prompt=format!("Sos el Supervisor de cumplimiento. Compará el OBJETIVO INICIAL completo con el RESULTADO FINAL real. Enumerá cada requisito del usuario, incluidos autonomía, paralelismo, integración y pruebas si fueron pedidos. No confundas tareas marcadas completas con cumplimiento: mirá archivos, contratos y comandos observados. Detectá omisiones y huecos entre agentes. No apruebes una afirmación sin evidencia. No reduzcas ni reformules el alcance para aprobarlo. Respondé SOLO JSON {{\"summary\":\"qué se cumplió y qué falta\",\"criteriaSatisfied\":true,\"criteria\":[{{\"requirement\":\"requisito original\",\"status\":\"met|missing|unverified\",\"evidence\":\"archivo u observación/comando concreto; explicar ausencia\"}}]}}. criteriaSatisfied solo true si TODOS los requisitos se verificaron. Reportá los faltantes al Lead para corregirlos antes de pedir QA al usuario.\nOBJETIVO INICIAL: {}\nRESULTADO FINAL Y EVIDENCIA: {}\nSUPERVISIONES PREVIAS: {}",r.goal,serde_json::to_string(&r.tasks).unwrap_or_default(),serde_json::to_string(&r.support_reports).unwrap_or_default());
    let (typed, mut value) = response::<Assessment>(app, id, &a, &session, &report, repo, &prompt)?;
    value["criteriaSatisfied"] = json!(approved(&typed));
    finish(app, id, &report, value.clone())?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completion_requires_every_original_requirement_and_real_evidence() {
        let mut a = Assessment {
            summary: "API lista".into(),
            criteria_satisfied: true,
            criteria: vec![],
        };
        assert!(!approved(&a));
        a.criteria.push(GoalCriterion {
            requirement: "API y frontend".into(),
            status: "unverified".into(),
            evidence: "Sin prueba de integración".into(),
        });
        assert!(!approved(&a));
        a.criteria[0].status = "met".into();
        a.criteria[0].evidence.clear();
        assert!(!approved(&a));
        a.criteria[0].evidence = "node --test: HTTP y UI observados".into();
        assert!(approved(&a));
    }
}
