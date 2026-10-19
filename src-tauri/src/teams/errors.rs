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
    if ["does not support image", "does not support images", "image input is not supported", "unsupported image", "invalid image"].iter().any(|s| text.contains(s)) { return "El modelo no pudo leer la imagen. Comprobá el archivo y usá un modelo que admita imágenes".into(); }
    if [
        "usage_limit_reached",
        "subscription_sharing_usage_limit_exceeded",
        "usage limit has been reached",
        "rate_limit_exceeded",
        "rate limit",
        "quota exceeded",
        "insufficient_quota",
        "monthly spending limit",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        return "La cuenta o el proveedor alcanzó su límite de uso. Esperá a que se restablezca o elegí otro modelo o proveedor y reintentá. Tus cambios se conservan.".into();
    }
    if ["model_not_found", "unsupported_model", "does not have access to model"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "El modelo elegido no está disponible para esta cuenta. Elegí otro modelo desde la configuración del equipo y reintentá.".into();
    }
    if ["context_length_exceeded", "maximum context length", "context window exceeded"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "La conversación del agente superó el espacio que admite el modelo. Elegí un modelo con más contexto o dividí el objetivo en partes.".into();
    }
    if ["econnrefused", "econnreset", "err_connection", "connection refused", "connection failed", "connection closed", "fetch failed", "network error", "timed out", "etimedout", "enotfound"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "Se perdió la conexión con el motor o el proveedor de IA. Revisá que ambos estén disponibles y reintentá; tus cambios se conservan.".into();
    }
    if ["overloaded", "server is busy", "temporarily unavailable", "service unavailable", "http 503", "529"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "El proveedor de IA está ocupado o temporalmente fuera de servicio. Esperá un momento y reintentá; tus cambios se conservan.".into();
    }
    if text.contains("not a git repository") {
        return "El agente intentó usar Git, pero la carpeta elegida no tiene un repositorio Git. Eso no impide trabajar en esa carpeta: reintentá y, si vuelve a pasar, indicá en el objetivo que no use comandos Git.".into();
    }
    if text.contains("falta una comprobación satisfactoria observada") {
        return "El agente dio pruebas por aprobadas, pero falta el registro de su ejecución satisfactoria. Hay que repetir esa verificación; las tareas ya terminadas se conservan.".into();
    }
    if text.contains("plan debe contener entre 1 y 100 tareas") || text.contains("respuesta estructurada inválida") {
        return "El Lead no pudo preparar un plan de trabajo válido para este objetivo. Reintentá y el equipo volverá a organizar las tareas automáticamente.".into();
    }
    if text.contains("no such file or directory") || text.contains("la carpeta de trabajo no existe") {
        return "La carpeta seleccionada ya no está disponible. Comprobá que siga en esa ubicación y volvé a seleccionarla en el equipo.".into();
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
    if ["invalid_request", "bad request", "http 400", "request body is invalid"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "El proveedor rechazó el formato de esta solicitud. Revisá el objetivo y los archivos adjuntos; si vuelve a pasar, probá con un objetivo más breve.".into();
    }
    if ["permission denied", "insufficient permission", "forbidden", "http 403"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "La cuenta conectada no tiene permiso para usar este modelo o servicio. Revisá el acceso del proveedor o elegí otra cuenta.".into();
    }
    if ["request too large", "payload too large", "http 413"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "La solicitud es demasiado grande para el proveedor. Reducí los archivos o el contexto y reintentá.".into();
    }
    if ["content_filter", "safety_filter", "blocked by policy"]
        .iter()
        .any(|s| text.contains(s))
    {
        return "El proveedor bloqueó esta solicitud por sus reglas de contenido. Reformulá el objetivo y reintentá.".into();
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
            if ["the ", "request ", "unable to ", "failed to ", "internal server error", "bad gateway", "service unavailable"]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
            {
                return "El agente no pudo completar la tarea. Abrí su sesión en Actividad para ver el último paso; sus cambios se conservan. Corregí lo indicado y reintentá.".into();
            }
            let spanish = lower.chars().any(|ch| "áéíóúñ".contains(ch))
                || ["el ", "la ", "los ", "las ", "no ", "se ", "falta ", "guillecode ", "revisá ", "esperá "]
                    .iter()
                    .any(|prefix| lower.starts_with(prefix));
            if !spanish {
                return "El agente no pudo completar la tarea. Abrí su sesión en Actividad para ver el último paso; sus cambios se conservan. Corregí lo indicado y reintentá.".into();
            }
            return super::evidence::sanitize(result)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(400)
                .collect();
        }
    }
    if messages.iter().any(|s| s.starts_with('{') || s.starts_with('[')) {
        return "El proveedor de IA respondió con un error que GuilleCode no pudo interpretar. Revisá la conexión, la cuenta y el modelo; después reintentá. Tus cambios se conservan.".into();
    }
    "El agente no pudo completar la tarea. Abrí su sesión en Actividad para ver el último paso; sus cambios se conservan. Corregí lo indicado y reintentá.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quota_error_omits_transport_metadata() {
        let error = json!({"data":{"message":"The usage limit has been reached","responseBody":"{\"error\":{\"type\":\"usage_limit_reached\"}}","responseHeaders":{"set-cookie":"private-session","x-codex-turn-state":"private-state"}}});
        let text = message(&error);
        assert!(text.contains("alcanzó su límite de uso"));
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

    #[test]
    fn common_team_failures_explain_why_and_how_to_continue() {
        let no_git = message(&json!("fatal: not a git repository (or any of the parent directories): .git"));
        assert!(no_git.contains("no tiene un repositorio Git"));
        assert!(no_git.contains("no impide trabajar"));

        let checks = message(&json!("Falta una comprobación satisfactoria observada para cada comando declarado."));
        assert!(checks.contains("dio pruebas por aprobadas"));
        assert!(checks.contains("repetir esa verificación"));

        let unknown = message(&json!("The upstream request failed unexpectedly"));
        assert!(unknown.contains("El agente no pudo completar la tarea"));
        assert!(!unknown.contains("upstream"));
    }
}
