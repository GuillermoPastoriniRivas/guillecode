// Opt-in Windows test. tests/teams-engine.mjs supplies an isolated real OpenCode
// instance backed by loopback deterministic inference. No real account is used.
use super::*;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

#[test]
#[ignore = "Run via node tests/teams-engine.mjs (isolated OpenCode + Tauri + Git)"]
fn native_team_end_to_end() {
    let url = std::env::var("GUILLE_TEAM_TEST_ENGINE").expect("use tests/teams-engine.mjs");
    assert!(url.starts_with("http://127.0.0.1:"));
    let repo = std::env::var("GUILLE_TEAM_TEST_REPO").expect("isolated repository");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.guillecode.teams-test-{}", id());
    context.config_mut().app.windows.clear();
    let mut app = tauri::Builder::default()
        .any_thread()
        .manage(crate::ServerState {
            child: Mutex::new(None),
            config: Mutex::new(Some(crate::ServerConfig {
                url,
                username: "opencode".into(),
                password: "qa-password".into(),
                worktree: repo.clone(),
            })),
            project: Mutex::new(Some(repo.clone())),
            stopping: AtomicBool::new(false),
        })
        .manage(crate::updates::UpdatesState::default())
        .build(context)
        .expect("isolated Tauri runtime");
    start(app.handle());
    crate::approvals::start(app.handle());
    crate::approvals::approvals_set(app.handle().clone(), true);
    let data_dir = app.path().app_data_dir().unwrap();
    let handle = app.handle().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if std::env::var("GUILLE_TEAM_TEST_CYCLE").as_deref() == Ok("1") || std::env::var("GUILLE_TEAM_TEST_HELP").as_deref() == Ok("1") {
                circular_team_scenario(&handle, &repo);
                return;
            }
            if std::env::var("GUILLE_TEAM_TEST_AUTO").as_deref() == Ok("1") {
                automatic_team_scenario(&handle, &repo);
                return;
            }
            let bundled = catalog();
            let version = |id: &str| bundled.iter().filter(|s| s.id == id).map(|s| s.version).max().unwrap();
            let mut team = super::domain::tests::team();
            team.project_root = repo.clone();
            team.allowed_repositories = vec![repo.clone()];
            team.members[0].model.model_id = "qa-lead".into();
            team.members[0].skill_refs = vec![
                SkillRef {
                    id: "team-lead".into(),
                    version: version("team-lead"),
                },
                SkillRef {
                    id: "comportamientos".into(),
                    version: version("comportamientos"),
                },
            ];
            if let Ok(url) = std::env::var("GUILLE_TEAM_TEST_CAPTURE_URL") {
                team.evidence_targets=vec![serde_json::from_value(serde_json::json!({"id":"project","name":"Módulos del proyecto","url":url,"required":true})).unwrap()];
            }
            for (id, model) in [("backend", "qa-backend"), ("frontend", "qa-frontend")] {
                let mut employee = team.members[0].clone();
                employee.id = id.into();
                employee.role = id.into();
                employee.name = id.into();
                employee.model.model_id = model.into();
                employee.skill_refs = vec![
                    SkillRef {
                        id: if id == "backend" {
                            "backend"
                        } else {
                            "frontend"
                        }
                        .into(),
                        version: version(if id == "backend" { "backend" } else { "frontend" }),
                    },
                    SkillRef {
                        id: "security".into(),
                        version: version("security"),
                    },
                ];
                employee.tools = ["read", "glob", "grep", "write", "edit", "bash"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                team.members.push(employee);
            }
            let team = teams_save(handle.clone(), team).unwrap();
            let chat = team_chats_create(handle.clone(), team.id.clone()).unwrap();
            let run_id = team_runs_start(
                handle.clone(),
                chat.id.clone(),
                "Crear backend y frontend comprobables".into(),
            )
            .unwrap();
            let c = runner::test_client(&handle, &repo).unwrap();
            let deadline = Instant::now() + Duration::from_secs(180);
            let result = loop {
                let r = run(&handle, &run_id).unwrap();
                // Exercise the normal OpenCode approval API only inside this isolated test.
                for p in c
                    .get("/permission")
                    .unwrap()
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    c.post(
                        &format!("/permission/{}/reply", p["id"].as_str().unwrap()),
                        serde_json::json!({"reply":"once"}),
                    )
                    .unwrap();
                }
                if !active(&r.status) {
                    break r;
                }
                assert!(Instant::now() < deadline, "native team timed out: {:?}", r);
                std::thread::sleep(Duration::from_millis(200));
            };
            assert_eq!(result.status, "completed", "{:?}", result);
            assert!(result.finished_at.is_some());
            assert!(result.closing_reviews.last().is_some_and(|r| matches!(r.status, ReviewStatus::Approved) && r.criteria_satisfied));
            let report: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(&result.evidence_dir).join("resultado.json")).unwrap()).unwrap();
            assert_eq!(report["manualQaStatus"], "pending");
            let mut completed_store = read(&handle).unwrap();
            recover(&mut completed_store);
            assert_eq!(completed_store.chats[0].runs[0].status, "completed", "completed delivery must survive restart without manual approval");
            assert_eq!(
                result.tasks.len(),
                2,
                "unexpected deterministic plan: {:?}",
                result.configuration_changes
            );
            let mut attempt_counts = result
                .tasks
                .iter()
                .map(|task| task.attempts.len())
                .collect::<Vec<_>>();
            attempt_counts.sort_unstable();
            assert_eq!(attempt_counts, vec![1, 2], "Lead must request and verify one correction regardless of which parallel task finishes first");
            assert!(result.tasks.iter().all(|t| t.status == "completed"));
            let backend = result.tasks.iter().find(|t| t.id == "backend").unwrap();
            let frontend = result.tasks.iter().find(|t| t.id == "frontend").unwrap();
            assert!(backend.attempts[0].started_at < frontend.attempts[0].finished_at.unwrap());
            assert!(frontend.attempts[0].started_at < backend.attempts[0].finished_at.unwrap());
            assert_eq!(
                frontend.attempts.len(),
                1,
                "dependency coordination must resume the SAME attempt"
            );
            assert_eq!(result.coordination.len(), 1);
            assert_eq!(result.coordination[0].status, "resolved");
            assert!(
                result.coordination[0].sessions.len() >= 2,
                "Lead checks progress, waits, then checks the delivered contract"
            );
            if std::env::var("GUILLE_TEAM_TEST_NO_GIT").as_deref() == Ok("1") {
                assert_eq!(result.baseline[0]["mode"], "filesystem");
                assert!(!std::path::Path::new(&repo).join(".git").exists());
                let diff = std::fs::read_to_string(
                    std::path::Path::new(&result.evidence_dir).join("cambios/cambios.diff"),
                )
                .unwrap();
                assert!(diff.contains("backend.txt") && diff.contains("frontend.txt"));
            }
            for a in &result.artifacts {
                if a.status == "captured" {
                    assert!(std::path::Path::new(&result.evidence_dir)
                        .join(&a.relative_path)
                        .is_file());
                }
            }
            let before: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(
                    std::path::Path::new(&result.evidence_dir).join("manifest.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(before["artifacts"].as_array().unwrap().len() > 5);
            assert!(result.notified);
            if !team.evidence_targets.is_empty() {
                assert!(
                    result
                        .observations
                        .iter()
                        .any(|o| o.phase == "before" && o.status == "captured"),
                    "real before screenshot missing: {:?}",
                    result.observations
                );
                let before = result
                    .observations
                    .iter()
                    .find(|o| o.phase == "before" && o.status == "captured")
                    .expect("real before screenshot");
                let after = result
                    .observations
                    .iter()
                    .find(|o| o.phase == "after" && o.status == "captured")
                    .expect("real after screenshot");
                let image = team_evidence_image(
                    handle.clone(),
                    result.id.clone(),
                    after.artifact_path.clone().unwrap(),
                )
                .unwrap();
                assert_eq!(image["sha256"], after.sha256.clone().unwrap());
                let path = std::path::Path::new(&result.evidence_dir)
                    .join(after.artifact_path.as_ref().unwrap());
                let bytes = std::fs::read(&path).unwrap();
                let mut changed = bytes.clone();
                changed.push(0);
                std::fs::write(&path, &changed).unwrap();
                assert!(team_evidence_image(
                    handle.clone(),
                    result.id.clone(),
                    after.artifact_path.clone().unwrap()
                )
                .is_err());
                std::fs::write(&path, bytes).unwrap();
                assert_ne!(before.sha256, after.sha256);
                assert!(before.details["text"].as_str().unwrap().contains("ausente"));
                assert!(after.details["text"]
                    .as_str()
                    .unwrap()
                    .contains("version 2"));
                if let Ok(out) = std::env::var("GUILLE_TEAM_TEST_ARTIFACTS") {
                    let out = std::path::Path::new(&out);
                    std::fs::create_dir_all(out).unwrap();
                    for (name, o) in [("before", before), ("after", after)] {
                        std::fs::copy(
                            std::path::Path::new(&result.evidence_dir)
                                .join(o.artifact_path.as_ref().unwrap()),
                            out.join(format!("{}.png", name)),
                        )
                        .unwrap();
                    }
                    std::fs::write(
                        out.join("observations.json"),
                        evidence::sanitize(
                            &serde_json::to_string_pretty(&result.observations).unwrap(),
                        ),
                    )
                    .unwrap();
                }
            }
            assert!(!crate::approvals::auto_approve(
                &handle,
                result.tasks[0].attempts[0].session_id.as_ref().unwrap()
            ));
            assert!(crate::approvals::auto_approve(&handle, "normal-session"));
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&repo).join("user.txt")).unwrap(),
                "user work\n"
            );
            assert!(read_db(&db(&handle).unwrap()).unwrap().chats[0].runs[0].notified);
            update(&handle, |store| {
                let saved = store.chats.iter_mut().find(|c| c.id == chat.id).unwrap();
                saved.messages.push(ChatMessage { clarification_start: None, id: "pending-status-test".into(), role: "assistant".into(), text: String::new(), created_at: now(), status: "pending".into(), run_id: Some(run_id.clone()), session_id: Some("lead-status-observation".into()), images: vec![] });
                Ok(())
            }).unwrap();
            let query = conversation::send(handle.clone(), chat.id.clone(), "¿Quién está bloqueado y qué falló?".into(), vec![]).unwrap();
            let saved = read(&handle).unwrap();
            let saved_chat = saved.chats.iter().find(|c| c.id == chat.id).unwrap();
            let reply = saved_chat.messages.iter().find(|m| m.id == query).unwrap();
            assert_eq!(reply.status, "complete", "status must be answered even with a pending Lead message");
            assert!(reply.session_id.is_none(), "a saved-status query must never call inference");
            assert_eq!(saved_chat.messages.iter().find(|m| m.id == "pending-status-test").unwrap().status, "pending");
            assert_eq!(saved_chat.runs.len(), 1);
            update(&handle, |store| { store.chats.iter_mut().find(|c| c.id == chat.id).unwrap().messages.iter_mut().find(|m| m.id == "pending-status-test").unwrap().status = "cancelled".into(); Ok(()) }).unwrap();
            let acceptance = conversation::send(handle.clone(), chat.id.clone(), "trabajo completado".into(), vec![]).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let saved = read(&handle).unwrap();
                let saved_chat = saved.chats.iter().find(|c| c.id == chat.id).unwrap();
                let reply = saved_chat.messages.iter().find(|m| m.id == acceptance).unwrap();
                if reply.status != "pending" {
                    assert_eq!(reply.status, "complete");
                    assert!(reply.text.contains("Registré tu visto bueno"));
                    assert!(reply.session_id.is_none(), "acceptance must not call inference or launch an agent");
                    assert_eq!(saved_chat.runs.len(), 1, "acceptance must not create another run");
                    break;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(run(&handle, &run_id).unwrap().status, "qa_approved");
            // Recovery blocks active attempts without sending another prompt.
            let mut durable = read(&handle).unwrap();
            durable.chats[0].runs[0].status = "running".into();
            recover(&mut durable);
            assert_eq!(durable.chats[0].runs[0].status, "blocked");
            assert_eq!(
                durable.chats[0].runs[0].tasks[0].attempts.len(),
                result.tasks[0].attempts.len()
            );
            let wait_for_run = |id: &str| -> Run {
                let deadline = Instant::now() + Duration::from_secs(90);
                loop {
                    let r = run(&handle, id).unwrap();
                    for p in c
                        .get("/permission")
                        .unwrap()
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        c.post(
                            &format!("/permission/{}/reply", p["id"].as_str().unwrap()),
                            serde_json::json!({"reply":"once"}),
                        )
                        .unwrap();
                    }
                    if !active(&r.status) {
                        return r;
                    }
                    assert!(Instant::now() < deadline, "run timed out: {:?}", r);
                    std::thread::sleep(Duration::from_millis(200));
                }
            };
            // Model removal blocks, explicit reassignment resumes the same task.
            let mut missing = team.clone();
            missing.id = String::new();
            missing.members[1].model.model_id = "qa-missing".into();
            let missing = teams_save(handle.clone(), missing).unwrap();
            let chat = team_chats_create(handle.clone(), missing.id).unwrap();
            let missing_run =
                team_runs_start(handle.clone(), chat.id, "Comprobar modelo ausente".into())
                    .unwrap();
            let blocked = wait_for_run(&missing_run);
            assert_eq!(blocked.status, "blocked");
            assert!(!blocked.notified);
            assert!(blocked.tasks[0].attempts[0].session_id.is_none());
            team_runs_model(
                handle.clone(),
                missing_run.clone(),
                "backend".into(),
                team.members[1].model.clone(),
                None,
            )
            .unwrap();
            control(&handle, &missing_run, "retry").unwrap();
            let recovered = wait_for_run(&missing_run);
            assert_eq!(recovered.status, "completed", "{:?}", recovered);
            assert_eq!(recovered.tasks[0].attempts.len(), 2);
            assert_eq!(recovered.configuration_changes.len(), 1);
            // A corrupt reviewer never yields a successful delivery.
            let mut invalid = team.clone();
            invalid.id = String::new();
            invalid.members[0].model.model_id = "qa-invalid-review".into();
            let invalid = teams_save(handle.clone(), invalid).unwrap();
            let chat = team_chats_create(handle.clone(), invalid.id).unwrap();
            let invalid_run =
                team_runs_start(handle.clone(), chat.id, "Revisión inválida".into()).unwrap();
            let blocked = wait_for_run(&invalid_run);
            assert_eq!(blocked.status, "blocked");
            assert!(!blocked.notified);
            assert!(matches!(
                blocked.tasks[0].attempts[0].review.as_ref().unwrap().status,
                ReviewStatus::ReviewError
            ));
            control(&handle, &invalid_run, "cancel").unwrap();
            assert_eq!(run(&handle, &invalid_run).unwrap().status, "cancelled");
            // A real usage budget blocks before any worker; adjusting it is audited.
            let mut limited = team.clone();
            limited.id = String::new();
            limited.limits.max_tokens = Some(1);
            if let Some(target) = limited.evidence_targets.first_mut() {
                target.url = target.url.replace("/app", "/capture-recovery");
                target.wait_for_selector = Some("main".into());
            }
            let limited = teams_save(handle.clone(), limited).unwrap();
            let chat = team_chats_create(handle.clone(), limited.id).unwrap();
            let limited_run = team_runs_start(
                handle.clone(),
                chat.id,
                "Presupuesto y recuperación de evidencia obligatoria".into(),
            )
            .unwrap();
            let blocked = wait_for_run(&limited_run);
            assert_eq!(blocked.status, "blocked");
            assert!(!blocked.notified);
            assert!(blocked.tasks.is_empty());
            assert!(blocked.error.as_deref().unwrap().contains("presupuesto"));
            assert!(blocked
                .session_usage
                .values()
                .any(|v| v["tokens"].as_u64().unwrap_or(0) > 0));
            team_runs_limits(handle.clone(), limited_run.clone(), Limits::default()).unwrap();
            control(&handle, &limited_run, "retry").unwrap();
            let blocked = wait_for_run(&limited_run);
            assert_eq!(blocked.status, "blocked");
            assert!(
                blocked.tasks.iter().all(|t| t.attempts.is_empty()),
                "required before capture must block every worker"
            );
            std::fs::write(
                std::path::Path::new(&repo).join("capture-before-ready.flag"),
                "ready",
            )
            .unwrap();
            control(&handle, &limited_run, "retry").unwrap();
            let blocked = wait_for_run(&limited_run);
            assert_eq!(blocked.status, "blocked");
            assert!(
                blocked.tasks.iter().all(|t| t.status == "completed"),
                "after capture failure must preserve completed workers"
            );
            assert!(!blocked.notified);
            assert!(blocked
                .error
                .as_deref()
                .unwrap()
                .contains("flujo obligatorio"));
            let attempts: Vec<_> = blocked.tasks.iter().map(|t| t.attempts.len()).collect();
            std::fs::write(
                std::path::Path::new(&repo).join("capture-ready.flag"),
                "ready",
            )
            .unwrap();
            control(&handle, &limited_run, "retry").unwrap();
            let recovered = wait_for_run(&limited_run);
            assert_eq!(recovered.status, "completed");
            assert_eq!(
                recovered
                    .tasks
                    .iter()
                    .map(|t| t.attempts.len())
                    .collect::<Vec<_>>(),
                attempts
            );
            assert_eq!(recovered.configuration_changes.len(), 1);
            assert!(recovered
                .observations
                .iter()
                .any(|o| o.phase == "before" && o.status == "unavailable"));
            assert!(
                recovered
                    .observations
                    .iter()
                    .rev()
                    .find(|o| o.phase == "after")
                    .unwrap()
                    .status
                    == "captured"
            );
        }));
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(210);
    let result = loop {
        app.run_iteration(|_, _| {});
        if let Ok(result) = rx.try_recv() {
            break result;
        }
        assert!(Instant::now() < deadline, "Tauri test timed out");
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(app);
    let _ = std::fs::remove_dir_all(data_dir);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

fn circular_team_scenario(handle: &tauri::AppHandle, repo: &str) {
    let lead_help = std::env::var("GUILLE_TEAM_TEST_HELP").as_deref() == Ok("1");
    let mut team = super::domain::tests::team();
    team.project_root = repo.into();
    team.allowed_repositories = vec![repo.into()];
    team.max_parallel_tasks = 2;
    if lead_help { team.max_retries_per_task = 0; }
    team.members[0].model.model_id = "qa-lead".into();
    for role in ["backend", "frontend"] {
        let mut worker = team.members[0].clone();
        worker.id = role.into(); worker.name = role.into(); worker.role = role.into();
        worker.model.model_id = format!("qa-{}", role);
        worker.tools = ["read", "write", "edit", "bash"].iter().map(|s| s.to_string()).collect();
        team.members.push(worker);
    }
    let team = teams_save(handle.clone(), team).unwrap();
    let chat = team_chats_create(handle.clone(), team.id).unwrap();
    let id = team_runs_start(handle.clone(), chat.id.clone(), "Separar dependencias circulares sin perder sesiones ni criterios".into()).unwrap();
    let client = runner::test_client(handle, repo).unwrap();
    let deadline = Instant::now() + Duration::from_secs(150);
    let result = loop {
        for permission in client.get("/permission").unwrap().as_array().into_iter().flatten() {
            client.post(&format!("/permission/{}/reply", permission["id"].as_str().unwrap()), serde_json::json!({"reply":"once"})).unwrap();
        }
        let r = run(handle, &id).unwrap();
        if !active(&r.status) { break r; }
        assert!(Instant::now() < deadline, "circular team timed out: {:?}", r);
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(result.status, "completed", "{:?}", result);
    assert!(result.tasks.iter().all(|t| t.status == "completed" && t.attempts.last().unwrap().commands.len() == 1));
    if lead_help {
        let backend = result.tasks.iter().find(|t| t.id == "backend").unwrap();
        let frontend = result.tasks.iter().find(|t| t.id == "frontend").unwrap();
        assert_eq!(backend.attempts.len(), 3);
        assert_eq!(frontend.attempts.len(), 1);
        let sessions: std::collections::HashSet<_> = backend.attempts.iter().map(|a| a.session_id.as_ref().unwrap()).collect();
        assert_eq!(sessions.len(), 1, "Lead assistance must continue the same worker session");
        assert!(matches!(backend.attempts[1].review.as_ref().unwrap().status, ReviewStatus::ChangesRequested));
        assert!(!backend.attempts[1].review.as_ref().unwrap().criteria_satisfied);
        assert!(frontend.attempts[0].finished_at.unwrap() <= backend.attempts[2].started_at, "Independent Frontend must finish while Backend is being repaired");
        assert!(result.coordination.iter().all(|c| c.kind == "technical_blocker"));
        assert!(result.configuration_changes.iter().any(|c| c["kind"] == "automaticCloseoutRepair"), "A technical closeout cannot be delegated to the user");
        assert!(result.configuration_changes.iter().any(|c| c["kind"] == "automaticCoordinatorRecovery"), "The Lead must recover its own exhausted corrections without blocking the team");
    } else { assert!(result.tasks.iter().all(|t| t.attempts.len() == 1)); }
    assert_eq!(result.coordination.len(), 2);
    assert!(result.coordination.iter().all(|c| c.status == "resolved"));
    assert!(result.coordination.iter().flat_map(|c| &c.replies).any(|reply| reply["status"] == "repair_requested"));
    if !lead_help { assert!(result.configuration_changes.iter().any(|c| c["resumedTaskIds"].as_array().is_some_and(|ids| !ids.is_empty()))); }
    assert!(super::coordination::circular_tasks(&result).is_empty());
    for role in ["backend", "frontend"] {
        assert_eq!(std::fs::read_to_string(std::path::Path::new(repo).join(format!("{}.txt", role))).unwrap(), "version 2\n");
    }
    assert_eq!(std::fs::read_to_string(std::path::Path::new(repo).join("user.txt")).unwrap(), "user work\n");
    if std::env::var("GUILLE_TEAM_TEST_NO_GIT").as_deref() == Ok("1") {
        assert!(!std::path::Path::new(repo).join(".git").exists());
    }
    for task in &result.tasks {
        let session = task.attempts[0].session_id.as_ref().unwrap();
        let history = client.get(&format!("/session/{}/message", session)).unwrap();
        let writes = history.as_array().unwrap().iter().flat_map(|m| m["parts"].as_array().into_iter().flatten()).filter(|p| p["tool"] == "write" && p["state"]["status"] == "completed").count();
        assert_eq!(writes, 1, "Continuing the same session must not repeat its file write");
        assert_eq!(history.as_array().unwrap().iter().flat_map(|m| m["parts"].as_array().into_iter().flatten()).filter(|p| p["tool"] == "bash" && p["state"]["status"] == "completed").count(), 1, "Lead guidance must not replay a completed command");
        assert_eq!(task.acceptance_criteria.len(), 2);
    }
    let persisted = read_db(&db(handle).unwrap()).unwrap();
    assert_eq!(persisted.chats[0].runs[0].coordination.len(), 2);
    assert!(persisted.chats[0].runs[0].coordination.iter().all(|c| c.status == "resolved"));
}

fn automatic_team_scenario(handle: &tauri::AppHandle, repo: &str) {
    let chat = team_chats_auto(handle.clone(), repo.into(), ModelRef { provider_id: "openai".into(), model_id: "qa-lead".into() }, None).unwrap();
    assert!(read(handle).unwrap().teams.is_empty());
    assert!(chat.team.autonomous);
    assert_eq!(chat.team.members.len(), 1);
    let wait_reply = |reply_id: &str| {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let store = read(handle).unwrap();
            let message = store.chats.iter().find(|c| c.id == chat.id).unwrap().messages.iter().find(|m| m.id == reply_id).unwrap().clone();
            if message.status != "pending" { assert_eq!(message.status, "complete", "{:?}", message); break message; }
            if Instant::now() >= deadline {
                let c = runner::test_client(handle, repo).unwrap();
                let history = message.session_id.as_ref().map(|session| c.get(&format!("/session/{}/message",session)));
                panic!("chat response timed out: {:?}; statuses: {:?}; permissions: {:?}; history: {:?}", message, c.get("/session/status"), c.get("/permission"), history);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    let question = team_chat_send(handle.clone(), chat.id.clone(), "Explicame cómo organizás el equipo".into(), Some(vec![ImageInput { filename: "referencia.png".into(), mime: "image/png".into(), url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==".into() }])).unwrap();
    let reply = wait_reply(&question);
    assert!(reply.text.contains("especialistas"));
    assert!(start_run(handle.clone(), chat.id.clone(), "Pedido ya finalizado".into(), vec![], Some(&question)).is_err(), "a completed/cancelled conversation turn cannot launch late work");
    assert!(read(handle).unwrap().chats[0].runs.is_empty(), "an explanation must not launch work");
    assert!(is_team_session(handle, reply.session_id.as_deref().unwrap()));
    let observation = team_chat_send(handle.clone(), chat.id.clone(), "Consultá las herramientas de la PC del equipo".into(), None).unwrap();
    let observed = wait_reply(&observation);
    assert!(observed.text.contains("observado"));
    assert!(read(handle).unwrap().chats[0].runs.is_empty(), "PC observation must not start file-editing work");
    let history = runner::test_client(handle, repo).unwrap().get(&format!("/session/{}/message", observed.session_id.unwrap())).unwrap();
    assert!(history.as_array().unwrap().iter().flat_map(|m| m["parts"].as_array().into_iter().flatten()).any(|p| p["tool"] == "desktop_status" && p["state"]["status"] == "completed"));
    let request = team_chat_send(handle.clone(), chat.id.clone(), "Crear dos servicios Backend y una pantalla Frontend, repartidos por el Lead".into(), None).unwrap();
    let clarification = wait_reply(&request);
    assert!(clarification.text.contains("Antes de empezar") && clarification.text.contains("saludo") && clarification.text.contains("dependencias"));
    assert!(clarification.clarification_start.is_some());
    assert!(read(handle).unwrap().chats[0].runs.is_empty(), "unanswered questions must not start workers, even with action=work");
    let saved = read_db(&db(handle).unwrap()).unwrap();
    assert_eq!(saved.chats[0].messages.last().unwrap().clarification_start, clarification.clarification_start);
    let answer = team_chat_send(handle.clone(), chat.id.clone(), "Usá hola mundo; sin dependencias externas".into(), None).unwrap();
    wait_reply(&answer);
    let id = read(handle).unwrap().chats[0].runs[0].id.clone();
    let status_reply = team_chat_send(handle.clone(), chat.id.clone(), "¿Cómo va el estado?".into(), None).unwrap();
    let message = wait_reply(&status_reply);
    assert!(message.session_id.is_none(), "saved status must not call inference");
    let client = runner::test_client(handle, repo).unwrap();
    let deadline = Instant::now() + Duration::from_secs(150);
    let result = loop {
        for permission in client.get("/permission").unwrap().as_array().into_iter().flatten() {
            client.post(&format!("/permission/{}/reply", permission["id"].as_str().unwrap()), serde_json::json!({"reply":"once"})).unwrap();
        }
        let r = run(handle, &id).unwrap();
        if !active(&r.status) { break r; }
        assert!(Instant::now() < deadline, "automatic team timed out: {:?}", r);
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(result.status, "completed", "{:?}", result);
    assert_eq!(result.team.members.len(), 4);
    assert_eq!(result.team.members.iter().filter(|m| m.role == "Backend").count(), 2);
    assert_eq!(result.tasks.len(), 3);
    assert!(result.tasks.iter().all(|t| t.status == "completed" && t.attempts.len() == 1));
    let attempts: Vec<_> = result.tasks.iter().map(|t| &t.attempts[0]).collect();
    assert!(attempts.iter().map(|a| a.started_at).max().unwrap() < attempts.iter().map(|a| a.finished_at.unwrap()).min().unwrap());
    assert!(attempts.iter().all(|a| !a.commands.is_empty()));
    assert_eq!(result.chat_summary.as_ref().unwrap().tested, "Las tres comprobaciones pasaron.");
    let persisted = read_db(&db(handle).unwrap()).unwrap();
    assert_eq!(persisted.chats[0].team.members.len(), 1, "chat seed stays automatic");
    assert_eq!(persisted.chats[0].runs[0].team.members.len(), 4);
    assert_eq!(persisted.chats[0].runs[0].chat_summary.as_ref().unwrap().done, "Creé dos servicios y la pantalla.");
    assert!(persisted.teams.is_empty());
    assert_eq!(persisted.chats[0].messages[0].images.len(), 1);
    assert_eq!(persisted.chats[0].runs[0].images.len(), 1);
    assert_eq!(persisted.chats[0].messages[0].images[0].id, persisted.chats[0].runs[0].images[0].id);
    assert!(team_image_read(handle.clone(), persisted.chats[0].runs[0].images[0].id.clone()).unwrap().starts_with("data:image/png;base64,"));
    assert!(team_image_read(handle.clone(), "../auth.json".into()).is_err());
    let image_path = crate::app_data_file(handle, "team-images").unwrap().join(&persisted.chats[0].runs[0].images[0].id);
    let original_image = std::fs::read(&image_path).unwrap();
    std::fs::write(&image_path, b"changed image").unwrap();
    assert!(team_image_read(handle.clone(), persisted.chats[0].runs[0].images[0].id.clone()).is_err());
    std::fs::write(&image_path, original_image).unwrap();
    assert_eq!(persisted.chats[0].runs.len(), 1, "conversation must not duplicate runs");
    assert_eq!(persisted.chats[0].messages.len(), 10);
    let mut interrupted = persisted.clone();
    interrupted.chats[0].messages[9].status = "pending".into();
    recover(&mut interrupted);
    assert_eq!(interrupted.chats[0].messages[9].status, "interrupted");
    assert!(interrupted.chats[0].messages[9].text.contains("no se repitió"));
    assert_eq!(interrupted.chats[0].runs.len(), 1);
    // A terminal run with an orphaned recorded session still owns the folder.
    // The bulk-stop action must settle it using the real engine, preserving
    // the completed delivery and its observed verification commands.
    update_run(handle,&result.id,|run| {
        run.tasks[0].attempts.last_mut().unwrap().finished_at=None;
        Ok(())
    }).unwrap();
    assert!(conflicts::occupies(&run(handle,&result.id).unwrap()));
    let stopped=conflicts::stop(handle,&chat.id,vec![result.id.clone()]).unwrap();
    assert!(serde_json::to_value(stopped).unwrap()[0]["stopped"].as_bool().unwrap());
    let settled=run(handle,&result.id).unwrap();
    assert!(!conflicts::occupies(&settled));
    assert_eq!(settled.status,"completed");
    assert_eq!(settled.artifacts.len(),result.artifacts.len());
    assert_eq!(settled.tasks[0].attempts[0].commands,result.tasks[0].attempts[0].commands);
    if std::env::var("GUILLE_TEAM_TEST_TRANSPORT").as_deref() == Ok("1") {
        // A real blocked task must not prevent a later independent task from
        // getting a worker when there is only one execution slot.
        let mut followup = result.clone();
        followup.id = super::domain::id();
        followup.status = "running".into();
        followup.finished_at = None;
        followup.notified = false;
        followup.team.max_parallel_tasks = 1;
        followup.evidence_dir = format!("{}-independent", result.evidence_dir);
        followup.baseline = evidence::baseline(&followup.team.allowed_repositories, std::path::Path::new(&followup.evidence_dir)).unwrap();
        followup.artifacts.clear();
        followup.observations.clear();
        evidence::initial(&mut followup).unwrap();
        followup.tasks[0].status = "blocked".into();
        followup.tasks[0].error = Some("La cuenta de este integrante necesita atención".into());
        followup.tasks[2].status = "pending".into();
        followup.tasks[2].attempts.clear();
        let retained_attempt = followup.tasks[1].attempts[0].id.clone();
        let followup_id = followup.id.clone();
        update(handle, |store| { store.chats[0].runs.push(followup); Ok(()) }).unwrap();
        runner::launch(handle, &followup_id);
        let deadline = Instant::now() + Duration::from_secs(60);
        let final_run = loop {
            for permission in client.get_resilient("/permission").unwrap().as_array().into_iter().flatten() {
                client.post(&format!("/permission/{}/reply", permission["id"].as_str().unwrap()), serde_json::json!({"reply":"once"})).unwrap();
            }
            let current = run(handle, &followup_id).unwrap();
            if !active(&current.status) { break current; }
            assert!(Instant::now() < deadline, "independent task did not advance: {:?}", current);
            std::thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(final_run.status, "blocked");
        assert_eq!(final_run.tasks[2].status, "completed", "independent work must finish before requiring intervention: {:?}", final_run.tasks[2]);
        assert_eq!(final_run.tasks[1].attempts.len(), 1);
        assert_eq!(final_run.tasks[1].attempts[0].id, retained_attempt, "completed work must not be replayed");
        let failed_id = team_chat_send(handle.clone(), chat.id.clone(), "Forzar rechazo Zen".into(), None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let store = read(handle).unwrap();
            let failed = store.chats[0].messages.iter().find(|m| m.id == failed_id).unwrap();
            if failed.status != "pending" {
                assert_eq!(failed.status, "error");
                assert!(failed.text.contains("restringido a la aplicación OpenCode"), "{}", failed.text);
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(100));
        }
        let question = team_chat_send(handle.clone(), chat.id.clone(), "¿Qué falló?".into(), None).unwrap();
        let explanation = wait_reply(&question);
        assert!(explanation.session_id.is_none(), "explaining saved failure must not use inference");
        assert!(explanation.text.contains("restringido a la aplicación OpenCode"));
        team_chats_model(handle.clone(), chat.id.clone(), chat.team.lead_agent_id.clone(), ModelRef { provider_id:"openai".into(), model_id:"qa-lead".into() }, None).unwrap();
        assert_eq!(run(handle, &followup_id).unwrap().tasks[1].attempts[0].id, retained_attempt);
    }
}
