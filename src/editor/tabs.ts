import { findTab, openTabsForPath, removeTabs, useEditors, type Tab } from "../state/editors"
import { closeDocument, isDirty, saveDocument } from "./documents"
import { ask } from "../components/Dialog"
import { basename } from "../lib/paths"

async function confirmClose(tabs: Tab[]): Promise<boolean> {
  const dirty = tabs.filter((t) => t.input.kind === "file" && isDirty(t.input.path))
  if (dirty.length === 0) return true
  const names = dirty.map((t) => (t.input.kind === "file" ? basename(t.input.path) : "")).join(", ")
  const choice = await ask(dirty.length === 1 ? `¿Guardar los cambios en ${names}?` : `¿Guardar los cambios en ${dirty.length} archivos?`, {
    message: dirty.length === 1 ? "Si no los guardás, se pierden." : names,
    icon: "save",
    buttons: [
      { id: "cancel", label: "Cancelar" },
      { id: "discard", label: "No guardar" },
      { id: "save", label: "Guardar", primary: true },
    ],
  })
  if (choice === "save") {
    for (const t of dirty) if (t.input.kind === "file" && !(await saveDocument(t.input.path))) return false
    return true
  }
  return choice === "discard"
}

function releaseDocs(tabs: Tab[]) {
  for (const t of tabs) {
    if (t.input.kind !== "file") continue
    const path = t.input.path
    if (openTabsForPath(path).length === 0) closeDocument(path)
  }
}

export async function closeTabs(predicate: (tab: Tab, groupId: string) => boolean): Promise<void> {
  const targets: Tab[] = []
  for (const g of useEditors.getState().groups) for (const t of g.tabs) if (predicate(t, g.id)) targets.push(t)
  if (targets.length === 0) return
  if (!(await confirmClose(targets))) return
  const ids = new Set(targets.map((t) => t.id))
  removeTabs((t) => ids.has(t.id))
  releaseDocs(targets)
}

export function closeTab(id: string): Promise<void> {
  return closeTabs((t) => t.id === id)
}

export function closeActiveTab(): Promise<void> {
  const s = useEditors.getState()
  const group = s.groups.find((g) => g.id === s.activeGroupId)
  if (!group?.activeId) return Promise.resolve()
  return closeTab(group.activeId)
}

export function closeOtherTabs(id: string): Promise<void> {
  const found = findTab(id)
  if (!found) return Promise.resolve()
  return closeTabs((t, gid) => gid === found.group.id && t.id !== id)
}

export function closeTabsToRight(id: string): Promise<void> {
  const found = findTab(id)
  if (!found) return Promise.resolve()
  const index = found.group.tabs.findIndex((t) => t.id === id)
  const right = new Set(found.group.tabs.slice(index + 1).map((t) => t.id))
  return closeTabs((t) => right.has(t.id))
}

export function closeSavedTabs(groupId?: string): Promise<void> {
  return closeTabs((t, gid) => (!groupId || gid === groupId) && !(t.input.kind === "file" && isDirty(t.input.path)))
}

export function closeAllTabs(groupId?: string): Promise<void> {
  return closeTabs((_t, gid) => !groupId || gid === groupId)
}
