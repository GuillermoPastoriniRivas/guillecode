// Conservative transport budget, not a documented provider context limit.
// Count serialized UTF-8 including schemas, images and encrypted reasoning.
export const CHATGPT_REQUEST_BUDGET = 900 * 1024
const wireBytes = (text) => new TextEncoder().encode(text).byteLength

export function budgetChatGPTRequest(body) {
  if (wireBytes(body) <= CHATGPT_REQUEST_BUDGET) return body
  let request
  try { request = JSON.parse(body) } catch { return null }
  if (!Array.isArray(request.input)) return null
  // Keep message text, tool calls/IDs, reasoning and the latest eight results.
  // Only shorten old textual tool outputs in this outbound copy. The persisted
  // history remains authoritative, and omissions are explicit to the model.
  const results = request.input.filter((item) => item.type === "function_call_output")
  // A parallel batch may contain more than eight calls: keep that entire batch.
  let batchStart = request.input.length
  while (batchStart > 0 && ["function_call", "function_call_output"].includes(request.input[batchStart - 1]?.type)) batchStart--
  const currentBatch = new Set(request.input.slice(batchStart))
  for (const item of results.slice(0, -8)) {
    if (currentBatch.has(item)) continue
    if (typeof item.output !== "string" || wireBytes(item.output) <= 4096) continue
    const originalBytes = wireBytes(item.output)
    item.output = item.output.slice(0, 512)
      + `\n[GuilleCode: salida antigua abreviada para el presupuesto de transporte; original ${originalBytes} bytes. El contenido completo sigue en el historial local. No inferir datos omitidos; consultar de nuevo si son necesarios.]\n`
      + item.output.slice(-512)
    const serialized = JSON.stringify(request)
    if (wireBytes(serialized) <= CHATGPT_REQUEST_BUDGET) return serialized
  }
  // Never silently drop user attachments, tool pairs or current observations.
  return null
}
