import { invoke, Channel } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export const isTauri = typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined"

export class DesktopOnlyError extends Error {
  constructor() {
    super("Disponible solo en la app de escritorio")
  }
}

function toError(e: unknown): Error {
  if (e instanceof Error) return e
  if (typeof e === "string") return new Error(e)
  if (e && typeof e === "object" && "message" in e) return new Error(String((e as { message: unknown }).message))
  return new Error(String(e))
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new DesktopOnlyError()
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw toError(e)
  }
}

export function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri) return () => undefined
  let disposed = false
  let unlisten: UnlistenFn | null = null
  listen<T>(name, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

export { Channel }

export function errorMessage(e: unknown): string {
  return toError(e).message
}
