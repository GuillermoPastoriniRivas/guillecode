use crate::proc::blocking;
use ignore::overrides::OverrideBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const PREVIEW_CHARS: usize = 220;
const HEAVY_DIRS: [&str; 8] = ["node_modules", "target", "dist", "build", ".next", ".turbo", "coverage", ".venv"];

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub root: String,
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
    pub max_results: Option<usize>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    pub line: usize,
    pub col: usize,
    pub col_end: usize,
    pub text: String,
    pub ranges: Vec<[usize; 2]>,
}

#[derive(Serialize, Clone)]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub total: usize,
    pub truncated: bool,
    pub searched: usize,
}

fn build_regex(q: &SearchQuery) -> Result<Regex, String> {
    let mut pattern = if q.regex { q.query.clone() } else { regex::escape(&q.query) };
    if q.whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| format!("regex inválida: {}", e))
}

fn split_globs(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s.replace('\\', "/");
            if s.contains('/') || s.contains('*') { s } else { format!("**/{}", s) }
        })
        .collect()
}

fn walker(q: &SearchQuery) -> Result<ignore::Walk, String> {
    let root = PathBuf::from(&q.root);
    let mut overrides = OverrideBuilder::new(&root);
    for glob in split_globs(&q.include) {
        overrides.add(&glob).map_err(|e| format!("glob inválido {}: {}", glob, e))?;
        if !glob.contains('.') && !glob.ends_with("**") {
            overrides.add(&format!("{}/**", glob.trim_end_matches('/'))).ok();
        }
    }
    for glob in split_globs(&q.exclude) {
        overrides.add(&format!("!{}", glob)).map_err(|e| format!("glob inválido {}: {}", glob, e))?;
        overrides.add(&format!("!{}/**", glob.trim_end_matches('/'))).ok();
    }
    let overrides = overrides.build().map_err(|e| e.to_string())?;
    Ok(ignore::WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .overrides(overrides)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != ".git"
                && !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && HEAVY_DIRS.contains(&name.as_ref()))
        })
        .build())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn preview(line: &str, byte_ranges: &[(usize, usize)]) -> (String, Vec<[usize; 2]>) {
    let first = byte_ranges.first().map(|r| r.0).unwrap_or(0);
    let mut start = 0;
    if line.len() > PREVIEW_CHARS && first > 40 {
        start = first - 40;
        while !line.is_char_boundary(start) {
            start -= 1;
        }
    }
    let mut end = line.len().min(start + PREVIEW_CHARS * 2);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    let slice = &line[start..end];
    let prefix = if start > 0 { "…" } else { "" };
    let offset = utf16_len(prefix);
    let ranges = byte_ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= end)
        .map(|(s, e)| [offset + utf16_len(&line[start..*s]), offset + utf16_len(&line[start..*e])])
        .collect();
    (format!("{}{}", prefix, slice), ranges)
}

fn read_text(path: &Path) -> Option<String> {
    let meta = path.metadata().ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn search_sync(q: SearchQuery) -> Result<SearchResult, String> {
    if q.query.is_empty() {
        return Ok(SearchResult { files: vec![], total: 0, truncated: false, searched: 0 });
    }
    let re = build_regex(&q)?;
    let max = q.max_results.unwrap_or(2000).min(20_000);
    let root = PathBuf::from(&q.root);
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut searched = 0usize;
    let mut truncated = false;
    for entry in walker(&q)?.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let Some(text) = read_text(entry.path()) else { continue };
        searched += 1;
        let mut matches = Vec::new();
        for (idx, line) in text.lines().enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let ranges: Vec<(usize, usize)> = re
                .find_iter(line)
                .filter(|m| m.end() > m.start())
                .map(|m| (m.start(), m.end()))
                .collect();
            if ranges.is_empty() {
                continue;
            }
            total += ranges.len();
            let col = utf16_len(&line[..ranges[0].0]);
            let col_end = utf16_len(&line[..ranges[0].1]);
            let (text, ranges) = preview(line, &ranges);
            matches.push(LineMatch { line: idx + 1, col, col_end, text, ranges });
            if total >= max {
                truncated = true;
                break;
            }
        }
        if !matches.is_empty() {
            let rel = entry
                .path()
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| entry.path().to_string_lossy().into_owned());
            files.push(FileMatches { path: rel, matches });
        }
        if truncated {
            break;
        }
    }
    Ok(SearchResult { files, total, truncated, searched })
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub query: SearchQuery,
    pub replacement: String,
    pub paths: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ReplaceResult {
    pub files: usize,
    pub replacements: usize,
}

fn replace_sync(req: ReplaceRequest) -> Result<ReplaceResult, String> {
    let re = build_regex(&req.query)?;
    let root = PathBuf::from(&req.query.root);
    let mut files = 0;
    let mut replacements = 0;
    for rel in &req.paths {
        let full = root.join(rel);
        let Some(text) = read_text(&full) else { continue };
        let count = re.find_iter(&text).filter(|m| m.end() > m.start()).count();
        if count == 0 {
            continue;
        }
        let replaced = if req.query.regex {
            re.replace_all(&text, req.replacement.as_str()).into_owned()
        } else {
            re.replace_all(&text, regex::NoExpand(&req.replacement)).into_owned()
        };
        std::fs::write(&full, replaced).map_err(|e| format!("no se pudo escribir {}: {}", rel, e))?;
        files += 1;
        replacements += count;
    }
    Ok(ReplaceResult { files, replacements })
}

#[tauri::command]
pub async fn search_text(query: SearchQuery) -> Result<SearchResult, String> {
    blocking(move || search_sync(query)).await
}

#[tauri::command]
pub async fn search_replace(request: ReplaceRequest) -> Result<ReplaceResult, String> {
    blocking(move || replace_sync(request)).await
}
