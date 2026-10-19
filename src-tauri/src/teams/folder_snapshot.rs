// Durable, read-only evidence for projects that do not use Git. No repository
// is created, and links/reparse points are never followed outside the project.
use super::domain::id;
use super::evidence::{safe_path, sanitize, sensitive_path};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::Path;

const MAX_FILES: usize = 10_000;
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
const MAX_TEXT: usize = 16_000;

#[derive(Serialize, Deserialize)]
struct FileState {
    hash: Option<String>,
    text: Option<String>,
    partial: bool,
    reason: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    files: BTreeMap<String, FileState>,
    complete: bool,
    notes: Vec<String>,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn excluded(path: &Path) -> bool {
    path.components().any(|c| {
        let part = c.as_os_str().to_string_lossy().to_lowercase();
        matches!(
            part.as_str(),
            ".git"
                | ".svn"
                | ".hg"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".cache"
                | ".ssh"
                | ".aws"
                | ".gnupg"
        )
    }) || sensitive_path(&path.to_string_lossy().replace('\\', "/"))
}

fn link_or_reparse(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return true;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn capture(root: &Path, evidence: &Path) -> Result<Snapshot, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let evidence = evidence.canonicalize().map_err(|e| e.to_string())?;
    let scope = root.clone();
    let mut builder = ignore::WalkBuilder::new(&root);
    builder
        .hidden(false)
        .parents(false)
        .require_git(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let path = entry.path();
            !path.starts_with(&evidence)
                && !link_or_reparse(path)
                && !excluded(path.strip_prefix(&scope).unwrap_or(path))
        });
    let mut snapshot = Snapshot {
        files: BTreeMap::new(),
        complete: true,
        notes: vec![],
    };
    let mut total: usize = 0;
    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                snapshot.complete = false;
                continue;
            }
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if snapshot.files.len() >= MAX_FILES {
            snapshot.complete = false;
            break;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("Nombre de archivo no compatible con evidencia")?
            .replace('\\', "/");
        let result = (|| -> Result<Vec<u8>, String> {
            // Check again before reading: walkers must not turn links into content.
            if link_or_reparse(path)
                || !path
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
            {
                return Err("Enlace o ruta fuera de la carpeta autorizada".into());
            }
            let length = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
            if length > MAX_FILE || total.saturating_add(length as usize) > MAX_TOTAL {
                return Err("Contenido omitido por límite de tamaño de evidencia".into());
            }
            let mut bytes = vec![];
            std::fs::File::open(path)
                .map_err(|_| "Archivo no legible".to_string())?
                .take(MAX_FILE + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "No se pudo leer el archivo".to_string())?;
            if bytes.len() as u64 > MAX_FILE {
                return Err("Archivo creció sobre el límite".into());
            }
            if link_or_reparse(path)
                || !path
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
            {
                return Err("La ruta cambió durante la captura".into());
            }
            Ok(bytes)
        })();
        let state = match result {
            Ok(bytes) => {
                total += bytes.len();
                let text = std::str::from_utf8(&bytes)
                    .ok()
                    .filter(|s| !s.contains('\0'));
                let partial = text.map(|s| s.chars().count() > MAX_TEXT).unwrap_or(false);
                FileState {
                    hash: Some(hash(&bytes)),
                    text: text.map(|s| sanitize(&s.chars().take(MAX_TEXT).collect::<String>())),
                    partial,
                    reason: None,
                }
            }
            Err(reason) => FileState {
                hash: None,
                text: None,
                partial: false,
                reason: Some(reason),
            },
        };
        snapshot.files.insert(relative, state);
    }
    if !snapshot.complete {
        snapshot.notes.push("Recorrido parcial: archivos no accesibles o límite de 10.000 archivos; no se presume que los no observados sean nuevos".into());
    }
    let omitted = snapshot
        .files
        .values()
        .filter(|f| f.reason.is_some() || f.partial)
        .count();
    if omitted > 0 {
        snapshot.notes.push(format!("{omitted} archivos con contenido omitido o parcial; no se presume que estén sin cambios"));
    }
    snapshot.notes.push("No se siguen enlaces/junctions. Se excluyen credenciales conocidas, dependencias, salidas de build y reglas .gitignore/.ignore locales. Límites: 2 MB por archivo, 64 MB leídos y 16.000 caracteres de texto por archivo".into());
    Ok(snapshot)
}

pub fn baseline(repository: &str, dir: &Path) -> Result<Value, String> {
    let snapshot = capture(Path::new(repository), dir)?;
    let relative = format!("baseline/{}.json", id());
    let path = safe_path(&dir.to_string_lossy(), &relative, false)?;
    std::fs::create_dir_all(path.parent().ok_or("Sin carpeta de snapshot")?)
        .map_err(|e| format!("No se pudo crear la carpeta de snapshot: {e}"))?;
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    // Only publish the reference after the full snapshot has reached disk.
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("No se pudo crear la instantánea temporal: {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("No se pudo sincronizar la instantánea: {e}"))?;
    drop(file);
    std::fs::rename(tmp, path).map_err(|e| format!("No se pudo publicar la instantánea: {e}"))?;
    Ok(
        json!({"repository":repository,"mode":"filesystem","snapshotPath":relative,"snapshotSha256":hash(&bytes),"capturedAt":super::domain::now(),"filesObserved":snapshot.files.len(),"limitations":snapshot.notes}),
    )
}

fn append_lines(out: &mut String, prefix: char, lines: &[&str]) {
    for line in lines {
        out.push(prefix);
        out.push_str(line);
        if !line.ends_with('\n') {
            out.push_str("\n\\ No newline at end of file\n");
        }
    }
}

fn text_diff(path: &str, before: &str, after: &str, added: bool, deleted: bool) -> String {
    let a: Vec<_> = before.split_inclusive('\n').collect();
    let b: Vec<_> = after.split_inclusive('\n').collect();
    let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start = prefix.saturating_sub(3);
    let end_a = a.len() - suffix.saturating_sub(3);
    let end_b = b.len() - suffix.saturating_sub(3);
    let mut out = format!(
        "diff --folder {path:?}\n--- {}\n+++ {}\n@@ -{},{} +{},{} @@\n",
        if added {
            "/dev/null".into()
        } else {
            format!("a/{path}")
        },
        if deleted {
            "/dev/null".into()
        } else {
            format!("b/{path}")
        },
        if a.is_empty() { 0 } else { start + 1 },
        end_a - start,
        if b.is_empty() { 0 } else { start + 1 },
        end_b - start
    );
    append_lines(&mut out, ' ', &a[start..prefix]);
    append_lines(&mut out, '-', &a[prefix..a.len() - suffix]);
    append_lines(&mut out, '+', &b[prefix..b.len() - suffix]);
    append_lines(&mut out, ' ', &a[a.len() - suffix..end_a]);
    out
}

pub fn compare(baseline: &Value, dir: &Path) -> Result<(String, String), String> {
    let repository = baseline["repository"]
        .as_str()
        .ok_or("Snapshot sin carpeta")?;
    let path = safe_path(
        &dir.to_string_lossy(),
        baseline["snapshotPath"]
            .as_str()
            .ok_or("Snapshot sin ruta")?,
        true,
    )?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if baseline["snapshotSha256"].as_str() != Some(hash(&bytes).as_str()) {
        return Err(
            "La instantánea inicial fue alterada; no se puede verificar la comparación".into(),
        );
    }
    let before: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let after = capture(Path::new(repository), dir)?;
    let mut diff = String::new();
    let mut files = String::new();
    let mut diff_truncated = false;
    let names: BTreeSet<_> = before.files.keys().chain(after.files.keys()).collect();
    for name in names {
        let a = before.files.get(name);
        let b = after.files.get(name);
        if a.and_then(|f| f.hash.as_ref()).is_some()
            && a.and_then(|f| f.hash.as_ref()) == b.and_then(|f| f.hash.as_ref())
        {
            continue;
        }
        let deleted = b.is_none()
            && std::fs::symlink_metadata(Path::new(repository).join(name))
                .err()
                .map(|e| e.kind() == std::io::ErrorKind::NotFound)
                .unwrap_or(false);
        let unavailable = a.map(|s| s.hash.is_none()).unwrap_or(!before.complete)
            || b.map(|s| s.hash.is_none()).unwrap_or(!deleted);
        let status = if unavailable {
            "?"
        } else if a.is_none() {
            "A"
        } else if deleted {
            "D"
        } else {
            "M"
        };
        files.push_str(&format!("{status}\t{name}\n"));
        if diff_truncated {
            continue;
        } else if unavailable {
            diff.push_str(&format!("No comparado {name:?}: contenido inicial/final no disponible; no se atribuye al equipo.\n"));
        } else if a.map(|s| s.partial).unwrap_or(false)
            || b.map(|s| s.partial).unwrap_or(false)
            || a.map(|s| s.text.is_none()).unwrap_or(false)
            || b.map(|s| s.text.is_none()).unwrap_or(false)
        {
            diff.push_str(&format!(
                "{status} {name:?}: contenido binario o parcial; hash inicial {:?}, final {:?}.\n",
                a.and_then(|s| s.hash.as_ref()),
                b.and_then(|s| s.hash.as_ref())
            ));
        } else if a.and_then(|s| s.text.as_deref()) == b.and_then(|s| s.text.as_deref()) {
            diff.push_str(&format!("{status} {name:?}: el contenido cambió dentro de una línea sanitizada; se conservan solo las huellas verificables.\n"));
        } else {
            diff.push_str(&text_diff(
                name,
                a.and_then(|s| s.text.as_deref()).unwrap_or(""),
                b.and_then(|s| s.text.as_deref()).unwrap_or(""),
                a.is_none(),
                deleted,
            ));
        }
        if diff.len() > super::evidence::LIMIT {
            diff.truncate(super::evidence::LIMIT);
            diff.push_str(
                "\n[comparación recortada; la lista completa permanece en archivos.json]\n",
            );
            diff_truncated = true;
        }
    }
    for note in before.notes.iter().chain(&after.notes) {
        diff.push_str(&format!("\nLímite de evidencia: {note}\n"));
    }
    Ok((sanitize(&diff), files))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("guille-folder-snapshot-{}", id()));
        let project = root.join("project");
        let evidence = root.join("evidence");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&evidence).unwrap();
        (root, project, evidence)
    }

    #[test]
    fn persists_and_compares_a_non_git_folder_without_creating_git() {
        let (root, project, evidence) = fixture();
        std::fs::write(project.join("kept.txt"), "before\n").unwrap();
        std::fs::write(project.join("deleted.txt"), "old\n").unwrap();
        std::fs::write(project.join(".env.local"), "TOKEN=private\n").unwrap();
        std::fs::write(project.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(project.join("ignored.txt"), "ignored before\n").unwrap();
        std::fs::create_dir_all(project.join("Node_Modules")).unwrap();
        std::fs::write(project.join("Node_Modules/ignored.js"), "large dependency").unwrap();
        let value = baseline(project.to_str().unwrap(), &evidence).unwrap();
        assert_eq!(value["mode"], "filesystem");
        assert!(!project.join(".git").exists());

        std::fs::write(project.join("kept.txt"), "after\n").unwrap();
        std::fs::remove_file(project.join("deleted.txt")).unwrap();
        std::fs::write(project.join("added.txt"), "new\n").unwrap();
        std::fs::write(project.join("ignored.txt"), "ignored after\n").unwrap();
        std::fs::write(project.join(".env.local"), "TOKEN=changed\n").unwrap();
        std::fs::write(
            project.join("Node_Modules/ignored.js"),
            "changed dependency",
        )
        .unwrap();
        let (diff, files) = compare(&value, &evidence).unwrap();
        assert!(diff.contains("-before") && diff.contains("+after"));
        assert!(files.contains("M\tkept.txt"));
        assert!(files.contains("D\tdeleted.txt"));
        assert!(files.contains("A\tadded.txt"));
        assert!(
            !files.contains(".env.local")
                && !files.contains("ignored.js")
                && !files.contains("ignored.txt")
        );
        assert!(!project.join(".git").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_modified_persisted_baseline() {
        let (root, project, evidence) = fixture();
        std::fs::write(project.join("file.txt"), "before\n").unwrap();
        let value = baseline(project.to_str().unwrap(), &evidence).unwrap();
        let stored = safe_path(
            &evidence.to_string_lossy(),
            value["snapshotPath"].as_str().unwrap(),
            true,
        )
        .unwrap();
        std::fs::write(stored, "{}").unwrap();
        assert!(compare(&value, &evidence).unwrap_err().contains("alterada"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_redacted_secret_changes_without_exposing_values() {
        let (root, project, evidence) = fixture();
        std::fs::write(project.join("config.txt"), "Authorization: Bearer first\n").unwrap();
        let value = baseline(project.to_str().unwrap(), &evidence).unwrap();
        std::fs::write(project.join("config.txt"), "Authorization: Bearer second\n").unwrap();
        let (diff, files) = compare(&value, &evidence).unwrap();
        assert!(files.contains("M\tconfig.txt"));
        assert!(diff.contains("línea sanitizada"));
        assert!(!diff.contains("first") && !diff.contains("second"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
