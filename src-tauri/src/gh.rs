use crate::proc::{blocking, Run};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MISSING_GH: &str = "gh CLI no está instalado: winget install GitHub.cli y después `gh auth login`";

fn gh(repo: &str, args: &[&str]) -> Result<String, String> {
    Run::new("gh", repo, args)
        .missing_hint(MISSING_GH)
        .exec()
        .map_err(|e| {
            if e.contains("gh auth login") {
                "gh no está autenticado: corré `gh auth login` en la terminal".to_string()
            } else {
                e
            }
        })
}

fn gh_quiet(repo: &str, args: &[&str]) -> Result<String, String> {
    Run::new("gh", repo, args).quiet().missing_hint(MISSING_GH).exec()
}

#[derive(Serialize, Clone)]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub message: String,
}

fn status_sync(repo: &str) -> GhStatus {
    match gh_quiet(repo, &["auth", "status"]) {
        Ok(out) => GhStatus { installed: true, authenticated: true, message: out },
        Err(e) if e.starts_with("gh CLI no está instalado") => {
            GhStatus { installed: false, authenticated: false, message: e }
        }
        Err(e) => GhStatus { installed: true, authenticated: false, message: e },
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub is_draft: bool,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub updated_at: String,
    pub url: String,
    pub additions: i64,
    pub deletions: i64,
    pub review_decision: String,
    pub checks: String,
    pub is_cross_repository: bool,
}

fn rollup_state(value: &Value) -> String {
    let Some(items) = value.as_array() else { return String::new() };
    if items.is_empty() {
        return String::new();
    }
    let mut pending = false;
    for item in items {
        let conclusion = item
            .get("conclusion")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("state").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_uppercase();
        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();
        if ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].contains(&conclusion.as_str()) {
            return "failure".into();
        }
        if conclusion.is_empty() || conclusion == "PENDING" || (status != "COMPLETED" && !status.is_empty()) {
            pending = true;
        }
    }
    if pending { "pending".into() } else { "success".into() }
}

fn pr_list_sync(repo: &str, state: &str) -> Result<Vec<PrSummary>, String> {
    let out = gh(
        repo,
        &[
            "pr", "list", "--state", state, "--limit", "50", "--json",
            "number,title,author,state,isDraft,headRefName,baseRefName,updatedAt,url,additions,deletions,reviewDecision,statusCheckRollup,isCrossRepository",
        ],
    )?;
    let raw: Vec<Value> = serde_json::from_str(&out).map_err(|e| format!("respuesta de gh inválida: {}", e))?;
    Ok(raw
        .iter()
        .map(|r| PrSummary {
            number: r["number"].as_u64().unwrap_or(0),
            title: r["title"].as_str().unwrap_or("").to_string(),
            author: r["author"]["login"].as_str().unwrap_or("").to_string(),
            state: r["state"].as_str().unwrap_or("").to_string(),
            is_draft: r["isDraft"].as_bool().unwrap_or(false),
            head_ref_name: r["headRefName"].as_str().unwrap_or("").to_string(),
            base_ref_name: r["baseRefName"].as_str().unwrap_or("").to_string(),
            updated_at: r["updatedAt"].as_str().unwrap_or("").to_string(),
            url: r["url"].as_str().unwrap_or("").to_string(),
            additions: r["additions"].as_i64().unwrap_or(0),
            deletions: r["deletions"].as_i64().unwrap_or(0),
            review_decision: r["reviewDecision"].as_str().unwrap_or("").to_string(),
            checks: rollup_state(&r["statusCheckRollup"]),
            is_cross_repository: r["isCrossRepository"].as_bool().unwrap_or(false),
        })
        .collect())
}

fn pr_view_sync(repo: &str, number: u64) -> Result<Value, String> {
    let out = gh(
        repo,
        &[
            "pr", "view", &number.to_string(), "--json",
            "number,title,body,author,state,isDraft,headRefName,baseRefName,url,additions,deletions,changedFiles,createdAt,updatedAt,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments,files,commits,labels",
        ],
    )?;
    serde_json::from_str(&out).map_err(|e| format!("respuesta de gh inválida: {}", e))
}

fn pr_diff_sync(repo: &str, number: u64) -> Result<String, String> {
    gh_quiet(repo, &["pr", "diff", &number.to_string(), "--color", "never"])
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrCreate {
    pub repo: String,
    pub title: String,
    pub body: String,
    pub base: Option<String>,
    pub draft: bool,
}

fn pr_create_sync(req: PrCreate) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "pr".into(), "create".into(), "--title".into(), req.title.clone(), "--body".into(), req.body.clone(),
    ];
    if let Some(base) = req.base.filter(|b| !b.trim().is_empty()) {
        args.push("--base".into());
        args.push(base.trim_start_matches("origin/").to_string());
    }
    if req.draft {
        args.push("--draft".into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    Ok(gh(&req.repo, &refs)?.trim().to_string())
}

fn pr_merge_sync(repo: &str, number: u64, method: &str, delete_branch: bool) -> Result<String, String> {
    let flag = match method {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    let n = number.to_string();
    let mut args = vec!["pr", "merge", n.as_str(), flag];
    if delete_branch {
        args.push("--delete-branch");
    }
    gh(repo, &args)
}

fn pr_checkout_sync(repo: &str, number: u64) -> Result<String, String> {
    gh(repo, &["pr", "checkout", &number.to_string()])
}

fn pr_comment_sync(repo: &str, number: u64, body: &str) -> Result<String, String> {
    gh(repo, &["pr", "comment", &number.to_string(), "--body", body])
}

fn pr_review_sync(repo: &str, number: u64, action: &str, body: &str) -> Result<String, String> {
    let flag = match action {
        "approve" => "--approve",
        "request-changes" => "--request-changes",
        _ => "--comment",
    };
    let n = number.to_string();
    let mut args = vec!["pr", "review", n.as_str(), flag];
    if !body.trim().is_empty() {
        args.push("--body");
        args.push(body);
    }
    gh(repo, &args)
}

fn pr_ready_sync(repo: &str, number: u64) -> Result<String, String> {
    gh(repo, &["pr", "ready", &number.to_string()])
}

#[tauri::command]
pub async fn gh_status(repo: String) -> Result<GhStatus, String> {
    blocking(move || Ok(status_sync(&repo))).await
}

#[tauri::command]
pub async fn gh_pr_list(repo: String, state: Option<String>) -> Result<Vec<PrSummary>, String> {
    blocking(move || pr_list_sync(&repo, &state.unwrap_or_else(|| "open".into()))).await
}

#[tauri::command]
pub async fn gh_pr_view(repo: String, number: u64) -> Result<Value, String> {
    blocking(move || pr_view_sync(&repo, number)).await
}

#[tauri::command]
pub async fn gh_pr_diff(repo: String, number: u64) -> Result<String, String> {
    blocking(move || pr_diff_sync(&repo, number)).await
}

#[tauri::command]
pub async fn gh_pr_create(request: PrCreate) -> Result<String, String> {
    blocking(move || pr_create_sync(request)).await
}

#[tauri::command]
pub async fn gh_pr_merge(repo: String, number: u64, method: String, delete_branch: bool) -> Result<String, String> {
    blocking(move || pr_merge_sync(&repo, number, &method, delete_branch)).await
}

#[tauri::command]
pub async fn gh_pr_checkout(repo: String, number: u64) -> Result<String, String> {
    blocking(move || pr_checkout_sync(&repo, number)).await
}

#[tauri::command]
pub async fn gh_pr_comment(repo: String, number: u64, body: String) -> Result<String, String> {
    blocking(move || pr_comment_sync(&repo, number, &body)).await
}

#[tauri::command]
pub async fn gh_pr_review(repo: String, number: u64, action: String, body: String) -> Result<String, String> {
    blocking(move || pr_review_sync(&repo, number, &action, &body)).await
}

#[tauri::command]
pub async fn gh_pr_ready(repo: String, number: u64) -> Result<String, String> {
    blocking(move || pr_ready_sync(&repo, number)).await
}
