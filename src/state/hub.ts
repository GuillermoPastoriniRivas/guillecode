import { getCurrentWindow } from "@tauri-apps/api/window"
import { emitTo } from "@tauri-apps/api/event"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { call, isTauri, onWindowEvent } from "../lib/tauri"
import { isMainWindow, MAIN_WINDOW, windowLabel, windowsList } from "../lib/windows"
import { loadJson, saveJson } from "../lib/persist"
import { dirtyPaths, saveAll } from "../editor/documents"
import { ask, confirmAction } from "../components/Dialog"
import { disposeAllTerminals } from "./terminals"
import { notify } from "./toasts"

let hubCheck: Promise<boolean> | null = null

export function hubAvailable(): Promise<boolean> {
  hubCheck ??= isTauri
    ? call<boolean>("autostart_get").then(
        () => true,
        (e) => !String(e instanceof Error ? e.message : e).toLowerCase().includes("not found"),
      )
    : Promise.resolve(false)
  return hubCheck
}

export function closeToTray(): boolean {
  return loadJson("hub.closeToTray", true)
}

export function setCloseToTray(on: boolean): void {
  saveJson("hub.closeToTray", on)
  notify.info(
    on ? "Cerrar la ventana la manda a la bandeja" : "Cerrar la ventana sale de GuilleCode",
    on ? "Las rutinas y el acceso desde el celular siguen andando. Para salir: ícono de la bandeja → Salir." : "Las rutinas y el acceso desde el celular se cortan al cerrar.",
  )
}

export async function desktopNotice(title: string, body: string): Promise<void> {
  if (!isTauri) return
  let granted = await isPermissionGranted()
  if (!granted) granted = (await requestPermission()) === "granted"
  if (granted) sendNotification({ title, body })
}

export async function hideToTray(): Promise<void> {
  await getCurrentWindow().hide()
  if (loadJson("hub.trayHintShown", false)) return
  saveJson("hub.trayHintShown", true)
  await desktopNotice("GuilleCode sigue en la bandeja", "Las rutinas y las sesiones siguen corriendo. Para salir, usá el ícono de la bandeja → Salir.")
}

async function settleDirty(message: string): Promise<boolean> {
  const dirty = dirtyPaths()
  if (dirty.length === 0) return true
  const choice = await ask(`Hay ${dirty.length} archivo${dirty.length === 1 ? "" : "s"} sin guardar`, {
    message,
    icon: "save",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "discard", label: "Cerrar sin guardar" },
      { id: "save", label: "Guardar y cerrar", primary: true },
    ],
  })
  if (choice === "cancel" || choice === null) return false
  if (choice === "save") {
    await saveAll()
    return dirtyPaths().length === 0
  }
  return true
}

export async function closeThisWindow(fromQuit = false): Promise<boolean> {
  if (fromQuit && dirtyPaths().length > 0) {
    const win = getCurrentWindow()
    await win.unminimize().catch(() => undefined)
    await win.show().catch(() => undefined)
    await win.setFocus().catch(() => undefined)
  }
  if (!(await settleDirty("¿Querés guardarlos antes de cerrar esta ventana?"))) {
    if (fromQuit) await emitTo(MAIN_WINDOW, "hub://close-canceled", windowLabel()).catch(() => undefined)
    return false
  }
  disposeAllTerminals()
  await getCurrentWindow().destroy()
  return true
}

export function listenWindowClose(): void {
  if (!isTauri || isMainWindow()) return
  onWindowEvent("hub://close-window", () => void closeThisWindow(true))
}

async function closeOtherWindows(): Promise<boolean> {
  const others = (await windowsList().catch(() => [])).filter((w) => !w.main)
  if (others.length === 0) return true
  const ok = await confirmAction(
    others.length === 1 ? "Hay otra ventana abierta" : `Hay ${others.length} ventanas más abiertas`,
    "Salir de GuilleCode las cierra también. Si alguna tiene archivos sin guardar, te pregunta en esa ventana.",
    "Cerrar todo y salir",
  )
  if (!ok) return false
  let canceled = false
  const off = onWindowEvent("hub://close-canceled", () => {
    canceled = true
  })
  await call<void>("window_quit_begin").catch(() => undefined)
  try {
    for (const w of others) await emitTo(w.label, "hub://close-window").catch(() => undefined)
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline && !canceled) {
      await new Promise((r) => setTimeout(r, 300))
      const left = (await windowsList().catch(() => [])).filter((w) => !w.main)
      if (left.length === 0) return true
    }
  } finally {
    off()
  }
  await call<void>("window_quit_cancel").catch(() => undefined)
  notify.info("No se salió de GuilleCode", "Una ventana quedó abierta con archivos sin guardar")
  return false
}

export async function requestQuit(): Promise<void> {
  if (!isMainWindow()) {
    await closeThisWindow()
    return
  }
  if (!(await closeOtherWindows())) return
  if (!(await settleDirty("¿Querés guardarlos antes de cerrar GuilleCode?"))) {
    await call<void>("window_quit_cancel").catch(() => undefined)
    return
  }
  await call<void>("window_quit_begin").catch(() => undefined)
  disposeAllTerminals()
  if (await hubAvailable()) await call<void>("app_quit")
  else await getCurrentWindow().destroy()
}

export function autostartEnabled(): Promise<boolean> {
  return call<boolean>("autostart_get")
}

export async function toggleAutostart(): Promise<void> {
  try {
    const next = !(await autostartEnabled())
    const enabled = await call<boolean>("autostart_set", { enabled: next })
    notify.info(
      enabled ? "GuilleCode arranca con Windows" : "GuilleCode ya no arranca con Windows",
      enabled ? "Arranca oculto en la bandeja, así las rutinas corren aunque no lo abras." : "",
    )
  } catch (e) {
    notify.error("No se pudo cambiar el inicio con Windows", e instanceof Error ? e.message : String(e))
  }
}
