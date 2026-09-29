use crate::app_data_file;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const RECORD_SIZE: u32 = 4096;
const MAX_PAYLOAD: usize = 3000;
const SUBJECT: &str = "mailto:guillecode@localhost";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Attention,
    Done,
    Error,
    Test,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub attention: bool,
    pub done: bool,
    pub error: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { attention: true, done: true, error: true }
    }
}

impl Prefs {
    fn wants(&self, kind: Kind) -> bool {
        match kind {
            Kind::Attention => self.attention,
            Kind::Done => self.done,
            Kind::Error => self.error,
            Kind::Test => true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    endpoint: String,
    p256dh: String,
    auth: String,
    #[serde(default)]
    prefs: Prefs,
    #[serde(default)]
    created_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct Store {
    vapid: String,
    subscriptions: Vec<Subscription>,
}

pub struct PushState {
    key: SigningKey,
    store: Mutex<Store>,
}

pub struct Notice {
    pub kind: Kind,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub url: String,
}

fn b64(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

fn unb64(text: &str) -> Option<Vec<u8>> {
    let clean: String = text.trim().trim_end_matches('=').chars().map(|c| match c {
        '+' => '-',
        '/' => '_',
        other => other,
    }).collect();
    URL_SAFE_NO_PAD.decode(clean).ok()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn save(app: &AppHandle, store: &Store) {
    if let Some(path) = app_data_file(app, "push.json") {
        let _ = std::fs::write(path, serde_json::to_string_pretty(store).unwrap_or_default());
    }
}

pub fn start(app: &AppHandle) {
    let mut store: Store = app_data_file(app, "push.json")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let key = unb64(&store.vapid).and_then(|b| SigningKey::from_slice(&b).ok()).unwrap_or_else(|| {
        let key = SigningKey::random(&mut OsRng);
        store.vapid = b64(&key.to_bytes());
        store.subscriptions.clear();
        key
    });
    save(app, &store);
    app.manage(PushState { key, store: Mutex::new(store) });
}

pub fn public_key(app: &AppHandle) -> String {
    let state = app.state::<PushState>();
    let point = state.key.verifying_key().to_encoded_point(false);
    b64(point.as_bytes())
}

pub fn device_count(app: &AppHandle) -> usize {
    app.state::<PushState>().store.lock().unwrap().subscriptions.len()
}

pub fn subscribe(app: &AppHandle, body: &Value) -> Result<Value, String> {
    let endpoint = body["endpoint"].as_str().unwrap_or_default().to_string();
    let p256dh = body["keys"]["p256dh"].as_str().unwrap_or_default().to_string();
    let auth = body["keys"]["auth"].as_str().unwrap_or_default().to_string();
    if !endpoint.starts_with("https://") {
        return Err("la suscripción no tiene un endpoint https".into());
    }
    let ua = unb64(&p256dh).ok_or("clave p256dh inválida")?;
    PublicKey::from_sec1_bytes(&ua).map_err(|_| "clave p256dh inválida".to_string())?;
    if unb64(&auth).map(|a| a.len()).unwrap_or(0) != 16 {
        return Err("clave auth inválida".into());
    }
    let incoming: Option<Prefs> = serde_json::from_value(body["prefs"].clone()).ok();
    let state = app.state::<PushState>();
    let mut store = state.store.lock().unwrap();
    let prefs = match store.subscriptions.iter().position(|s| s.endpoint == endpoint) {
        Some(i) => {
            let sub = &mut store.subscriptions[i];
            sub.p256dh = p256dh;
            sub.auth = auth;
            if let Some(p) = incoming {
                sub.prefs = p;
            }
            sub.prefs.clone()
        }
        None => {
            let prefs = incoming.unwrap_or_default();
            store.subscriptions.push(Subscription { endpoint, p256dh, auth, prefs: prefs.clone(), created_at: now_secs() });
            prefs
        }
    };
    save(app, &store);
    Ok(json!({ "prefs": prefs }))
}

pub fn unsubscribe(app: &AppHandle, endpoint: &str) {
    let state = app.state::<PushState>();
    let mut store = state.store.lock().unwrap();
    store.subscriptions.retain(|s| s.endpoint != endpoint);
    save(app, &store);
}

fn remove_endpoint(app: &AppHandle, endpoint: &str) {
    log::info!("[push] suscripción vencida, la quito");
    unsubscribe(app, endpoint);
}

fn origin(endpoint: &str) -> String {
    let after = endpoint.find("://").map(|i| i + 3).unwrap_or(0);
    let end = endpoint[after..].find('/').map(|i| after + i).unwrap_or(endpoint.len());
    endpoint[..end].to_string()
}

fn vapid_header(key: &SigningKey, endpoint: &str) -> String {
    let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = json!({ "aud": origin(endpoint), "exp": now_secs() + 12 * 3600, "sub": SUBJECT });
    let input = format!("{}.{}", header, b64(claims.to_string().as_bytes()));
    let signature: Signature = key.sign(input.as_bytes());
    let public = key.verifying_key().to_encoded_point(false);
    format!("vapid t={}.{}, k={}", input, b64(&signature.to_bytes()), b64(public.as_bytes()))
}

fn encrypt(p256dh: &[u8], auth: &[u8], payload: &[u8]) -> Result<Vec<u8>, String> {
    let ua_public = PublicKey::from_sec1_bytes(p256dh).map_err(|_| "clave del dispositivo inválida".to_string())?;
    let ua_bytes = ua_public.to_encoded_point(false);
    let secret = EphemeralSecret::random(&mut OsRng);
    let as_bytes = secret.public_key().to_encoded_point(false);
    let shared = secret.diffie_hellman(&ua_public);

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_bytes.as_bytes());
    key_info.extend_from_slice(as_bytes.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), &shared.raw_secret_bytes()[..])
        .expand(&key_info, &mut ikm)
        .map_err(|e| e.to_string())?;

    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    hk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    hk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|e| e.to_string())?;

    let mut plain = payload.to_vec();
    plain.push(2);
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|e| e.to_string())?;
    let sealed = cipher.encrypt(&Nonce::from(nonce), plain.as_ref()).map_err(|e| e.to_string())?;

    let mut body = Vec::with_capacity(86 + sealed.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_bytes.as_bytes().len() as u8);
    body.extend_from_slice(as_bytes.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

fn truncate(text: &str, max: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        return clean;
    }
    format!("{}…", clean.chars().take(max.saturating_sub(1)).collect::<String>())
}

fn deliver(app: &AppHandle, sub: &Subscription, payload: &[u8]) -> Result<(), String> {
    let p256dh = unb64(&sub.p256dh).ok_or("clave p256dh inválida")?;
    let auth = unb64(&sub.auth).ok_or("clave auth inválida")?;
    let body = encrypt(&p256dh, &auth, payload)?;
    let authorization = vapid_header(&app.state::<PushState>().key, &sub.endpoint);
    let result = ureq::post(&sub.endpoint)
        .set("TTL", "86400")
        .set("Urgency", "high")
        .set("Content-Encoding", "aes128gcm")
        .set("Content-Type", "application/octet-stream")
        .set("Authorization", &authorization)
        .timeout(Duration::from_secs(20))
        .send_bytes(&body);
    match result {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(404 | 410, _)) => {
            remove_endpoint(app, &sub.endpoint);
            Err("la suscripción ya no existe".into())
        }
        Err(ureq::Error::Status(code, resp)) => Err(format!("el servicio de push respondió {}: {}", code, resp.into_string().unwrap_or_default().chars().take(200).collect::<String>())),
        Err(e) => Err(e.to_string()),
    }
}

fn payload(notice: &Notice) -> Vec<u8> {
    let mut body = truncate(&notice.body, 240);
    loop {
        let data = json!({
            "kind": notice.kind,
            "title": truncate(&notice.title, 80),
            "body": body,
            "tag": notice.tag,
            "url": notice.url,
        })
        .to_string()
        .into_bytes();
        if data.len() <= MAX_PAYLOAD || body.is_empty() {
            return data;
        }
        body = truncate(&body, body.chars().count() / 2);
    }
}

pub fn send(app: &AppHandle, notice: Notice, only: Option<&str>) -> Result<usize, String> {
    let targets: Vec<Subscription> = app
        .state::<PushState>()
        .store
        .lock()
        .unwrap()
        .subscriptions
        .iter()
        .filter(|s| only.map(|e| e == s.endpoint).unwrap_or(true) && s.prefs.wants(notice.kind))
        .cloned()
        .collect();
    if targets.is_empty() {
        return Ok(0);
    }
    let data = payload(&notice);
    let mut sent = 0;
    let mut last_error = None;
    for sub in &targets {
        match deliver(app, sub, &data) {
            Ok(()) => sent += 1,
            Err(e) => {
                log::warn!("[push] no se pudo enviar: {}", e);
                last_error = Some(e);
            }
        }
    }
    match (sent, last_error) {
        (0, Some(e)) => Err(e),
        _ => Ok(sent),
    }
}

pub fn send_in_background(app: &AppHandle, notice: Notice) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = send(&app, notice, None);
    });
}
