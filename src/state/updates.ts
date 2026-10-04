import { create } from "zustand"
import { isMainWindow } from "../lib/windows"
import { getVersion } from "@tauri-apps/api/app"
import { ask } from "../components/Dialog"
import { dirtyPaths, saveAll } from "../editor/documents"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { useAgent } from "./agent"
import { useTerminals } from "./terminals"

type UpdateInfo = { version: string; currentVersion: string; notes: string }
type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing"
type UpdateState = {
  open: boolean
  version: string
  update: UpdateInfo | null
  phase: Phase
  downloaded: number
  total: number | null
  error: string | null
  checkedAt: number | null
}

export const useUpdates = create<UpdateState>(() => ({
  open: false, version: "", update: null, phase: "idle", downloaded: 0, total: null, error: null, checkedAt: null,
}))

export function showUpdates(): void {
  useUpdates.setState({ open: true })
  if (!useUpdates.getState().checkedAt) void checkUpdates()
}

export async function checkUpdates(): Promise<void> {
  const { phase } = useUpdates.getState()
  if (!isTauri || ["checking", "downloading", "ready", "installing"].includes(phase)) return
  useUpdates.setState({ phase: "checking", error: null })
  try {
    const update = await call<UpdateInfo | null>("update_check")
    useUpdates.setState({ update, phase: update ? "available" : "idle", checkedAt: Date.now() })
  } catch (e) {
    useUpdates.setState({ phase: useUpdates.getState().update ? "available" : "idle", error: errorMessage(e), checkedAt: Date.now() })
  }
}

export async function downloadUpdate(): Promise<void> {
  if (useUpdates.getState().phase !== "available") return
  useUpdates.setState({ phase: "downloading", downloaded: 0, total: null, error: null })
  try {
    await call("update_download")
    useUpdates.setState({ phase: "ready" })
  } catch (e) {
    useUpdates.setState({ phase: "available", error: `No se pudo descargar o verificar la actualización: ${errorMessage(e)}` })
  }
}

let confirming = false
export async function installUpdate(): Promise<void> {
  if (confirming || useUpdates.getState().phase !== "ready") return
  confirming = true
  try {
    const busy = Object.values(useAgent.getState().statuses).some((s) => s.type !== "idle")
    const globalBusy = await call<string[]>("live_busy_sessions")
    if (busy || globalBusy.length) {
      useUpdates.setState({ error: "Hay agentes trabajando. Esperá a que terminen antes de reiniciar." })
      return
    }
    const dirty = dirtyPaths()
    const terminals = useTerminals.getState().terminals.filter((t) => !t.exited).length
    const choice = await ask("Instalar actualización y reiniciar GuilleCode", {
      message: [
        `Se instalará la versión ${useUpdates.getState().update?.version}. Tus cuentas y conversaciones se conservan.`,
        dirty.length ? `Se guardarán ${dirty.length} archivos antes de cerrar.` : "",
        terminals ? `Se cerrarán ${terminals} terminales. Terminá sus procesos antes de continuar.` : "",
        "El acceso desde el celular se interrumpirá brevemente. Las rutinas activas impiden instalar.",
      ].filter(Boolean).join("\n"),
      icon: "cloud-download",
      buttons: [{ id: "cancel", label: "Más tarde" }, { id: "install", label: dirty.length ? "Guardar, instalar y reiniciar" : "Instalar y reiniciar", primary: true }],
    })
    if (choice !== "install") return
    // Freeze interaction while saving/checking, not after the installer starts.
    useUpdates.setState({ phase: "installing", error: null })
    await saveAll()
    if (dirtyPaths().length) throw new Error("Quedaron archivos sin guardar. La actualización no se instaló.")
    await call("update_install")
  } catch (e) {
    useUpdates.setState({ phase: "ready", error: errorMessage(e) })
  } finally {
    confirming = false
  }
}

let started = false
export function startUpdates(): void {
  if (started || !isTauri) return
  started = true
  void getVersion().then((version) => useUpdates.setState({ version })).catch(() => {})
  onEvent<{ downloaded: number; total: number | null }>("update://progress", (p) => useUpdates.setState(p))
  // Development builds never announce updates automatically.
  if (import.meta.env.DEV || !isMainWindow()) return
  setTimeout(() => void checkUpdates(), 10_000)
  setInterval(() => void checkUpdates(), 4 * 60 * 60_000)
  window.addEventListener("focus", () => {
    if (Date.now() - (useUpdates.getState().checkedAt ?? 0) > 15 * 60_000) void checkUpdates()
  })
}
