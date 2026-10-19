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
            if std::env::var("GUILLE_TEAM_TEST_AUTO").as_deref() == Ok("1") {
                automatic_team_scenario(&handle, &repo);
                return;
            }
            let mut team = super::domain::tests::team();
            team.project_root = repo.clone();
            team.allowed_repositories = vec![repo.clone()];
            team.members[0].model.model_id = "qa-lead".into();
            team.members[0].skill_refs = vec![
                SkillRef {
                    id: "team-lead".into(),
                    version: 2,
                },
                SkillRef {
                    id: "comportamientos".into(),
                    version: 2,
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
                        version: 2,
                    },
                    SkillRef {
                        id: "security".into(),
                        version: 2,
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
            assert_eq!(result.status, "awaiting_manual_qa", "{:?}", result);
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
            control(&handle, &run_id, "approve").unwrap();
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
            assert_eq!(recovered.status, "awaiting_manual_qa", "{:?}", recovered);
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
            assert_eq!(recovered.status, "awaiting_manual_qa");
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
    assert!(read(handle).unwrap().chats[0].runs.is_empty(), "an explanation must not launch work");
    assert!(is_team_session(handle, reply.session_id.as_deref().unwrap()));
    let request = team_chat_send(handle.clone(), chat.id.clone(), "Crear dos servicios Backend y una pantalla Frontend, repartidos por el Lead".into(), None).unwrap();
    wait_reply(&request);
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
    assert_eq!(result.status, "awaiting_manual_qa", "{:?}", result);
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
    assert_eq!(persisted.chats[0].messages.len(), 6);
    let mut interrupted = persisted.clone();
    interrupted.chats[0].messages[5].status = "pending".into();
    recover(&mut interrupted);
    assert_eq!(interrupted.chats[0].messages[5].status, "interrupted");
    assert!(interrupted.chats[0].messages[5].text.contains("no se repitió"));
    assert_eq!(interrupted.chats[0].runs.len(), 1);
}
