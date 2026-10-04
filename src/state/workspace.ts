import { basename, normalizePath, samePath } from "../lib/paths"
import { setActiveRoot, useProject } from "./project"
import { persistEditors, resetEditors, restoreEditors } from "./editors"
import { initGit, resetGit } from "./git"
import { initExplorer } from "./explorer"
import { getFileIndex, resetFileIndex } from "./fileIndex"
import { bindAgentProject, loadSessions } from "./agent"
import { closeAllTerminals, createTerminal, liveTerminals } from "./terminals"
import { useLayout } from "./layout"
import { closeDocument, dirtyPaths, openDocumentPaths, saveAll } from "../editor/documents"
import { startSync } from "../workbench/sync"
import { ask } from "../components/Dialog"

let unbind: (() => void) | null = null
let switching = false

export function bindRoot(root: string): void {
  unbind?.()
  restoreEditors(root)
  const offEditors = persistEditors(root)
  void initGit(root)
  void initExplorer(root)
  const offSync = startSync(root)
  const indexTimer = setTimeout(() => void getFileIndex(root), 1500)
  unbind = () => {
    offEditors()
    offSync()
    clearTimeout(indexTimer)
  }
}

async function settleDirtyDocuments(): Promise<boolean> {
  const dirty = dirtyPaths()
  if (dirty.length === 0) return true
  const names = dirty.slice(0, 4).map(basename).join(", ") + (dirty.length > 4 ? ` y ${dirty.length - 4} más` : "")
  const choice = await ask(dirty.length === 1 ? "Hay un archivo sin guardar" : `Hay ${dirty.length} archivos sin guardar`, {
    message: `${names}. Guardalos antes de cambiar de feature, o descartá esos cambios.`,
    icon: "warning",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "discard", label: "Descartar", danger: true },
      { id: "save", label: "Guardar y seguir", primary: true },
    ],
  })
  if (choice === "save") {
    await saveAll()
    return dirtyPaths().length === 0
  }
  return choice === "discard"
}

async function confirmTerminals(label: string | undefined, silent: boolean): Promise<boolean> {
  const live = liveTerminals()
  if (live.length === 0 || silent) return true
  const app = live.some((t) => t.title === "app")
  const choice = await ask("Cambiar de feature", {
    message: `${live.length === 1 ? "Se cierra la terminal abierta" : `Se cierran las ${live.length} terminales abiertas`}${app ? ", incluida la app que está corriendo," : ""} y se liberan sus puertos${label ? ` antes de abrir «${label}»` : ""}. Los agentes siguen trabajando.`,
    icon: "question",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "ok", label: "Cambiar", primary: true },
    ],
  })
  return choice === "ok"
}

export function isSwitching(): boolean {
  return switching
}

export async function activateRoot(next: string, opts: { label?: string; silent?: boolean } = {}): Promise<boolean> {
  const target = normalizePath(next)
  const current = useProject.getState().root
  if (current && samePath(current, target)) return true
  if (switching) return false
  switching = true
  try {
    if (!(await settleDirtyDocuments())) return false
    if (!(await confirmTerminals(opts.label, !!opts.silent))) return false
    unbind?.()
    unbind = null
    await closeAllTerminals()
    for (const path of openDocumentPaths()) closeDocument(path)
    resetEditors()
    resetGit()
    resetFileIndex()
    setActiveRoot(target)
    bindAgentProject(target)
    bindRoot(target)
    void loadSessions()
    if (useLayout.getState().panelVisible) createTerminal({ show: false })
    return true
  } finally {
    switching = false
  }
}
