import { emitTo } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri, onWindowEvent } from "../lib/tauri"
import { windowBubble } from "../lib/windows"
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

// Devuelve la conversación a la ventana de origen y cierra la burbuja.
export async function dockBubble(sessionId: string, origin: string): Promise<void> {
  await emitTo(origin, "bubble://dock", sessionId).catch(() => undefined)
  await getCurrentWindow().destroy().catch(() => undefined)
}
