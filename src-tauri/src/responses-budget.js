import { createHash } from "node:crypto"

// Conservative transport budget, not a documented provider context limit.
// Count serialized UTF-8 including schemas, images and encrypted reasoning.
export const CHATGPT_REQUEST_BUDGET = 900 * 1024
const wireBytes = (text) => new TextEncoder().encode(text).byteLength
// Below this a textual output is not worth rewriting even under pressure.
const MIN_OUTPUT_BYTES = 4096

const shortenOutput = (output, originalBytes) => output.slice(0, 512)
  + `\n[Flufy: salida antigua abreviada para el presupuesto de transporte; original ${originalBytes} bytes. El contenido completo sigue en el historial local. No inferir datos omitidos; consultar de nuevo si son necesarios.]\n`
  + output.slice(-512)

const omitCapture = (originalBytes) => ({
  type: "input_text",
  text: `[Flufy: captura anterior omitida para el presupuesto de transporte; original ${originalBytes} bytes. El historial local conserva la imagen. No inferir datos omitidos; observá la pantalla de nuevo si es necesario.]`,
})

// Requests over the transport budget are reduced where possible and sent.
// This budget must never synthesize a local failure. Omissions are explicit to
// the model, the persisted history stays intact, and only outbound copies change.
export function budgetChatGPTRequest(body) {
  if (wireBytes(body) <= CHATGPT_REQUEST_BUDGET) return body
  let request
  try { request = JSON.parse(body) } catch { return body }
  if (!Array.isArray(request?.input)) return body
  const fits = () => {
    const serialized = JSON.stringify(request)
    return wireBytes(serialized) <= CHATGPT_REQUEST_BUDGET ? serialized : null
  }
  // Keep message text, tool calls/IDs, reasoning and the latest eight results.
  // Only shorten old textual tool outputs in this outbound copy. The persisted
  // history remains authoritative, and omissions are explicit to the model.
  const results = request.input.filter((item) => item?.type === "function_call_output")
  // A parallel batch may contain more than eight calls: keep that entire batch.
  let batchStart = request.input.length
  while (batchStart > 0 && ["function_call", "function_call_output"].includes(request.input[batchStart - 1]?.type)) batchStart--
  const currentBatch = new Set(request.input.slice(batchStart))
  const shorten = (item) => {
    if (typeof item.output !== "string" || wireBytes(item.output) <= MIN_OUTPUT_BYTES) return false
    item.output = shortenOutput(item.output, wireBytes(item.output))
    return true
  }
  for (const item of results.slice(0, -8)) {
    if (currentBatch.has(item)) continue
    if (!shorten(item)) continue
    const serialized = fits()
    if (serialized !== null) return serialized
  }
  // Only explicitly identified automatic captures are eligible. Unmarked
  // images (including legacy captures) may be user attachments: keep them.
  // Preserve the entire latest user message AND the newest automatic capture.
  const latestUser = request.input.findLastIndex((item) => item?.role === "user")
  const captures = []
  for (const [index, item] of request.input.entries()) {
    if (item?.role !== "user" || !Array.isArray(item.content)) continue
    const markers = new Set(item.content.flatMap((part) => part?.type === "input_text" && typeof part.text === "string"
      ? Array.from(part.text.matchAll(/\[Flufy desktop capture sha256:([a-f0-9]{64})\]/g), (match) => match[1]) : []))
    if (!markers.size) continue
    for (const [position, part] of item.content.entries()) {
      if (part?.type !== "input_image" || typeof part.image_url !== "string") continue
      const hash = createHash("sha256").update(part.image_url).digest("hex")
      if (markers.has(hash)) captures.push({ index, content: item.content, position })
    }
  }
  for (const { index, content, position } of captures.slice(0, -1)) {
    if (index >= latestUser) continue
    const originalBytes = wireBytes(content[position].image_url)
    // Replace the whole part: image-only fields (detail/file_id) are not valid
    // on input_text. Never mutate the persisted history or caller's objects.
    content[position] = omitCapture(originalBytes)
    const serialized = fits()
    if (serialized !== null) return serialized
  }
  // Still over budget: force the conversation down instead of failing locally.
  // Abbreviate remaining older tool outputs from oldest to newest. User text, tool
  // calls/IDs, reasoning, the latest output and the newest capture are kept.
  for (const item of results.slice(0, -1)) {
    if (!shorten(item)) continue
    const serialized = fits()
    if (serialized !== null) return serialized
  }
  // The last resort is to send the best-effort reduction even if it stays over the
  // local budget; if it is genuinely too large, the provider returns the error.
  return JSON.stringify(request)
}
