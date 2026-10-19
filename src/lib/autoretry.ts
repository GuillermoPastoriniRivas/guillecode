import type { Message, Part } from "@opencode-ai/sdk"
import { INTERNAL_SCREENSHOT_FILENAME, isDesktopContextText } from "./internal-context.ts"
import { isAccountLimitError, readableProviderError } from "./provider-error.ts"

export type RetryMessage = { info: Message; parts: Part[] }
export type RetryContext = { model: { providerID: string; modelID: string }; agent: string; variant?: string; directory: string }

export function retryContext(messages: RetryMessage[], failed: RetryMessage): RetryContext {
  if (failed.info.role !== "assistant") throw new Error("La respuesta no pertenece al agente.")
  const parentID = failed.info.parentID
  const parent = messages.find((message) => message.info.id === parentID)?.info
  // User metadata is persisted by the engine. Never borrow the picker from
  // another tab, including when the original parent has left the history page.
  const original = parent?.role === "user" ? parent : null
  const variant = (original?.model as { variant?: string } | undefined)?.variant ?? (original as (typeof original & { variant?: string }))?.variant
  const agent = original?.agent ?? (failed.info as Message & { agent?: string }).agent ?? failed.info.mode
  if (!agent) throw new Error("No se pudo recuperar el agente original de la respuesta.")
  return {
    model: { providerID: original?.model.providerID ?? failed.info.providerID, modelID: original?.model.modelID ?? failed.info.modelID },
    agent, ...(variant ? { variant } : {}), directory: failed.info.path.cwd,
  }
}

export type RetryPromptPart = { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }
export const CONTINUE_INTERRUPTED_TURN = "La respuesta anterior se interrumpió. Continuá con el trabajo pendiente desde el último paso completado, usando el historial y los resultados de las herramientas. No reinicies la tarea ni repitas acciones que ya se completaron."

function interruptedStream(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const message = (error as { data?: { message?: string } }).data?.message
  if (!message) return null
  try {
    const event = JSON.parse(message)
    return event?.response?.error?.code === "guillecode_interrupted_stream" ? event.response.error.message : null
  } catch { return null }
}

export function isUpstreamBufferError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const data = (error as { data?: { message?: unknown; responseBody?: unknown } }).data
  return [data?.message, data?.responseBody].some((text) => typeof text === "string"
    && /exceeded request buffer limit while retrying upstream|request_payload_exceeded_retry_buffer_limit/i.test(text))
}

export function providerErrorMessage(error: { name?: string; data?: { message?: string } }): string | undefined {
  if (isUpstreamBufferError(error))
    return "El servidor de IA superó su búfer al intentar reenviar la solicitud. No es falta de espacio en tu PC. Compactá la conversación para intentar continuar desde el último paso."
  return interruptedStream(error) ?? readableProviderError(error)
}

export function isRetryableProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if (isAccountLimitError(error)) return false
  const e = error as { name?: string; data?: { isRetryable?: boolean } }
  // Some gateways return 507 with isRetryable=false. Replaying the same request
  // is not useful, but compacting can recover it without losing the conversation.
  return isUpstreamBufferError(error) || (e.name === "APIError" && e.data?.isRetryable === true)
}

function isContextText(text: string): boolean {
  return /^#{1,2} Memoria fluws/.test(text) || isDesktopContextText(text)
}

function hasVisibleUserContent(message: RetryMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === "file") return true
    if (part.type !== "text") return false
    const text = part.text.trim()
    return !part.synthetic && text.length > 0 && !isContextText(text)
  })
}

export function lastVisibleUserMessage(messages: RetryMessage[]): RetryMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    if (hasVisibleUserContent(message)) return message
  }
  return null
}

export function latestFailedAssistant(messages: RetryMessage[]): RetryMessage | null {
  // Compaction is an intermediate step, not a resumed user turn. If admission
  // of the continuation fails, keep the original recovery action available,
  // including after reloading or opening the conversation in another window.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role === "assistant" && message.info.summary) continue
    if (message.info.role === "user" && message.parts.length && message.parts.every((part) => part.type === "compaction")) continue
    return message.info.role === "assistant" && message.info.time.completed && message.info.error ? message : null
  }
  return null
}

export function retryPromptParts(messages: RetryMessage[], parentID: string): RetryPromptPart[] {
  const last = messages.at(-1)?.info
  if (last?.role === "assistant" && interruptedStream(last.error)) return [{ type: "text", text: CONTINUE_INTERRUPTED_TURN }]
  const parent = messages.find((message) => message.info.id === parentID)
  const parts: RetryPromptPart[] = []
  if (parent && shouldAutoRetry(messages, parentID)) {
    for (const part of parent.parts) {
      if (part.type === "text" && !part.synthetic && part.text.trim() && !isContextText(part.text))
        parts.push({ type: "text", text: part.text })
      else if (part.type === "file" && part.filename !== INTERNAL_SCREENSHOT_FILENAME)
        parts.push({ type: "file", mime: part.mime, url: part.url, filename: part.filename ?? "" })
    }
  }
  // A long turn can outlive the message page, and its parent can be synthetic.
  // In either case resume from the existing history instead of silently doing
  // nothing or replaying a task that already produced side effects.
  return parts.length ? parts : [{ type: "text", text: CONTINUE_INTERRUPTED_TURN }]
}

export function retryMessageID(): string {
  const time = (BigInt(Date.now()) << 12n).toString(16).padStart(12, "0")
  const random = Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => b.toString(16).padStart(2, "0")).join("")
  return `msg_${time}${random}`
}

// Replaying a turn that already ran tools could repeat side effects, so only a
// turn with no tool parts is safe to resend automatically.
export function turnExecutedTools(messages: RetryMessage[], parentID: string): boolean {
  const start = messages.findIndex((message) => message.info.id === parentID)
  if (start === -1) return true
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message.info.role === "user") break
    if (message.parts.some((part) => part.type === "tool")) return true
  }
  return false
}

export function shouldAutoRetry(messages: RetryMessage[], parentID: string): boolean {
  return !turnExecutedTools(messages, parentID)
}
