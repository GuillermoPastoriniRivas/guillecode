use crate::usage::{opencode_data, GO_PROVIDER};
use serde::Serialize;
use serde_json::Value;

pub fn available_models(catalog: &Value) -> Vec<(String, String)> {
    catalog["providers"].as_array().into_iter().flatten().filter(|p| {
        matches!(p["id"].as_str(), Some("openai" | "opencode" | "opencode-go")) &&
            p["options"]["apiKey"].as_str() != Some("public") &&
            (matches!(p["source"].as_str(), Some("api" | "env")) || p["options"]["apiKey"].as_str().map(|k| !k.is_empty()).unwrap_or(false))
    }).flat_map(|p| {
        let provider = p["id"].as_str().unwrap_or_default().to_string();
        p["models"].as_object().into_iter().flat_map(|models| models.values()).filter_map(move |m| {
            Some((provider.clone(), m["id"].as_str()?.to_string()))
        })
    }).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthEntry {
    pub id: String,
    pub kind: String,
}

pub fn read_auth() -> Result<Value, String> {
    let path = opencode_data().ok_or_else(|| "no encontré la carpeta de opencode".to_string())?.join("auth.json");
    let text = std::fs::read_to_string(&path).map_err(|_| "no encontré las credenciales de opencode (auth.json)".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("auth.json ilegible: {}", e))
}

#[tauri::command]
pub fn auth_entries() -> Result<Vec<AuthEntry>, String> {
    let path = opencode_data().ok_or("no encontré la carpeta de opencode")?.join("auth.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let auth = read_auth()?;
    Ok(auth
        .as_object()
        .map(|entries| {
            entries
                .iter()
                .map(|(id, v)| AuthEntry { id: id.clone(), kind: v["type"].as_str().unwrap_or_default().to_string() })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn validate_opencode_key(key: String) -> Result<(), String> {
    crate::proc::blocking(move || {
        let key = key.trim();
        if key.is_empty() || key.chars().any(char::is_whitespace) {
            return Err("Pegá una API key de OpenCode Go válida, sin espacios".into());
        }
        let response = ureq::get("https://opencode.ai/zen/go/v1/usage")
            .set("Authorization", &format!("Bearer {}", key))
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => "OpenCode Go rechazó la clave. Revisá que sea de una cuenta con Go activo".to_string(),
                ureq::Error::Status(429, _) => "OpenCode está limitando pedidos. Probá de nuevo en un momento".to_string(),
                ureq::Error::Status(code, _) => format!("OpenCode no pudo verificar la clave (HTTP {})", code),
                _ => "No se pudo conectar con OpenCode. Revisá tu conexión e intentá otra vez".to_string(),
            })?;
        let body: Value = response.into_json().map_err(|_| "OpenCode devolvió una respuesta ilegible".to_string())?;
        if !body["usage"].is_object() {
            return Err("OpenCode no devolvió la información de tu cuenta Go".into());
        }
        Ok(())
    }).await
}

const ZEN_PROVIDER: &str = "opencode";

#[tauri::command]
pub async fn set_opencode_zen(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::proc::blocking(move || {
        let auth = read_auth()?;
        if !enabled && auth.get(ZEN_PROVIDER).is_none() {
            return Ok(());
        }
        let server = crate::ensure_server(&app)?;
        let opencode = crate::oc::Opencode::new(&server, "");
        if enabled {
            let key = auth[GO_PROVIDER]
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty())
                .ok_or_else(|| "Primero conectá tu clave de OpenCode Go".to_string())?;
            opencode.put(&format!("/auth/{}", ZEN_PROVIDER), serde_json::json!({ "type": "api", "key": key }))?;
        } else {
            opencode.delete(&format!("/auth/{}", ZEN_PROVIDER))?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_engine_models_are_not_a_connected_account() {
        let catalog = json!({ "providers": [{ "id": "opencode", "source": "custom", "options": { "apiKey": "public" }, "models": { "free": { "id": "free" } } }] });
        assert!(available_models(&catalog).is_empty());
    }

    #[test]
    fn chatgpt_and_go_are_independent_accounts() {
        let chatgpt = json!({ "id": "openai", "source": "api", "options": { "apiKey": "opencode-oauth-dummy-key" }, "models": { "gpt": { "id": "gpt" } } });
        let go = json!({ "id": "opencode-go", "source": "api", "models": { "deepseek": { "id": "deepseek" } } });
        assert_eq!(available_models(&json!({ "providers": [chatgpt.clone()] })), vec![("openai".into(), "gpt".into())]);
        assert_eq!(available_models(&json!({ "providers": [go.clone()] })), vec![("opencode-go".into(), "deepseek".into())]);
        assert_eq!(available_models(&json!({ "providers": [chatgpt, go] })).len(), 2);
    }
}
