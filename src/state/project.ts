import { create } from "zustand"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { call, isTauri } from "../lib/tauri"
import { connection, resetConnection, type ServerConfig } from "../lib/opencode"
import { normalizePath } from "../lib/paths"
import { notify } from "./toasts"

type ProjectState = {
  root: string | null
  ready: boolean
  error: string | null
  recent: string[]
}

export const useProject = create<ProjectState>(() => ({
  root: null,
  ready: false,
  error: null,
  recent: [],
}))

export async function initProject(): Promise<void> {
  try {
    const c = await connection()
    const root = c.worktree && c.worktree.trim() ? normalizePath(c.worktree) : null
    const recent = isTauri ? (await call<string[]>("recent_projects")).map(normalizePath) : []
    useProject.setState({ root, ready: true, recent })
  } catch (e) {
    useProject.setState({ ready: true, error: e instanceof Error ? e.message : String(e) })
  }
}

export async function openProject(path: string): Promise<void> {
  if (!isTauri) return
  try {
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
