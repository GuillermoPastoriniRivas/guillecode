type ErrorRecord = Record<string, unknown>

// Read only known error fields. Headers, request bodies and telemetry never
// become user-facing text, including when an old error was stored as JSON.
function errorParts(value: unknown, depth = 0): string[] {
  if (depth > 8 || value == null) return []
  if (value instanceof Error) return errorParts(value.message, depth + 1)
  if (typeof value === "string") {
    const text = value.slice(0, 64_000).trim()
    if (!text) return []
    if (text.startsWith("{") || text.startsWith("[")) {
      try { return errorParts(JSON.parse(text), depth + 1) } catch { return [] }
    }
    return [text]
  }
  if (typeof value !== "object" || Array.isArray(value)) return []
  const record = value as ErrorRecord
  return ["code", "type", "message", "data", "error", "response", "responseBody"].flatMap((key) => errorParts(record[key], depth + 1))
}

export function isAccountLimitError(error: unknown): boolean {
  return /usage_limit_reached|subscription_sharing_usage_limit_exceeded|usage limit|rate_limit_exceeded|rate limit|quota exceeded|insufficient_quota|monthly spending limit|límite de uso de tu cuenta/i.test(errorParts(error).join(" "))
}

export function readableProviderError(error: unknown): string {
  const parts = errorParts(error)
  const text = parts.join(" ")
  if (/does not support images?|image input is not supported|unsupported image|invalid image/i.test(text)) return "El modelo no pudo leer la imagen. Comprobá el archivo y usá un modelo que admita imágenes."
  if (isAccountLimitError(error)) return "La cuenta o el proveedor alcanzó su límite de uso. Esperá a que se restablezca o elegí otro modelo o proveedor y reintentá. Tus cambios se conservan."
  if (/invalid_api_key|authentication_error|unauthorized|token.*expired|expired.*token|incorrect api key/i.test(text)) return "La cuenta de IA necesita volver a conectarse. Revisá la conexión del proveedor y reintentá. Tus cambios se conservan."
  if (/model_not_found|model.*not (found|available)|does not have access to model|unsupported_model/i.test(text)) return "El modelo elegido no está disponible para esta cuenta. Elegí otro modelo desde la configuración del equipo y reintentá."
  if (/context_length_exceeded|maximum context length|context window.*exceeded/i.test(text)) return "La conversación alcanzó el límite de contexto del modelo. Compactá el historial antes de continuar."
  if (/ECONNREFUSED|ECONNRESET|ERR_CONNECTION|fetch failed|network error|connection.*(failed|closed|refused)|timed? ?out|ETIMEDOUT|ENOTFOUND/i.test(text)) return "Se perdió la conexión con el motor o el proveedor de IA. Revisá que ambos estén disponibles y reintentá; tus cambios se conservan."
  if (/overloaded|server is busy|temporarily unavailable|service unavailable|\bHTTP\s*503\b|\b529\b/i.test(text)) return "El proveedor de IA está ocupado o temporalmente fuera de servicio. Esperá un momento y reintentá; tus cambios se conservan."
  if (/invalid_request|bad request|\bHTTP\s*400\b|request body.*invalid/i.test(text)) return "El proveedor rechazó el formato de esta solicitud. Revisá el objetivo y los archivos adjuntos; si vuelve a pasar, probá con un objetivo más breve."
  if (/permission.?denied|insufficient permission|forbidden|\bHTTP\s*403\b/i.test(text)) return "La cuenta conectada no tiene permiso para usar este modelo o servicio. Revisá el acceso del proveedor o elegí otra cuenta."
  if (/request too large|payload too large|\bHTTP\s*413\b/i.test(text)) return "La solicitud es demasiado grande para el proveedor. Reducí los archivos o el contexto y reintentá."
  if (/content.?filter|safety.?filter|blocked by.*policy/i.test(text)) return "El proveedor bloqueó esta solicitud por sus reglas de contenido. Reformulá el objetivo y reintentá."
  const message = [...parts].reverse().find((part) => part.length > 15 && !/^[\w.-]+$/.test(part))
  if (!message || /responseHeaders|authorization|bearer\s|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|https?:\/\//i.test(message)) return "El proveedor no pudo completar la respuesta. Revisá la conexión, la cuenta y el modelo; después reintentá. Tus cambios se conservan."
  // Provider messages are often JSON or terse English status strings. Keep
  // safe Spanish diagnostics, but never show an opaque protocol error as a
  // complete explanation to the person using the app.
  if (/^(HTTP\s*)?\d{3}\b|^[\w.-]+$/.test(message)) return `El proveedor de IA rechazó la solicitud (${message.slice(0, 80)}). Revisá la cuenta o el modelo y reintentá.`
  if (/^(the |an? |request |unable to |failed to |error:|internal server error|bad gateway|service unavailable)/i.test(message)) return "El proveedor de IA no pudo completar la solicitud. Revisá la conexión, la cuenta y el modelo; después reintentá. Tus cambios se conservan."
  if (!/[áéíóúñ]/i.test(message) && !/^(el |la |los |las |no |se |falta |guillecode |la cuenta |la conversación)/i.test(message)) return "El proveedor de IA devolvió un error que no pudimos identificar. Revisá la conexión, la cuenta y el modelo; después reintentá. Tus cambios se conservan."
  return message.replace(/[\r\n]+/g, " ").slice(0, 240)
}

export function readableTeamError(error: unknown): string {
  const parts = errorParts(error)
  const text = parts.join(" ").replace(/[\r\n]+/g, " ").trim()
  const lower = text.toLowerCase()
  if (isAccountLimitError(error)) return readableProviderError(error)
  if (/invalid_api_key|authentication_error|unauthorized|token.*expired|model_not_found|unsupported_model|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|connection refused|fetch failed|network error|timed? ?out|overloaded|service unavailable|\bHTTP\s*\d{3}\b/i.test(text)) return readableProviderError(error)
  if (!text || text.startsWith("{") || text.startsWith("[")) return readableProviderError(error)
  if (/fatal: not a git repository|not a git repository|no es un repositorio git/i.test(text)) return "El agente intentó usar Git, pero la carpeta elegida no tiene un repositorio Git. Eso no impide trabajar en esa carpeta: reintentá y, si vuelve a pasar, indicá en el objetivo que no use comandos Git."
  if (/falta una comprobación satisfactoria observada|checks? (were )?not observed|no se pudo confirmar.*(prueba|comprobaci[oó]n)/i.test(text)) return "El agente dio pruebas por aprobadas, pero falta el registro de su ejecución satisfactoria. Hay que repetir esa verificación; las tareas ya terminadas se conservan."
  if (/plan debe contener entre 1 y 100 tareas|plan must contain between 1 and 100 tasks|respuesta estructurada inválida|invalid structured response/i.test(text)) return "El Lead no pudo preparar un plan de trabajo válido para este objetivo. Reintentá y el equipo volverá a organizar las tareas automáticamente."
  if (/la carpeta de trabajo no existe|directory does not exist|no such file or directory/i.test(text)) return "La carpeta seleccionada ya no está disponible. Comprobá que siga en esa ubicación y volvé a seleccionarla en el equipo."
  if (/no se puede leer la carpeta|permission denied|access is denied|acceso denegado/i.test(text)) return "GuilleCode no tiene permiso para leer la carpeta del proyecto. Revisá sus permisos y volvé a intentarlo."
  if (/el modelo agotó el contexto|context length|context window/i.test(text)) return "La conversación del agente superó el espacio que admite el modelo. Elegí un modelo con más contexto o dividí el objetivo en partes."
  if (/la sesión quedó inactiva sin respuesta final|worker interrupted unexpectedly|trabajador se interrumpió inesperadamente/i.test(text)) return "El agente dejó de responder antes de terminar la tarea. Sus cambios se conservan; abrí su sesión en Actividad y reintentá."
  if (/no hay tareas que puedan avanzar|el plan contiene un ciclo|espera circular|dependencias pendientes/i.test(text)) return "Las tareas quedaron esperando unas a otras y el equipo no puede avanzar. Reintentá para que el Lead reorganice las dependencias."
  if (/falta el team lead|lead inexistente|team lead/i.test(lower)) return "El equipo no tiene un responsable Lead disponible. Editá el equipo y asigná un integrante con ese rol."
  if (/connect econnrefused|connection refused|err_connection_refused|no respondió|failed to fetch/i.test(lower)) return "La aplicación del proyecto no respondió cuando GuilleCode intentó abrirla. Iniciá el proyecto y verificá que la dirección y el puerto estén correctos; después reintentá la captura."
  if (/capture|captura|screenshot|evidencia/i.test(lower) && /failed|error|falló|no disponible|unavailable|timeout/i.test(lower)) return `No se pudo obtener una de las evidencias visuales. Revisá que la aplicación del proyecto esté abierta y responda, y reintentá la captura.`
  if (/timed out|timeout|timedout/i.test(lower)) return "La operación tardó más de lo permitido. Comprobá que la aplicación o el proveedor siga respondiendo y reintentá."
  if (/invalid selector|no node found|selector.*not found/i.test(lower)) return "La captura no encontró uno de los elementos indicados en el flujo. Revisá el selector de la pantalla y volvé a intentarlo."
  if (/responseheaders|authorization|bearer\s|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|https?:\/\//i.test(text)) return readableProviderError(error)
  if (/^[\w.-]+$/.test(text) || /^(the |an? |request |unable to |failed to |error\b|fatal:|internal server error|bad gateway|service unavailable|exception|panicked at)/i.test(text)) return readableProviderError(error)
  return text.slice(0, 320)
}
