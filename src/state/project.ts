import { create } from "zustand"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { windowFocus, windowLabel, windowNew, windowsList } from "../lib/windows"
import { connection, resetConnection, setActiveDirectory, type ServerConfig } from "../lib/opencode"
import { basename, normalizePath, samePath } from "../lib/paths"
import { loadJson, projectKey, saveJson } from "../lib/persist"
import { stat } from "../lib/fs"
import { notify } from "./toasts"
import { pickOne } from "./quickinput"

type ProjectState = {
  project: string | null
  root: string | null
  ready: boolean
  error: string | null
  recent: string[]
}

export const useProject = create<ProjectState>(() => ({
  project: null,
  root: null,
  ready: false,
  error: null,
  recent: [],
}))

const ACTIVE_FEATURE_KEY = "features.active"

async function rememberedRoot(project: string): Promise<string> {
  const saved = loadJson<string | null>(projectKey(project, ACTIVE_FEATURE_KEY), null)
  if (!saved || samePath(saved, project) || !isTauri) return project
  try {
    const info = await stat(saved)
    return info.exists && info.is_dir ? normalizePath(saved) : project
  } catch {
    return project
  }
}

export async function initProject(): Promise<void> {
  try {
    const c = await connection()
    const project = c.worktree && c.worktree.trim() ? normalizePath(c.worktree) : null
    const root = project ? await rememberedRoot(project) : null
    setActiveDirectory(root)
    const recent = isTauri ? (await call<string[]>("recent_projects")).map(normalizePath) : []
    useProject.setState({ project, root, ready: true, recent })
  } catch (e) {
    useProject.setState({ ready: true, error: e instanceof Error ? e.message : String(e) })
  }
}

export function setActiveRoot(root: string): void {
  const next = normalizePath(root)
  setActiveDirectory(next)
  useProject.setState({ root: next })
  const project = useProject.getState().project
  if (project) saveJson(projectKey(project, ACTIVE_FEATURE_KEY), next)
}

async function focusIfOpenElsewhere(path: string): Promise<boolean> {
  const other = (await windowsList().catch(() => [])).find((w) => w.label !== windowLabel() && w.project && samePath(w.project, path))
  if (!other) return false
  await windowFocus(other.label)
  notify.info("Ese proyecto ya está abierto en otra ventana", "Te llevé a esa ventana")
  return true
}

export async function openInNewWindow(path?: string | null): Promise<void> {
  if (!isTauri) return
  try {
    if (path) {
      const current = useProject.getState().project
      if (current && samePath(current, path)) {
        notify.info("Ese proyecto ya está abierto en esta ventana")
        return
      }
      if (await focusIfOpenElsewhere(path)) return
    }
    await windowNew(path)
  } catch (e) {
    notify.error("No se pudo abrir la ventana", errorMessage(e))
  }
}

export async function pickRecentInNewWindow(): Promise<void> {
  const { recent, project } = useProject.getState()
  const items = recent
    .filter((p) => !project || !samePath(p, project))
    .map((p) => ({ id: p, label: basename(p), description: p, icon: "root-folder" }))
  if (items.length === 0) {
    notify.info("No hay otros proyectos recientes", "Usá «Abrir carpeta en una ventana nueva…»")
    return
  }
  const choice = await pickOne(items, { title: "Abrir en una ventana nueva", placeholder: "Elegí un proyecto reciente" })
  if (choice) await openInNewWindow(choice.id)
}

export async function pickWindow(): Promise<void> {
  if (!isTauri) return
  const windows = await windowsList().catch(() => [])
  const me = windowLabel()
  const choice = await pickOne(
    [
      ...windows.map((w) => ({
        id: w.label,
        label: w.project ? basename(w.project) : "Ventana sin carpeta",
        description: w.label === me ? "esta ventana" : w.main ? "ventana principal" : w.project,
        icon: w.label === me ? "window-active" : "window",
      })),
      { id: "__new__", label: "Nueva ventana", icon: "empty-window" },
    ],
    { title: "Ventanas de GuilleCode", placeholder: "Elegí una ventana" },
  )
  if (!choice) return
  if (choice.id === "__new__") await openInNewWindow()
  else if (choice.id !== me) await windowFocus(choice.id).catch((e) => notify.error("No se pudo ir a esa ventana", errorMessage(e)))
}

export async function pickProjectInNewWindow(): Promise<void> {
  if (!isTauri) return
  const dir = await openDialog({ directory: true, multiple: false, title: "Abrir carpeta en una ventana nueva" })
  if (typeof dir === "string" && dir) await openInNewWindow(dir)
}

export async function openProject(path: string): Promise<void> {
  if (!isTauri) return
  try {
    if (await focusIfOpenElsewhere(path)) return
    await call<ServerConfig>("set_server_worktree", { path })
    resetConnection()
    window.location.reload()
  } catch (e) {
    notify.error("No se pudo abrir el proyecto", e instanceof Error ? e.message : String(e))
  }
}

export async function pickProject(): Promise<void> {
  if (!isTauri) return
  const dir = await openDialog({ directory: true, multiple: false, title: "Abrir carpeta de proyecto" })
  if (typeof dir === "string" && dir) await openProject(dir)
}

export function requireRoot(): string {
  const root = useProject.getState().root
  if (!root) throw new Error("Abrí una carpeta de proyecto primero")
  return root
}
