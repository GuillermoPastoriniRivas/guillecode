import { emitTo, listen } from "@tauri-apps/api/event"
import { getCurrentWindow, Window } from "@tauri-apps/api/window"
import type { Session } from "@opencode-ai/sdk"
import { isTauri, onWindowEvent } from "../lib/tauri"
import { windowBubble, windowLabel } from "../lib/windows"
import { draftRuntimeKey, patchSessionRuntime, sessionRuntime } from "./session-runtime"
import { client, modelKey, rememberSessionDirectory } from "../lib/opencode"
import { finishPendingInput } from "../lib/pending-input"
import { useProject } from "./project"
import { closeSessionTab, ensureSessionView, selectSession, useAgent } from "./agent"
import { notify } from "./toasts"

type Transfer = NonNullable<ReturnType<typeof sessionRuntime>["transfer"]> & { session: string }
const moving = new Set<string>()
const TIMEOUT = 12000
async function discardBubble(label: string) {
  try { await (await Window.getByLabel(label))?.destroy() } catch { /* source still owns the chat */ }
}

function prepareSession(session: string, fresh = false) {
  const s = useAgent.getState()
  const saved = sessionRuntime(session)
  const model = saved.model ?? s.model
  const agent = saved.agent ?? (fresh ? "escritorio" : s.agentName)
  const variants = { ...(saved.variants ?? s.variants) }
  // Default new desktop conversations to a supported interactive effort. An
  // existing conversation's explicit model/agent/effort must survive the move.
  const info = s.models.find(m => modelKey(m) === modelKey(model))
  const fast = ["low", "medium", "minimal"].find(v => info?.variants.includes(v))
  if (fresh && fast) variants[modelKey(model)] = fast
  if (!patchSessionRuntime(session, { agent, model, variants, context: saved.context ?? s.context })) {
    throw new Error("No se pudo guardar el estado del chat. Liberá espacio local antes de moverlo; el borrador sigue acá.")
  }
}

function pending(request: Transfer) {
  const saved = sessionRuntime(request.session).transfer
  return saved?.id === request.id && saved.state === "pending" && saved.expires > Date.now()
}

async function transfer(session: string, target: string) {
  const request: Transfer = { id: crypto.randomUUID(), session, source: windowLabel(), target, state: "pending", expires: Date.now() + TIMEOUT }
  if (!patchSessionRuntime(session, { transfer: request })) throw new Error("No se pudo guardar la transferencia del chat.")
  let resolve!: () => void
  const ready = new Promise<void>(r => { resolve = r })
  const off = await listen<string>("bubble://received", e => { if (e.payload === request.id) resolve() }, { target: request.source })
  let retry: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const send = () => emitTo(target, "bubble://attach", request)
    await send()
    retry = setInterval(() => void send().catch(() => undefined), 300)
    await Promise.race([ready, new Promise<void>(r => { timeout = setTimeout(r, TIMEOUT) })])
    const saved = sessionRuntime(session).transfer
    // A lost ACK is harmless if the destination durably accepted the transfer.
    if (saved?.id !== request.id || saved.state !== "received") {
      throw new Error("La otra ventana no confirmó la conversación. El chat sigue disponible acá.")
    }
  } catch (e) {
    const saved = sessionRuntime(session).transfer
    if (saved?.id === request.id && saved.state !== "received") {
      patchSessionRuntime(session, { transfer: { ...request, state: "cancelled" } })
    }
    throw e
  } finally { off(); clearInterval(retry); clearTimeout(timeout) }
}

export async function bubbleOut(sessionId: string): Promise<void> {
  if (!isTauri || !sessionId || moving.has(sessionId)) return
  moving.add(sessionId)
  let label: string | undefined
  try {
    await finishPendingInput(sessionId)
    prepareSession(sessionId)
    const session = useAgent.getState().sessions.find(s => s.id === sessionId)
    label = await windowBubble(sessionId, session?.title ?? null)
    await transfer(sessionId, label)
    closeSessionTab(sessionId)
  } catch (e) {
    // A failed move must not leave a second actionable copy of the chat.
    if (label) await discardBubble(label)
    notify.error("No se pudo sacar el chat como burbuja", String(e))
  } finally { moving.delete(sessionId) }
}

export async function bubbleDraft(): Promise<void> {
  if (!isTauri || moving.has("draft")) return
  moving.add("draft")
  const key = draftRuntimeKey(useProject.getState().root, windowLabel())
  let label: string | undefined
  try {
    await finishPendingInput(key)
    // Finishing a pending dictation may already have created the conversation.
    const active = useAgent.getState().activeSessionId
    if (active) { await bubbleOut(active); return }
    const created = (await client.session.create({ body: {} })).data as Session | undefined
    if (!created) throw new Error("El motor no devolvió la conversación")
    rememberSessionDirectory(created.id, created.directory)
    patchSessionRuntime(created.id, { ...sessionRuntime(key), transfer: undefined })
    prepareSession(created.id, true)
    // Keep the new conversation reachable if creating/hydrating the view fails.
    useAgent.setState(s => ({ sessions: [created, ...s.sessions], allSessions: [created, ...s.allSessions] }))
    selectSession(created.id)
    label = await windowBubble(created.id, created.title ?? null)
    await transfer(created.id, label)
    patchSessionRuntime(key, { draft: "", context: [] })
    closeSessionTab(created.id)
  } catch (e) {
    if (label) await discardBubble(label)
    notify.error("No se pudo abrir la conversación en una burbuja", String(e))
  } finally { moving.delete("draft") }
}

let listening = false
export function listenBubbleDock(): void {
  if (listening) return
  listening = true
  const loading = new Set<string>()
  onWindowEvent<Transfer>("bubble://attach", request => {
    if (!request?.session || request.target !== windowLabel() || loading.has(request.id)) return
    const saved = sessionRuntime(request.session).transfer
    if (saved?.id === request.id && saved.state === "received") {
      void emitTo(request.source, "bubble://received", request.id).catch(() => undefined)
      return
    }
    if (!pending(request)) return
    loading.add(request.id)
    void (async () => {
      try {
        const [result] = await Promise.all([
          client.session.get({ path: { id: request.session } }),
          ensureSessionView(request.session, true),
        ])
        const view = useAgent.getState().views[request.session]
        if (!view || view.loading || view.error || !result.data) throw new Error(view?.error ?? "No se pudo cargar el chat")
        if (!pending(request)) return // timeout/cancel during the REST request
        const session = result.data as Session
        rememberSessionDirectory(session.id, session.directory)
        useAgent.setState(s => ({ sessions: [session, ...s.sessions.filter(x => x.id !== session.id)],
          allSessions: [session, ...s.allSessions.filter(x => x.id !== session.id)] }))
        const previous = useAgent.getState().activeSessionId
        const wasOpen = useAgent.getState().openSessionIds.includes(request.session)
        selectSession(request.session)
        const win = getCurrentWindow()
        await win.unminimize(); await win.show(); await win.setFocus()
        if (!pending(request)) {
          if (!wasOpen) closeSessionTab(request.session)
          selectSession(previous)
          return
        }
        if (!patchSessionRuntime(request.session, { owner: windowLabel(), transfer: { ...request, state: "received" } })) {
          if (!wasOpen) closeSessionTab(request.session)
          selectSession(previous)
          throw new Error("No se pudo confirmar la transferencia")
        }
        await emitTo(request.source, "bubble://received", request.id)
      } catch (e) { notify.error("No se pudo recibir el chat", String(e)) }
      finally { loading.delete(request.id) }
    })()
  })
}

export async function minimizeBubble(): Promise<void> {
  try { await getCurrentWindow().minimize() }
  catch (e) { notify.error("No se pudo minimizar el chat", String(e)) }
}

export async function dockBubble(sessionId: string, origin: string): Promise<void> {
  if (moving.has(sessionId)) return
  moving.add(sessionId)
  try {
    await finishPendingInput(sessionId)
    prepareSession(sessionId)
    await transfer(sessionId, origin)
    await getCurrentWindow().destroy()
  } catch (e) { notify.error("No se pudo devolver el chat", String(e)) }
  finally { moving.delete(sessionId) }
}
