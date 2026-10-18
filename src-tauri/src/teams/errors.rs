use serde_json::Value;

fn parts(value: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 8 {
        return;
    }
    match value {
        Value::String(text) => {
            let text = text.trim();
            if text.starts_with('{') || text.starts_with('[') {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    parts(&value, depth + 1, out);
                }
            } else {
                out.push(text.chars().take(64_000).collect());
            }
        }
        Value::Object(record) => {
            for key in [
                "code",
                "type",
                "message",
                "data",
                "error",
                "response",
                "responseBody",
            ] {
                if let Some(value) = record.get(key) {
                    parts(value, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

pub fn message(value: &Value) -> String {
    let mut messages = vec![];
    parts(value, 0, &mut messages);
    let text = messages.join(" ").to_lowercase();
    if [
        "usage_limit_reached",
        "usage limit has been reached",
        "rate_limit_exceeded",
        "rate limit",
        "quota exceeded",
        "insufficient_quota",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return "Alcanzaste el límite de uso de tu cuenta de IA. Esperá a que se restablezca o elegí un modelo de otra cuenta o proveedor y reintentá. Tus cambios se conservan.".into();
    }
    if [
        "invalid_api_key",
        "authentication_error",
        "unauthorized",
        "token expired",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return "La cuenta de IA necesita volver a conectarse. Revisá la conexión del proveedor y reintentá. Tus cambios se conservan.".into();
    }
    let result = messages.iter().rev().find(|s| s.chars().count() > 15);
    if let Some(result) = result {
        let lower = result.to_lowercase();
        if ![
            "responseheaders",
            "authorization",
            "bearer ",
            "cookie",
            "api_key",
            "access_token",
            "refresh_token",
            "https://",
            "http://",
        ]
        .iter()
        .any(|s| lower.contains(s))
        {
            return super::evidence::sanitize(result)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(400)
                .collect();
        }
    }
    "No se pudo completar la respuesta de IA. Revisá la cuenta o el modelo y reintentá.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quota_error_omits_transport_metadata() {
        let error = json!({"data":{"message":"The usage limit has been reached","responseBody":"{\"error\":{\"type\":\"usage_limit_reached\"}}","responseHeaders":{"set-cookie":"private-session","x-codex-turn-state":"private-state"}}});
        let text = message(&error);
        assert!(text.contains("límite de uso de tu cuenta"));
        assert!(!text.contains("private"));
        assert_eq!(message(&json!(error.to_string())), text);
    }

    #[test]
    fn unknown_structured_errors_never_dump_headers() {
        assert!(
            !message(&json!({"data":{"responseHeaders":{"cookie":"private"}}})).contains("private")
        );
        assert_eq!(
            message(&json!("El modelo de Backend no está disponible")),
            "El modelo de Backend no está disponible"
        );
    }
}
