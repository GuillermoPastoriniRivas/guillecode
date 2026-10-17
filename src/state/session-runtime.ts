import { useSyncExternalStore } from "react"
import type { ModelRef } from "../lib/opencode"
import type { ContextItem } from "./agent"

export type SessionRuntime = {
  agent?: string; model?: ModelRef; variants?: Record<string, string>
  draft?: string; context?: ContextItem[]; owner?: string
  voice?: "recording" | "transcribing" | "idle"
  voiceStarted?: number; voiceEnded?: number; transcribedAt?: number
  submittedAt?: number; preparedAt?: number
  browserWindow?: number
  transfer?: { id: string; source: string; target: string; expires: number; state: "pending" | "received" | "cancelled" }
}
export function draftRuntimeKey(root: string | null, window: string) { return `draft:${root ?? ""}:${window}` }
const prefix = "guillecode:session-runtime:"
const listeners = new Set<() => void>()
const cache = new Map<string, { raw: string | null; value: SessionRuntime; volatile?: boolean }>()
const empty: SessionRuntime = {}
export function sessionRuntime(id: string | null): SessionRuntime {
  if (!id) return empty
  const previous = cache.get(id)
  let raw: string | null
  try { raw = localStorage.getItem(prefix + id) } catch { return previous?.value ?? empty }
  if (previous?.volatile) return previous.value
  if (previous?.raw === raw) return previous.value
  let value = empty
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed
  } catch { /* damaged draft */ }
  cache.set(id, { raw, value })
  return value
}
export function patchSessionRuntime(id: string, patch: Partial<SessionRuntime>) {
  const value = { ...sessionRuntime(id), ...patch }
  const raw = JSON.stringify(value)
  let persisted = true
  try { localStorage.setItem(prefix + id, raw) } catch { persisted = false }
  // Quota/storage failures must not discard typing or prevent sending. Moving
  // the view, however, requires persisted=true so the destination can read it.
  cache.set(id, { raw, value, volatile: !persisted })
  listeners.forEach(fn => fn())
  return persisted
}
window.addEventListener("storage", event => {
  if (event.key === null || event.key?.startsWith(prefix)) {
    if (event.key) cache.delete(event.key.slice(prefix.length))
    else cache.clear()
    listeners.forEach(fn => fn())
  }
})
export function useSessionRuntime(id: string | null) {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => sessionRuntime(id))
}
