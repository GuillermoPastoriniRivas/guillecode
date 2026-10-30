//! Authenticated Hub adapter. Never accepts an executor status from a client.
use super::{domain::*, plan_v2, read, run};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

fn owned_run<'a>(store: &'a Store, chat_id: &str, run_id: &str) -> Result<&'a Run, String> {
    store
        .chats
        .iter()
        .find(|c| c.id == chat_id)
        .and_then(|c| c.runs.iter().find(|r| r.id == run_id))
        .ok_or("La ejecución no pertenece a este chat".into())
}

pub(super) fn snapshot(run: &Run) -> Value {
    let mut value = serde_json::to_value(run).expect("serializable run");
    let object = value.as_object_mut().unwrap();
    // The mobile board needs contracts and receipts, not model prompts,
    // repository baselines, skill instructions or private evidence locations.
    for key in [
        "baseline",
        "guidance",
        "images",
        "recoveredPlan",
        "configurationChanges",
        "supportReports",
        "observations",
    ] {
        object.remove(key);
    }
    object.insert("skills".into(), json!([]));
    object.insert("evidenceDir".into(), json!(""));
    if let Some(state) = object.get_mut("planV2").and_then(Value::as_object_mut) {
        state.remove("rejectedProposals");
        state.insert("discovery".into(), json!([]));
        if let Some(revisions) = state.get_mut("revisions").and_then(Value::as_array_mut) {
            for revision in revisions {
                if let Some(operations) =
                    revision.get_mut("operations").and_then(Value::as_array_mut)
                {
                    for operation in operations {
                        *operation = json!({"type":operation["type"],"taskId":operation.get("taskId").or_else(|| operation["task"].get("id"))});
                    }
                }
            }
        }
    }
    fn trim_agent(agent: &mut Value) {
        if let Some(object) = agent.as_object_mut() {
            object.insert("instructions".into(), json!(""));
            object.insert("skillRefs".into(), json!([]));
            object.insert("tools".into(), json!([]));
        }
    }
    for agent in value["team"]["members"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        trim_agent(agent);
    }
    for task in value["tasks"].as_array_mut().into_iter().flatten() {
        for attempt in task["attempts"].as_array_mut().into_iter().flatten() {
            trim_agent(&mut attempt["agent"]);
            for command in attempt["commands"].as_array_mut().into_iter().flatten() {
                if let Some(output) = command["output"].as_str() {
                    command["output"] = json!(output.chars().take(8000).collect::<String>());
                }
            }
            for observation in attempt["observations"].as_array_mut().into_iter().flatten() {
                if let Some(output) = observation["output"].as_str() {
                    observation["output"] = json!(output.chars().take(4000).collect::<String>());
                }
            }
        }
    }
    value
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchRequest {
    chat_id: String,
    patch: plan_v2::PlanPatch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlRequest {
    chat_id: String,
    run_id: String,
    action: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageRequest {
    chat_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceRequest {
    chat_id: String,
    run_id: String,
    path: String,
}

pub fn request(
    app: &AppHandle,
    method: &str,
    path: &str,
    chat_id: &str,
    run_id: &str,
    body: Value,
) -> Result<Value, String> {
    match (method, path) {
        ("GET", "/hub/teams") => {
            let store = read(app)?;
            Ok(
                json!({"chats":store.chats.iter().map(|c| json!({"id":c.id,"title":c.title,"archived":c.archived,"projectRoot":c.team.project_root,
                "runs":c.runs.iter().map(|r| json!({"id":r.id,"goal":r.goal.chars().take(160).collect::<String>(),"status":r.status,"startedAt":r.started_at,
                    "sequence":r.plan_v2.sequence,"revision":r.plan_v2.revision_number})).collect::<Vec<_>>()})).collect::<Vec<_>>()}),
            )
        }
        ("GET", "/hub/teams/run") => {
            let store = read(app)?;
            let run = owned_run(&store, chat_id, run_id)?;
            Ok(json!({"run":snapshot(run),"sequence":run.plan_v2.sequence}))
        }
        ("POST", "/hub/teams/patch") => {
            let request: PatchRequest =
                serde_json::from_value(body).map_err(|e| format!("Solicitud inválida: {e}"))?;
            let store = read(app)?;
            owned_run(&store, &request.chat_id, &request.patch.run_id)?;
            if store
                .chats
                .iter()
                .any(|c| c.id == request.chat_id && c.archived)
            {
                return Err("El chat está archivado".into());
            }
            super::apply_plan_patch(app.clone(), request.patch)
                .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
        }
        ("POST", "/hub/teams/control") => {
            let request: ControlRequest =
                serde_json::from_value(body).map_err(|e| format!("Solicitud inválida: {e}"))?;
            let store = read(app)?;
            owned_run(&store, &request.chat_id, &request.run_id)?;
            if ![
                "pause",
                "resume",
                "cancel",
                "retry",
                "start_plan",
                "approve",
            ]
            .contains(&request.action.as_str())
            {
                return Err("Acción de ejecución inválida".into());
            }
            if request.action != "cancel"
                && store
                    .chats
                    .iter()
                    .any(|c| c.id == request.chat_id && c.archived)
            {
                return Err("El chat está archivado".into());
            }
            super::control(app, &request.run_id, &request.action)?;
            Ok(json!({"ok":true,"sequence":run(app,&request.run_id)?.plan_v2.sequence}))
        }
        ("POST", "/hub/teams/message") => {
            let request: MessageRequest =
                serde_json::from_value(body).map_err(|e| format!("Solicitud inválida: {e}"))?;
            let reply = super::team_chat_send(app.clone(), request.chat_id, request.text, None)?;
            Ok(json!({"replyId":reply}))
        }
        ("POST", "/hub/teams/evidence") => {
            let request: EvidenceRequest =
                serde_json::from_value(body).map_err(|e| format!("Solicitud inválida: {e}"))?;
            let store = read(app)?;
            let run = owned_run(&store, &request.chat_id, &request.run_id)?;
            if run.observations.iter().any(|o| {
                o.artifact_path.as_deref() == Some(&request.path) && o.status == "captured"
            }) {
                super::team_evidence_image(app.clone(), request.run_id, request.path)
            } else {
                super::team_evidence_read(app.clone(), request.run_id, request.path)
                    .map(|text| json!({"text":text}))
            }
        }
        _ => Err("Ruta de equipos no admitida".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_omits_prompts_and_evidence_roots_without_changing_receipt_identity() {
        let run:Run = serde_json::from_value(json!({"id":"run","goal":"goal","team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":1,
            "tasks":[],"summary":"","evidenceDir":"PRIVATE_ROOT","artifacts":[],"baseline":[{"private":"BASELINE"}],"notified":false,"guidance":["PRIVATE_PROMPT"],
            "planV2":{"digest":"original-digest","sequence":17,"rejectedProposals":["REJECTED_PROMPT"],"discovery":[]}})).unwrap();
        let snapshot = snapshot(&run);
        let text = snapshot.to_string();
        for secret in [
            "PRIVATE_ROOT",
            "PRIVATE_PROMPT",
            "BASELINE",
            "REJECTED_PROMPT",
        ] {
            assert!(!text.contains(secret));
        }
        assert_eq!(snapshot["planV2"]["digest"], "original-digest");
        assert_eq!(snapshot["planV2"]["sequence"], 17);
    }
    #[test]
    fn clients_cannot_supply_status_or_actor_to_remote_mutations() {
        assert!(serde_json::from_value::<ControlRequest>(
            json!({"chatId":"c","runId":"r","action":"approve","status":"completed"})
        )
        .is_err());
        assert!(serde_json::from_value::<MessageRequest>(
            json!({"chatId":"c","text":"hello","actor":"scheduler"})
        )
        .is_err());
    }
}
