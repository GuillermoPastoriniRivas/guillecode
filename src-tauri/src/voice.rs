use crate::app_data_file;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

pub const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct VoiceConfig {
    base_url: String,
    api_key: String,
    model: String,
    language: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    base_url: String,
    model: String,
    language: String,
    key_hint: Option<String>,
    ready: bool,
}

fn load(app: &AppHandle) -> VoiceConfig {
    app_data_file(app, "voice.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &VoiceConfig) {
    if let Some(path) = app_data_file(app, "voice.json") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

fn is_ready(config: &VoiceConfig) -> bool {
    !config.base_url.trim().is_empty() && !config.model.trim().is_empty()
}

fn view(config: &VoiceConfig) -> VoiceView {
    let key = config.api_key.trim();
    VoiceView {
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        language: config.language.clone(),
        key_hint: (!key.is_empty()).then(|| format!("…{}", key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>())),
        ready: is_ready(config),
    }
}

pub fn ready(app: &AppHandle) -> bool {
    is_ready(&load(app))
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "audio/ogg" | "audio/opus" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac" => "m4a",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/flac" | "audio/x-flac" => "flac",
        _ => "webm",
    }
}

fn multipart(boundary: &str, fields: &[(&str, &str)], filename: &str, mime: &str, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(data.len() + 1024);
    for (name, value) in fields {
        body.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n", boundary, name, value).as_bytes());
    }
    body.extend_from_slice(format!("--{}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n", boundary, filename, mime).as_bytes());
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    body
}

fn service_error(code: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v["error"]["message"].as_str().or_else(|| v["error"].as_str()).or_else(|| v["detail"].as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(240).collect());
    match code {
        401 | 403 => format!("El servicio rechazó la clave ({}): {}", code, message),
        404 => format!("No existe {} en ese servicio: revisá la URL base y el modelo. {}", "/audio/transcriptions", message),
        413 => "El audio es demasiado largo para el servicio".to_string(),
        429 => format!("El servicio está limitando pedidos o no hay saldo: {}", message),
        _ => format!("El servicio de transcripción respondió {}: {}", code, message),
    }
}

fn run(config: &VoiceConfig, audio: &[u8], mime: &str) -> Result<String, String> {
    if !is_ready(config) {
        return Err("Falta configurar la transcripción en GuilleCode (comando «Conectar el celular» → Audios)".into());
    }
    if audio.is_empty() {
        return Err("El audio llegó vacío".into());
    }
    if audio.len() > MAX_BYTES {
        return Err("El audio pesa más de 25 MB: grabá mensajes más cortos".into());
    }
    let mime = mime.split(';').next().unwrap_or("").trim();
    let mime = if mime.starts_with("audio/") { mime } else { "audio/webm" };
    let mut fields = vec![("model", config.model.trim()), ("response_format", "json")];
    if !config.language.trim().is_empty() {
        fields.push(("language", config.language.trim()));
    }
    let boundary = format!("guillecode{}", uuid::Uuid::new_v4().simple());
    let body = multipart(&boundary, &fields, &format!("audio.{}", extension(mime)), mime, audio);
    let url = format!("{}/audio/transcriptions", config.base_url.trim().trim_end_matches('/'));
    let mut request = ureq::post(&url)
        .set("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(180));
    if !config.api_key.trim().is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", config.api_key.trim()));
    }
    match request.send_bytes(&body) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| e.to_string())?;
            let parsed: Option<Value> = serde_json::from_str(&text).ok();
            Ok(match parsed {
                Some(v) => v["text"].as_str().unwrap_or_default().trim().to_string(),
                None => text.trim().to_string(),
            })
        }
        Err(ureq::Error::Status(code, resp)) => Err(service_error(code, &resp.into_string().unwrap_or_default())),
        Err(e) => Err(format!("No se pudo conectar con {}: {}", config.base_url, e)),
    }
}

pub fn transcribe(app: &AppHandle, audio: &[u8], mime: &str) -> Result<String, String> {
    run(&load(app), audio, mime)
}

fn silence_wav() -> Vec<u8> {
    let rate: u32 = 16000;
    let samples = rate / 2;
    let data_len = samples * 2;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(44 + data_len as usize, 0);
    wav
}

#[tauri::command]
pub fn voice_get(app: AppHandle) -> VoiceView {
    view(&load(&app))
}

#[tauri::command]
pub async fn voice_set(app: AppHandle, base_url: String, model: String, language: String, api_key: Option<String>) -> VoiceView {
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = load(&app);
        config.base_url = base_url.trim().to_string();
        config.model = model.trim().to_string();
        config.language = language.trim().to_string();
        if let Some(key) = api_key {
            config.api_key = key.trim().to_string();
        }
        save(&app, &config);
        view(&config)
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn voice_test(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run(&load(&app), &silence_wav(), "audio/wav").map(|_| ()))
        .await
        .unwrap()
}
