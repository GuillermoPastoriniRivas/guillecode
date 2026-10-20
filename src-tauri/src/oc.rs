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

// Only observational requests may be replayed. In particular, a failed POST
// acknowledgement says nothing about whether a command already took effect.
pub(crate) fn transient_read_error(error: &str) -> bool {
    let error = error.to_lowercase();
    error.starts_with("no se pudo hablar con opencode:")
        || [408, 500, 502, 503, 504].iter().any(|code| error.starts_with(&format!("opencode respondió {code}:")))
}

fn retry_read<T>(mut read: impl FnMut() -> Result<T, String>, mut wait: impl FnMut(Duration)) -> Result<T, String> {
    let delays = [300, 900, 1800];
    for attempt in 0..=delays.len() {
        match read() {
            Err(error) if attempt < delays.len() && transient_read_error(&error) => wait(Duration::from_millis(delays[attempt])),
            result => return result,
        }
    }
    unreachable!()
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

    pub fn get_resilient(&self, path: &str) -> Result<Value, String> {
        retry_read(|| self.get(path), std::thread::sleep)
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

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn temporary_observation_failures_recover_with_bounded_backoff() {
        let mut calls = 0;
        let mut delays = vec![];
        let value = retry_read(|| {
            calls += 1;
            if calls < 4 { Err("opencode respondió 503: unavailable".into()) } else { Ok(42) }
        }, |delay| delays.push(delay.as_millis())).unwrap();
        assert_eq!(value, 42);
        assert_eq!(calls, 4);
        assert_eq!(delays, vec![300, 900, 1800]);
        calls = 0;
        assert!(retry_read::<()>(|| { calls += 1; Err("no se pudo hablar con opencode: connection reset".into()) }, |_| {}).is_err());
        assert_eq!(calls, 4);
    }

    #[test]
    fn account_and_request_errors_do_not_retry() {
        for code in [400, 401, 402, 403, 404, 429] {
            let mut calls = 0;
            assert!(retry_read::<()>(|| { calls += 1; Err(format!("opencode respondió {code}: rejected")) }, |_| panic!("permanent error retried")).is_err());
            assert_eq!(calls, 1);
        }
    }
}
