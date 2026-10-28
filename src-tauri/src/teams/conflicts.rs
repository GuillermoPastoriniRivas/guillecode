use super::{domain::*, read, runner, control};
use serde::Serialize;
use std::collections::HashSet;
use tauri::AppHandle;

pub(super) fn occupies(run: &Run) -> bool { active(&run.status) || runner::unsettled(run) }

pub(super) fn in_scope(chat: &Chat, run: &Run) -> bool {
    chat.team.allowed_repositories.iter().any(|a| run.team.allowed_repositories.iter().any(|b| overlaps(a,b)))
}

pub(super) fn first<'a>(store: &'a Store, chat: &Chat) -> Option<(&'a Chat, &'a Run)> {
    store.chats.iter().flat_map(|owner| owner.runs.iter().map(move |run| (owner,run)))
        .find(|(_,run)| occupies(run) && in_scope(chat,run))
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct StopResult { run_id: String, title: String, stopped: bool, message: String }

fn validate_targets(store: &Store, chat_id: &str, run_ids: &[String]) -> Result<(), String> {
    let chat = store.chats.iter().find(|chat| chat.id == chat_id).ok_or("Chat inexistente")?;
    let mut seen = HashSet::new();
    if run_ids.is_empty() || run_ids.len() > 500 { return Err("Seleccioná las ejecuciones que querés detener".into()); }
    for id in run_ids {
        if !seen.insert(id) { return Err("La selección contiene una ejecución repetida".into()); }
        let run = store.chats.iter().flat_map(|chat| &chat.runs).find(|run| &run.id == id).ok_or("La ejecución seleccionada ya no existe")?;
        if !in_scope(chat,run) { return Err("La ejecución seleccionada pertenece a otra carpeta; no se detuvo ningún equipo".into()); }
    }
    Ok(())
}

pub(super) fn stop(app: &AppHandle, chat_id: &str, run_ids: Vec<String>) -> Result<Vec<StopResult>, String> {
    let store = read(app)?;
    // Validate the whole displayed selection before stopping anything. New
    // executions that appeared after the click are never silently included.
    validate_targets(&store,chat_id,&run_ids)?;
    let mut results = Vec::new();
    for id in run_ids {
        let snapshot = read(app)?;
        let (owner,run) = snapshot.chats.iter().find_map(|owner| owner.runs.iter().find(|run| run.id == id).map(|run| (owner,run))).ok_or("Ejecución inexistente")?;
        let title = owner.title.clone();
        if !occupies(run) {
            results.push(StopResult {run_id:id,title,stopped:true,message:"Ya no ocupa la carpeta.".into()});
            continue;
        }
        let outcome = control(app,&id,"cancel");
        let stopped = super::run(app,&id).map(|run| !occupies(&run)).unwrap_or(false);
        let message = match outcome {
            Ok(()) if stopped => "Detenido. Sus cambios y su historial se conservan.".into(),
            Ok(()) => "Detención solicitada; estamos cerrando sus sesiones.".into(),
            Err(error) => format!("No se pudo confirmar la detención: {}", super::errors::message(&serde_json::json!(error))),
        };
        results.push(StopResult {run_id:id,title,stopped,message});
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> Store {
        let team=super::super::domain::tests::team();
        serde_json::from_value(json!({"schemaVersion":2,"teams":[],"skills":[],"chats":[{"id":"request","title":"Nuevo","archived":false,"team":team,"skills":[],"createdAt":0,"runs":[]},{"id":"owner","title":"Frontend y Backend","archived":true,"team":team,"skills":[],"createdAt":0,"runs":[{"id":"held","goal":"Integrar API","team":team,"skills":[],"status":"running","startedAt":0,"tasks":[],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false}]}]})).unwrap()
    }
    #[test]
    fn archived_runs_have_a_human_reference_and_finished_runs_release_the_folder() {
        let mut s=fixture();
        assert_eq!(first(&s,&s.chats[0]).unwrap().0.title,"Frontend y Backend");
        s.chats[1].runs[0].status="completed".into();
        assert!(first(&s,&s.chats[0]).is_none());
        s.chats[1].runs[0].coordination.push(serde_json::from_value(json!({"id":"c","fromTaskId":"t","message":"","taskIds":[],"status":"checking","summary":"","createdAt":0,"sessions":[]})).unwrap());
        assert!(first(&s,&s.chats[0]).is_some());
    }
    #[test]
    fn cancelling_selection_never_reaches_other_folders_and_is_validated_upfront() {
        let mut s=fixture();
        let mut other=s.chats[1].runs[0].clone();other.id="elsewhere".into();other.team.allowed_repositories=vec!["Z:/unrelated".into()];s.chats[1].runs.push(other);
        let before=serde_json::to_value(&s).unwrap();
        assert!(validate_targets(&s,"request",&["held".into()]).is_ok());
        assert!(validate_targets(&s,"request",&["held".into(),"elsewhere".into()]).is_err());
        assert!(validate_targets(&s,"request",&["held".into(),"held".into()]).is_err());
        assert_eq!(serde_json::to_value(&s).unwrap(),before);
    }
}
