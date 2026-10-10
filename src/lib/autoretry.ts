import type { Message, Part } from "@opencode-ai/sdk"

export type RetryMessage = { info: Message; parts: Part[] }

export type RetryPromptPart = { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }
export const CONTINUE_INTERRUPTED_TURN = "La respuesta anterior se interrumpió. Continuá con el trabajo pendiente desde el último paso completado, usando el historial y los resultados de las herramientas. No reinicies la tarea ni repitas acciones que ya se completaron."

export const AUTO_RETRY_MAX = 3

// The engine already retries a provider call five times. These delays are extra
// breathing room after it gives up, so a transient 503 has time to clear.
const DELAYS_MS = [15_000, 45_000, 90_000]

export function isRetryableProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { name?: string; data?: { isRetryable?: boolean } }
  return e.name === "APIError" && e.data?.isRetryable === true
}

function isContextText(text: string): boolean {
  return /^#{1,2} Memoria fluws/.test(text)
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
  const last = messages.at(-1)
  return last?.info.role === "assistant" && last.info.time.completed && last.info.error ? last : null
}

export function retryPromptParts(messages: RetryMessage[], parentID: string): RetryPromptPart[] {
  const parent = messages.find((message) => message.info.id === parentID)
  const parts: RetryPromptPart[] = []
  if (parent && shouldAutoRetry(messages, parentID)) {
    for (const part of parent.parts) {
      if (part.type === "text" && !part.synthetic && part.text.trim() && !isContextText(part.text))
        parts.push({ type: "text", text: part.text })
      else if (part.type === "file")
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

export function autoRetryDelayMs(attempt: number): number {
  return DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)]
}
