import { create } from "zustand"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { confirmAction } from "../components/Dialog"
import { openEditor } from "./editors"
import { useLayout } from "./layout"
import { useProject } from "./project"
import { notify } from "./toasts"

export type MemoryNote = { id: string; title: string; kind: string; updated: string; preview: string; source: string }
export type MemoryTask = { id: string; title: string; updated: string; directory: string; progress: string; lastUser: string; source: string }
export type MemoryOverview = { scope: string; slug: string; preferences: string; overview: string; notes: MemoryNote[]; tasks: MemoryTask[] }
export type MemorySection = "tasks" | "notes" | "preferences" | "overview"
export type MemoryEntry = { kind: "notes" | "tasks"; id: string }

const EMPTY: MemoryOverview = { scope: "", slug: "", preferences: "", overview: "", notes: [], tasks: [] }

export const useMemory = create<{
  data: MemoryOverview
  loaded: boolean
  error: string | null
  request: { scope: string; view: MemorySection; entry?: MemoryEntry; nonce: number } | null
}>(() => ({ data: EMPTY, loaded: false, error: null, request: null }))

let loadVersion = 0
let requestNonce = 0

export async function loadMemory(scope: string): Promise<void> {
  if (!isTauri) return
  const version = ++loadVersion
  if (useMemory.getState().data.scope !== scope) useMemory.setState({ data: { ...EMPTY, scope }, loaded: false, error: null })
  try {
    const data = await call<MemoryOverview>("memory_overview", { scope })
    if (version === loadVersion) useMemory.setState({ data, loaded: true, error: null })
  } catch (e) {
    if (version === loadVersion) useMemory.setState({ loaded: true, error: errorMessage(e) })
  }
}

export function openMemory(view: MemorySection = "tasks", entry?: MemoryEntry): void {
  useLayout.getState().showView("memory", false)
  useMemory.setState({ request: { scope: useProject.getState().root ?? "", view, entry, nonce: ++requestNonce } })
  openEditor({ kind: "memory" })
}

export function memoryEntryPath(slug: string, entry: MemoryEntry): string {
  const id = entry.kind === "tasks" ? entry.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : entry.id
  return `workspaces/${slug}/${entry.kind}/${id}.${entry.kind === "tasks" ? "json" : "md"}`
}

export async function writeMemory(command: string, args: Record<string, unknown>): Promise<void> {
  const result = await call<{ ok?: boolean; error?: string }>(command, args)
  if (!result?.ok) throw new Error(result?.error ?? "No se pudo guardar el cambio en la memoria")
}

export async function deleteMemoryEntry(entry: MemoryEntry, title: string): Promise<boolean> {
  const data = useMemory.getState().data
  if (!(await confirmAction(`Eliminar «${title}»`, entry.kind === "tasks" ? "Se elimina el estado guardado de este trabajo. El historial de la conversación se conserva." : "Se elimina esta nota de la memoria del proyecto.", "Eliminar", true))) return false
  try {
    await writeMemory(entry.kind === "tasks" ? "memory_delete_task" : "memory_delete_note", entry.kind === "tasks"
      ? { scope: data.scope, id: entry.id }
      : { id: memoryEntryPath(data.slug, entry) })
    notify.info(entry.kind === "tasks" ? "Trabajo eliminado de la memoria" : "Nota eliminada")
    await loadMemory(data.scope)
    return true
  } catch (e) {
    notify.error(errorMessage(e))
    return false
  }
}
