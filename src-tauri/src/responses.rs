use serde_json::{json, Value};
use tauri::AppHandle;

pub(crate) fn configure(app: &AppHandle, extra: Option<String>) -> Result<String, String> {
    let path = crate::app_data_file(app, "responses-guard.js")
        .ok_or("No se pudo preparar la protección de respuestas")?;
    std::fs::write(&path, include_str!("responses_guard.js"))
        .map_err(|e| format!("No se pudo instalar la protección de respuestas: {e}"))?;
    let module = crate::app_data_file(app, "provider-diagnostics.js")
        .ok_or("No se pudo preparar el diagnóstico del proveedor")?;
    std::fs::write(module, include_str!("provider-diagnostics.js"))
        .map_err(|e| format!("No se pudo instalar el diagnóstico del proveedor: {e}"))?;
    let diagnostics = crate::app_data_file(app, "provider-diagnostics.jsonl")
        .ok_or("No se pudo preparar el registro del proveedor")?;
    let budget = crate::app_data_file(app, "responses-budget.js")
        .ok_or("No se pudo preparar el presupuesto de transporte")?;
    std::fs::write(budget, include_str!("responses-budget.js"))
        .map_err(|e| format!("No se pudo instalar el presupuesto de transporte: {e}"))?;
    let mut config: Value = serde_json::from_str(extra.as_deref().unwrap_or("{}"))
        .map_err(|e| format!("Configuración del motor inválida: {e}"))?;
    let url = tauri::Url::from_file_path(path).map_err(|_| "Ruta de protección inválida")?;
    let entry = json!([url.as_str(), { "diagnosticsPath": diagnostics, "appVersion": app.package_info().version.to_string() }]);
    match config.get_mut("plugin") {
        Some(Value::Array(list)) => list.push(entry),
        _ => config["plugin"] = json!([entry]),
    }
    Ok(config.to_string())
}
