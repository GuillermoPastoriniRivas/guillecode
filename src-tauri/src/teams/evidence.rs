use super::domain::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const LIMIT: usize = 512_000;

pub fn validate_folders(repositories: &[String]) -> Result<(), String> {
    for repository in repositories {
        if !Path::new(repository).is_dir() {
            return Err(format!("La carpeta de trabajo no existe: {repository}"));
        }
        std::fs::read_dir(repository)
            .map_err(|_| format!("No se puede leer la carpeta de trabajo: {repository}"))?;
    }
    Ok(())
}

pub fn sanitize(text: &str) -> String {
    // Evidence is deliberately conservative: omit entire sensitive lines, not just values.
    let sensitive = regex::Regex::new(r"(?i)(authorization|bearer\s|api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|cookie|private[_ -]key|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|sk-[a-z0-9_-]{12,})").unwrap();
    fn redact(value: &mut Value, sensitive: &regex::Regex) {
        match value {
            Value::String(s) => {
                *s = s
                    .lines()
                    .map(|line| {
                        if sensitive.is_match(line) {
                            "[línea sensible omitida]"
                        } else {
                            line
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
                    .chars()
                    .take(64_000)
                    .collect();
            }
            Value::Array(v) => {
                for item in v {
                    redact(item, sensitive);
                }
            }
            Value::Object(v) => {
                for (key, item) in v {
                    if sensitive.is_match(key) {
                        *item = json!("[dato sensible omitido]");
                    } else {
                        redact(item, sensitive);
                    }
                }
            }
            _ => (),
        }
    }
    if let Ok(mut value) = serde_json::from_str::<Value>(text) {
        redact(&mut value, &sensitive);
        return serde_json::to_string_pretty(&value).unwrap_or_default();
    }
    let mut out: String = text
        .lines()
        .map(|line| {
            if sensitive.is_match(line) {
                "[línea sensible omitida]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(LIMIT)
        .collect();
    if text.chars().count() > LIMIT {
        out.push_str("\n[evidencia recortada por límite de tamaño]");
    }
    out
}

pub fn git(repo: &str, args: &[&str], index: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(sanitize(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub(super) fn sensitive_path(path: &str) -> bool {
    let p = path.to_lowercase();
    p.split('/').any(|part| {
        part.starts_with(".env")
            || [
                "auth.json",
                "credentials.json",
                "id_rsa",
                "id_ed25519",
                ".npmrc",
                ".netrc",
                ".pypirc",
                ".git-credentials",
            ]
            .contains(&part)
    }) || p.ends_with(".pem")
        || p.ends_with(".key")
}

fn tree(repo: &str, dir: &Path) -> Result<String, String> {
    // A private temporary index includes pre-existing staged, unstaged and untracked files.
    // The user's index, branch and working files are never reset, stashed or committed.
    let index = dir.join(format!("index-{}", id()));
    let result = (|| {
        git(repo, &["read-tree", "--empty"], Some(&index))?;
        let paths = git(
            repo,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            None,
        )?;
        let files: Vec<_> = paths
            .split('\0')
            .filter(|p| !p.is_empty() && !sensitive_path(p) && Path::new(repo).join(p).is_file())
            .collect();
        for batch in files.chunks(100) {
            // Use literal pathspecs; a repository filename is never a Git option.
            let mut args = vec!["--literal-pathspecs", "add", "--"];
            args.extend(batch.iter().copied());
            git(repo, &args, Some(&index))?;
        }
        git(repo, &["write-tree"], Some(&index))
    })();
    let _ = std::fs::remove_file(&index);
    result
}

pub fn baseline(repos: &[String], dir: &Path) -> Result<Vec<Value>, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    repos.iter().map(|repo| {
        let root = git(repo, &["rev-parse", "--show-toplevel"], None).ok();
        let is_root = root.as_ref().map(|root| {
            same_path(root, repo) || std::fs::canonicalize(root).ok().zip(std::fs::canonicalize(repo).ok())
                .map(|(root, repo)| same_path(&root.to_string_lossy(), &repo.to_string_lossy()))
                .unwrap_or(false)
        }).unwrap_or(false);
        if !is_root {
            return super::folder_snapshot::baseline(repo, dir);
        }
        Ok(json!({ "repository": repo, "head": git(repo, &["rev-parse", "HEAD"], None).ok(), "branch": git(repo, &["branch", "--show-current"], None).ok(), "status": sanitize(&git(repo, &["status", "--short", "--untracked-files=all"], None)?), "tree": tree(repo, dir)?, "capturedAt": now() }))
    }).collect()
}

pub fn changes(run: &Run) -> Result<String, String> {
    let mut chunks = vec![];
    for b in &run.baseline {
        let repo = b["repository"].as_str().ok_or("Baseline sin repo")?;
        if b["mode"] == "filesystem" {
            let (diff, _) = super::folder_snapshot::compare(b, Path::new(&run.evidence_dir))?;
            chunks.push(format!("Carpeta: {}\n{}", repo, diff));
            continue;
        }
        let before = b["tree"].as_str().ok_or("Baseline sin árbol")?;
        let after = tree(repo, Path::new(&run.evidence_dir))?;
        let diff = git(
            repo,
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                before,
                &after,
            ],
            None,
        )?;
        chunks.push(format!("Repositorio: {}\n{}", repo, sanitize(&diff)));
    }
    Ok(chunks.join("\n\n"))
}

pub fn write(
    run: &mut Run,
    relative: &str,
    phase: &str,
    kind: &str,
    source: &str,
    text: &str,
) -> Result<(), String> {
    if text.len() > 4 * LIMIT {
        return Err("La evidencia supera el límite de 2 MB".into());
    }
    let path = safe_path(&run.evidence_dir, relative, false)?;
    std::fs::create_dir_all(path.parent().ok_or("Ruta inválida")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", id()));
    std::fs::write(&tmp, sanitize(text)).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, &path).map_err(|e| e.to_string())?;
    run.artifacts.retain(|a| a.relative_path != relative);
    run.artifacts.push(Artifact {
        id: id(),
        task_id: None,
        phase: phase.into(),
        kind: kind.into(),
        relative_path: relative.into(),
        captured_at: now(),
        status: "captured".into(),
        source: source.into(),
        reason: None,
    });
    Ok(())
}

pub fn safe_path(root: &str, relative: &str, exists: bool) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with(['/', '\\'])
        || relative.contains(':')
        || relative.replace('\\', "/").split('/').any(|s| s == "..")
    {
        return Err("Ruta de evidencia inválida".into());
    }
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let target = root.join(relative);
    let mut parent = target.as_path();
    while !parent.exists() {
        parent = parent.parent().ok_or("Ruta inválida")?;
    }
    if !parent
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("La evidencia sale de la carpeta autorizada".into());
    }
    if exists && !target.is_file() {
        return Err("El archivo de evidencia ya no existe".into());
    }
    Ok(target)
}

pub fn initial(run: &mut Run) -> Result<(), String> {
    let baseline = serde_json::to_string_pretty(&run.baseline).map_err(|e| e.to_string())?;
    write(
        run,
        "antes/repositorios.json",
        "before",
        "report",
        "Instantánea inicial de archivos; Git cuando está disponible",
        &baseline,
    )?;
    write(run, "antes/estado-inicial.md", "before", "report", "Archivos locales", "Contenido inicial registrado antes de planificar. Si existe una raíz Git se conserva también branch/commit; en otras carpetas se guarda una instantánea durable de archivos. Git es opcional y no se inicializa. La comparación distingue el contenido previo de los cambios posteriores; excluye credenciales conocidas y declara sus límites. No se observó todavía un flujo visual; no se presume que antes funcionara o no existiera.")?;
    Ok(())
}

pub fn deliver(run: &mut Run) -> Result<(), String> {
    let revisions =
        serde_json::to_string_pretty(&run.configuration_changes).map_err(|e| e.to_string())?;
    write(
        run,
        "revisiones/configuracion.json",
        "change",
        "report",
        "Cambios explícitos de modelo o responsable",
        &revisions,
    )?;
    let diff = changes(run)?;
    write(
        run,
        "cambios/cambios.diff",
        "change",
        "diff",
        "Contenido inicial contra final (Git o instantánea de carpeta)",
        &diff,
    )?;
    let mut files = vec![];
    for b in &run.baseline {
        let repo = b["repository"].as_str().ok_or("Falta repo")?;
        if b["mode"] == "filesystem" {
            let (_, names) = super::folder_snapshot::compare(b, Path::new(&run.evidence_dir))?;
            files.push(json!({"repository":repo,"mode":"filesystem","files":names}));
            continue;
        }
        let after = tree(repo, Path::new(&run.evidence_dir))?;
        files.push(json!({"repository":repo, "files":git(repo, &["diff", "--name-status", b["tree"].as_str().ok_or("Falta tree")?, &after], None)?}));
    }
    write(
        run,
        "cambios/archivos.json",
        "change",
        "report",
        "Comparación nativa de archivos",
        &serde_json::to_string_pretty(&files).map_err(|e| e.to_string())?,
    )?;
    let checks: Vec<Value> = run
        .tasks
        .iter()
        .flat_map(|t| t.attempts.iter().flat_map(|a| a.commands.iter().cloned()))
        .collect();
    write(
        run,
        "pruebas/pruebas.json",
        "test",
        "log",
        "Eventos de herramientas OpenCode (no inferidos del texto del modelo)",
        &serde_json::to_string_pretty(&checks).map_err(|e| e.to_string())?,
    )?;
    write(
        run,
        "despues/estado-final.md",
        "after",
        "report",
        "Team Lead",
        &run.summary.clone(),
    )?;
    let limitations: Vec<String> = run
        .artifacts
        .iter()
        .filter(|a| a.status != "captured")
        .filter_map(|a| a.reason.clone())
        .chain([
            "Capturas locales con campos privados ocultos; no equivalen a una aprobación personal del usuario".into(),
            "Ediciones externas simultáneas al equipo no pueden atribuirse automáticamente".into(),
        ])
        .collect();
    let summary = format!("# {}\n\nObjetivo: {}\n\n{}\n\nTrabajo y comprobaciones del equipo completados. Tu visto bueno personal es opcional.\n\n## Evidencia visual\n{} capturas reales verificadas. Consultá manifest.json y los reportes de cada flujo.\n\n## Límites de la evidencia\n{}\n\nLos comandos se registran solo si OpenCode los devolvió como herramientas completadas. Los diffs comparan contenido inicial y final sin modificar archivos ni el index del usuario. En carpetas sin Git se usa una instantánea durable con límites declarados. Los reportes se sanitizan y las credenciales conocidas no se incluyen.\n", run.team.name, run.goal, run.summary,run.observations.iter().filter(|o|o.status=="captured").count(),limitations.join("\n"));
    write(
        run,
        "resumen.md",
        "after",
        "report",
        "Team Lead + observaciones nativas",
        &summary,
    )?;
    let result = json!({ "runId":run.id, "teamId":run.team.id, "goal":run.goal, "leadStatus":"completed", "manualQaStatus":"optional", "finishedAt":now(), "summary":run.summary, "tasks":{"total":run.tasks.len(),"completed":run.tasks.iter().filter(|t| t.status == "completed").count()},"checks":checks,"limitations":limitations,"observations":run.observations,"artifacts":run.artifacts,"usage":run.session_usage });
    write(
        run,
        "resultado.json",
        "after",
        "report",
        "Orquestador nativo",
        &serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?,
    )?;
    for a in run.artifacts.iter().filter(|a| a.status == "captured") {
        safe_path(&run.evidence_dir, &a.relative_path, true)?;
    }
    let manifest = serde_json::to_string_pretty(
        &json!({"schemaVersion":1,"runId":run.id,"artifacts":run.artifacts}),
    )
    .map_err(|e| e.to_string())?;
    write(
        run,
        "manifest.json",
        "after",
        "report",
        "Verificación nativa de existencia",
        &manifest,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn non_git_folder_is_accepted_without_initializing_or_modifying_files() {
        let dir = std::env::temp_dir().join(format!("teams-non-git-{}", id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("user.txt"), "keep").unwrap();
        validate_folders(&[dir.to_string_lossy().into()]).unwrap();
        assert!(!dir.join(".git").exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("user.txt")).unwrap(),
            "keep"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_work_folder_is_rejected_before_a_run_is_created() {
        let dir = std::env::temp_dir().join(format!("teams-missing-{}", id()));
        let error = validate_folders(&[dir.to_string_lossy().into()]).unwrap_err();
        assert!(error.contains("no existe"));
        assert!(!dir.exists());
    }
    #[test]
    fn secrets_are_omitted() {
        let s = sanitize("ok\nAuthorization: Bearer abc\nAPI_KEY=xyz\na@b.com\nfin");
        assert!(!s.contains("abc") && !s.contains("xyz") && !s.contains("a@b.com"));
        assert!(s.contains("fin"));
    }
    #[test]
    fn traversal_is_rejected() {
        assert!(safe_path(".", "../secrets", false).is_err());
        assert!(safe_path(".", "C:\\secret", false).is_err());
    }
    #[test]
    fn baseline_preserves_dirty_index_and_distinguishes_team_diff() {
        let dir = std::env::temp_dir().join(format!("guille-teams-{}", id()));
        let repo = dir.join("repo");
        let evidence = dir.join("evidence");
        std::fs::create_dir_all(&repo).unwrap();
        let r = repo.to_str().unwrap();
        git(r, &["init"], None).unwrap();
        std::fs::write(repo.join("user.txt"), "staged\n").unwrap();
        git(r, &["add", "."], None).unwrap();
        std::fs::write(repo.join("user.txt"), "user's unstaged work\n").unwrap();
        std::fs::write(repo.join("new.txt"), "user untracked\n").unwrap();
        let before = git(r, &["diff", "--cached"], None).unwrap();
        let baseline = baseline(&[r.into()], &evidence).unwrap();
        std::fs::write(repo.join("team.txt"), "team addition\n").unwrap();
        let end = tree(r, &evidence).unwrap();
        let diff = git(
            r,
            &["diff", baseline[0]["tree"].as_str().unwrap(), &end],
            None,
        )
        .unwrap();
        assert!(diff.contains("team addition"));
        assert!(!diff.contains("user's unstaged work"));
        assert!(!diff.contains("user untracked"));
        assert_eq!(before, git(r, &["diff", "--cached"], None).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
