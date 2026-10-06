use crate::app_data_file;
use crate::git::{git, git_quiet, merge_in_progress, parse_commits, range_files, Commit, CommitFile, COMMIT_FORMAT};
use crate::proc::{blocking, hide_console};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static LOCK: Mutex<()> = Mutex::new(());
static EXCLUDED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

const REGISTRY: &str = "features.json";
pub(crate) const WORKTREES_DIR: &str = ".worktrees";
const GENERATED: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv",
    ".gradle", ".cache", "out", "vendor", ".pytest_cache", ".mypy_cache", "bin", "obj",
];
const MAX_COPY_DIR_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    pub run: Option<String>,
    pub setup: Option<String>,
    pub copy: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Entry {
    id: String,
    repo: String,
    path: String,
    label: String,
    branch: Option<String>,
    base: Option<String>,
    base_source: Option<String>,
    base_oid: Option<String>,
    created_at: i64,
    archived: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Registry {
    version: u32,
    features: Vec<Entry>,
    projects: HashMap<String, ProjectSettings>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicts: u32,
}

impl Changes {
    fn tracked(&self) -> u32 {
        self.staged + self.unstaged + self.conflicts
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeatureInfo {
    pub id: Option<String>,
    pub path: String,
    pub root: String,
    pub repo: String,
    pub group: Option<String>,
    pub label: String,
    pub kind: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub missing: bool,
    pub archived: bool,
    pub base: Option<String>,
    pub base_source: String,
    pub base_oid: Option<String>,
    pub created_at: Option<i64>,
    pub changes: Option<Changes>,
    pub merging: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoGroup {
    pub path: String,
    pub main: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub default_base: Option<String>,
    pub worktrees_dir: String,
    pub settings: ProjectSettings,
    pub changes: Option<Changes>,
    pub merging: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeatureList {
    pub git: bool,
    pub multi: bool,
    pub project: String,
    pub repo: String,
    pub default_base: Option<String>,
    pub worktrees_dir: String,
    pub features: Vec<FeatureInfo>,
    pub repos: Vec<RepoGroup>,
    pub settings: ProjectSettings,
}

#[derive(Default, Clone)]
struct Worktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: Option<String>,
    prunable: Option<String>,
}

struct RepoCtx {
    main: String,
    rel: String,
    worktrees: Vec<Worktree>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn long_path(path: &str) -> String {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetLongPathNameW;
    let wide = HSTRING::from(path.replace('/', "\\"));
    let needed = unsafe { GetLongPathNameW(&wide, None) } as usize;
    if needed == 0 {
        return path.to_string();
    }
    let mut buf = vec![0u16; needed];
    let len = unsafe { GetLongPathNameW(&wide, Some(&mut buf)) } as usize;
    if len == 0 || len >= needed {
        return path.to_string();
    }
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(not(windows))]
fn long_path(path: &str) -> String {
    path.to_string()
}

fn clean(path: &str) -> String {
    let path = path.trim();
    let mut p = if path.contains('~') { long_path(path) } else { path.to_string() }.replace('\\', "/");
    while p.len() > 3 && p.ends_with('/') {
        p.pop();
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        let drive = p[..1].to_uppercase();
        p = format!("{}{}", drive, &p[1..]);
    }
    p
}

fn key(path: &str) -> String {
    clean(path).to_lowercase()
}

fn same(a: &str, b: &str) -> bool {
    key(a) == key(b)
}

fn join(base: &str, rel: &str) -> String {
    if rel.is_empty() {
        return clean(base);
    }
    clean(&format!("{}/{}", clean(base), rel.trim_start_matches('/')))
}

fn relative(path: &str, root: &str) -> String {
    let p = clean(path);
    let r = clean(root);
    if p.to_lowercase() == r.to_lowercase() {
        return String::new();
    }
    let prefix = format!("{}/", r.to_lowercase());
    if p.to_lowercase().starts_with(&prefix) {
        return p[prefix.len()..].to_string();
    }
    String::new()
}

fn basename(path: &str) -> String {
    clean(path).rsplit('/').next().unwrap_or_default().to_string()
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn git_raw(cwd: &str, args: &[&str]) -> Result<(i32, String, String), String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("la carpeta no existe: {}", cwd));
    }
    let mut full: Vec<&str> = vec!["-c", "core.quotepath=false", "-c", "color.ui=false"];
    full.extend_from_slice(args);
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .args(&full)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("no se pudo ejecutar git: {}", e))?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

fn probe(cwd: &str, args: &[&str]) -> Option<String> {
    match git_raw(cwd, args) {
        Ok((0, out, _)) => Some(out),
        _ => None,
    }
}

fn load(app: &AppHandle) -> Registry {
    app_data_file(app, REGISTRY)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Registry>(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, reg: &mut Registry) -> Result<(), String> {
    reg.version = 1;
    let path = app_data_file(app, REGISTRY).ok_or("no se pudo localizar la carpeta de datos de GuilleCode")?;
    let data = serde_json::to_vec_pretty(reg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("no se pudo guardar el registro de features: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("no se pudo guardar el registro de features: {}", e))
}

fn changed(app: &AppHandle) {
    ROOTS_CACHE.lock().unwrap_or_else(|e| e.into_inner()).take();
    let _ = app.emit("features://changed", ());
}

fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for field in out.split('\0') {
        if field.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (name, value) = field.split_once(' ').unwrap_or((field, ""));
        if name == "worktree" {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree { path: clean(value), ..Default::default() });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        match name {
            "HEAD" => w.head = Some(value.to_string()),
            "branch" => w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
            "detached" => w.detached = true,
            "bare" => w.bare = true,
            "locked" => w.locked = Some(if value.is_empty() { "bloqueada".to_string() } else { value.to_string() }),
            "prunable" => w.prunable = Some(if value.is_empty() { "la carpeta ya no existe".to_string() } else { value.to_string() }),
            _ => {}
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    list
}

fn repo_ctx(project: &str) -> Result<Option<RepoCtx>, String> {
    if !Path::new(project).is_dir() {
        return Err(format!("la carpeta no existe: {}", project));
    }
    let top = match probe(project, &["rev-parse", "--show-toplevel"]) {
        Some(t) => clean(t.trim()),
        None => return Ok(None),
    };
    let rel = relative(project, &top);
    let out = git_quiet(&top, &["worktree", "list", "--porcelain", "-z"])?;
    let worktrees = parse_worktrees(&out);
    let main = worktrees.iter().find(|w| !w.bare).map(|w| w.path.clone()).unwrap_or_else(|| top.clone());
    Ok(Some(RepoCtx { main, rel, worktrees }))
}

fn require_ctx(project: &str) -> Result<RepoCtx, String> {
    repo_ctx(project)?.ok_or_else(|| "la carpeta del proyecto no es un repositorio git".to_string())
}

fn local_branch_exists(cwd: &str, branch: &str) -> bool {
    probe(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", branch)]).is_some()
}

fn default_base(main: &str) -> Option<String> {
    // A default for NEW worktrees, never evidence of an existing worktree's origin.
    probe(main, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .or_else(|| probe(main, &["symbolic-ref", "--short", "HEAD"]))
        .or_else(|| probe(main, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Default)]
struct BaseResolution {
    reference: Option<String>,
    oid: Option<String>,
    source: &'static str,
}

fn commit_oid(path: &str, reference: &str) -> Option<String> {
    if reference.is_empty() || reference.starts_with('-') {
        return None;
    }
    probe(path, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", reference)])
        .map(|s| s.trim().to_string())
}

fn named_base(path: &str, reference: &str, branch: &str) -> bool {
    if reference.starts_with('-') || reference == "HEAD" || reference == branch {
        return false;
    }
    probe(path, &["rev-parse", "--symbolic-full-name", "--verify", reference])
        .is_some_and(|r| r.trim().starts_with("refs/heads/") || r.trim().starts_with("refs/remotes/"))
}

fn base_metadata(path: &str, branch: &str) -> Option<BaseResolution> {
    let reference = probe(path, &["config", "--local", "--get", &format!("branch.{}.guillecode-base", branch)])?
        .trim().to_string();
    if reference.is_empty() {
        return None;
    }
    let oid = probe(path, &["config", "--local", "--get", &format!("branch.{}.guillecode-base-oid", branch)])
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Some(BaseResolution { reference: Some(reference), oid, source: "registered" })
}

fn write_base_metadata(path: &str, branch: &str, base: &str, oid: Option<&str>) -> Result<(), String> {
    let (code, _, error) = git_raw(path, &["config", "--local", &format!("branch.{}.guillecode-base", branch), base])?;
    if code != 0 {
        return Err(format!("no se pudo registrar la base del worktree: {}", error));
    }
    let oid_key = format!("branch.{}.guillecode-base-oid", branch);
    if let Some(oid) = oid {
        let (code, _, error) = git_raw(path, &["config", "--local", &oid_key, oid])?;
        if code != 0 {
            return Err(format!("no se pudo registrar el commit inicial: {}", error));
        }
    } else {
        let _ = probe(path, &["config", "--local", "--unset-all", &oid_key]);
    }
    Ok(())
}

fn branch_creation(path: &str, branch: &str) -> Option<(String, String)> {
    probe(path, &["reflog", "show", "--format=%H%x1f%gs", &format!("refs/heads/{}", branch)])
        .and_then(|out| out.lines().rev().find_map(|line| {
            let (oid, subject) = line.split_once('\x1f')?;
            Some((oid.to_string(), subject.strip_prefix("branch: Created from ")?.to_string()))
        }))
}

fn resolve_base(ctx: &RepoCtx, w: &Worktree, entry: Option<&Entry>) -> BaseResolution {
    if let Some(branch) = w.branch.as_deref() {
        if let Some(base) = base_metadata(&ctx.main, branch) {
            return base;
        }
    }
    // Old external entries could have had the repo default persisted by rename/archive.
    // Only a recorded creation OID or an explicit registration makes that base authoritative.
    if let Some(e) = entry.filter(|e| e.base_oid.is_some() || e.base_source.as_deref() == Some("registered")) {
        if e.base.is_some() {
            return BaseResolution { reference: e.base.clone(), oid: e.base_oid.clone(), source: "registered" };
        }
    }
    let Some(branch) = w.branch.as_deref() else {
        return BaseResolution { source: "unknown", ..Default::default() };
    };
    let creation = branch_creation(&ctx.main, branch);
    if let Some((oid, reference)) = &creation {
        if named_base(&ctx.main, reference, branch) {
            return BaseResolution { reference: Some(reference.clone()), oid: Some(oid.clone()), source: "reflog" };
        }
    }
    let upstream = probe(&ctx.main, &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{}", branch)])
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(reference) = &upstream {
        // origin/feature/foo is a publication upstream, not the parent of feature/foo.
        if reference.split_once('/').map(|(_, name)| name != branch).unwrap_or(false) && named_base(&ctx.main, reference, branch) {
            return BaseResolution { reference: Some(reference.clone()), oid: creation.map(|c| c.0), source: "upstream" };
        }
    }
    infer_base(ctx, w, creation.map(|c| c.0), upstream.as_deref())
}

fn infer_base(ctx: &RepoCtx, w: &Worktree, creation_oid: Option<String>, upstream: Option<&str>) -> BaseResolution {
    let unknown = || BaseResolution { source: "unknown", ..Default::default() };
    let Some(head) = &w.head else { return unknown() };
    let refs = probe(&ctx.main, &["for-each-ref", "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(symref)", "refs/heads", "refs/remotes"])
        .unwrap_or_default();
    let mut best = u32::MAX;
    let mut candidates: Vec<(String, String, bool)> = Vec::new();
    for line in refs.lines() {
        let fields: Vec<&str> = line.split('\x1f').collect();
        if fields.len() != 4 || !fields[3].is_empty() {
            continue;
        }
        let (reference, oid, remote) = (fields[1], fields[2], fields[0].starts_with("refs/remotes/"));
        if Some(reference) == w.branch.as_deref() || Some(reference) == upstream ||
            ctx.worktrees.iter().any(|other| !same(&other.path, &ctx.main) && other.branch.as_deref() == Some(reference)) {
            continue;
        }
        let Some(merge_base) = probe(&ctx.main, &["merge-base", reference, head]).map(|s| s.trim().to_string()) else { continue };
        let distance = count_commits(&ctx.main, &merge_base, head);
        if distance > best { continue }
        if distance < best {
            best = distance;
            candidates.clear();
        }
        candidates.push((reference.to_string(), oid.to_string(), remote));
    }
    let Some((first, first_oid, first_remote)) = candidates.first() else { return unknown() };
    let name = |reference: &str, remote: bool| if remote { reference.split_once('/').map(|(_, rest)| rest).unwrap_or(reference).to_string() } else { reference.to_string() };
    let logical = name(first, *first_remote);
    // Equivalent local/remote refs are one candidate. Distinct tips or branch names are ambiguous.
    if candidates.iter().any(|(reference, oid, remote)| name(reference, *remote) != logical || oid != first_oid) {
        return unknown();
    }
    let reference = candidates.iter().find(|(_, _, remote)| *remote).unwrap_or(&candidates[0]).0.clone();
    BaseResolution { reference: Some(reference), oid: creation_oid, source: "inferred" }
}

fn worktrees_dir(main: &str) -> String {
    join(main, WORKTREES_DIR)
}

fn is_worktrees_entry(rel: &str) -> bool {
    let rel = rel.trim_end_matches('/');
    rel == WORKTREES_DIR || rel.starts_with(&format!("{}/", WORKTREES_DIR))
}

fn ensure_excluded(main: &str) {
    let k = key(main);
    if EXCLUDED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(&k)) {
        return;
    }
    let pattern = format!("/{}/", WORKTREES_DIR);
    let ignored = matches!(git_raw(main, &["check-ignore", "-q", &format!("{}/", WORKTREES_DIR)]), Ok((0, _, _)));
    if !ignored {
        let Some(rel) = probe(main, &["rev-parse", "--git-path", "info/exclude"]) else { return };
        let rel = rel.trim();
        let file = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { Path::new(main).join(rel) };
        let current = std::fs::read_to_string(&file).unwrap_or_default();
        if !current.lines().any(|l| l.trim() == pattern) {
            if let Some(parent) = file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
            if std::fs::write(&file, format!("{}{}{}\n", current, sep, pattern)).is_err() {
                return;
            }
        }
    }
    EXCLUDED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(k);
}

fn changes_of(path: &str) -> Option<Changes> {
    let out = probe(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
    let mut c = Changes::default();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        if record.len() < 3 {
            continue;
        }
        let x = &record[..1];
        let y = &record[1..2];
        if x == "R" || x == "C" {
            records.next();
        }
        let pair = format!("{}{}", x, y);
        if pair == "??" {
            c.untracked += 1;
        } else if x == "U" || y == "U" || pair == "AA" || pair == "DD" {
            c.conflicts += 1;
        } else {
            if x != " " && x != "!" {
                c.staged += 1;
            }
            if y != " " && y != "!" {
                c.unstaged += 1;
            }
        }
    }
    Some(c)
}

fn ahead_behind(path: &str, base: &str) -> Option<(u32, u32)> {
    let out = probe(path, &["rev-list", "--left-right", "--count", &format!("{}...HEAD", base), "--"])?;
    let mut parts = out.split_whitespace();
    let behind = parts.next()?.parse().ok()?;
    let ahead = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

fn settings_of(reg: &Registry, project: &str) -> ProjectSettings {
    reg.projects.get(&key(project)).cloned().unwrap_or_default()
}

fn collect(reg: &Registry, ctx: &RepoCtx, scope: &str, group: Option<&str>, with_main: bool) -> Vec<FeatureInfo> {
    let entries: Vec<&Entry> = reg.features.iter().filter(|e| same(&e.repo, &ctx.main)).collect();
    let mut features: Vec<FeatureInfo> = Vec::new();
    for w in ctx.worktrees.iter().filter(|w| !w.bare) {
        let main = same(&w.path, &ctx.main);
        if main && !with_main {
            continue;
        }
        let entry = entries.iter().find(|e| same(&e.path, &w.path));
        let kind = if main { "main" } else if entry.is_some() { "managed" } else { "external" };
        let missing = w.prunable.is_some() || !Path::new(&w.path).is_dir();
        let base = if main { BaseResolution::default() } else { resolve_base(ctx, w, entry.copied()) };
        features.push(FeatureInfo {
            id: entry.map(|e| e.id.clone()),
            path: w.path.clone(),
            root: join(&w.path, &ctx.rel),
            repo: scope.to_string(),
            group: group.map(str::to_string),
            label: entry.map(|e| e.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| {
                if main { "Principal".to_string() } else { basename(&w.path) }
            }),
            kind: kind.to_string(),
            branch: w.branch.clone(),
            head: w.head.clone(),
            detached: w.detached,
            locked: w.locked.clone(),
            prunable: w.prunable.clone(),
            missing,
            archived: entry.map(|e| e.archived).unwrap_or(false),
            base: base.reference,
            base_source: base.source.to_string(),
            base_oid: base.oid,
            created_at: entry.map(|e| e.created_at),
            ..Default::default()
        });
    }
    let orphans: Vec<&&Entry> = entries.iter().filter(|e| !features.iter().any(|f| same(&f.path, &e.path))).collect();
    for e in orphans {
        features.push(FeatureInfo {
            id: Some(e.id.clone()),
            path: clean(&e.path),
            root: join(&e.path, &ctx.rel),
            repo: scope.to_string(),
            group: group.map(str::to_string),
            label: e.label.clone(),
            kind: "managed".to_string(),
            branch: e.branch.clone(),
            missing: true,
            archived: e.archived,
            base: e.base.clone(),
            base_source: e.base_source.clone().unwrap_or_else(|| "unknown".into()),
            base_oid: e.base_oid.clone(),
            created_at: Some(e.created_at),
            ..Default::default()
        });
    }
    features
}

fn fill_live(features: &mut [FeatureInfo], groups: &mut [RepoGroup]) {
    std::thread::scope(|scope| {
        let feature_handles: Vec<_> = features
            .iter()
            .enumerate()
            .filter(|(_, f)| !f.missing)
            .map(|(i, f)| {
                let path = f.path.clone();
                let base = if f.kind == "main" { None } else { f.base.clone() };
                scope.spawn(move || {
                    let changes = changes_of(&path);
                    let merging = merge_in_progress(&path);
                    let counts = base.and_then(|b| ahead_behind(&path, &b));
                    (i, changes, merging, counts)
                })
            })
            .collect();
        let group_handles: Vec<_> = groups
            .iter()
            .enumerate()
            .map(|(i, g)| {
                let path = g.main.clone();
                scope.spawn(move || (i, changes_of(&path), merge_in_progress(&path)))
            })
            .collect();
        for h in feature_handles {
            if let Ok((i, changes, merging, counts)) = h.join() {
                let f = &mut features[i];
                f.changes = changes;
                f.merging = merging;
                if let Some((ahead, behind)) = counts {
                    f.ahead = Some(ahead);
                    f.behind = Some(behind);
                }
            }
        }
        for h in group_handles {
            if let Ok((i, changes, merging)) = h.join() {
                groups[i].changes = changes;
                groups[i].merging = merging;
            }
        }
    });
}

fn sub_repos(project: &str) -> Vec<(String, RepoCtx)> {
    let paths = crate::git::subrepos_sync(project).unwrap_or_default();
    let found: Vec<RepoCtx> = std::thread::scope(|scope| {
        let handles: Vec<_> = paths.iter().map(|p| scope.spawn(move || repo_ctx(p).ok().flatten())).collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    });
    let mut out: Vec<(String, RepoCtx)> = Vec::new();
    for ctx in found {
        if out.iter().any(|(_, c)| same(&c.main, &ctx.main)) {
            continue;
        }
        let rel = relative(&ctx.main, project);
        let name = if rel.is_empty() { basename(&ctx.main) } else { rel };
        out.push((name, RepoCtx { rel: String::new(), ..ctx }));
    }
    out.sort_by_key(|(name, _)| name.to_lowercase());
    out
}

fn single_list(reg: &Registry, ctx: RepoCtx) -> FeatureList {
    let canonical = join(&ctx.main, &ctx.rel);
    if exists(&worktrees_dir(&ctx.main)) {
        ensure_excluded(&ctx.main);
    }
    let default = default_base(&ctx.main);
    let mut features = collect(reg, &ctx, &canonical, None, true);
    fill_live(&mut features, &mut []);
    let settings = settings_of(reg, &canonical);
    let main = features.iter().find(|f| f.kind == "main");
    let group = RepoGroup {
        path: canonical.clone(),
        main: ctx.main.clone(),
        name: basename(&canonical),
        branch: main.and_then(|f| f.branch.clone()),
        head: main.and_then(|f| f.head.clone()),
        detached: main.map(|f| f.detached).unwrap_or(false),
        default_base: default.clone(),
        worktrees_dir: worktrees_dir(&ctx.main),
        settings: settings.clone(),
        changes: main.and_then(|f| f.changes.clone()),
        merging: main.map(|f| f.merging).unwrap_or(false),
    };
    FeatureList {
        git: true,
        multi: false,
        project: canonical,
        repo: ctx.main.clone(),
        default_base: default,
        worktrees_dir: worktrees_dir(&ctx.main),
        features,
        repos: vec![group],
        settings,
    }
}

fn multi_list(reg: &Registry, project: &str) -> FeatureList {
    let project = clean(project);
    let settings = settings_of(reg, &project);
    let repos = sub_repos(&project);
    if repos.is_empty() {
        return FeatureList { git: false, project, settings, ..Default::default() };
    }
    let defaults: Vec<Option<String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = repos
            .iter()
            .map(|(_, ctx)| {
                scope.spawn(move || {
                    if exists(&worktrees_dir(&ctx.main)) {
                        ensure_excluded(&ctx.main);
                    }
                    default_base(&ctx.main)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().ok().flatten()).collect()
    });
    let mut features: Vec<FeatureInfo> = Vec::new();
    let mut groups: Vec<RepoGroup> = Vec::new();
    for ((name, ctx), default) in repos.iter().zip(defaults) {
        features.extend(collect(reg, ctx, &ctx.main, Some(name), false));
        let main = ctx.worktrees.iter().find(|w| same(&w.path, &ctx.main));
        groups.push(RepoGroup {
            path: ctx.main.clone(),
            main: ctx.main.clone(),
            name: name.clone(),
            branch: main.and_then(|w| w.branch.clone()),
            head: main.and_then(|w| w.head.clone()),
            detached: main.map(|w| w.detached).unwrap_or(false),
            default_base: default,
            worktrees_dir: worktrees_dir(&ctx.main),
            settings: settings_of(reg, &ctx.main),
            ..Default::default()
        });
    }
    fill_live(&mut features, &mut groups);
    features.insert(
        0,
        FeatureInfo {
            path: project.clone(),
            root: project.clone(),
            label: "Principal".to_string(),
            kind: "main".to_string(),
            ..Default::default()
        },
    );
    FeatureList { git: true, multi: true, project, features, repos: groups, settings, ..Default::default() }
}

pub(crate) fn build_list(app: &AppHandle, project: &str) -> Result<FeatureList, String> {
    let reg = load(app);
    Ok(match repo_ctx(project)? {
        Some(ctx) => single_list(&reg, ctx),
        None => multi_list(&reg, project),
    })
}

static ROOTS_CACHE: Mutex<Option<HashMap<String, (std::time::Instant, Vec<(String, String)>)>>> = Mutex::new(None);
const ROOTS_TTL: std::time::Duration = std::time::Duration::from_secs(20);

fn roots_of(reg: &Registry, ctx: &RepoCtx, group: Option<&str>) -> Vec<(String, String)> {
    ctx.worktrees
        .iter()
        .filter(|w| !w.bare && w.prunable.is_none() && !same(&w.path, &ctx.main) && Path::new(&w.path).is_dir())
        .filter_map(|w| {
            let entry = reg.features.iter().find(|e| same(&e.path, &w.path));
            if entry.map(|e| e.archived).unwrap_or(false) {
                return None;
            }
            let label = entry.map(|e| e.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| basename(&w.path));
            let label = match group {
                Some(g) => format!("{} · {}", g, label),
                None => label,
            };
            Some((join(&w.path, &ctx.rel), label))
        })
        .collect()
}

fn light_roots(app: &AppHandle, project: &str) -> Vec<(String, String)> {
    let reg = load(app);
    match repo_ctx(project) {
        Ok(Some(ctx)) => roots_of(&reg, &ctx, None),
        Ok(None) => sub_repos(project).iter().flat_map(|(name, ctx)| roots_of(&reg, ctx, Some(name))).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn feature_roots(app: &AppHandle, project: &str) -> Vec<(String, String)> {
    let k = key(project);
    if let Some((at, roots)) = ROOTS_CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| c.get(&k)).cloned() {
        if at.elapsed() < ROOTS_TTL {
            return roots;
        }
    }
    let roots = light_roots(app, project);
    ROOTS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(k, (std::time::Instant::now(), roots.clone()));
    roots
}

fn slugify(text: &str) -> String {
    let mut out = String::new();
    for ch in text.trim().to_lowercase().chars() {
        let mapped = match ch {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        };
        if mapped == '-' && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push(mapped);
    }
    let mut out = out.trim_matches('-').to_string();
    out.truncate(40);
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "feature".to_string()
    } else {
        out
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if !target.exists() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn dir_size(path: &Path, limit: u64) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
            if total > limit {
                return total;
            }
        }
    }
    total
}

fn copy_into(main: &str, dir: &str, files: &[String]) -> (Vec<String>, Vec<String>) {
    let mut copied = Vec::new();
    let mut skipped = Vec::new();
    for rel in files {
        let rel = rel.trim().trim_end_matches('/').replace('\\', "/");
        if rel.is_empty() || rel.split('/').any(|s| s == "..") {
            continue;
        }
        let src = PathBuf::from(join(main, &rel));
        let dst = PathBuf::from(join(dir, &rel));
        if !src.exists() {
            skipped.push(format!("{} (no existe en la principal)", rel));
            continue;
        }
        if dst.exists() {
            skipped.push(format!("{} (ya existía)", rel));
            continue;
        }
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let result = if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()) };
        match result {
            Ok(()) => copied.push(rel),
            Err(e) => skipped.push(format!("{} ({})", rel, e)),
        }
    }
    (copied, skipped)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    pub project: String,
    pub label: String,
    pub branch: String,
    pub base: String,
    #[serde(default)]
    pub existing: bool,
    #[serde(default)]
    pub copy: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    pub feature: FeatureInfo,
    pub copied: Vec<String>,
    pub skipped: Vec<String>,
}

pub(crate) fn create_sync(app: &AppHandle, args: CreateArgs) -> Result<CreateResult, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = require_ctx(&args.project)?;
    let label = args.label.trim().to_string();
    if label.is_empty() {
        return Err("poné un nombre para la feature".to_string());
    }
    let requested = args.branch.trim();
    if requested.is_empty() || requested.starts_with('-') {
        return Err("el nombre de la rama no es válido".to_string());
    }
    let branch = probe(&ctx.main, &["check-ref-format", "--branch", requested])
        .map(|b| b.trim().to_string())
        .ok_or_else(|| format!("«{}» no es un nombre de rama válido para git", requested))?;
    if let Some(w) = ctx.worktrees.iter().find(|w| w.branch.as_deref() == Some(branch.as_str())) {
        return Err(format!("la rama {} ya está abierta en {}", branch, w.path));
    }
    let branch_exists = local_branch_exists(&ctx.main, &branch);
    if branch_exists && !args.existing {
        return Err(format!("la rama {} ya existe: elegí «usar la rama existente» o cambiá el nombre", branch));
    }
    let base = args.base.trim().to_string();
    if base.is_empty() || base.starts_with('-') {
        return Err("elegí desde qué rama arranca la feature".to_string());
    }
    let base_oid = probe(&ctx.main, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", base)])
        .map(|o| o.trim().to_string())
        .ok_or_else(|| format!("no encontré la rama o commit {}", base))?;
    let container = worktrees_dir(&ctx.main);
    std::fs::create_dir_all(&container).map_err(|e| format!("no se pudo crear {}: {}", container, e))?;
    ensure_excluded(&ctx.main);
    let slug = slugify(&label);
    let mut dir = join(&container, &slug);
    let mut n = 2;
    while exists(&dir) || ctx.worktrees.iter().any(|w| same(&w.path, &dir)) {
        dir = join(&container, &format!("{}-{}", slug, n));
        n += 1;
    }
    let native = dir.replace('/', std::path::MAIN_SEPARATOR_STR);
    if branch_exists {
        git(&ctx.main, &["worktree", "add", &native, &branch])?;
    } else {
        git(&ctx.main, &["worktree", "add", "-b", &branch, &native, &base_oid])?;
    }
    let (copied, skipped) = copy_into(&ctx.main, &dir, &args.copy);
    let creation_oid = if branch_exists { branch_creation(&ctx.main, &branch).map(|c| c.0) } else { Some(base_oid) };
    write_base_metadata(&ctx.main, &branch, &base, creation_oid.as_deref())?;
    let mut reg = load(app);
    let entry = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        repo: ctx.main.clone(),
        path: dir.clone(),
        label: label.clone(),
        branch: Some(branch.clone()),
        base: Some(base.clone()),
        base_source: Some("registered".into()),
        base_oid: creation_oid.clone(),
        created_at: now_ms(),
        archived: false,
    };
    reg.features.retain(|e| !same(&e.path, &dir));
    reg.features.push(entry.clone());
    let canonical = join(&ctx.main, &ctx.rel);
    let mut settings = settings_of(&reg, &canonical);
    if settings.copy != args.copy {
        settings.copy = args.copy.clone();
        reg.projects.insert(key(&canonical), settings);
    }
    save(app, &mut reg)?;
    changed(app);
    let head = git_quiet(&dir, &["rev-parse", "HEAD"]).map(|h| h.trim().to_string()).ok();
    Ok(CreateResult {
        feature: FeatureInfo {
            id: Some(entry.id),
            path: dir.clone(),
            root: join(&dir, &ctx.rel),
            repo: canonical.clone(),
            label,
            kind: "managed".to_string(),
            branch: Some(branch),
            head,
            base: Some(base),
            base_source: "registered".into(),
            base_oid: creation_oid,
            created_at: Some(entry.created_at),
            changes: Some(Changes::default()),
            ahead: Some(0),
            behind: Some(0),
            ..Default::default()
        },
        copied,
        skipped,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub project: String,
    pub path: String,
    pub label: Option<String>,
    pub archived: Option<bool>,
    pub base: Option<String>,
    pub base_oid: Option<String>,
}

pub(crate) fn update_sync(app: &AppHandle, args: UpdateArgs) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = require_ctx(&args.project)?;
    if same(&args.path, &ctx.main) {
        return Err("la copia principal no se puede renombrar ni archivar".to_string());
    }
    let mut reg = load(app);
    let worktree = ctx.worktrees.iter().find(|w| same(&w.path, &args.path)).cloned();
    if args.base.is_some() && worktree.as_ref().map_or(true, |w| !exists(&w.path)) {
        return Err("no se puede registrar la base: la carpeta del worktree no está disponible".into());
    }
    let index = match reg.features.iter().position(|e| same(&e.path, &args.path) && same(&e.repo, &ctx.main)) {
        Some(i) => i,
        None => {
            let w = worktree.as_ref().ok_or("esa carpeta no es un worktree de este repositorio")?;
            reg.features.push(Entry {
                id: uuid::Uuid::new_v4().to_string(),
                repo: ctx.main.clone(),
                path: w.path.clone(),
                label: basename(&w.path),
                branch: w.branch.clone(),
                base: None,
                base_source: None,
                base_oid: None,
                created_at: now_ms(),
                archived: false,
            });
            reg.features.len() - 1
        }
    };
    let entry = &mut reg.features[index];
    if let Some(w) = &worktree {
        entry.branch = w.branch.clone();
    }
    if let Some(label) = args.label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()) {
        entry.label = label;
    }
    if let Some(archived) = args.archived {
        entry.archived = archived;
    }
    if let Some(base) = args.base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        commit_oid(&ctx.main, &base).ok_or_else(|| format!("no encontré la rama {}", base))?;
        let oid = match args.base_oid {
            Some(oid) => Some(commit_oid(&ctx.main, &oid).ok_or("no encontré el commit inicial")?),
            None => if entry.base.as_deref() == Some(base.as_str()) { entry.base_oid.clone() } else { None },
        };
        if let Some(branch) = entry.branch.as_deref() {
            write_base_metadata(&ctx.main, branch, &base, oid.as_deref())?;
        }
        entry.base = Some(base);
        entry.base_oid = oid;
        entry.base_source = Some("registered".into());
    }
    save(app, &mut reg)?;
    changed(app);
    Ok(())
}

fn settings_sync(app: &AppHandle, project: &str, settings: ProjectSettings) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let canonical = match repo_ctx(project)? {
        Some(ctx) => join(&ctx.main, &ctx.rel),
        None => clean(project),
    };
    let mut reg = load(app);
    let clean_text = |s: Option<String>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    reg.projects.insert(
        key(&canonical),
        ProjectSettings {
            run: clean_text(settings.run),
            setup: clean_text(settings.setup),
            copy: settings.copy.into_iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect(),
        },
    );
    save(app, &mut reg)?;
    changed(app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyCandidate {
    pub path: String,
    pub dir: bool,
    pub suggested: bool,
}

fn looks_local(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with(".env")
        || n.ends_with(".local")
        || n.contains(".local.")
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n.ends_with(".crt")
        || n.ends_with(".p12")
        || n.contains("secret")
        || n == ".npmrc"
        || n == "local.settings.json"
        || n == "appsettings.development.json"
}

fn ignored_entries(cwd: &str) -> Vec<String> {
    git_quiet(cwd, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .map(|out| out.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

fn is_generated(rel: &str) -> bool {
    rel.trim_end_matches('/').split('/').any(|seg| GENERATED.contains(&seg))
}

pub(crate) fn candidates_sync(project: &str) -> Result<Vec<CopyCandidate>, String> {
    let ctx = require_ctx(project)?;
    let mut out = Vec::new();
    for rel in ignored_entries(&ctx.main) {
        if is_generated(&rel) || is_worktrees_entry(&rel) {
            continue;
        }
        let dir = rel.ends_with('/');
        let clean_rel = rel.trim_end_matches('/').to_string();
        if dir && dir_size(Path::new(&join(&ctx.main, &clean_rel)), MAX_COPY_DIR_BYTES) > MAX_COPY_DIR_BYTES {
            continue;
        }
        let name = clean_rel.rsplit('/').next().unwrap_or(&clean_rel).to_string();
        out.push(CopyCandidate { suggested: looks_local(&name), path: clean_rel, dir });
        if out.len() >= 200 {
            break;
        }
    }
    out.sort_by(|a, b| b.suggested.cmp(&a.suggested).then(a.path.cmp(&b.path)));
    Ok(out)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCheck {
    pub main: bool,
    pub missing: bool,
    pub locked: Option<String>,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub changes: Changes,
    pub dirty: Vec<String>,
    pub unmerged: u32,
    pub merging: bool,
    pub ignored: Vec<String>,
    pub ignored_total: u32,
}

fn remove_check_sync(app: &AppHandle, project: &str, path: &str) -> Result<RemoveCheck, String> {
    let ctx = require_ctx(project)?;
    let list = build_list(app, project)?;
    let feature = list.features.iter().find(|f| same(&f.path, path)).ok_or("esa feature ya no existe")?;
    let mut check = RemoveCheck {
        main: feature.kind == "main",
        missing: feature.missing,
        locked: feature.locked.clone(),
        branch: feature.branch.clone(),
        base: feature.base.clone(),
        merging: feature.merging,
        ..Default::default()
    };
    if check.main || check.missing {
        return Ok(check);
    }
    check.changes = feature.changes.clone().unwrap_or_default();
    if let Ok(out) = git_quiet(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"]) {
        let mut records = out.split('\0');
        while let Some(record) = records.next() {
            if record.len() < 4 {
                continue;
            }
            if matches!(&record[..1], "R" | "C") {
                records.next();
            }
            if check.dirty.len() < 15 {
                check.dirty.push(record[3..].to_string());
            }
        }
    }
    if let (Some(base), Some(branch)) = (&feature.base, &feature.branch) {
        if let Some(out) = probe(&ctx.main, &["rev-list", "--count", &format!("{}..{}", base, branch), "--"]) {
            check.unmerged = out.trim().parse().unwrap_or(0);
        }
    }
    let ignored: Vec<String> = ignored_entries(path).into_iter().filter(|r| !is_generated(r)).collect();
    check.ignored_total = ignored.len() as u32;
    check.ignored = ignored.into_iter().take(15).collect();
    Ok(check)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    pub project: String,
    pub path: String,
    #[serde(default)]
    pub delete_branch: bool,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub force_branch: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub branch_deleted: bool,
    pub warning: Option<String>,
}

fn remove_sync(app: &AppHandle, args: RemoveArgs) -> Result<RemoveResult, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = require_ctx(&args.project)?;
    if same(&args.path, &ctx.main) {
        return Err("la copia principal no se elimina desde acá".to_string());
    }
    let worktree = ctx.worktrees.iter().find(|w| same(&w.path, &args.path)).cloned();
    let mut reg = load(app);
    let branch = worktree
        .as_ref()
        .and_then(|w| w.branch.clone())
        .or_else(|| reg.features.iter().find(|e| same(&e.path, &args.path)).and_then(|e| e.branch.clone()));
    match &worktree {
        Some(w) if w.locked.is_some() => {
            return Err(format!(
                "la feature está bloqueada ({}). Desbloqueala con git worktree unlock antes de eliminarla",
                w.locked.clone().unwrap_or_default()
            ));
        }
        Some(w) if w.prunable.is_none() && Path::new(&w.path).is_dir() => {
            let native = w.path.replace('/', std::path::MAIN_SEPARATOR_STR);
            let mut cmd: Vec<&str> = vec!["worktree", "remove"];
            if args.force {
                cmd.push("--force");
            }
            cmd.push(&native);
            git(&ctx.main, &cmd).map_err(|e| {
                if e.contains("contains modified or untracked files") {
                    "la feature tiene cambios sin commitear o archivos nuevos: commitealos o eliminá forzando".to_string()
                } else {
                    e
                }
            })?;
        }
        _ => {
            git(&ctx.main, &["worktree", "prune"])?;
        }
    }
    let mut result = RemoveResult::default();
    if args.delete_branch {
        if let Some(branch) = branch {
            let flag = if args.force_branch { "-D" } else { "-d" };
            match git(&ctx.main, &["branch", flag, &branch]) {
                Ok(_) => result.branch_deleted = true,
                Err(e) => {
                    result.warning = Some(if e.contains("not fully merged") {
                        format!("la carpeta se eliminó, pero la rama {} tiene commits sin integrar y se conservó", branch)
                    } else {
                        format!("la carpeta se eliminó, pero no se pudo borrar la rama {}: {}", branch, e)
                    });
                }
            }
        }
    }
    reg.features.retain(|e| !same(&e.path, &args.path));
    save(app, &mut reg)?;
    changed(app);
    Ok(result)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub source: String,
    pub source_head: String,
    pub target: String,
    pub target_head: String,
    pub target_checkout: Option<String>,
    pub target_changes: Option<Changes>,
    pub target_merging: bool,
    pub source_changes: Changes,
    pub commits: Vec<Commit>,
    pub total_commits: u32,
    pub stat: String,
    pub conflicts: Vec<String>,
    pub up_to_date: bool,
    pub fast_forward: bool,
}

fn rev(cwd: &str, refname: &str) -> Result<String, String> {
    probe(cwd, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", refname)])
        .map(|o| o.trim().to_string())
        .ok_or_else(|| format!("no encontré {}", refname))
}

fn is_ancestor(cwd: &str, a: &str, b: &str) -> bool {
    matches!(git_raw(cwd, &["merge-base", "--is-ancestor", a, b]), Ok((0, _, _)))
}

fn conflicts_between(cwd: &str, target: &str, source: &str) -> Result<(Option<String>, Vec<String>), String> {
    let (code, out, err) = git_raw(cwd, &["merge-tree", "--write-tree", "--name-only", "--no-messages", target, source])?;
    let mut lines = out.lines();
    let tree = lines.next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    match code {
        0 => Ok((tree, Vec::new())),
        1 => Ok((None, lines.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())),
        _ => Err(if err.is_empty() { "git merge-tree falló".to_string() } else { err }),
    }
}

fn preview_sync(project: &str, source_path: &str, target: &str) -> Result<MergePreview, String> {
    let ctx = require_ctx(project)?;
    let source = ctx
        .worktrees
        .iter()
        .find(|w| same(&w.path, source_path))
        .ok_or("esa feature ya no existe")?;
    let source_branch = source.branch.clone().ok_or("la feature está en HEAD detached: creá una rama antes de integrarla")?;
    if source_branch == target {
        return Err("el origen y el destino son la misma rama".to_string());
    }
    if !local_branch_exists(&ctx.main, target) {
        return Err(format!("la rama destino {} no existe localmente", target));
    }
    let source_head = rev(&ctx.main, &source_branch)?;
    let target_head = rev(&ctx.main, target)?;
    let target_checkout = ctx.worktrees.iter().find(|w| w.branch.as_deref() == Some(target)).map(|w| w.path.clone());
    let range = format!("{}..{}", target_head, source_head);
    let total_commits = git_quiet(&ctx.main, &["rev-list", "--count", &range, "--"])
        .map(|o| o.trim().parse().unwrap_or(0))
        .unwrap_or(0);
    let commits = git_quiet(&ctx.main, &["log", "--topo-order", "--decorate=full", COMMIT_FORMAT, "-n", "50", &range, "--"])
        .map(|o| parse_commits(&o))
        .unwrap_or_default();
    let stat = git_quiet(&ctx.main, &["diff", "--stat", "--no-ext-diff", &format!("{}...{}", target_head, source_head), "--"])
        .unwrap_or_default();
    let up_to_date = is_ancestor(&ctx.main, &source_head, &target_head);
    let fast_forward = !up_to_date && is_ancestor(&ctx.main, &target_head, &source_head);
    let conflicts = if up_to_date { Vec::new() } else { conflicts_between(&ctx.main, &target_head, &source_head)?.1 };
    Ok(MergePreview {
        source: source_branch,
        source_head,
        target: target.to_string(),
        target_head,
        target_changes: target_checkout.as_deref().and_then(changes_of),
        target_merging: target_checkout.as_deref().map(merge_in_progress).unwrap_or(false),
        target_checkout,
        source_changes: changes_of(source_path).unwrap_or_default(),
        commits,
        total_commits,
        stat,
        conflicts,
        up_to_date,
        fast_forward,
    })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub status: String,
    pub head: Option<String>,
    pub checkout: Option<String>,
    pub conflicts: Vec<String>,
}

fn merge_in(checkout: &str, refname: &str, message: Option<&str>) -> Result<MergeResult, String> {
    let mut args: Vec<&str> = vec!["merge"];
    match message {
        Some(m) => {
            args.push("--no-ff");
            args.push("-m");
            args.push(m);
        }
        None => args.push("--no-edit"),
    }
    args.push(refname);
    let (code, out, err) = git_raw(checkout, &args)?;
    if code == 0 {
        let status = if out.contains("Already up to date") { "up_to_date" } else { "merged" };
        return Ok(MergeResult {
            status: status.to_string(),
            head: git_quiet(checkout, &["rev-parse", "HEAD"]).map(|h| h.trim().to_string()).ok(),
            checkout: Some(clean(checkout)),
            conflicts: Vec::new(),
        });
    }
    if merge_in_progress(checkout) {
        let files = git_quiet(checkout, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        return Ok(MergeResult {
            status: "conflicts".to_string(),
            head: None,
            checkout: Some(clean(checkout)),
            conflicts: files.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        });
    }
    Err(if err.is_empty() { out.trim().to_string() } else { err })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeArgs {
    pub project: String,
    pub source_path: String,
    pub target: String,
    pub expected_source: String,
    pub expected_target: String,
    pub message: String,
}

fn merge_sync(app: &AppHandle, args: MergeArgs) -> Result<MergeResult, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let preview = preview_sync(&args.project, &args.source_path, &args.target)?;
    if preview.source_head != args.expected_source || preview.target_head != args.expected_target {
        return Err("las ramas cambiaron desde la vista previa: revisala de nuevo antes de integrar".to_string());
    }
    if preview.source_changes.tracked() > 0 {
        return Err("la feature tiene cambios sin commitear: commitealos o descartalos antes de integrar".to_string());
    }
    if preview.up_to_date {
        return Ok(MergeResult { status: "up_to_date".to_string(), ..Default::default() });
    }
    let message = if args.message.trim().is_empty() {
        format!("Merge {} into {}", preview.source, preview.target)
    } else {
        args.message.trim().to_string()
    };
    let ctx = require_ctx(&args.project)?;
    let result = match &preview.target_checkout {
        Some(checkout) => {
            if preview.target_merging {
                return Err(format!("{} ya tiene un merge en curso: terminalo o abortalo primero", checkout));
            }
            if preview.target_changes.as_ref().map(|c| c.tracked()).unwrap_or(0) > 0 {
                return Err(format!(
                    "la rama {} está abierta en {} con cambios sin commitear: commitealos o guardalos en stash antes de integrar",
                    preview.target, checkout
                ));
            }
            merge_in(checkout, &preview.source, Some(&message))?
        }
        None => {
            let (tree, conflicts) = conflicts_between(&ctx.main, &preview.target_head, &preview.source_head)?;
            match tree {
                Some(tree) if conflicts.is_empty() => {
                    let commit = git_quiet(
                        &ctx.main,
                        &["commit-tree", &tree, "-p", &preview.target_head, "-p", &preview.source_head, "-m", &message],
                    )?
                    .trim()
                    .to_string();
                    git(
                        &ctx.main,
                        &[
                            "update-ref",
                            "-m",
                            &format!("guillecode: merge {}", preview.source),
                            &format!("refs/heads/{}", preview.target),
                            &commit,
                            &preview.target_head,
                        ],
                    )?;
                    MergeResult { status: "merged".to_string(), head: Some(commit), checkout: None, conflicts: Vec::new() }
                }
                _ => MergeResult { status: "conflicts".to_string(), head: None, checkout: None, conflicts },
            }
        }
    };
    changed(app);
    Ok(result)
}

fn update_from_base_sync(app: &AppHandle, project: &str, path: &str) -> Result<MergeResult, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let list = build_list(app, project)?;
    let feature = list.features.iter().find(|f| same(&f.path, path)).ok_or("esa feature ya no existe")?;
    if feature.kind == "main" {
        return Err("la copia principal no tiene una base de la que actualizarse".to_string());
    }
    let base = feature.base.clone().ok_or("la feature no tiene rama base: definila primero")?;
    if feature.merging {
        return Err("ya hay un merge en curso en esta feature: terminalo o abortalo primero".to_string());
    }
    if feature.changes.as_ref().map(|c| c.tracked()).unwrap_or(0) > 0 {
        return Err("la feature tiene cambios sin commitear: commitealos antes de traer la base".to_string());
    }
    let result = merge_in(path, &base, None)?;
    changed(app);
    Ok(result)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDiff {
    pub base: Option<String>,
    pub merge_base: Option<String>,
    pub head: Option<String>,
    pub commits: u32,
    pub files: Vec<CommitFile>,
}

fn count_commits(cwd: &str, from: &str, to: &str) -> u32 {
    probe(cwd, &["rev-list", "--count", &format!("{}..{}", from, to), "--"])
        .and_then(|c| c.trim().parse().ok())
        .unwrap_or(0)
}

fn diff_sync(app: &AppHandle, project: &str, path: &str, comparison: Option<&str>) -> Result<FeatureDiff, String> {
    // Inspect only this checkout: a comparison must not poll every repo/worktree in the project.
    let ctx = require_ctx(project)?;
    let w = ctx.worktrees.iter().find(|w| same(&w.path, path)).ok_or("esa feature ya no existe")?;
    if w.prunable.is_some() || !exists(&w.path) {
        return Err("la carpeta de esta feature ya no existe".to_string());
    }
    let reg = load(app);
    let entry = reg.features.iter().find(|e| same(&e.path, path) && same(&e.repo, &ctx.main));
    let base = if comparison.is_none() { resolve_base(&ctx, w, entry).reference } else { None };
    diff_for(&FeatureInfo { path: w.path.clone(), base, ..Default::default() }, comparison)
}

fn diff_for(feature: &FeatureInfo, comparison: Option<&str>) -> Result<FeatureDiff, String> {
    let path = &feature.path;
    let base = comparison.map(str::to_string).or_else(|| feature.base.clone());
    let mut out = FeatureDiff { base: base.clone(), ..Default::default() };
    let Some(base) = base else { return Ok(out) };
    commit_oid(path, &base).ok_or_else(|| format!("la referencia base {} no está disponible; actualizá las referencias del repositorio", base))?;
    let Some(head) = probe(path, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).map(|h| h.trim().to_string()) else {
        return Ok(out);
    };
    let merge_base = probe(path, &["merge-base", &base, &head]).map(|m| m.trim().to_string())
        .ok_or_else(|| format!("{} y la rama del worktree no tienen un ancestro común", base))?;
    out.commits = count_commits(path, &merge_base, &head);
    out.files = range_files(path, &merge_base, &head)?;
    out.merge_base = Some(merge_base);
    out.head = Some(head);
    Ok(out)
}

#[tauri::command]
pub async fn features_diff(app: AppHandle, project: String, path: String, base: Option<String>) -> Result<FeatureDiff, String> {
    blocking(move || diff_sync(&app, &project, &path, base.as_deref())).await
}

#[tauri::command]
pub async fn features_list(app: AppHandle, project: String) -> Result<FeatureList, String> {
    blocking(move || build_list(&app, &project)).await
}

#[tauri::command]
pub async fn features_create(app: AppHandle, args: CreateArgs) -> Result<CreateResult, String> {
    blocking(move || create_sync(&app, args)).await
}

#[tauri::command]
pub async fn features_update(app: AppHandle, args: UpdateArgs) -> Result<(), String> {
    blocking(move || update_sync(&app, args)).await
}

#[tauri::command]
pub async fn features_set_settings(app: AppHandle, project: String, settings: ProjectSettings) -> Result<(), String> {
    blocking(move || settings_sync(&app, &project, settings)).await
}

#[tauri::command]
pub async fn features_copy_candidates(project: String) -> Result<Vec<CopyCandidate>, String> {
    blocking(move || candidates_sync(&project)).await
}

#[tauri::command]
pub async fn features_remove_check(app: AppHandle, project: String, path: String) -> Result<RemoveCheck, String> {
    blocking(move || remove_check_sync(&app, &project, &path)).await
}

#[tauri::command]
pub async fn features_remove(app: AppHandle, args: RemoveArgs) -> Result<RemoveResult, String> {
    blocking(move || remove_sync(&app, args)).await
}

#[tauri::command]
pub async fn features_merge_preview(project: String, source_path: String, target: String) -> Result<MergePreview, String> {
    blocking(move || preview_sync(&project, &source_path, &target)).await
}

#[tauri::command]
pub async fn features_merge(app: AppHandle, args: MergeArgs) -> Result<MergeResult, String> {
    blocking(move || merge_sync(&app, args)).await
}

#[tauri::command]
pub async fn features_update_from_base(app: AppHandle, project: String, path: String) -> Result<MergeResult, String> {
    blocking(move || update_from_base_sync(&app, &project, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let out = "worktree C:/repo\0HEAD abc\0branch refs/heads/main\0\0worktree C:/wt/demo\0HEAD def\0detached\0locked\0\0worktree C:/wt/gone\0HEAD 123\0branch refs/heads/feature/x\0prunable gitdir file points to non-existent location\0\0";
        let list = parse_worktrees(out);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert!(list[1].detached);
        assert_eq!(list[1].locked.as_deref(), Some("bloqueada"));
        assert_eq!(list[2].branch.as_deref(), Some("feature/x"));
        assert!(list[2].prunable.is_some());
    }

    #[test]
    fn slugs_are_ascii_and_short() {
        assert_eq!(slugify("Autenticación con Google"), "autenticacion-con-google");
        assert_eq!(slugify("  ¿¿??  "), "feature");
        assert!(slugify(&"a".repeat(80)).len() <= 40);
    }

    #[test]
    fn relative_paths_ignore_case_and_separators() {
        assert_eq!(relative("c:\\Repo\\apps\\web", "C:/repo"), "apps/web");
        assert_eq!(relative("C:/repo", "C:/repo/"), "");
        assert_eq!(join("C:/wt/demo", "apps/web"), "C:/wt/demo/apps/web");
        assert_eq!(worktrees_dir("C:/code/guillecode"), "C:/code/guillecode/.worktrees");
        assert!(is_worktrees_entry(".worktrees/"));
        assert!(is_worktrees_entry(".worktrees/login/.env"));
        assert!(!is_worktrees_entry(".worktrees-viejos/"));
    }

    fn init_repo(path: &str) {
        std::fs::create_dir_all(path).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            git_raw(path, &args).unwrap();
        }
        std::fs::write(join(path, "a.txt"), "uno\n").unwrap();
        git_raw(path, &["add", "."]).unwrap();
        git_raw(path, &["commit", "-qm", "init"]).unwrap();
    }

    #[test]
    fn worktrees_inside_the_repo_are_excluded_from_its_status() {
        let dir = tempdir::Dir::new();
        let main = join(&dir.path, "repo");
        init_repo(&main);
        git_raw(&main, &["worktree", "add", "-q", "-b", "feature/a", &join(&worktrees_dir(&main), "a")]).unwrap();
        assert_eq!(changes_of(&main).unwrap().untracked, 1);
        ensure_excluded(&main);
        assert_eq!(changes_of(&main).unwrap().untracked, 0);
        let exclude = std::fs::read_to_string(join(&main, ".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == "/.worktrees/").count(), 1);
        assert!(ignored_entries(&main).iter().all(|r| is_worktrees_entry(r)));
    }

    #[test]
    fn folder_with_several_repos_lists_each_repo_and_its_worktrees() {
        let dir = tempdir::Dir::new();
        let back = join(&dir.path, "v2backend");
        let gql = join(&dir.path, "v2GQL");
        init_repo(&back);
        init_repo(&gql);
        let release = join(&worktrees_dir(&gql), "gql-release");
        git_raw(&gql, &["worktree", "add", "-q", "-b", "codex/gql-release", &release]).unwrap();
        std::fs::write(join(&gql, "b.txt"), "x\n").unwrap();

        let list = multi_list(&Registry::default(), &dir.path);
        assert!(list.git && list.multi);
        assert_eq!(list.repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["v2backend", "v2GQL"]);
        assert_eq!(list.repos[1].branch.as_deref(), Some("main"));
        assert_eq!(list.repos[1].changes.as_ref().map(|c| c.untracked), Some(1));
        assert_eq!(list.repos[1].worktrees_dir, worktrees_dir(&gql));
        assert_eq!(list.features.len(), 2);
        assert_eq!((list.features[0].kind.as_str(), key(&list.features[0].root)), ("main", key(&dir.path)));
        let f = &list.features[1];
        assert_eq!((f.kind.as_str(), f.group.as_deref(), f.branch.as_deref()), ("external", Some("v2GQL"), Some("codex/gql-release")));
        assert_eq!(key(&f.repo), key(&gql));
        assert_eq!(key(&f.root), key(&release));
        assert_eq!(f.base.as_deref(), Some("main"));

        let roots: Vec<String> = sub_repos(&dir.path).iter().flat_map(|(name, ctx)| roots_of(&Registry::default(), ctx, Some(name))).map(|(_, l)| l).collect();
        assert_eq!(roots, vec!["v2GQL · gql-release".to_string()]);
        assert_eq!(key(&require_ctx(&f.repo).unwrap().main), key(&gql));
    }

    #[test]
    fn folder_without_repos_has_no_features() {
        let dir = tempdir::Dir::new();
        std::fs::create_dir_all(join(&dir.path, "docs")).unwrap();
        let list = multi_list(&Registry::default(), &dir.path);
        assert!(!list.git && !list.multi && list.features.is_empty());
    }

    fn repo_with_feature() -> (tempdir::Dir, String, String) {
        let dir = tempdir::Dir::new();
        let main = join(&dir.path, "repo");
        std::fs::create_dir_all(&main).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            git_raw(&main, &args).unwrap();
        }
        std::fs::write(join(&main, "a.txt"), "uno\n").unwrap();
        git_raw(&main, &["add", "."]).unwrap();
        git_raw(&main, &["commit", "-qm", "init"]).unwrap();
        let wt = join(&dir.path, "wt");
        git_raw(&main, &["worktree", "add", "-q", "-b", "feature/a", &wt]).unwrap();
        (dir, main, wt)
    }

    mod tempdir {
        pub struct Dir {
            pub path: String,
        }
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("guillecode-features-{}", uuid::Uuid::new_v4().simple()));
                std::fs::create_dir_all(&path).unwrap();
                Dir { path: super::clean(&path.to_string_lossy()) }
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    #[test]
    fn preview_detects_conflicts_and_clean_merges() {
        let (_dir, main, wt) = repo_with_feature();
        std::fs::write(join(&wt, "b.txt"), "nuevo\n").unwrap();
        git_raw(&wt, &["add", "."]).unwrap();
        git_raw(&wt, &["commit", "-qm", "b"]).unwrap();
        let clean_preview = preview_sync(&main, &wt, "main").unwrap();
        assert!(clean_preview.conflicts.is_empty());
        assert!(clean_preview.fast_forward);
        assert_eq!(clean_preview.total_commits, 1);

        std::fs::write(join(&wt, "a.txt"), "feature\n").unwrap();
        git_raw(&wt, &["commit", "-qam", "a en feature"]).unwrap();
        std::fs::write(join(&main, "a.txt"), "main\n").unwrap();
        git_raw(&main, &["commit", "-qam", "a en main"]).unwrap();
        let conflicted = preview_sync(&main, &wt, "main").unwrap();
        assert_eq!(conflicted.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(conflicted.target_checkout.as_deref().map(key), Some(key(&main)));
    }

    #[cfg(windows)]
    fn short_path(path: &str) -> String {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::GetShortPathNameW;
        let wide = HSTRING::from(path.replace('/', "\\"));
        let mut buf = vec![0u16; 1024];
        let len = unsafe { GetShortPathNameW(&wide, Some(&mut buf)) } as usize;
        String::from_utf16_lossy(&buf[..len])
    }

    #[cfg(windows)]
    #[test]
    fn short_windows_paths_find_their_worktrees() {
        let (_dir, main, wt) = repo_with_feature();
        let (short_main, short_wt) = (short_path(&main), short_path(&wt));
        if !short_main.contains('~') {
            return;
        }
        assert_eq!(key(&short_wt), key(&wt));
        assert_eq!(relative(&short_main, &main), "");
        std::fs::write(join(&wt, "b.txt"), "nuevo\n").unwrap();
        git_raw(&wt, &["add", "."]).unwrap();
        git_raw(&wt, &["commit", "-qm", "b"]).unwrap();
        let preview = preview_sync(&short_main, &short_wt, "main").unwrap();
        assert_eq!(preview.total_commits, 1);
        assert_eq!(require_ctx(&short_wt).unwrap().rel, "");
    }

    #[test]
    fn merge_in_checkout_reports_conflicts_and_keeps_merge_state() {
        let (_dir, main, wt) = repo_with_feature();
        std::fs::write(join(&wt, "a.txt"), "feature\n").unwrap();
        git_raw(&wt, &["commit", "-qam", "feature"]).unwrap();
        std::fs::write(join(&main, "a.txt"), "main\n").unwrap();
        git_raw(&main, &["commit", "-qam", "main"]).unwrap();
        let result = merge_in(&main, "feature/a", Some("merge")).unwrap();
        assert_eq!(result.status, "conflicts");
        assert_eq!(result.conflicts, vec!["a.txt".to_string()]);
        assert!(merge_in_progress(&main));
        git_raw(&main, &["merge", "--abort"]).unwrap();
        assert!(!merge_in_progress(&main));
    }

    #[test]
    fn range_files_lists_what_the_feature_changed_since_its_base() {
        let (_dir, main, wt) = repo_with_feature();
        std::fs::write(join(&wt, "nuevo.txt"), "x\n").unwrap();
        std::fs::write(join(&wt, "a.txt"), "dos\n").unwrap();
        git_raw(&wt, &["add", "."]).unwrap();
        git_raw(&wt, &["commit", "-qm", "feature"]).unwrap();
        std::fs::write(join(&main, "otro.txt"), "main\n").unwrap();
        git_raw(&main, &["add", "."]).unwrap();
        git_raw(&main, &["commit", "-qm", "main avanza"]).unwrap();
        let base = probe(&wt, &["merge-base", "main", "HEAD"]).unwrap().trim().to_string();
        let mut files: Vec<(String, String)> = range_files(&wt, &base, "HEAD").unwrap().into_iter().map(|f| (f.status, f.path)).collect();
        files.sort();
        assert_eq!(files, vec![("A".to_string(), "nuevo.txt".to_string()), ("M".to_string(), "a.txt".to_string())]);
    }

    #[test]
    fn commit_count_survives_long_windows_paths() {
        let dir = tempdir::Dir::new();
        let deep = join(&dir.path, &"carpeta-larga-".repeat(7));
        std::fs::create_dir_all(&deep).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "t@t"], vec!["config", "user.name", "t"]] {
            git_raw(&deep, &args).unwrap();
        }
        for n in ["uno", "dos"] {
            std::fs::write(join(&deep, "a.txt"), n).unwrap();
            git_raw(&deep, &["add", "."]).unwrap();
            git_raw(&deep, &["commit", "-qm", n]).unwrap();
        }
        let first = probe(&deep, &["rev-parse", "HEAD~1"]).unwrap().trim().to_string();
        let head = probe(&deep, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert!(deep.len() + first.len() + head.len() + 2 > 260);
        assert_eq!(count_commits(&deep, &first, &head), 1);
    }

    #[test]
    fn changes_count_staged_unstaged_and_untracked() {
        let (_dir, _main, wt) = repo_with_feature();
        std::fs::write(join(&wt, "a.txt"), "cambio\n").unwrap();
        std::fs::write(join(&wt, "nuevo.txt"), "x\n").unwrap();
        std::fs::write(join(&wt, "staged.txt"), "y\n").unwrap();
        git_raw(&wt, &["add", "staged.txt"]).unwrap();
        let c = changes_of(&wt).unwrap();
        assert_eq!((c.staged, c.unstaged, c.untracked, c.conflicts), (1, 1, 1, 0));
    }

    fn run(path: &str, args: &[&str]) {
        let (code, _, error) = git_raw(path, args).unwrap();
        assert_eq!(code, 0, "git {:?}: {}", args, error);
    }

    fn develop_repo() -> (tempdir::Dir, String, String, String) {
        let dir = tempdir::Dir::new();
        let main = join(&dir.path, "repo");
        init_repo(&main);
        run(&main, &["remote", "add", "origin", &main]);
        run(&main, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run(&main, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        run(&main, &["checkout", "-qb", "develop"]);
        std::fs::write(join(&main, "develop-only.txt"), "desarrollo\n").unwrap();
        run(&main, &["add", "."]);
        run(&main, &["commit", "-qm", "develop"]);
        let origin = commit_oid(&main, "HEAD").unwrap();
        run(&main, &["update-ref", "refs/remotes/origin/develop", &origin]);
        run(&main, &["branch", "--set-upstream-to=origin/develop", "develop"]);
        let wt = join(&worktrees_dir(&main), "login");
        (dir, main, wt, origin)
    }

    #[test]
    fn external_worktree_keeps_origin_develop_and_only_its_own_changes() {
        let (_dir, main, wt, origin) = develop_repo();
        // Local develop differs from origin/develop, and origin/HEAD still points to main.
        std::fs::write(join(&main, "local-only.txt"), "local\n").unwrap();
        run(&main, &["add", "."]);
        run(&main, &["commit", "-qm", "develop local avanza"]);
        assert_eq!(default_base(&main).as_deref(), Some("origin/develop"));
        run(&main, &["worktree", "add", "-qb", "feature/login", &wt, "origin/develop"]);
        std::fs::write(join(&wt, "login.txt"), "login\n").unwrap();
        run(&wt, &["add", "login.txt"]);
        run(&wt, &["commit", "-qm", "login"]);
        std::fs::write(join(&wt, "a.txt"), "pendiente\n").unwrap();
        std::fs::write(join(&wt, "nuevo.txt"), "nuevo\n").unwrap();
        std::fs::write(join(&wt, "staged.txt"), "stage\n").unwrap();
        run(&wt, &["add", "staged.txt"]);

        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.kind, "external");
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert_eq!(feature.base_source, "reflog");
        assert_eq!(feature.base_oid.as_deref(), Some(origin.as_str()));
        let changes = feature.changes.as_ref().unwrap();
        assert_eq!((changes.staged, changes.unstaged, changes.untracked), (1, 1, 1));
        let head_before = commit_oid(&wt, "HEAD");
        let index_before = probe(&wt, &["diff", "--cached", "--name-only", "--"]);
        let diff = diff_for(feature, None).unwrap();
        assert_eq!(diff.commits, 1);
        assert_eq!(diff.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["login.txt"]);
        let alternate = diff_for(feature, Some("origin/main")).unwrap();
        assert!(alternate.files.iter().any(|f| f.path == "develop-only.txt"));
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert_eq!(commit_oid(&wt, "HEAD"), head_before);
        assert_eq!(probe(&wt, &["diff", "--cached", "--name-only", "--"]), index_before);
        assert_eq!(probe(&main, &["symbolic-ref", "--short", "HEAD"]).unwrap().trim(), "develop");
    }

    #[test]
    fn registered_base_survives_publication_upstream_and_remote_advances() {
        let (_dir, main, wt, origin) = develop_repo();
        run(&main, &["worktree", "add", "--no-track", "-qb", "feature/login", &wt, &origin]);
        write_base_metadata(&main, "feature/login", "origin/develop", Some(&origin)).unwrap();
        std::fs::write(join(&wt, "login.txt"), "login\n").unwrap();
        run(&wt, &["add", "."]);
        run(&wt, &["commit", "-qm", "login"]);
        let head = commit_oid(&wt, "HEAD").unwrap();
        run(&main, &["update-ref", "refs/remotes/origin/feature/login", &head]);
        run(&wt, &["branch", "--set-upstream-to=origin/feature/login"]);
        std::fs::write(join(&main, "base-new.txt"), "base nueva\n").unwrap();
        run(&main, &["add", "."]);
        run(&main, &["commit", "-qm", "avanza develop"]);
        run(&main, &["update-ref", "refs/remotes/origin/develop", "HEAD"]);
        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert_eq!(feature.base_source, "registered");
        assert_eq!(feature.base_oid.as_deref(), Some(origin.as_str()));
        assert_eq!(diff_for(feature, None).unwrap().files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["login.txt"]);
    }

    #[test]
    fn external_worktree_can_infer_develop_without_a_named_creation_ref() {
        let (_dir, main, wt, origin) = develop_repo();
        run(&main, &["worktree", "add", "--no-track", "-qb", "feature/login", &wt, &origin]);
        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert_eq!(feature.base_source, "inferred");
    }

    #[test]
    fn ambiguous_external_origin_is_unknown_instead_of_defaulting_to_main() {
        let (_dir, main, wt) = repo_with_feature();
        run(&main, &["branch", "develop", "main"]);
        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert!(feature.base.is_none());
        assert_eq!(feature.base_source, "unknown");
        assert!(diff_for(feature, None).unwrap().base.is_none());
    }

    #[test]
    fn legacy_auto_registered_main_does_not_override_the_actual_origin() {
        let (_dir, main, wt, _) = develop_repo();
        run(&main, &["worktree", "add", "-qb", "feature/login", &wt, "origin/develop"]);
        let mut reg = Registry::default();
        reg.features.push(Entry { repo: main.clone(), path: wt.clone(), branch: Some("feature/login".into()), base: Some("main".into()), ..Default::default() });
        let list = single_list(&reg, require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert_eq!(feature.base_source, "reflog");
    }

    #[test]
    fn publication_upstream_is_not_used_as_the_comparison_base() {
        let (_dir, main, wt) = repo_with_feature();
        run(&main, &["remote", "add", "origin", &main]);
        std::fs::write(join(&wt, "login.txt"), "login\n").unwrap();
        run(&wt, &["add", "."]);
        run(&wt, &["commit", "-qm", "login"]);
        run(&wt, &["update-ref", "refs/remotes/origin/feature/a", "HEAD"]);
        run(&wt, &["branch", "--set-upstream-to=origin/feature/a"]);
        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.base.as_deref(), Some("main"));
        assert_eq!(diff_for(feature, None).unwrap().commits, 1);
    }

    #[test]
    fn deleted_registered_base_returns_an_error_instead_of_an_empty_diff() {
        let (_dir, main, wt, origin) = develop_repo();
        run(&main, &["worktree", "add", "--no-track", "-qb", "feature/login", &wt, &origin]);
        write_base_metadata(&main, "feature/login", "origin/develop", Some(&origin)).unwrap();
        run(&main, &["update-ref", "-d", "refs/remotes/origin/develop"]);
        let list = single_list(&Registry::default(), require_ctx(&main).unwrap());
        let feature = list.features.iter().find(|f| same(&f.path, &wt)).unwrap();
        assert_eq!(feature.base.as_deref(), Some("origin/develop"));
        assert!(diff_for(feature, None).err().unwrap().contains("no está disponible"));
    }
}
