// Invoked in separate, forcibly terminated Windows processes by the JS harness.
use super::*;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

#[test]
#[ignore = "Run node tests/teams-restart.mjs; this test is intentionally killed mid-command"]
fn restart_phase() {
    let repo = std::env::var("GUILLE_RESTART_REPO").unwrap();
    let phase = std::env::var("GUILLE_RESTART_PHASE").unwrap();
    let signal = std::env::var("GUILLE_RESTART_SIGNAL").unwrap();
    let identifier = std::env::var("GUILLE_RESTART_APP").unwrap();
    let coordination = std::env::var("GUILLE_RESTART_COORDINATION").as_deref() == Ok("1");
    let autonomous = std::env::var("GUILLE_RESTART_AUTO").as_deref() == Ok("1");
    assert!(identifier.starts_with("com.guillecode.recovery-"));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identifier;
    context.config_mut().app.windows.clear();
    let mut app = tauri::Builder::default()
        .any_thread()
        .manage(crate::ServerState {
            child: Mutex::new(None),
            config: Mutex::new(Some(crate::ServerConfig {
                url: std::env::var("GUILLE_RESTART_ENGINE").unwrap(),
                username: "opencode".into(),
                password: "qa-password".into(),
                worktree: repo.clone(),
            })),
            project: Mutex::new(Some(repo.clone())),
            stopping: AtomicBool::new(false),
        })
        .manage(crate::updates::UpdatesState::default())
        .build(context)
        .unwrap();
    start(app.handle());
    crate::approvals::start(app.handle());
    let handle = app.handle().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let c = runner::test_client(&handle, &repo).unwrap();
            let mut run_id = read(&handle)
                .unwrap()
                .chats
                .last()
                .and_then(|c| c.runs.last())
                .map(|r| r.id.clone());
            let mut ready = false;
            if phase.starts_with("prepare") {
                let mut team = super::domain::tests::team();
                team.plan_v2.enabled = std::env::var("GUILLE_RESTART_PLAN_V2").as_deref() == Ok("1");
                team.plan_v2.routing.enabled = std::env::var("GUILLE_RESTART_ROUTING").as_deref() == Ok("1");
                team.project_root = repo.clone();
                team.allowed_repositories = vec![repo.clone()];
                team.members[0].model.model_id = "qa-recovery-lead".into();
                let mut worker = team.members[0].clone();
                worker.id = "worker".into();
                worker.name = "Recovery worker".into();
                worker.model.model_id = "qa-recovery-worker".into();
                worker.tools = vec!["read".into(), "bash".into()];
                team.members.push(worker);
                if coordination {
                    let mut front = team.members[1].clone();
                    front.id = "front".into();
                    front.name = "Frontend".into();
                    front.model.model_id = "qa-recovery-front".into();
                    team.members.push(front);
                }
                let chat = if autonomous {
                    team_chats_auto(handle.clone(), repo.clone(), team.members[0].model.clone(), None).unwrap()
                } else {
                    let team = teams_save(handle.clone(), team).unwrap();
                    team_chats_create(handle.clone(), team.id).unwrap()
                };
                run_id = Some(
                    team_runs_start(
                        handle.clone(),
                        chat.id,
                        if phase == "prepare_engine" {
                            "engine-crash"
                        } else {
                            "app-crash"
                        }
                        .into(),
                    )
                    .unwrap(),
                );
            } else {
                let r = run(&handle, run_id.as_ref().unwrap()).unwrap();
                if autonomous {
                    assert!(r.team.autonomous);
                    let base_members = r.team.members.iter().filter(|m| !["support-solver", "support-supervisor"].contains(&m.id.as_str())).count();
                    assert_eq!(base_members, if coordination { 3 } else { 2 });
                    assert_eq!(r.team.members.iter().find(|m| m.id == "worker").unwrap().role, "Backend");
                    assert!(read(&handle).unwrap().teams.is_empty());
                }
                if phase == "reopen" {
                    assert_eq!(r.status, "completed");
                    assert!(r.notified);
                    if autonomous { assert_eq!(r.chat_summary.as_ref().unwrap().tested, "El efecto ocurrió una sola vez."); }
                    std::fs::write(&signal,serde_json::json!({"status":"reopened","runId":r.id,"dataDir":handle.path().app_data_dir().unwrap()}).to_string()).unwrap();
                    return;
                }
                assert_eq!(r.status, "blocked");
                if phase == "busy" {
                    assert!(control(&handle, &r.id, "retry")
                        .unwrap_err()
                        .contains("sigue activa"));
                    std::fs::write(&signal, "{\"status\":\"busy-preserved\"}").unwrap();
                    return;
                }
                control(&handle, &r.id, "retry").unwrap();
            }
            let run_id = run_id.unwrap();
            let deadline = Instant::now() + Duration::from_secs(110);
            loop {
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
                let r = run(&handle, &run_id).unwrap();
                if phase.starts_with("prepare")
                    && !ready
                    && (!coordination || r.coordination.iter().any(|c| c.status == "waiting"))
                    && std::path::Path::new(&repo)
                        .join(if phase == "prepare_engine" {
                            "engine-effects.log"
                        } else {
                            "app-effects.log"
                        })
                        .exists()
                {
                    let attempt = r.tasks[0].attempts[0].clone();
                    std::fs::write(&signal,serde_json::json!({"status":"ready","pid":std::process::id(),"runId":r.id,"planRevision":r.plan_v2.revision_number,"planDigest":r.plan_v2.digest,"routing":attempt.routing,"sessionId":attempt.session_id,"frontSessionId":r.tasks.get(1).and_then(|t|t.attempts.last()).and_then(|a|a.session_id.as_ref()),"coordinationId":r.coordination.first().map(|c|&c.id),"dataDir":handle.path().app_data_dir().unwrap()}).to_string()).unwrap();
                    ready = true;
                }
                if !active(&r.status) {
                    assert!(
                        !phase.starts_with("prepare"),
                        "process should have been terminated during command: {:?}", r
                    );
                    assert_eq!(r.status, "completed", "{:?}", r);
                    assert_eq!(
                        r.tasks[0].attempts.len(),
                        1,
                        "restart must reuse attempt, not repeat work: {:?}",
                        r.tasks[0].attempts
                    );
                    assert!(r.tasks[0].attempts[0].recovered);
                    if coordination {
                        assert_eq!(r.tasks[1].attempts.len(), 1);
                        assert!(r.tasks[1].attempts[0].recovered);
                        assert_eq!(r.coordination.len(), 1);
                        assert_eq!(r.coordination[0].status, "resolved");
                        assert!(r.coordination[0].sessions.len() >= 2);
                    }
                    let file = if phase == "resume_engine" {
                        "engine-effects.log"
                    } else {
                        "app-effects.log"
                    };
                    assert_eq!(
                        std::fs::read_to_string(std::path::Path::new(&repo).join(file)).unwrap(),
                        "once\n"
                    );
                    if std::env::var("GUILLE_RESTART_NO_GIT").as_deref() == Ok("1") {
                        assert_eq!(r.baseline[0]["mode"], "filesystem");
                        assert!(!std::path::Path::new(&repo).join(".git").exists());
                        assert!(std::path::Path::new(&r.evidence_dir)
                            .join("cambios/cambios.diff")
                            .is_file());
                    }
                    std::fs::write(&signal,serde_json::json!({"status":"recovered","planRevision":r.plan_v2.revision_number,"planDigest":r.plan_v2.digest,"routing":r.tasks[0].attempts[0].routing,"sessionId":r.tasks[0].attempts[0].session_id,"frontSessionId":r.tasks.get(1).and_then(|t|t.attempts.last()).and_then(|a|a.session_id.as_ref()),"coordinationId":r.coordination.first().map(|c|&c.id),"runId":r.id,"attempts":r.tasks[0].attempts.len(),"dataDir":handle.path().app_data_dir().unwrap()}).to_string()).unwrap();
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "restart phase timed out: {:?}",
                    r
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }));
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(120);
    let result = loop {
        app.run_iteration(|_, _| {});
        if let Ok(r) = rx.try_recv() {
            break r;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(app);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
