import { createHash } from "node:crypto"

// Conservative transport budget, not a documented provider context limit.
// Count serialized UTF-8 including schemas, images and encrypted reasoning.
export const CHATGPT_REQUEST_BUDGET = 900 * 1024
const wireBytes = (text) => new TextEncoder().encode(text).byteLength

export function budgetChatGPTRequest(body) {
  if (wireBytes(body) <= CHATGPT_REQUEST_BUDGET) return body
  let request
  try { request = JSON.parse(body) } catch { return null }
  if (!Array.isArray(request?.input)) return null
  // Keep message text, tool calls/IDs, reasoning and the latest eight results.
  // Only shorten old textual tool outputs in this outbound copy. The persisted
  // history remains authoritative, and omissions are explicit to the model.
  const results = request.input.filter((item) => item?.type === "function_call_output")
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
  // Only explicitly identified automatic captures are eligible. Unmarked
  // images (including legacy captures) may be user attachments: keep them.
  // Preserve the entire latest user message AND the newest automatic capture.
  const latestUser = request.input.findLastIndex((item) => item?.role === "user")
  const images = []
  for (const [index, item] of request.input.entries()) {
    if (item?.role !== "user" || !Array.isArray(item.content)) continue
    const markers = new Set(item.content.flatMap((part) => part?.type === "input_text" && typeof part.text === "string"
      ? Array.from(part.text.matchAll(/\[GuilleCode desktop capture sha256:([a-f0-9]{64})\]/g), (match) => match[1]) : []))
    if (!markers.size) continue
    for (const [position, part] of item.content.entries()) {
      if (part?.type !== "input_image" || typeof part.image_url !== "string") continue
      const hash = createHash("sha256").update(part.image_url).digest("hex")
      if (markers.has(hash)) images.push({ index, content: item.content, position })
    }
  }
  for (const { index, content, position } of images.slice(0, -1)) {
    if (index >= latestUser) continue
    const originalBytes = wireBytes(content[position].image_url)
    // Replace the whole part: image-only fields (detail/file_id) are not valid
    // on input_text. Never mutate the persisted history or caller's objects.
    content[position] = { type: "input_text", text: `[GuilleCode: captura anterior omitida para el presupuesto de transporte; original ${originalBytes} bytes. El historial local conserva la imagen. No inferir datos omitidos; observá la pantalla de nuevo si es necesario.]` }
    const serialized = JSON.stringify(request)
    if (wireBytes(serialized) <= CHATGPT_REQUEST_BUDGET) return serialized
  }
  // Everything omitted above is explicit to the model: user text, tool pairs
  // and the current observation are never dropped silently.
  return null
}
