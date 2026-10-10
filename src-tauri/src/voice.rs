use crate::whisper;
use crate::app_data_file;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

pub const MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct VoiceConfig {
    /// "local" = Whisper en esta PC; cualquier otra cosa (vacío) = servicio compatible con OpenAI.
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    language: String,
    /// Tamaño del modelo de Whisper local (base/small/medium/large-v3-turbo).
    local_model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    kind: String,
    base_url: String,
    model: String,
    language: String,
    local_model: String,
    key_hint: Option<String>,
    ready: bool,
}

fn is_local(config: &VoiceConfig) -> bool {
    config.kind.trim() == "local"
}

fn local_size(config: &VoiceConfig) -> String {
    let size = config.local_model.trim();
    if size.is_empty() {
        whisper::DEFAULT_SIZE.to_string()
    } else {
        size.to_string()
    }
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

fn is_ready(app: &AppHandle, config: &VoiceConfig) -> bool {
    if is_local(config) {
        whisper::available(app) && whisper::model_present(app, &local_size(config))
    } else {
        !config.base_url.trim().is_empty() && !config.model.trim().is_empty()
    }
}

fn view(app: &AppHandle, config: &VoiceConfig) -> VoiceView {
    let key = config.api_key.trim();
    VoiceView {
        kind: if is_local(config) { "local".into() } else { "cloud".into() },
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        language: config.language.clone(),
        local_model: local_size(config),
        key_hint: (!key.is_empty()).then(|| format!("…{}", key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>())),
        ready: is_ready(app, config),
    }
}

pub fn ready(app: &AppHandle) -> bool {
    is_ready(app, &load(app))
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

/// Resuelve a dónde mandar el audio según el modo. En local levanta (o reusa)
/// el `whisper-server` de whisper.cpp y devuelve su endpoint compatible OpenAI.
fn endpoint(app: &AppHandle, config: &VoiceConfig) -> Result<(String, String, String), String> {
    if is_local(config) {
        if !whisper::available(app) {
            return Err("El motor de Whisper no está instalado en esta PC".into());
        }
        let size = local_size(config);
        if !whisper::model_present(app, &size) {
            return Err(format!("Falta descargar el modelo de Whisper «{}» (GuilleCode → Audios)", size));
        }
        let port = whisper::ensure(app, &size)?;
        Ok((format!("http://127.0.0.1:{}/v1", port), "whisper-1".to_string(), String::new()))
    } else {
        if !is_ready(app, config) {
            return Err("Falta configurar la transcripción en GuilleCode (comando «Conectar el celular» → Audios)".into());
        }
        Ok((config.base_url.trim().trim_end_matches('/').to_string(), config.model.trim().to_string(), config.api_key.trim().to_string()))
    }
}

fn run(app: &AppHandle, config: &VoiceConfig, audio: &[u8], mime: &str) -> Result<String, String> {
    if audio.is_empty() {
        return Err("El audio llegó vacío".into());
    }
    if audio.len() > MAX_BYTES {
        return Err("El audio pesa más de 25 MB: grabá mensajes más cortos".into());
    }
    let mime = mime.split(';').next().unwrap_or("").trim();
    let mime = if mime.starts_with("audio/") { mime } else { "audio/webm" };
    let (base_url, model, api_key) = endpoint(app, config)?;
    let mut fields = vec![("model", model.as_str()), ("response_format", "json")];
    if !config.language.trim().is_empty() {
        fields.push(("language", config.language.trim()));
    }
    let boundary = format!("guillecode{}", uuid::Uuid::new_v4().simple());
    let body = multipart(&boundary, &fields, &format!("audio.{}", extension(mime)), mime, audio);
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let mut request = ureq::post(&url)
        .set("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(180));
    if !api_key.is_empty() {
        request = request.set("Authorization", &format!("Bearer {}", api_key));
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
        Err(e) => Err(format!("No se pudo conectar con {}: {}", base_url, e)),
    }
}

pub fn transcribe(app: &AppHandle, audio: &[u8], mime: &str) -> Result<String, String> {
    run(app, &load(app), audio, mime)
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
    view(&app, &load(&app))
}

#[tauri::command]
pub async fn voice_set(app: AppHandle, kind: String, base_url: String, model: String, language: String, local_model: String, api_key: Option<String>) -> VoiceView {
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = load(&app);
        config.kind = if kind.trim() == "local" { "local".into() } else { "cloud".into() };
        config.base_url = base_url.trim().to_string();
        config.model = model.trim().to_string();
        config.language = language.trim().to_string();
        config.local_model = local_model.trim().to_string();
        if let Some(key) = api_key {
            config.api_key = key.trim().to_string();
        }
        save(&app, &config);
        view(&app, &config)
    })
    .await
    .unwrap()
}

#[tauri::command]
pub async fn voice_test(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, &load(&app), &silence_wav(), "audio/wav").map(|_| ()))
        .await
        .unwrap()
}

/// Transcripción desde el chat de escritorio. El frontend manda el WAV crudo
/// como cuerpo binario (`ArrayBuffer`) para no serializar megabytes en JSON.
#[tauri::command]
pub async fn voice_transcribe(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let audio: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => value
            .get("audio")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().filter_map(|n| n.as_u64().map(|x| x as u8)).collect())
            .ok_or("El audio llegó en un formato inesperado")?,
    };
    tauri::async_runtime::spawn_blocking(move || transcribe(&app, &audio, "audio/wav"))
        .await
        .map_err(|e| e.to_string())?
}
