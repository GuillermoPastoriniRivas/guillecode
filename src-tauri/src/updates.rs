use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdatesState {
    operation: AtomicBool,
    installing: AtomicBool,
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
}

// All IPC operations share a guard, including retries and simultaneous checks.
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl UpdatesState {
    fn begin(&self) -> Result<Operation<'_>, String> {
        self.operation
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Ya hay una operación de actualización en curso".to_string())?;
        Ok(Operation(&self.operation))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    edition: &'static str,
    requires_source_integration: bool,
}

const LOCAL_UPDATE_REASON: &str = "Esta edición incluye Equipos IA y cambios locales. Para conservarlos, integrá la actualización en el código de esta rama, verificá y compilá un instalador combinado. El instalador público reemplazaría esta edición.";

const EDITION_ENDPOINT: &str =
    "https://github.com/GuillermoPastoriniRivas/guillecode/releases/latest/download/latest.json";

fn local_edition(identifier: &str, endpoints: &[&str]) -> bool {
    // Only the original repository's signed releases are allowed to replace this edition.
    identifier == "com.guillecode.desktop"
        && (endpoints.is_empty() || endpoints.iter().any(|url| *url != EDITION_ENDPOINT))
}

fn requires_integration(app: &AppHandle) -> bool {
    let config = app.config();
    let endpoints: Vec<&str> = config
        .plugins
        .0
        .get("updater")
        .and_then(|v| v["endpoints"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .collect();
    local_edition(&config.identifier, &endpoints)
}

#[tauri::command]
pub fn update_policy(app: AppHandle) -> UpdatePolicy {
    UpdatePolicy {
        edition: "Equipos IA",
        requires_source_integration: requires_integration(&app),
    }
}

fn preserve_local_edition(app: &AppHandle) -> Result<(), String> {
    if requires_integration(app) {
        return Err(LOCAL_UPDATE_REASON.into());
    }
    Ok(())
}

pub fn installing(app: &AppHandle) -> bool {
    app.try_state::<UpdatesState>()
        .map(|s| s.installing.load(Ordering::SeqCst))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let state = app.state::<UpdatesState>();
    let _operation = state.begin()?;
    // A downloaded, verified update must not be invalidated by periodic checks.
    if state.downloaded.lock().unwrap().is_some() {
        return Ok(state.pending.lock().unwrap().as_ref().map(info));
    }
    let handle = app.clone();
    let mut update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .on_before_exit(move || crate::shutdown(&handle))
        .restart_after_install(true)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = update.as_mut() {
        update.timeout = Some(Duration::from_secs(20 * 60));
    }
    let result = update.as_ref().map(info);
    *state.pending.lock().unwrap() = update;
    Ok(result)
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn update_download(app: AppHandle) -> Result<(), String> {
    preserve_local_edition(&app)?;
    let state = app.state::<UpdatesState>();
    let _operation = state.begin()?;
    let update = state
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("Buscá una actualización primero")?;
    *state.downloaded.lock().unwrap() = None;
    let mut downloaded = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= Duration::from_millis(100) {
                    let _ = app.emit("update://progress", Progress { downloaded, total });
                    last = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // download() verifies the mandatory minisign signature before returning bytes.
    let len = bytes.len() as u64;
    *state.downloaded.lock().unwrap() = Some(bytes);
    let _ = app.emit(
        "update://progress",
        Progress {
            downloaded: len,
            total: Some(len),
        },
    );
    Ok(())
}

fn preflight(app: &AppHandle) -> Result<(), String> {
    if crate::teams::busy(app) {
        return Err("Hay equipos IA trabajando o sesiones pendientes. Finalizá o cancelá sus ejecuciones antes de actualizar".into());
    }
    if crate::routines::views(app).iter().any(|r| {
        r.routine
            .runs
            .first()
            .map(|r| r.finished_at.is_none())
            .unwrap_or(false)
    }) {
        return Err("Hay rutinas trabajando. Esperá a que terminen antes de actualizar".into());
    }
    if !crate::live::live_busy_sessions(app.clone()).is_empty() {
        return Err(
            "Hay agentes trabajando, incluso en otros proyectos. Esperá a que terminen".into(),
        );
    }
    // Query the actual engine, not only the currently selected frontend project.
    let server = crate::ensure_server(app)?;
    let mut projects: HashSet<String> = crate::recent_project_list(app).into_iter().collect();
    projects.insert(server.worktree.clone());
    for p in crate::windows::all_projects(app) {
        projects.insert(p);
    }
    for r in crate::routines::views(app) {
        projects.insert(r.routine.project);
    }
    let bases: Vec<String> = projects.iter().cloned().collect();
    for base in bases {
        for (root, _) in crate::features::feature_roots(app, &base) {
            projects.insert(root);
        }
    }
    for project in projects {
        let client = crate::oc::Opencode::new(&server, &project);
        let statuses = client.get("/session/status")?;
        let statuses = statuses
            .as_object()
            .ok_or("No se pudo verificar el estado de los agentes")?;
        if statuses
            .values()
            .any(|s| s["type"].as_str() != Some("idle"))
        {
            return Err("Hay agentes trabajando. Esperá a que terminen antes de actualizar".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    preserve_local_edition(&app)?;
    let state = app.state::<UpdatesState>();
    let _operation = state.begin()?;
    state.installing.store(true, Ordering::SeqCst);
    let handle = app.clone();
    let result = crate::proc::blocking(move || {
        preflight(&handle)?;
        let state = handle.state::<UpdatesState>();
        let update = state
            .pending
            .lock()
            .unwrap()
            .clone()
            .ok_or("No hay actualización pendiente")?;
        let bytes = state.downloaded.lock().unwrap();
        let bytes = bytes
            .as_ref()
            .ok_or("Descargá la actualización antes de instalar")?;
        // On Windows install invokes cleanup, launches NSIS with /R and exits.
        // Do not call restart() after install: that branch never runs on Windows.
        update.install(bytes).map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        handle.restart();
        Ok(())
    })
    .await;
    if result.is_err() {
        // Windows may reject launching NSIS after on_before_exit has run.
        // Allow lazy engine recovery when the current app is still alive.
        let server = app.state::<crate::ServerState>();
        let _config = server.config.lock().unwrap();
        server.stopping.store(false, Ordering::SeqCst);
        crate::windows::window_quit_cancel(app.clone());
    }
    state.installing.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Run via node tests/windows-updater-download.mjs with signed QA fixtures"]
    fn native_signed_download() {
        let url = std::env::var("GUILLE_UPDATER_TEST_URL").expect("isolated fixture server");
        assert!(url.starts_with("http://127.0.0.1:"));
        let expected = std::env::var("GUILLE_UPDATER_TEST_VERSION").unwrap();
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = format!("com.guillecode.updater-test-{}", uuid::Uuid::new_v4());
        context.config_mut().app.windows.clear();
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
            "pubkey": std::env::var("GUILLE_UPDATER_TEST_PUBLIC_KEY").unwrap(),
            "endpoints": [format!("{url}/latest.json")],
            "dangerousInsecureTransportProtocol": true,
        }));
        let mut app = tauri::Builder::default().any_thread()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(UpdatesState::default()).build(context).unwrap();
        let handle = app.handle().clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tauri::async_runtime::block_on(async {
                    assert!(!update_policy(handle.clone()).requires_source_integration);
                    assert_eq!(update_check(handle.clone()).await.unwrap().unwrap().version, expected);
                    assert!(update_download(handle.clone()).await.is_err());
                    assert!(handle.state::<UpdatesState>().downloaded.lock().unwrap().is_none());
                    ureq::get(&format!("{url}/mode/invalid")).call().unwrap();
                    update_check(handle.clone()).await.unwrap();
                    assert!(update_download(handle.clone()).await.is_err());
                    assert!(handle.state::<UpdatesState>().downloaded.lock().unwrap().is_none());
                    ureq::get(&format!("{url}/mode/valid")).call().unwrap();
                    update_check(handle.clone()).await.unwrap();
                    update_download(handle.clone()).await.unwrap();
                    let size = handle.state::<UpdatesState>().downloaded.lock().unwrap().as_ref().unwrap().len();
                    assert!(size > 1_000_000);
                    assert_eq!(update_check(handle.clone()).await.unwrap().unwrap().version, expected);
                    assert_eq!(handle.state::<UpdatesState>().downloaded.lock().unwrap().as_ref().unwrap().len(), size);
                });
            }));
            let _ = tx.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(180);
        let result = loop {
            app.run_iteration(|_, _| {});
            if let Ok(result) = rx.try_recv() { break result; }
            assert!(Instant::now() < deadline, "native updater test timed out");
            std::thread::sleep(Duration::from_millis(10));
        };
        drop(app);
        if let Err(error) = result { std::panic::resume_unwind(error); }
    }
    #[test]
    fn customized_desktop_blocks_every_non_official_update_source() {
        assert!(local_edition("com.guillecode.desktop", &[]));
        assert!(!local_edition("com.guillecode.desktop", &[EDITION_ENDPOINT]));
        assert!(local_edition("com.guillecode.desktop", &["https://github.com/Kaitach/guillecode/releases/latest/download/latest.json"]));
        assert!(local_edition(
            "com.guillecode.desktop",
            &["https://github.com/Kaitach/guillecode-evil/releases/latest/download/latest.json"]
        ));
        assert!(!local_edition(
            "com.guillecode.upgrade-test-isolated",
            &["http://127.0.0.1/latest.json"]
        ));
    }
    #[test]
    fn serializes_operations_and_releases_after_failure() {
        let state = UpdatesState::default();
        let operation = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(operation);
        assert!(state.begin().is_ok());
    }
}
