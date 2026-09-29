import { getCurrentWindow } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { call, isTauri } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { dirtyPaths, saveAll } from "../editor/documents"
import { ask } from "../components/Dialog"
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

export async function requestQuit(): Promise<void> {
  const dirty = dirtyPaths()
  if (dirty.length > 0) {
    const choice = await ask(`Hay ${dirty.length} archivo${dirty.length === 1 ? "" : "s"} sin guardar`, {
      message: "¿Querés guardarlos antes de cerrar GuilleCode?",
      icon: "save",
      buttons: [
        { id: "cancel", label: "Cancelar" },
        { id: "discard", label: "Cerrar sin guardar" },
        { id: "save", label: "Guardar y cerrar", primary: true },
      ],
    })
    if (choice === "cancel" || choice === null) return
    if (choice === "save") await saveAll()
  }
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
