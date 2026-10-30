use super::{domain::*, plan_v2::*};
use serde_json::json;

fn task(id: &str, deps: &[&str]) -> Task {
    serde_json::from_value(json!({"id":id,"title":format!("Implementar {id}"),"objective":"Entregar un comportamiento y comprobarlo",
        "assignedAgentId":"lead","repository":"D:/repo","dependencies":deps,"expectedFiles":[format!("{id}/main.ts")],
        "writePaths":[format!("{id}/")],"acceptanceCriteria":["El resultado rechaza entradas inválidas"],"requirementIds":["R1"],
        "verificationPlan":[{"kind":"command","command":"node --test","expected":"exitCode=0 y casos negativos aprobados"}],"risk":"medium"})).unwrap()
}

fn run() -> Run {
    let mut run: Run = serde_json::from_value(json!({"id":"run","goal":"Implementar y verificar un resultado con casos negativos","team":super::domain::tests::team(),
        "skills":[],"status":"running","startedAt":now(),"tasks":[task("a",&[]),task("b",&[])],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
    run.plan_v2.enabled = true;
    run.team.members[0].tools = vec!["read".into(), "write".into(), "bash".into()];
    run.plan_v2.contract.requirements = vec![Requirement {
        id: "R1".into(),
        description: run.goal.clone(),
        limitation: None,
    }];
    let receipt = validate(&plan(&run), &run.team, true);
    assert!(receipt.valid, "{}", receipt.message());
    freeze(
        &mut run,
        "initial",
        "lead",
        "Plan inicial validado",
        vec![],
        receipt,
    );
    run
}

fn plan(run: &Run) -> Plan {
    Plan {
        contract: run.plan_v2.contract.clone(),
        agents: vec![],
        tasks: run.tasks.clone(),
        evidence_targets: vec![],
    }
}

fn patch(run: &Run, operation: PlanOperation) -> PlanPatch {
    PlanPatch {
        operation_id: id(),
        run_id: run.id.clone(),
        expected_revision: run.plan_v2.revision_number,
        expected_digest: run.plan_v2.digest.clone(),
        reason: "Nueva evidencia requiere un ajuste concreto".into(),
        operations: vec![operation],
    }
}

fn draft(id: &str, dependencies: &[&str]) -> TaskDraft {
    serde_json::from_value(
        serde_json::to_value(task(id, dependencies))
            .map(|mut v| {
                let o = v.as_object_mut().unwrap();
                for key in [
                    "status",
                    "attempts",
                    "error",
                    "parentTaskId",
                    "taskKind",
                    "correctionForTaskId",
                ] {
                    o.remove(key);
                }
                v
            })
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn twenty_malformed_or_invalid_proposals_never_create_workers_or_replace_valid_state() {
    let run = run();
    let before = serde_json::to_value(&run).unwrap();
    let good = serde_json::to_value(plan(&run)).unwrap();
    let mut fixtures = vec![
        "".into(),
        "prosa".into(),
        "[]".into(),
        "null".into(),
        "{}".into(),
        "{\"tasks\":[]}".into(),
        "{\"tasks\":null}".into(),
        "{\"tasks\":[{}]}".into(),
        "{\"tasks\":\"a\"}".into(),
        "{\"tasks\":[".into(),
    ];
    for (path, value) in [
        ("id", json!("")),
        ("title", json!("")),
        ("objective", json!("")),
        ("assignedAgentId", json!("missing")),
        ("repository", json!("D:/other")),
        ("dependencies", json!(["missing"])),
        ("writePaths", json!(["../escape"])),
        ("acceptanceCriteria", json!([])),
        ("verificationPlan", json!([])),
        ("requirementIds", json!([])),
    ] {
        let mut invalid = good.clone();
        invalid["tasks"][0][path] = value;
        fixtures.push(invalid.to_string());
    }
    assert_eq!(fixtures.len(), 20);
    for fixture in fixtures {
        assert!(parse_proposal(&fixture, &run).is_err(), "{fixture}");
        assert_eq!(serde_json::to_value(&run).unwrap(), before);
        assert!(run.tasks.iter().all(|t| t.attempts.is_empty()));
    }
    assert!(parse_proposal(&good.to_string(), &run).is_ok());
}

#[test]
fn scopes_require_ordering_and_detect_nested_repositories() {
    let mut run = run();
    run.tasks[1].write_paths = vec!["a/child/".into()];
    run.tasks[1].expected_files.clear();
    assert!(validate(&plan(&run), &run.team, true)
        .issues
        .iter()
        .any(|i| i.code == PlanErrorCode::OverlappingWriteScope));
    run.tasks[1].dependencies = vec!["a".into()];
    assert!(validate(&plan(&run), &run.team, true).valid);
    run.tasks[1].dependencies.clear();
    run.tasks[1].repository = "D:/repo/a".into();
    run.team.allowed_repositories.push("D:/repo/a".into());
    run.tasks[1].write_paths = vec!["child/".into()];
    assert!(validate(&plan(&run), &run.team, true)
        .issues
        .iter()
        .any(|i| i.code == PlanErrorCode::OverlappingWriteScope));
}

#[test]
fn fanout_measures_simultaneous_readiness_instead_of_total_task_count() {
    let mut run = run();
    run.tasks = (0..8).map(|i| task(&format!("t{i}"), &[])).collect();
    assert!(validate(&plan(&run), &run.team, true)
        .issues
        .iter()
        .any(|i| i.code == PlanErrorCode::UnjustifiedFanout));
    for i in 1..run.tasks.len() {
        run.tasks[i].dependencies = vec![format!("t{}", i - 1)];
    }
    assert!(validate(&plan(&run), &run.team, true).valid);
}

#[test]
fn patch_preserves_live_attempts_and_evidence_and_rejects_one_hundred_stale_writes() {
    let mut run = run();
    run.tasks[0].status = "running".into();
    let attempt = json!({"id":"attempt","agent":run.team.members[0],"sessionId":"session","startedAt":1,"status":"running","summary":"","commands":[{"command":"already ran","exitCode":0}],"recovered":false});
    run.tasks[0]
        .attempts
        .push(serde_json::from_value(attempt).unwrap());
    let original_task = serde_json::to_value(&run.tasks[0]).unwrap();
    let request = patch(
        &run,
        PlanOperation::ReprioritizePending {
            task_id: "b".into(),
            priority: 10,
        },
    );
    let (changed, receipt) = simulate_patch(&run, &request, "user").unwrap();
    assert_eq!(
        serde_json::to_value(&changed.tasks[0]).unwrap(),
        original_task
    );
    assert_eq!(changed.plan_v2.revision_number, 2);
    assert_ne!(changed.plan_v2.digest, run.plan_v2.digest);
    let (_, same) = simulate_patch(&changed, &request, "user").unwrap();
    assert_eq!(same.id, receipt.id);
    for _ in 0..100 {
        let mut stale = request.clone();
        stale.operation_id = id();
        assert!(simulate_patch(&changed, &stale, "user")
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
    }
    let active = patch(
        &changed,
        PlanOperation::CancelPending {
            task_id: "a".into(),
            reason: "No debe cancelar una sesión activa".into(),
        },
    );
    assert!(simulate_patch(&changed, &active, "user")
        .unwrap_err()
        .contains("ACTIVE_TASK"));
    assert_eq!(
        serde_json::to_value(&changed.tasks[0]).unwrap(),
        original_task
    );
    assert_eq!(changed.plan_v2.revisions[0].id, run.plan_v2.revisions[0].id);
}

#[test]
fn split_creates_a_non_executable_group_without_widening_scope() {
    let mut run = run();
    let mut one = draft("child-1", &[]);
    one.write_paths = vec!["a/one/".into()];
    one.expected_files = vec!["a/one/main.ts".into()];
    let mut two = draft("child-2", &[]);
    two.write_paths = vec!["a/two/".into()];
    two.expected_files = vec!["a/two/main.ts".into()];
    let request = patch(
        &run,
        PlanOperation::SplitPendingTask {
            task_id: "a".into(),
            children: vec![one.clone(), two.clone()],
        },
    );
    let (changed, _) = simulate_patch(&run, &request, "user").unwrap();
    assert_eq!(
        changed.tasks[0].contract.task_kind.as_deref(),
        Some("group")
    );
    assert_eq!(changed.tasks[0].dependencies, vec!["child-1", "child-2"]);
    assert_eq!(
        changed.tasks[2].contract.parent_task_id.as_deref(),
        Some("a")
    );
    assert!(changed.tasks[0].attempts.is_empty());
    one.write_paths = vec!["outside/".into()];
    let bad = patch(
        &run,
        PlanOperation::SplitPendingTask {
            task_id: "a".into(),
            children: vec![one, two],
        },
    );
    assert!(simulate_patch(&run, &bad, "user")
        .unwrap_err()
        .contains("PERMISSION_ESCALATION"));
    run.tasks[1].dependencies = vec!["a".into()];
    run.plan_v2.digest = plan_digest(&run);
    let cancel = patch(
        &run,
        PlanOperation::CancelPending {
            task_id: "a".into(),
            reason: "Cancelar el entregable pendiente".into(),
        },
    );
    assert!(simulate_patch(&run, &cancel, "user").is_err());
}

#[test]
fn patches_are_atomic_and_cannot_recycle_ids_or_supply_runtime_status() {
    let run = run();
    let mut request = patch(
        &run,
        PlanOperation::ReprioritizePending {
            task_id: "b".into(),
            priority: 10,
        },
    );
    request
        .operations
        .push(PlanOperation::UpdatePendingDependencies {
            task_id: "a".into(),
            dependencies: vec!["a".into()],
        });
    assert!(simulate_patch(&run, &request, "user").is_err());
    assert_eq!(run.tasks[1].contract.priority, 0);
    let duplicate = patch(
        &run,
        PlanOperation::AddTask {
            task: draft("a", &[]),
        },
    );
    assert!(simulate_patch(&run, &duplicate, "user").is_err());
    let mut invalid = serde_json::to_value(draft("new", &[])).unwrap();
    invalid["status"] = json!("completed");
    assert!(serde_json::from_value::<TaskDraft>(invalid).is_err());
    let mut invalid = serde_json::to_value(request).unwrap();
    invalid["actor"] = json!("scheduler");
    assert!(serde_json::from_value::<PlanPatch>(invalid).is_err());
}

#[test]
fn precommitted_tests_cannot_be_replaced_by_a_workers_success_claim() {
    let task = task("a", &[]);
    assert!(!verification_passed(&task, &[], &[]));
    assert!(!verification_passed(
        &task,
        &[json!({"command":"echo success","exitCode":0})],
        &[]
    ));
    assert!(!verification_passed(
        &task,
        &[json!({"command":"node --test","exitCode":1})],
        &[]
    ));
    assert!(verification_passed(
        &task,
        &[json!({"command":"node --test","exitCode":0})],
        &[]
    ));
}

#[test]
fn native_discovery_observes_files_and_scripts_without_reading_secrets_or_creating_git() {
    let root = std::env::temp_dir().join(format!("flufy-plan-v2-{}", id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("package.json"),
        r#"{"scripts":{"test":"node --test"}}"#,
    )
    .unwrap();
    std::fs::write(root.join(".env"), "PRIVATE=never-read").unwrap();
    let mut run = run();
    run.team.allowed_repositories = vec![root.to_string_lossy().into()];
    let report = discover(&run).unwrap();
    assert!(!root.join(".git").exists());
    assert_eq!(report[0].observed_files.len(), 1);
    assert_eq!(report[0].observed_scripts[0].name, "test");
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("never-read"));
    std::fs::write(root.join("package.json"), "{}").unwrap();
    assert_ne!(report[0].digest, discover(&run).unwrap()[0].digest);
    std::fs::remove_file(root.join(".env")).unwrap();
    std::fs::remove_file(root.join("package.json")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn sqlite_keeps_complete_revisions_and_rolls_back_a_failed_commit() {
    let original = run();
    let request = patch(
        &original,
        PlanOperation::ReprioritizePending {
            task_id: "b".into(),
            priority: 7,
        },
    );
    let (changed, receipt) = simulate_patch(&original, &request, "user").unwrap();
    let mut store = super::empty();
    store.chats.push(Chat {
        messages: vec![],
        id: "chat".into(),
        title: "History".into(),
        archived: false,
        team: original.team.clone(),
        skills: vec![],
        created_at: 1,
        runs: vec![original.clone()],
    });
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE team_store(id INTEGER PRIMARY KEY,document TEXT NOT NULL)").unwrap();
    super::write_db(&mut db, &store).unwrap();
    store.chats[0].runs[0] = changed.clone();
    db.execute_batch("CREATE TRIGGER reject_commit BEFORE UPDATE ON team_store BEGIN SELECT RAISE(ABORT,'injected failure'); END").unwrap();
    assert!(super::write_db(&mut db, &store).is_err());
    let recovered = super::read_db(&db).unwrap();
    assert_eq!(recovered.chats[0].runs[0].plan_v2.revision_number, 1);
    assert_eq!(recovered.chats[0].runs[0].tasks[1].contract.priority, 0);
    db.execute_batch("DROP TRIGGER reject_commit").unwrap();
    super::write_db(&mut db, &store).unwrap();
    let recovered = super::read_db(&db).unwrap();
    let saved = &recovered.chats[0].runs[0];
    assert_eq!(saved.plan_v2.revisions.len(), 2);
    assert_eq!(saved.plan_v2.revisions[1].id, receipt.id);
    assert_eq!(saved.plan_v2.digest, plan_digest(saved));
    assert_eq!(
        simulate_patch(saved, &request, "user").unwrap().1.id,
        receipt.id
    );
}

#[test]
fn new_user_requirements_need_real_provenance_and_coverage_in_the_same_patch() {
    let mut run = run();
    run.guidance
        .push("Agregar una comprobación de sesión vencida".into());
    let requirement = Requirement {
        id: "R2".into(),
        description: run.guidance[0].clone(),
        limitation: None,
    };
    let mut request = patch(
        &run,
        PlanOperation::AddRequirement {
            requirement: requirement.clone(),
            guidance_index: 0,
        },
    );
    assert!(
        simulate_patch(&run, &request, "user").is_err(),
        "Un requisito sin entregable no se admite"
    );
    let mut extra = draft("expired-session", &[]);
    extra.requirement_ids = vec!["R2".into()];
    request
        .operations
        .push(PlanOperation::AddTask { task: extra });
    let (changed, _) = simulate_patch(&run, &request, "user").unwrap();
    assert_eq!(changed.plan_v2.contract.requirements.len(), 2);
    assert_eq!(changed.tasks.len(), 3);
    assert_eq!(
        serde_json::to_value(&changed.tasks[0]).unwrap(),
        serde_json::to_value(&run.tasks[0]).unwrap()
    );
    request.operations[0] = PlanOperation::AddRequirement {
        requirement,
        guidance_index: 20,
    };
    assert!(simulate_patch(&run, &request, "user").is_err());
}
