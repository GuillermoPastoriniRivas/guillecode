use crate::app_data_file;
use crate::git::{git, git_quiet, merge_in_progress, parse_commits, range_files, Commit, CommitFile, COMMIT_FORMAT};
use crate::proc::{blocking, hide_console};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static LOCK: Mutex<()> = Mutex::new(());

const REGISTRY: &str = "features.json";
const WORKTREES_DIR: &str = ".guillecode-worktrees";
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
    pub base_oid: Option<String>,
    pub created_at: Option<i64>,
    pub changes: Option<Changes>,
    pub merging: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeatureList {
    pub git: bool,
    pub project: String,
    pub repo: String,
    pub default_base: Option<String>,
    pub worktrees_dir: String,
    pub features: Vec<FeatureInfo>,
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
    let remote = probe(main, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            ["origin/main", "origin/master", "main", "master"]
                .iter()
                .find(|c| probe(main, &["rev-parse", "--verify", "--quiet", c]).is_some())
                .map(|c| c.to_string())
        })
        .or_else(|| probe(main, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).filter(|s| s != "HEAD"))?;
    let local = remote.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| remote.clone());
    if local_branch_exists(main, &local) {
        Some(local)
    } else {
        Some(remote)
    }
}

fn worktrees_dir(main: &str) -> String {
    let main = clean(main);
    let parent = Path::new(&main).parent().map(|p| clean(&p.to_string_lossy())).unwrap_or_else(|| main.clone());
    join(&join(&parent, WORKTREES_DIR), &basename(&main))
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

fn build_list(app: &AppHandle, project: &str) -> Result<FeatureList, String> {
    let reg = load(app);
    let Some(ctx) = repo_ctx(project)? else {
        return Ok(FeatureList {
            git: false,
            project: clean(project),
            settings: settings_of(&reg, project),
            ..Default::default()
        });
    };
    let canonical = join(&ctx.main, &ctx.rel);
    let default = default_base(&ctx.main);
    let entries: Vec<&Entry> = reg.features.iter().filter(|e| same(&e.repo, &ctx.main)).collect();
    let mut features: Vec<FeatureInfo> = Vec::new();
    for w in ctx.worktrees.iter().filter(|w| !w.bare) {
        let entry = entries.iter().find(|e| same(&e.path, &w.path));
        let main = same(&w.path, &ctx.main);
        let kind = if main { "main" } else if entry.is_some() { "managed" } else { "external" };
        let missing = w.prunable.is_some() || !Path::new(&w.path).is_dir();
        features.push(FeatureInfo {
            id: entry.map(|e| e.id.clone()),
            path: w.path.clone(),
            root: join(&w.path, &ctx.rel),
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
            base: if main { None } else { entry.and_then(|e| e.base.clone()).or_else(|| default.clone()) },
            base_oid: entry.and_then(|e| e.base_oid.clone()),
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
            label: e.label.clone(),
            kind: "managed".to_string(),
            branch: e.branch.clone(),
            missing: true,
            archived: e.archived,
            base: e.base.clone(),
            base_oid: e.base_oid.clone(),
            created_at: Some(e.created_at),
            ..Default::default()
        });
    }
    std::thread::scope(|scope| {
        let handles: Vec<_> = features
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
        for h in handles {
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
    });
    Ok(FeatureList {
        git: true,
        project: canonical.clone(),
        repo: ctx.main.clone(),
        default_base: default,
        worktrees_dir: worktrees_dir(&ctx.main),
        features,
        settings: settings_of(&reg, &canonical),
    })
}

static ROOTS_CACHE: Mutex<Option<HashMap<String, (std::time::Instant, Vec<(String, String)>)>>> = Mutex::new(None);
const ROOTS_TTL: std::time::Duration = std::time::Duration::from_secs(20);

fn light_roots(app: &AppHandle, project: &str) -> Vec<(String, String)> {
    let Ok(Some(ctx)) = repo_ctx(project) else { return Vec::new() };
    let reg = load(app);
    ctx.worktrees
        .iter()
        .filter(|w| !w.bare && w.prunable.is_none() && !same(&w.path, &ctx.main) && Path::new(&w.path).is_dir())
        .filter_map(|w| {
            let entry = reg.features.iter().find(|e| same(&e.path, &w.path));
            if entry.map(|e| e.archived).unwrap_or(false) {
                return None;
            }
            let label = entry.map(|e| e.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| basename(&w.path));
            Some((join(&w.path, &ctx.rel), label))
        })
        .collect()
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

fn create_sync(app: &AppHandle, args: CreateArgs) -> Result<CreateResult, String> {
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
    let mut reg = load(app);
    let entry = Entry {
        id: uuid::Uuid::new_v4().to_string(),
        repo: ctx.main.clone(),
        path: dir.clone(),
        label: label.clone(),
        branch: Some(branch.clone()),
        base: Some(base.clone()),
        base_oid: Some(base_oid.clone()),
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
            label,
            kind: "managed".to_string(),
            branch: Some(branch),
            head,
            base: Some(base),
            base_oid: Some(base_oid),
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
}

fn update_sync(app: &AppHandle, args: UpdateArgs) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let ctx = require_ctx(&args.project)?;
    if same(&args.path, &ctx.main) {
        return Err("la copia principal no se puede renombrar ni archivar".to_string());
    }
    let mut reg = load(app);
    let worktree = ctx.worktrees.iter().find(|w| same(&w.path, &args.path)).cloned();
    let index = match reg.features.iter().position(|e| same(&e.path, &args.path)) {
        Some(i) => i,
        None => {
            let w = worktree.ok_or("esa carpeta no es un worktree de este repositorio")?;
            reg.features.push(Entry {
                id: uuid::Uuid::new_v4().to_string(),
                repo: ctx.main.clone(),
                path: w.path.clone(),
                label: basename(&w.path),
                branch: w.branch.clone(),
                base: default_base(&ctx.main),
                base_oid: None,
                created_at: now_ms(),
                archived: false,
            });
            reg.features.len() - 1
        }
    };
    let entry = &mut reg.features[index];
    if let Some(label) = args.label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()) {
        entry.label = label;
    }
    if let Some(archived) = args.archived {
        entry.archived = archived;
    }
    if let Some(base) = args.base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        probe(&ctx.main, &["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", base)])
            .ok_or_else(|| format!("no encontré la rama {}", base))?;
        entry.base = Some(base);
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

fn candidates_sync(project: &str) -> Result<Vec<CopyCandidate>, String> {
    let ctx = require_ctx(project)?;
    let mut out = Vec::new();
    for rel in ignored_entries(&ctx.main) {
        if is_generated(&rel) || rel.starts_with(WORKTREES_DIR) {
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

fn diff_sync(app: &AppHandle, project: &str, path: &str) -> Result<FeatureDiff, String> {
    let list = build_list(app, project)?;
    let feature = list.features.iter().find(|f| same(&f.path, path)).ok_or("esa feature ya no existe")?;
    if feature.missing {
        return Err("la carpeta de esta feature ya no existe".to_string());
    }
    let mut out = FeatureDiff { base: feature.base.clone(), ..Default::default() };
    let Some(base) = feature.base.clone() else { return Ok(out) };
    let Some(head) = probe(path, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).map(|h| h.trim().to_string()) else {
        return Ok(out);
    };
    let Some(merge_base) = probe(path, &["merge-base", &base, &head]).map(|m| m.trim().to_string()) else {
        return Ok(out);
    };
    out.commits = count_commits(path, &merge_base, &head);
    out.files = range_files(path, &merge_base, &head)?;
    out.merge_base = Some(merge_base);
    out.head = Some(head);
    Ok(out)
}

#[tauri::command]
pub async fn features_diff(app: AppHandle, project: String, path: String) -> Result<FeatureDiff, String> {
    blocking(move || diff_sync(&app, &project, &path)).await
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
        assert_eq!(worktrees_dir("C:/code/guillecode"), "C:/code/.guillecode-worktrees/guillecode");
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
}
