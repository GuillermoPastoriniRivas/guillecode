use super::{domain::*, read, update};
use std::path::Path;
use tauri::AppHandle;

fn eligible(r: &Run) -> bool {
    matches!(r.status.as_str(), "qa_approved" | "cancelled" | "failed")
        && r.evidence_expired_at.is_none()
        && r.team
            .limits
            .retention_days
            .zip(r.finished_at)
            .map(|(days, finished)| now() - finished > days as i64 * 86_400_000)
            .unwrap_or(false)
}

fn remove(root: &Path, run: &Run) -> Result<(), String> {
    if run.id.len() != 32 || !run.id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ID de ejecución inválido para retención".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let expected = root.join(&run.id);
    let path = Path::new(&run.evidence_dir);
    if !path.exists() {
        return Ok(());
    }
    let actual = path.canonicalize().map_err(|e| e.to_string())?;
    // No symlink/junction redirection, no arbitrary persisted path, no repo paths.
    if actual != expected {
        return Err("La carpeta no pertenece a la retención de esta app".into());
    }
    std::fs::remove_dir_all(&actual).map_err(|e| e.to_string())
}

pub fn sweep(app: &AppHandle) -> Result<usize, String> {
    let root = crate::app_data_file(app, "comportamientos").ok_or("Sin carpeta de evidencias")?;
    if !root.exists() {
        return Ok(0);
    }
    let mut expired = vec![];
    for r in read(app)?
        .chats
        .iter()
        .flat_map(|c| &c.runs)
        .filter(|r| eligible(r))
    {
        remove(&root, r)?;
        expired.push(r.id.clone());
    }
    if !expired.is_empty() {
        update(app, |s| {
            for r in s
                .chats
                .iter_mut()
                .flat_map(|c| &mut c.runs)
                .filter(|r| expired.contains(&r.id))
            {
                r.evidence_expired_at = Some(now());
                for artifact in &mut r.artifacts {
                    if artifact.status == "captured" {
                        artifact.status = "expired".into();
                        artifact.reason = Some("Expiró según la retención configurada".into());
                    }
                }
                for o in &mut r.observations {
                    o.status = "expired".into();
                    o.details["reason"] =
                        serde_json::json!("Expiró según la retención configurada");
                }
            }
            Ok(())
        })?;
    }
    Ok(expired.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_is_opt_in_and_keeps_manual_qa() {
        let team = super::super::domain::tests::team();
        let mut r:Run=serde_json::from_value(serde_json::json!({"id":id(),"goal":"x","team":team,"skills":[],"status":"qa_approved","startedAt":0,"finishedAt":0,"planSessionId":null,"tasks":[],"summary":"x","error":null,"evidenceDir":"unused","artifacts":[],"baseline":[],"notified":true})).unwrap();
        assert!(!eligible(&r));
        r.team.limits.retention_days = Some(1);
        assert!(eligible(&r));
        r.status = "awaiting_manual_qa".into();
        assert!(!eligible(&r));
        r.status = "completed".into();
        assert!(!eligible(&r));
        let root = std::env::temp_dir().join(format!("teams-retention-{}", id()));
        std::fs::create_dir_all(&root).unwrap();
        r.evidence_dir = std::env::temp_dir().to_string_lossy().into();
        assert!(remove(&root, &r).is_err());
        let own = root.join(&r.id);
        std::fs::create_dir(&own).unwrap();
        std::fs::write(own.join("proof.txt"), "fixture").unwrap();
        r.evidence_dir = own.to_string_lossy().into();
        remove(&root, &r).unwrap();
        assert!(!own.exists());
        std::fs::remove_dir(&root).unwrap();
    }
}
