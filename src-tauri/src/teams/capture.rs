use super::{domain::*, evidence};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn validate_targets(targets: &[CaptureTarget]) -> Result<(), String> {
    if targets.len() > 10 {
        return Err("Máximo 10 flujos de evidencia por ejecución".into());
    }
    let mut ids = std::collections::HashSet::new();
    for t in targets {
        let u = tauri::Url::parse(&t.url).map_err(|_| "URL de captura inválida")?;
        if !["http", "https"].contains(&u.scheme())
            || !["localhost", "127.0.0.1", "[::1]", "::1"].contains(&u.host_str().unwrap_or(""))
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err("Los flujos de evidencia deben pertenecer a una aplicación local, sin credenciales en la URL".into());
        }
        if u.query_pairs().any(|(key, _)| {
            ["token", "key", "secret", "password", "cookie", "auth"]
                .iter()
                .any(|k| key.to_lowercase().contains(k))
        }) || [".env", "credentials", "auth.json"]
            .iter()
            .any(|s| u.path().to_lowercase().contains(s))
        {
            return Err(
                "No se permiten credenciales ni rutas de secretos en las evidencias".into(),
            );
        }
        if t.id.is_empty()
            || !ids.insert(&t.id)
            || t.name.trim().is_empty()
            || !(320..=2560).contains(&t.width)
            || !(240..=1600).contains(&t.height)
            || t.actions.len() > 20
            || t.mask_selectors.len() > 30
        {
            return Err("Flujo de evidencia inválido: revisá identificador, nombre, viewport y cantidad de pasos".into());
        }
        if t.actions.iter().any(|a| {
            !["click", "fill", "wait"].contains(&a.kind.as_str())
                || a.selector.is_empty()
                || a.selector.len() > 500
                || a.value.as_ref().map(|s| s.len() > 2000).unwrap_or(false)
        }) {
            return Err(
                "Los pasos de evidencia admiten click, fill o wait y selectores acotados".into(),
            );
        }
        if t.mask_selectors
            .iter()
            .any(|s| s.trim().is_empty() || s.len() > 500)
        {
            return Err("Selector de privacidad inválido".into());
        }
    }
    Ok(())
}

fn browser() -> Option<PathBuf> {
    let roots = [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ];
    for root in roots.into_iter().flatten() {
        for relative in [
            "Google/Chrome/Application/chrome.exe",
            "Microsoft/Edge/Application/msedge.exe",
            "Chromium/Application/chrome.exe",
        ] {
            let path = PathBuf::from(&root).join(relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub fn capture_target(run: &mut Run, target: &CaptureTarget, phase: &str) -> Result<(), String> {
    validate_targets(&[target.clone()])?;
    let capture_id = id();
    let relative = format!(
        "{}/{}.png",
        if phase == "before" {
            "antes"
        } else {
            "despues"
        },
        capture_id
    );
    let output = evidence::safe_path(&run.evidence_dir, &relative, false)?;
    std::fs::create_dir_all(output.parent().ok_or("Carpeta de captura inválida")?)
        .map_err(|e| e.to_string())?;
    let details = match browser() {
        None => {
            json!({"status":"unavailable","reason":"No se encontró Chrome/Edge instalado. No se generó una imagen de reemplazo."})
        }
        Some(browser) => {
            let helper = Path::new(&run.evidence_dir).join(format!("capture-{}.mjs", capture_id));
            std::fs::write(&helper, include_str!("capture.mjs")).map_err(|e| e.to_string())?;
            let config = json!({"target":target,"browser":browser,"output":output});
            let mut command = std::process::Command::new("node");
            command.arg(&helper);
            let response = crate::proc::capture(
                &mut command,
                Some(&config.to_string()),
                std::time::Duration::from_secs(50),
                false,
            );
            let _ = std::fs::remove_file(helper);
            match response {
                Ok(out)=>serde_json::from_slice::<Value>(&out.stdout).unwrap_or_else(|_|json!({"status":"failed","reason":"El capturador no devolvió un reporte JSON válido"})),
                Err(e)=>json!({"status":"unavailable","reason":e}),
            }
        }
    };
    let details: Value = serde_json::from_str(&evidence::sanitize(&details.to_string()))
        .map_err(|e| e.to_string())?;
    let mut status = details["status"].as_str().unwrap_or("failed").to_string();
    let mut hash = None;
    if status == "captured" {
        match png(&output) {
            Ok(bytes) => {
                hash = Some(format!("{:x}", Sha256::digest(&bytes)));
            }
            Err(_) => {
                status = "failed".into();
            }
        }
    }
    let reason = if status == "captured" {
        None
    } else {
        Some(
            details["reason"]
                .as_str()
                .unwrap_or("PNG ausente, corrupto o demasiado grande")
                .to_string(),
        )
    };
    run.artifacts.push(Artifact {
        id: capture_id.clone(),
        task_id: None,
        phase: phase.into(),
        kind: "screenshot".into(),
        relative_path: if status == "captured" {
            relative.clone()
        } else {
            String::new()
        },
        captured_at: now(),
        status: status.clone(),
        source: "Navegador local aislado · CDP".into(),
        reason,
    });
    let report = format!("capturas/{}.json", capture_id);
    evidence::write(run,&report,phase,"report","Navegador real / resultado de captura",&json!({"targetId":target.id,"name":target.name,"url":target.url,"phase":phase,"sha256":hash,"observation":details}).to_string())?;
    let mut details = details;
    details["revision"] = json!(run.tasks.iter().map(|t| t.attempts.len()).sum::<usize>());
    run.observations.push(Observation {
        id: capture_id,
        target_id: target.id.clone(),
        phase: phase.into(),
        captured_at: now(),
        status: status.clone(),
        artifact_path: if status == "captured" {
            Some(relative)
        } else {
            None
        },
        report_path: report,
        sha256: hash,
        details,
    });
    Ok(())
}

pub fn png(path: &Path) -> Result<Vec<u8>, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 5 * 1024 * 1024 {
        return Err("Captura mayor a 5 MB".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 24 || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
        return Err("PNG inválido".into());
    }
    Ok(bytes)
}

pub fn collect(run: &mut Run, phase: &str) -> Result<(), String> {
    if run.capture_targets.is_empty() {
        if !run
            .artifacts
            .iter()
            .any(|a| a.phase == phase && a.kind == "screenshot")
        {
            run.artifacts.push(Artifact {
                id: id(),
                task_id: None,
                phase: phase.into(),
                kind: "screenshot".into(),
                relative_path: String::new(),
                captured_at: now(),
                status: "unavailable".into(),
                source: "Descubrimiento del Lead".into(),
                reason: Some(
                    "No se identificó un flujo web local para capturar en este objetivo".into(),
                ),
            });
        }
        return Ok(());
    }
    for target in run.capture_targets.clone() {
        let revision = run.tasks.iter().map(|t| t.attempts.len()).sum::<usize>();
        if !run.observations.iter().any(|o| {
            o.target_id == target.id
                && o.phase == phase
                && (phase == "before"
                    || (o.status == "captured"
                        && o.details["revision"].as_u64() == Some(revision as u64)))
        }) {
            capture_target(run, &target, phase)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_targets_do_not_allow_production_or_credentials() {
        for url in [
            "https://example.com",
            "file:///C:/secret",
            "http://user:pw@localhost",
            "http://localhost.evil.test",
        ] {
            let t: CaptureTarget =
                serde_json::from_value(json!({"id":"x","name":"x","url":url})).unwrap();
            assert!(validate_targets(&[t]).is_err());
        }
        let t: CaptureTarget = serde_json::from_value(
            json!({"id":"x","name":"x","url":"http://127.0.0.1:5173/login"}),
        )
        .unwrap();
        assert!(validate_targets(&[t]).is_ok());
    }
}
