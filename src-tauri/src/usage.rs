use crate::proc::blocking;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HOUR_MS: i64 = 3_600_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub five_hours: f64,
    pub week: f64,
    pub month: f64,
    pub oldest_five_hours: Option<i64>,
    pub messages: i64,
    pub measured_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_percent: f64,
    pub window_seconds: i64,
    pub resets_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptUsage {
    pub plan: String,
    pub windows: Vec<QuotaWindow>,
    pub limit_reached: bool,
    pub resets_available: Option<i64>,
    pub measured_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub id: String,
    pub status: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatgptResets {
    pub credits: Vec<ResetCredit>,
    pub available: i64,
    pub measured_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    pub outcome: String,
    pub windows_reset: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoUsage {
    pub windows: Vec<QuotaWindow>,
    pub measured_at: i64,
}

const CHATGPT_WHAM: &str = "https://chatgpt.com/backend-api/wham";
const GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

pub fn opencode_data() -> Option<PathBuf> {
    let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(|home| PathBuf::from(home).join(".local").join("share"))
    })?;
    Some(data_home.join("opencode"))
}

fn opencode_db() -> Option<PathBuf> {
    let path = opencode_data()?.join("opencode.db");
    path.is_file().then_some(path)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn usage_sync(provider: String) -> Result<ProviderUsage, String> {
    let path = opencode_db().ok_or_else(|| "no encontré la base de opencode (opencode.db)".to_string())?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("no se pudo abrir opencode.db: {}", e))?;
    conn.busy_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let now = now_ms();
    let five_hours = now - 5 * HOUR_MS;
    let week = now - 7 * 24 * HOUR_MS;
    let month = now - 30 * 24 * HOUR_MS;
    conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN time_created >= ?1 THEN cost END), 0),
           COALESCE(SUM(CASE WHEN time_created >= ?2 THEN cost END), 0),
           COALESCE(SUM(cost), 0),
           MIN(CASE WHEN time_created >= ?1 THEN time_created END),
           COUNT(*)
         FROM (
           SELECT time_created, json_extract(data, '$.cost') AS cost
           FROM message
           WHERE time_created >= ?3
             AND json_extract(data, '$.role') = 'assistant'
             AND json_extract(data, '$.providerID') = ?4
         )",
        params![five_hours, week, month, provider],
        |row| {
            Ok(ProviderUsage {
                five_hours: row.get(0)?,
                week: row.get(1)?,
                month: row.get(2)?,
                oldest_five_hours: row.get(3)?,
                messages: row.get(4)?,
                measured_at: now,
            })
        },
    )
    .map_err(|e| format!("no se pudo leer el uso de {}: {}", provider, e))
}

pub const GO_PROVIDER: &str = "opencode-go";

pub fn snapshot(provider: &str) -> Result<ProviderUsage, String> {
    usage_sync(provider.to_string())
}

#[tauri::command]
pub async fn provider_usage(provider: String) -> Result<ProviderUsage, String> {
    blocking(move || usage_sync(provider)).await
}

fn quota_window(w: &Value, now: i64) -> Option<QuotaWindow> {
    Some(QuotaWindow {
        used_percent: w["used_percent"].as_f64()?,
        window_seconds: w["limit_window_seconds"].as_i64()?,
        resets_at: w["reset_at"]
            .as_i64()
            .map(|s| s * 1000)
            .or_else(|| w["reset_after_seconds"].as_i64().map(|s| now + s * 1000)),
    })
}

fn chatgpt_request(method: &str, path: &str, timeout: Duration) -> Result<ureq::Request, String> {
    let auth = crate::accounts::read_auth()?;
    let openai = &auth["openai"];
    if openai["type"].as_str() != Some("oauth") {
        return Err("ChatGPT no está conectado con tu suscripción".into());
    }
    let access = openai["access"].as_str().ok_or_else(|| "falta el token de ChatGPT en auth.json".to_string())?;
    if openai["expires"].as_i64().is_some_and(|e| e < now_ms()) {
        return Err("la sesión de ChatGPT venció: se renueva sola con el próximo mensaje que mandes con un modelo de ChatGPT".into());
    }
    let mut request = ureq::request(method, &format!("{}{}", CHATGPT_WHAM, path))
        .set("Authorization", &format!("Bearer {}", access))
        .set("Accept", "application/json")
        .timeout(timeout);
    if let Some(account) = openai["accountId"].as_str() {
        request = request.set("ChatGPT-Account-Id", account);
    }
    Ok(request)
}

fn chatgpt_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => "ChatGPT rechazó la sesión: cerrá sesión y volvé a entrar desde Cuentas de IA".to_string(),
        ureq::Error::Status(code, response) => {
            let body: Value = response.into_json().unwrap_or(Value::Null);
            let detail = body["detail"]
                .as_str()
                .or_else(|| body["error"]["message"].as_str())
                .or_else(|| body["message"].as_str());
            match detail {
                Some(detail) => format!("ChatGPT respondió {}: {}", code, detail),
                None => format!("ChatGPT respondió {}", code),
            }
        }
        other => format!("no se pudo consultar ChatGPT: {}", other),
    }
}

fn chatgpt_json(response: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    response
        .map_err(chatgpt_error)?
        .into_json()
        .map_err(|e| format!("respuesta de ChatGPT ilegible: {}", e))
}

pub fn chatgpt_snapshot() -> Result<ChatgptUsage, String> {
    let body = chatgpt_json(chatgpt_request("GET", "/usage", Duration::from_secs(15))?.call())?;
    let now = now_ms();
    let limit = &body["rate_limit"];
    Ok(ChatgptUsage {
        plan: body["plan_type"].as_str().unwrap_or_default().to_string(),
        windows: ["primary_window", "secondary_window"].iter().filter_map(|k| quota_window(&limit[*k], now)).collect(),
        limit_reached: limit["limit_reached"].as_bool().unwrap_or(false),
        resets_available: body["rate_limit_reset_credits"]["available_count"].as_i64(),
        measured_at: now,
    })
}

#[tauri::command]
pub async fn chatgpt_usage() -> Result<ChatgptUsage, String> {
    blocking(chatgpt_snapshot).await
}

fn rfc3339_ms(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}

pub fn chatgpt_resets_snapshot() -> Result<ChatgptResets, String> {
    let body = chatgpt_json(chatgpt_request("GET", "/rate-limit-reset-credits", Duration::from_secs(15))?.call())?;
    let credits = body["credits"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|c| c["reset_type"].as_str().is_none_or(|t| t == "codex_rate_limits"))
                .filter_map(|c| {
                    Some(ResetCredit {
                        id: c["id"].as_str()?.to_string(),
                        status: c["status"].as_str().unwrap_or_default().to_string(),
                        title: c["title"].as_str().map(str::to_string),
                        description: c["description"].as_str().map(str::to_string),
                        granted_at: rfc3339_ms(&c["granted_at"]),
                        expires_at: rfc3339_ms(&c["expires_at"]),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let available = body["available_count"]
        .as_i64()
        .unwrap_or_else(|| credits.iter().filter(|c| c.status == "available").count() as i64);
    Ok(ChatgptResets { credits, available, measured_at: now_ms() })
}

#[tauri::command]
pub async fn chatgpt_resets() -> Result<ChatgptResets, String> {
    blocking(chatgpt_resets_snapshot).await
}

pub fn chatgpt_use_reset_now(request_id: &str, credit_id: Option<&str>) -> Result<ResetOutcome, String> {
    if request_id.trim().is_empty() {
        return Err("falta el identificador del canje".into());
    }
    let mut payload = serde_json::json!({ "redeem_request_id": request_id });
    if let Some(credit) = credit_id.filter(|c| !c.is_empty()) {
        payload["credit_id"] = Value::from(credit);
    }
    let body = chatgpt_json(chatgpt_request("POST", "/rate-limit-reset-credits/consume", Duration::from_secs(30))?.send_json(payload))?;
    Ok(ResetOutcome {
        outcome: body["code"].as_str().unwrap_or("unknown").to_string(),
        windows_reset: body["windows_reset"].as_i64().unwrap_or(0),
    })
}

#[tauri::command]
pub async fn chatgpt_use_reset(request_id: String, credit_id: Option<String>) -> Result<ResetOutcome, String> {
    blocking(move || chatgpt_use_reset_now(&request_id, credit_id.as_deref())).await
}

fn go_window(w: &Value, window_seconds: i64) -> Option<QuotaWindow> {
    Some(QuotaWindow {
        used_percent: w["percent"].as_f64()?,
        window_seconds,
        resets_at: w["resetsAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis()),
    })
}

pub fn go_snapshot() -> Result<GoUsage, String> {
    let auth = crate::accounts::read_auth()?;
    let key = auth["opencode-go"]["key"]
        .as_str()
        .ok_or_else(|| "OpenCode Go no está conectado: pegá tu clave en Cuentas de IA".to_string())?;
    let now = now_ms();
    let body: Value = ureq::get(GO_USAGE_URL)
        .set("Authorization", &format!("Bearer {}", key))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => "OpenCode Go rechazó la clave: volvé a conectarla desde Cuentas de IA".to_string(),
            ureq::Error::Status(code, _) => format!("OpenCode Go respondió {}", code),
            other => format!("no se pudo consultar OpenCode Go: {}", other),
        })?
        .into_json()
        .map_err(|e| format!("respuesta de OpenCode Go ilegible: {}", e))?;
    let usage = &body["usage"];
    let windows = [
        ("rolling", 5 * 3600),
        ("weekly", 7 * 24 * 3600),
        ("monthly", 30 * 24 * 3600),
    ]
    .into_iter()
    .filter_map(|(name, seconds)| go_window(&usage[name], seconds))
    .collect();
    Ok(GoUsage { windows, measured_at: now })
}

#[tauri::command]
pub async fn go_usage() -> Result<GoUsage, String> {
    blocking(go_snapshot).await
}
