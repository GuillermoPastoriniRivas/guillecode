use crate::proc::{blocking, exec_bytes, Run};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::path::Path;

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_STATUS_ENTRIES: usize = 5000;
const MAX_CONTEXT_BYTES: usize = 60_000;
const MAX_MEDIA_BYTES: usize = 20 * 1024 * 1024;

fn git(worktree: &str, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<&str> = vec!["-c", "core.quotepath=false", "-c", "color.ui=false"];
    full.extend_from_slice(args);
    Run::new("git", worktree, &full)
        .missing_hint("git no está instalado o no está en el PATH")
        .exec()
}

fn git_quiet(worktree: &str, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<&str> = vec!["-c", "core.quotepath=false", "-c", "color.ui=false"];
    full.extend_from_slice(args);
    Run::new("git", worktree, &full).quiet().exec()
}

fn git_with_stdin(worktree: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut full: Vec<&str> = vec!["-c", "core.quotepath=false"];
    full.extend_from_slice(args);
    Run::new("git", worktree, &full).stdin(input).exec()
}

fn truncate_utf8(mut text: String, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text, false);
    }
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    (text, true)
}

#[derive(Serialize, Clone)]
pub struct StatusEntry {
    pub path: String,
    pub orig: Option<String>,
    pub index: String,
    pub worktree: String,
}

#[derive(Serialize, Clone, Default)]
pub struct GitStatus {
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub gone: bool,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
    pub staged_added: u64,
    pub staged_removed: u64,
    pub unstaged_added: u64,
    pub unstaged_removed: u64,
}

fn parse_branch_header(header: &str, status: &mut GitStatus) {
    if let Some(rest) = header.strip_prefix("No commits yet on ") {
        status.branch = rest.trim().to_string();
        return;
    }
    if let Some(rest) = header.strip_prefix("Initial commit on ") {
        status.branch = rest.trim().to_string();
        return;
    }
    if header.starts_with("HEAD (no branch)") {
        status.branch = "HEAD".to_string();
        status.detached = true;
        return;
    }
    let (names, meta) = match header.find(" [") {
        Some(i) => (&header[..i], Some(header[i + 2..].trim_end_matches(']'))),
        None => (header, None),
    };
    match names.split_once("...") {
        Some((local, upstream)) => {
            status.branch = local.to_string();
            status.upstream = Some(upstream.to_string());
        }
        None => status.branch = names.to_string(),
    }
    if let Some(meta) = meta {
        for part in meta.split(',') {
            let part = part.trim();
            if part == "gone" {
                status.gone = true;
            } else if let Some(n) = part.strip_prefix("ahead ") {
                status.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                status.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

fn parse_numstat(out: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for line in out.lines() {
        let mut parts = line.split('\t');
        let a = parts.next().unwrap_or("0");
        let d = parts.next().unwrap_or("0");
        // "-" = binario: no suma líneas
        if a != "-" {
            added += a.parse().unwrap_or(0);
        }
        if d != "-" {
            removed += d.parse().unwrap_or(0);
        }
    }
    (added, removed)
}

const MAX_UNTRACKED_COUNT: usize = 500;
const MAX_UNTRACKED_BYTES: u64 = 5 * 1024 * 1024;

fn count_untracked_lines(worktree: &str, paths: &[String]) -> u64 {
    use std::io::{BufRead, BufReader};
    let root = Path::new(worktree);
    let mut total = 0u64;
    for rel in paths.iter().take(MAX_UNTRACKED_COUNT) {
        if rel.ends_with('/') {
            continue;
        }
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let meta = std::fs::metadata(&abs);
        let Ok(meta) = meta else { continue };
        if !meta.is_file() || meta.len() > MAX_UNTRACKED_BYTES {
            continue;
        }
        let Ok(file) = std::fs::File::open(&abs) else { continue };
        let mut reader = BufReader::new(file);
        let mut lines = 0u64;
        let mut buf = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            let Ok(n) = reader.read_until(b'\n', &mut buf) else { break };
            if n == 0 {
                break;
            }
            // Heurística binaria: NUL en el chunk => no es texto
            if buf.contains(&0) {
                lines = 0;
                break;
            }
            lines += 1;
        }
        total += lines;
    }
    total
}

fn status_sync(worktree: &str) -> Result<GitStatus, String> {
    let out = git_quiet(
        worktree,
        &["status", "--porcelain=v1", "-z", "-b", "--untracked-files=normal"],
    )?;
    let mut status = GitStatus::default();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("## ") {
            parse_branch_header(header, &mut status);
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let index = record[..1].to_string();
        let worktree_code = record[1..2].to_string();
        let path = record[3..].to_string();
        let orig = if index == "R" || index == "C" {
            records.next().map(|s| s.to_string())
        } else {
            None
        };
        if status.entries.len() >= MAX_STATUS_ENTRIES {
            status.truncated = true;
            continue;
        }
        status.entries.push(StatusEntry { path, orig, index, worktree: worktree_code });
    }
    // Totales de líneas: un solo `diff --numstat` por lado (rápido, sin N llamadas).
    // Si el repo es enorme y el status se truncó, igual sumamos el diff global.
    if let Ok(out) = git_quiet(worktree, &["diff", "--no-ext-diff", "--numstat"]) {
        let (a, r) = parse_numstat(&out);
        status.unstaged_added = a;
        status.unstaged_removed = r;
    }
    if let Ok(out) = git_quiet(worktree, &["diff", "--no-ext-diff", "--cached", "--numstat"]) {
        let (a, r) = parse_numstat(&out);
        status.staged_added = a;
        status.staged_removed = r;
    }
    // Untracked no aparece en numstat: cada línea cuenta como agregada.
    let untracked: Vec<String> = status
        .entries
        .iter()
        .filter(|e| e.index == "?" && e.worktree == "?")
        .map(|e| e.path.clone())
        .collect();
    if !untracked.is_empty() {
        status.unstaged_added += count_untracked_lines(worktree, &untracked);
    }
    Ok(status)
}

fn root_sync(path: &str) -> Result<String, String> {
    let out = git_quiet(path, &["rev-parse", "--show-toplevel"])?;
    Ok(out.trim().replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[derive(Serialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
}

fn parse_commits(out: &str) -> Vec<Commit> {
    out.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            if record.is_empty() {
                return None;
            }
            let mut f = record.split('\x1f');
            let hash = f.next()?.to_string();
            let parents = f
                .next()?
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            let author = f.next()?.to_string();
            let email = f.next()?.to_string();
            let time = f.next()?.trim().parse().unwrap_or(0);
            let refs = f
                .next()?
                .split(", ")
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect();
            let subject = f.next().unwrap_or("").to_string();
            Some(Commit { hash, parents, author, email, time, refs, subject })
        })
        .collect()
}

const COMMIT_FORMAT: &str = "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

fn log_sync(worktree: &str, limit: u32, skip: u32, all: bool, file: Option<String>) -> Result<Vec<Commit>, String> {
    let limit = limit.clamp(1, 2000).to_string();
    let skip = skip.to_string();
    let mut args: Vec<&str> = vec!["log", "--topo-order", "--decorate=full", COMMIT_FORMAT, "-n", &limit, "--skip", &skip];
    if all {
        args.push("--all");
    }
    let file_owned;
    if let Some(f) = file {
        file_owned = f;
        args.push("--follow");
        args.push("--");
        args.push(&file_owned);
    }
    match git_quiet(worktree, &args) {
        Ok(out) => Ok(parse_commits(&out)),
        Err(e) if e.contains("does not have any commits") => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[derive(Serialize, Clone)]
pub struct CommitFile {
    pub path: String,
    pub orig: Option<String>,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Serialize, Clone)]
pub struct CommitDetail {
    pub commit: Commit,
    pub body: String,
    pub parent: String,
    pub files: Vec<CommitFile>,
}

fn commit_detail_sync(worktree: &str, hash: &str) -> Result<CommitDetail, String> {
    let header = git_quiet(
        worktree,
        &["show", "--no-patch", "--decorate=full", "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e%b", hash],
    )?;
    let (head, body) = header.split_once('\x1e').unwrap_or((header.as_str(), ""));
    let commit = parse_commits(&format!("{}\x1e", head))
        .into_iter()
        .next()
        .ok_or("commit no encontrado")?;
    let parent = commit.parents.first().cloned().unwrap_or_else(|| EMPTY_TREE.to_string());
    let names = git_quiet(worktree, &["diff", "-M", "--name-status", &parent, hash])?;
    let nums = git_quiet(worktree, &["diff", "-M", "--numstat", &parent, hash])?;
    let mut counts: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    for line in nums.lines() {
        let mut f = line.splitn(3, '\t');
        let add = f.next().unwrap_or("0").parse().unwrap_or(0);
        let del = f.next().unwrap_or("0").parse().unwrap_or(0);
        let raw = f.next().unwrap_or("").to_string();
        let path = if let (Some(open), Some(close)) = (raw.find('{'), raw.find('}')) {
            let inner = &raw[open + 1..close];
            let new_part = inner.split(" => ").nth(1).unwrap_or(inner);
            format!("{}{}{}", &raw[..open], new_part, &raw[close + 1..]).replace("//", "/")
        } else if let Some((_, new)) = raw.split_once(" => ") {
            new.to_string()
        } else {
            raw
        };
        counts.insert(path, (add, del));
    }
    let files = names
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\t');
            let code = f.next()?;
            let first = f.next()?.to_string();
            let second = f.next().map(|s| s.to_string());
            let (path, orig) = match second {
                Some(new) => (new, Some(first)),
                None => (first, None),
            };
            let (additions, deletions) = counts.get(&path).cloned().unwrap_or((0, 0));
            Some(CommitFile {
                path,
                orig,
                status: code.chars().next().unwrap_or('M').to_string(),
                additions,
                deletions,
            })
        })
        .collect();
    Ok(CommitDetail { commit, body: body.trim().to_string(), parent, files })
}

fn show_file_sync(worktree: &str, rev: &str, file: &str) -> Result<String, String> {
    let file = file.replace('\\', "/");
    let spec = if rev.is_empty() { format!(":{}", file) } else { format!("{}:{}", rev, file) };
    git_quiet(worktree, &["show", &spec])
}

fn show_file_base64_sync(worktree: &str, rev: &str, file: &str) -> Result<String, String> {
    let file = file.replace('\\', "/");
    let spec = if rev.is_empty() { format!(":{}", file) } else { format!("{}:{}", rev, file) };
    let bytes = exec_bytes(
        "git",
        worktree,
        &["-c", "core.quotepath=false", "-c", "color.ui=false", "show", &spec],
    )?;
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err("imagen demasiado grande para previsualizar".to_string());
    }
    Ok(BASE64.encode(&bytes))
}

fn diff_file_sync(worktree: &str, file: &str, staged: bool) -> Result<String, String> {
    if staged {
        git_quiet(worktree, &["diff", "--cached", "--no-ext-diff", "--", file])
    } else {
        git_quiet(worktree, &["diff", "--no-ext-diff", "--", file])
    }
}

#[derive(Serialize, Clone)]
pub struct Branch {
    pub name: String,
    pub full: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub time: i64,
    pub subject: String,
}

fn branches_sync(worktree: &str) -> Result<Vec<Branch>, String> {
    let out = git_quiet(
        worktree,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)%1f%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\x1f');
            let full = f.next()?.to_string();
            let name = f.next()?.to_string();
            if full.ends_with("/HEAD") {
                return None;
            }
            let current = f.next()? == "*";
            let upstream = f.next().filter(|s| !s.is_empty()).map(|s| s.to_string());
            let time = f.next().unwrap_or("0").parse().unwrap_or(0);
            let subject = f.next().unwrap_or("").to_string();
            Some(Branch {
                remote: full.starts_with("refs/remotes/"),
                name,
                full,
                current,
                upstream,
                time,
                subject,
            })
        })
        .collect())
}

fn checkout_sync(worktree: &str, branch: &str, create: bool, from: Option<String>) -> Result<(), String> {
    if create {
        let mut args = vec!["checkout", "-b", branch];
        let from_owned;
        if let Some(f) = from {
            from_owned = f;
            args.push(&from_owned);
        }
        git(worktree, &args)?;
        return Ok(());
    }
    let is_remote = git_quiet(
        worktree,
        &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{}", branch)],
    )
    .is_ok();
    if is_remote {
        let local = branch.split_once('/').map(|(_, rest)| rest).unwrap_or(branch);
        let local_exists = git_quiet(
            worktree,
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", local)],
        )
        .is_ok();
        if local_exists {
            git(worktree, &["checkout", local])?;
        } else {
            git(worktree, &["checkout", "--track", branch])?;
        }
        return Ok(());
    }
    git(worktree, &["checkout", branch])?;
    Ok(())
}

fn subrepos_sync(worktree: &str) -> Result<Vec<String>, String> {
    let root = Path::new(worktree).to_path_buf();
    if !root.is_dir() {
        return Err(format!("la carpeta no existe: {}", worktree));
    }
    let skip = [
        "node_modules", ".git", "target", "dist", "build", ".next", ".venv", "venv", "coverage",
        "out", ".turbo", ".gradle", "vendor", "__pycache__",
    ];
    let mut repos: Vec<String> = Vec::new();
    if root.join(".git").exists() {
        repos.push(root.to_string_lossy().into_owned());
    }
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.clone(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 3 {
            continue;
        }
        if dir != root && dir.join(".git").exists() {
            repos.push(dir.to_string_lossy().into_owned());
            continue;
        }
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || skip.contains(&name.as_str()) {
                    continue;
                }
                let p = entry.path();
                if p.is_dir() {
                    stack.push((p, depth + 1));
                }
            }
        }
    }
    repos.sort();
    Ok(repos)
}

fn git_paths(worktree: &str, args: &[&str], files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let mut full: Vec<&str> = args.to_vec();
    full.extend_from_slice(&["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let mut input = files.join("\0");
    input.push('\0');
    git_with_stdin(worktree, &full, &input)?;
    Ok(())
}

fn has_head(worktree: &str) -> bool {
    git_quiet(worktree, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

fn stage_sync(worktree: &str, files: &[String]) -> Result<(), String> {
    git_paths(worktree, &["add", "-A"], files)
}

fn stage_all_sync(worktree: &str) -> Result<(), String> {
    git(worktree, &["add", "-A"])?;
    Ok(())
}

fn unstage_sync(worktree: &str, files: &[String]) -> Result<(), String> {
    if has_head(worktree) {
        git_paths(worktree, &["restore", "--staged"], files)
    } else {
        git_paths(worktree, &["rm", "--cached", "-r", "--quiet", "--ignore-unmatch"], files)
    }
}

fn unstage_all_sync(worktree: &str) -> Result<(), String> {
    if has_head(worktree) {
        git(worktree, &["reset", "--quiet"])?;
    } else {
        git(worktree, &["rm", "--cached", "-r", "--quiet", "--ignore-unmatch", "--", "."])?;
    }
    Ok(())
}

fn discard_sync(worktree: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    git_paths(worktree, &["restore", "--worktree"], tracked)?;
    let existing: Vec<std::path::PathBuf> = untracked
        .iter()
        .map(|f| Path::new(worktree).join(f.trim_end_matches('/')))
        .filter(|p| p.exists())
        .collect();
    if !existing.is_empty() {
        trash::delete_all(&existing).map_err(|e| format!("no se pudo mandar a la papelera: {}", e))?;
    }
    Ok(())
}

fn apply_patch_sync(worktree: &str, patch: &str, cached: bool, reverse: bool) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["apply", "--whitespace=nowarn", "--unidiff-zero"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    args.push("-");
    git_with_stdin(worktree, &args, patch)?;
    Ok(())
}

fn ignore_add_sync(worktree: &str, patterns: &[String]) -> Result<(), String> {
    let root = Path::new(worktree);
    let file = root.join(".gitignore");
    let mut content = std::fs::read_to_string(&file).unwrap_or_default();
    let additions: Vec<&String> = patterns
        .iter()
        .filter(|p| !p.trim().is_empty() && !content.lines().any(|l| l.trim() == p.trim()))
        .collect();
    if additions.is_empty() {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for a in &additions {
        content.push_str(a.trim());
        content.push('\n');
    }
    std::fs::write(&file, content).map_err(|e| format!("no se pudo escribir .gitignore: {}", e))?;
    let mut args: Vec<&str> = vec!["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", "--"];
    args.extend(additions.iter().map(|s| s.trim()));
    git(worktree, &args)?;
    Ok(())
}

fn commit_sync(worktree: &str, message: &str, amend: bool) -> Result<String, String> {
    if !amend {
        let staged = git_quiet(worktree, &["diff", "--cached", "--name-only"])?;
        if staged.trim().is_empty() {
            return Err("no hay nada en el commit: agregá archivos primero".to_string());
        }
    }
    let mut args: Vec<&str> = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    git(worktree, &args)?;
    Ok(git_quiet(worktree, &["rev-parse", "HEAD"])?.trim().to_string())
}

fn first_remote(worktree: &str) -> Option<String> {
    let out = git_quiet(worktree, &["remote"]).ok()?;
    let remotes: Vec<&str> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if remotes.contains(&"origin") {
        return Some("origin".to_string());
    }
    remotes.first().map(|s| s.to_string())
}

fn push_sync(worktree: &str, force: bool) -> Result<String, String> {
    let status = status_sync(worktree)?;
    let mut args: Vec<String> = vec!["push".into()];
    if force {
        args.push("--force-with-lease".into());
    }
    if status.upstream.is_none() || status.gone {
        let remote = first_remote(worktree).ok_or("el repo no tiene remotes configurados")?;
        args.push("-u".into());
        args.push(remote);
        args.push("HEAD".into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(worktree, &refs)
}

fn pull_sync(worktree: &str) -> Result<String, String> {
    git(worktree, &["pull"])
}

fn fetch_sync(worktree: &str) -> Result<String, String> {
    git(worktree, &["fetch", "--all", "--prune"])
}

fn stash_sync(worktree: &str, pop: bool, message: Option<String>) -> Result<String, String> {
    if pop {
        return git(worktree, &["stash", "pop"]);
    }
    let msg = message.unwrap_or_else(|| "guillecode".to_string());
    git(worktree, &["stash", "push", "-u", "-m", &msg])
}

#[derive(Serialize, Clone)]
pub struct BlameLine {
    pub line: u32,
    pub hash: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
}

fn is_blame_header(line: &str) -> bool {
    let mut parts = line.split(' ');
    let Some(hash) = parts.next() else { return false };
    (hash.len() == 40 || hash.len() == 64)
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
        && parts.next().map(|n| n.parse::<u32>().is_ok()).unwrap_or(false)
}

fn blame_sync(worktree: &str, file: &str, contents: Option<String>) -> Result<Vec<BlameLine>, String> {
    let out = match contents {
        Some(text) => git_with_stdin(worktree, &["blame", "--line-porcelain", "--contents", "-", "--", file], &text)?,
        None => git_quiet(worktree, &["blame", "--line-porcelain", "--", file])?,
    };
    let mut lines: Vec<BlameLine> = Vec::new();
    let mut current: Option<BlameLine> = None;
    for l in out.lines() {
        if l.starts_with('\t') {
            if let Some(entry) = current.take() {
                lines.push(entry);
            }
            continue;
        }
        if is_blame_header(l) {
            let mut parts = l.split(' ');
            let hash = parts.next().unwrap_or("").to_string();
            let _orig = parts.next();
            let final_line = parts.next().and_then(|n| n.parse().ok()).unwrap_or(lines.len() as u32 + 1);
            current = Some(BlameLine {
                line: final_line,
                hash,
                author: String::new(),
                email: String::new(),
                time: 0,
                subject: String::new(),
            });
            continue;
        }
        if let Some(entry) = current.as_mut() {
            if let Some(rest) = l.strip_prefix("author ") {
                entry.author = rest.to_string();
            } else if let Some(rest) = l.strip_prefix("author-mail ") {
                entry.email = rest.trim_matches(|c| c == '<' || c == '>').to_string();
            } else if let Some(rest) = l.strip_prefix("author-time ") {
                entry.time = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = l.strip_prefix("summary ") {
                entry.subject = rest.to_string();
            }
        }
    }
    Ok(lines)
}

fn default_branch_sync(worktree: &str) -> Result<String, String> {
    if let Ok(out) = git_quiet(worktree, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        let b = out.trim();
        if !b.is_empty() {
            return Ok(b.to_string());
        }
    }
    for candidate in ["origin/main", "origin/master", "main", "master"] {
        if git_quiet(worktree, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("no se encontró la rama por defecto".to_string())
}

#[derive(Serialize, Clone)]
pub struct DiffContext {
    pub stat: String,
    pub log: String,
    pub diff: String,
    pub truncated: bool,
}

fn staged_context_sync(worktree: &str) -> Result<DiffContext, String> {
    let stat = git_quiet(worktree, &["diff", "--cached", "--stat"])?;
    let (diff, truncated) = truncate_utf8(
        git_quiet(worktree, &["diff", "--cached", "--no-ext-diff", "-U2"])?,
        MAX_CONTEXT_BYTES,
    );
    let log = git_quiet(worktree, &["log", "-n", "8", "--pretty=format:%s"]).unwrap_or_default();
    Ok(DiffContext { stat, log, diff, truncated })
}

const REVIEW_CONTEXT_BYTES: usize = 160_000;

#[derive(Serialize, Clone)]
pub struct ChangesContext {
    pub stat: String,
    pub diff: String,
    pub untracked: Vec<String>,
    pub truncated: bool,
}

fn changes_context_sync(worktree: &str) -> Result<ChangesContext, String> {
    let base = if git_quiet(worktree, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() { "HEAD" } else { EMPTY_TREE };
    let stat = git_quiet(worktree, &["diff", "--stat", base])?;
    let (diff, truncated) = truncate_utf8(
        git_quiet(worktree, &["diff", "--no-ext-diff", "-U3", base])?,
        REVIEW_CONTEXT_BYTES,
    );
    let untracked = git_quiet(worktree, &["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(200)
        .map(|l| l.to_string())
        .collect();
    Ok(ChangesContext { stat, diff, untracked, truncated })
}

fn range_context_sync(worktree: &str, base: &str) -> Result<DiffContext, String> {
    let range_dots = format!("{}...HEAD", base);
    let range = format!("{}..HEAD", base);
    let stat = git_quiet(worktree, &["diff", "--stat", &range_dots])?;
    let log = git_quiet(worktree, &["log", "--pretty=format:- %s%n%b", &range])?;
    let (diff, truncated) = truncate_utf8(
        git_quiet(worktree, &["diff", "--no-ext-diff", "-U2", &range_dots])?,
        MAX_CONTEXT_BYTES,
    );
    Ok(DiffContext { stat, log, diff, truncated })
}

#[tauri::command]
pub async fn git_root(path: String) -> Result<String, String> {
    blocking(move || root_sync(&path)).await
}

#[tauri::command]
pub async fn git_status(worktree: String) -> Result<GitStatus, String> {
    blocking(move || status_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_log(
    worktree: String,
    limit: Option<u32>,
    skip: Option<u32>,
    all: Option<bool>,
    file: Option<String>,
) -> Result<Vec<Commit>, String> {
    blocking(move || log_sync(&worktree, limit.unwrap_or(200), skip.unwrap_or(0), all.unwrap_or(false), file)).await
}

#[tauri::command]
pub async fn git_commit_detail(worktree: String, hash: String) -> Result<CommitDetail, String> {
    blocking(move || commit_detail_sync(&worktree, &hash)).await
}

#[tauri::command]
pub async fn git_show_file(worktree: String, rev: String, file: String) -> Result<String, String> {
    blocking(move || show_file_sync(&worktree, &rev, &file)).await
}

#[tauri::command]
pub async fn git_show_file_base64(worktree: String, rev: String, file: String) -> Result<String, String> {
    blocking(move || show_file_base64_sync(&worktree, &rev, &file)).await
}

#[tauri::command]
pub async fn git_diff_file(worktree: String, file: String, staged: Option<bool>) -> Result<String, String> {
    blocking(move || diff_file_sync(&worktree, &file, staged.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_branches(worktree: String) -> Result<Vec<Branch>, String> {
    blocking(move || branches_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_checkout(
    worktree: String,
    branch: String,
    create: Option<bool>,
    from: Option<String>,
) -> Result<(), String> {
    blocking(move || checkout_sync(&worktree, &branch, create.unwrap_or(false), from)).await
}

#[tauri::command]
pub async fn git_subrepos(worktree: String) -> Result<Vec<String>, String> {
    blocking(move || subrepos_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_stage(worktree: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || stage_sync(&worktree, &files)).await
}

#[tauri::command]
pub async fn git_stage_all(worktree: String) -> Result<(), String> {
    blocking(move || stage_all_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_unstage(worktree: String, files: Vec<String>) -> Result<(), String> {
    blocking(move || unstage_sync(&worktree, &files)).await
}

#[tauri::command]
pub async fn git_unstage_all(worktree: String) -> Result<(), String> {
    blocking(move || unstage_all_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_discard(worktree: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    blocking(move || discard_sync(&worktree, &tracked, &untracked)).await
}

#[tauri::command]
pub async fn git_apply_patch(worktree: String, patch: String, cached: bool, reverse: bool) -> Result<(), String> {
    blocking(move || apply_patch_sync(&worktree, &patch, cached, reverse)).await
}

#[tauri::command]
pub async fn git_ignore_add(worktree: String, patterns: Vec<String>) -> Result<(), String> {
    blocking(move || ignore_add_sync(&worktree, &patterns)).await
}

#[tauri::command]
pub async fn git_commit(worktree: String, message: String, amend: Option<bool>) -> Result<String, String> {
    blocking(move || commit_sync(&worktree, &message, amend.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_push(worktree: String, force: Option<bool>) -> Result<String, String> {
    blocking(move || push_sync(&worktree, force.unwrap_or(false))).await
}

#[tauri::command]
pub async fn git_pull(worktree: String) -> Result<String, String> {
    blocking(move || pull_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_fetch(worktree: String) -> Result<String, String> {
    blocking(move || fetch_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_stash(worktree: String, pop: bool, message: Option<String>) -> Result<String, String> {
    blocking(move || stash_sync(&worktree, pop, message)).await
}

#[tauri::command]
pub async fn git_blame(worktree: String, file: String, contents: Option<String>) -> Result<Vec<BlameLine>, String> {
    blocking(move || blame_sync(&worktree, &file, contents)).await
}

#[tauri::command]
pub async fn git_default_branch(worktree: String) -> Result<String, String> {
    blocking(move || default_branch_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_staged_context(worktree: String) -> Result<DiffContext, String> {
    blocking(move || staged_context_sync(&worktree)).await
}

#[tauri::command]
pub async fn git_range_context(worktree: String, base: String) -> Result<DiffContext, String> {
    blocking(move || range_context_sync(&worktree, &base)).await
}

#[tauri::command]
pub async fn git_changes_context(worktree: String) -> Result<ChangesContext, String> {
    blocking(move || changes_context_sync(&worktree)).await
}
