import { create } from "zustand"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { confirmAction } from "../components/Dialog"
import { openEditor } from "./editors"
import { useLayout } from "./layout"
import { notify } from "./toasts"

export type PlaneFile = {
  key: string
  label: string
  hint: string
  file: string
  path: string
  exists: boolean
  edited: boolean
}
export type PlaneList = { files: PlaneFile[] }

export const usePlane = create<{
  data: PlaneList
  loaded: boolean
  error: string | null
  request: { key?: string; nonce: number } | null
}>(() => ({ data: { files: [] }, loaded: false, error: null, request: null }))

let requestNonce = 0

export async function loadPlane(): Promise<void> {
  if (!isTauri) {
    usePlane.setState({ loaded: true })
    return
  }
  try {
    const data = await call<PlaneList>("plane_list")
    usePlane.setState({ data, loaded: true, error: null })
  } catch (e) {
    usePlane.setState({ loaded: true, error: errorMessage(e) })
  }
}

export function openPlane(key?: string): void {
  useLayout.getState().showView("plane", false)
  usePlane.setState({ request: { key, nonce: ++requestNonce } })
  openEditor({ kind: "plane" })
}

export async function readPlane(key: string): Promise<string> {
  return call<string>("plane_read", { key })
}

export async function writePlane(key: string, body: string): Promise<void> {
  const result = await call<{ ok?: boolean; error?: string }>("plane_write", { key, body })
  if (!result?.ok) throw new Error(result?.error ?? "No se pudo guardar el archivo del plano")
  await loadPlane()
}

export async function resetPlane(key: string): Promise<boolean> {
  if (!(await confirmAction("Restaurar el original", "Se descarta tu versión de este archivo y vuelve a la que trae GuilleCode.", "Restaurar", true))) return false
  try {
    await call("plane_reset", { key })
    notify.info("Archivo restaurado al original")
    await loadPlane()
    return true
  } catch (e) {
    notify.error(errorMessage(e))
    return false
  }
}

export async function applyPlane(): Promise<boolean> {
  if (!(await confirmAction("Aplicar y reiniciar el motor", "El motor arranca de nuevo para tomar el plano nuevo: las conversaciones que estén trabajando se cortan, el resto se conserva.", "Reiniciar el motor", true))) return false
  try {
    await call("reload_engine")
    notify.info("Reiniciando el motor", "El agente vuelve con tu plano en unos segundos.")
    return true
  } catch (e) {
    notify.error(errorMessage(e))
    return false
  }
}
