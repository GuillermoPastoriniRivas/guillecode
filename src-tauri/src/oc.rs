use crate::ServerConfig;
use serde_json::Value;
use std::time::Duration;

pub fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn basic_auth(server: &ServerConfig) -> String {
    format!("Basic {}", base64(format!("{}:{}", server.username, server.password).as_bytes()))
}

pub struct Opencode {
    base: String,
    auth: String,
    directory: String,
}

fn describe(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            format!("opencode respondió {}: {}", code, body.chars().take(300).collect::<String>())
        }
        other => format!("no se pudo hablar con opencode: {}", other),
    }
}

fn parse(text: String) -> Value {
    if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }
}

impl Opencode {
    pub fn new(server: &ServerConfig, directory: &str) -> Self {
        Opencode { base: server.url.clone(), auth: basic_auth(server), directory: directory.to_string() }
    }

    pub fn get(&self, path: &str) -> Result<Value, String> {
        let resp = ureq::get(&format!("{}{}", self.base, path))
            .query("directory", &self.directory)
            .set("Authorization", &self.auth)
            .timeout(Duration::from_secs(30))
            .call()
            .map_err(describe)?;
        Ok(parse(resp.into_string().map_err(|e| e.to_string())?))
    }

    pub fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = ureq::post(&format!("{}{}", self.base, path))
            .query("directory", &self.directory)
            .set("Authorization", &self.auth)
            .timeout(Duration::from_secs(60))
            .send_json(body)
            .map_err(describe)?;
        Ok(parse(resp.into_string().map_err(|e| e.to_string())?))
    }

    pub fn put(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = ureq::put(&format!("{}{}", self.base, path))
            .set("Authorization", &self.auth)
            .timeout(Duration::from_secs(30))
            .send_json(body)
            .map_err(describe)?;
        Ok(parse(resp.into_string().map_err(|e| e.to_string())?))
    }

    pub fn delete(&self, path: &str) -> Result<Value, String> {
        let resp = ureq::delete(&format!("{}{}", self.base, path))
            .set("Authorization", &self.auth)
            .timeout(Duration::from_secs(30))
            .call()
            .map_err(describe)?;
        Ok(parse(resp.into_string().map_err(|e| e.to_string())?))
    }
}
