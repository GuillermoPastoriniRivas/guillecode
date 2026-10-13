import { emitTo } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { Session } from "@opencode-ai/sdk"
import { isTauri, onWindowEvent } from "../lib/tauri"
import { windowBubble } from "../lib/windows"
import { client, rememberSessionDirectory } from "../lib/opencode"
import { closeSessionTab, ensureSessionView, selectSession, useAgent } from "./agent"
import { notify } from "./toasts"

// Saca una conversación de esta ventana y la abre como burbuja flotante. Una vez
// creada la ventana, la pestaña local se cierra: el chat "sale" de GuilleCode
// para vivir en la burbuja, y vuelve al acoplárselo.
export async function bubbleOut(sessionId: string): Promise<void> {
  if (!isTauri || !sessionId) return
  const session = useAgent.getState().sessions.find((s) => s.id === sessionId)
  try {
    await windowBubble(sessionId, session?.title ?? null)
  } catch (e) {
    notify.error("No se pudo sacar el chat como burbuja", e instanceof Error ? e.message : String(e))
    return
  }
  closeSessionTab(sessionId)
}

// Saca la conversación todavía "nueva" (sin sesión) como burbuja: crea la sesión
// y la abre directo ahí, para poder empezar a escribir en la burbuja. La ventana
// principal queda en una conversación nueva vacía.
export async function bubbleDraft(): Promise<void> {
  if (!isTauri) return
  let created: Session | undefined
  try {
    created = (await client.session.create({ body: {} })).data as Session | undefined
  } catch (e) {
    notify.error("No se pudo abrir la conversación en una burbuja", e instanceof Error ? e.message : String(e))
    return
  }
  if (!created) {
    notify.error("No se pudo abrir la conversación en una burbuja", "El motor no devolvió la conversación")
    return
  }
  rememberSessionDirectory(created.id, created.directory)
  try {
    await windowBubble(created.id, created.title ?? null)
  } catch (e) {
    notify.error("No se pudo sacar el chat como burbuja", e instanceof Error ? e.message : String(e))
  }
}

// La burbuja avisa a la ventana de la que salió y se destruye: la conversación
// vuelve a las pestañas de esa ventana. Todas las ventanas normales escuchan.
export function listenBubbleDock(): void {
  onWindowEvent<string>("bubble://dock", (sessionId) => {
    if (!sessionId) return
    const win = getCurrentWindow()
    void win.unminimize().catch(() => undefined)
    void win.show().catch(() => undefined)
    void win.setFocus().catch(() => undefined)
    selectSession(sessionId)
    void ensureSessionView(sessionId, true)
  })
}

// Minimiza la ventana sin cerrar el chat ni perder el borrador. Se recupera
// desde la barra de tareas de Windows.
export async function minimizeBubble(): Promise<void> {
  try {
    await getCurrentWindow().minimize()
  } catch (e) {
    notify.error("No se pudo minimizar el chat", e instanceof Error ? e.message : String(e))
  }
}

// Devuelve la conversación a la ventana de origen y cierra la burbuja.
export async function dockBubble(sessionId: string, origin: string): Promise<void> {
  await emitTo(origin, "bubble://dock", sessionId).catch(() => undefined)
  await getCurrentWindow().destroy().catch(() => undefined)
}
