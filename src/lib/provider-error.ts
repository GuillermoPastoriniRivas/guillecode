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
  return /usage_limit_reached|usage limit has been reached|rate_limit_exceeded|rate limit|quota exceeded|insufficient_quota|límite de uso de tu cuenta/i.test(errorParts(error).join(" "))
}

export function readableProviderError(error: unknown): string {
  const parts = errorParts(error)
  const text = parts.join(" ")
  if (isAccountLimitError(error)) return "Alcanzaste el límite de uso de tu cuenta de IA. Esperá a que se restablezca o elegí un modelo de otra cuenta o proveedor y reintentá. Tus cambios se conservan."
  if (/invalid_api_key|authentication_error|unauthorized|token.*expired|expired.*token|incorrect api key/i.test(text)) return "La cuenta de IA necesita volver a conectarse. Revisá la conexión del proveedor y reintentá. Tus cambios se conservan."
  if (/model_not_found|model.*not (found|available)|does not have access to model/i.test(text)) return "El modelo elegido no está disponible para esta cuenta. Elegí otro modelo y reintentá."
  if (/context_length_exceeded|maximum context length|context window.*exceeded/i.test(text)) return "La conversación alcanzó el límite de contexto del modelo. Compactá el historial antes de continuar."
  if (/ECONNREFUSED|ECONNRESET|fetch failed|network error|connection.*(failed|closed)|timed? ?out/i.test(text)) return "Se interrumpió la conexión con el motor o el proveedor de IA. Comprobá la conexión y reintentá; tus cambios se conservan."
  const message = [...parts].reverse().find((part) => part.length > 15 && !/^[\w.-]+$/.test(part))
  if (!message || /responseHeaders|authorization|bearer\s|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|https?:\/\//i.test(message)) return "No se pudo completar la respuesta de IA. Revisá la cuenta o el modelo y reintentá."
  return message.replace(/[\r\n]+/g, " ").slice(0, 400)
}
