import { create } from "zustand"
import { readDir, type FsEntry } from "../lib/fs"
import { ancestors, dirname, normalizePath } from "../lib/paths"
import { loadJson, projectKey, saveJson } from "../lib/persist"

type Pending = { parent: string; kind: "file" | "folder" } | null

type ExplorerState = {
  root: string | null
  children: Record<string, FsEntry[]>
  expanded: Record<string, true>
  selected: string | null
  renaming: string | null
  creating: Pending
  revealNonce: number
}

export const useExplorer = create<ExplorerState>(() => ({
  root: null,
  children: {},
  expanded: {},
  selected: null,
  renaming: null,
  creating: null,
  revealNonce: 0,
}))

const k = (p: string) => normalizePath(p).toLowerCase()

export async function loadDir(dir: string): Promise<void> {
  try {
    const entries = await readDir(dir)
    useExplorer.setState((s) => ({ children: { ...s.children, [k(dir)]: entries } }))
  } catch {
    useExplorer.setState((s) => {
      const children = { ...s.children }
      delete children[k(dir)]
      const expanded = { ...s.expanded }
      delete expanded[k(dir)]
      return { children, expanded }
    })
  }
}

export async function initExplorer(root: string): Promise<void> {
  const saved = loadJson<string[]>(projectKey(root, "explorer.expanded"), [])
  const expanded: Record<string, true> = {}
  for (const p of saved) expanded[k(p)] = true
  useExplorer.setState({ root, expanded, children: {}, selected: null, renaming: null, creating: null })
  await loadDir(root)
  await Promise.all(saved.map((p) => loadDir(p)))
}

function persistExpanded() {
  const s = useExplorer.getState()
  if (!s.root) return
  saveJson(projectKey(s.root, "explorer.expanded"), Object.keys(s.expanded))
}

export async function toggleDir(dir: string, force?: boolean): Promise<void> {
  const key = k(dir)
  const isOpen = !!useExplorer.getState().expanded[key]
  const open = force ?? !isOpen
  useExplorer.setState((s) => {
    const expanded = { ...s.expanded }
    if (open) expanded[key] = true
    else delete expanded[key]
    return { expanded }
  })
  persistExpanded()
  if (open && !useExplorer.getState().children[key]) await loadDir(dir)
}

export function collapseAll(): void {
  useExplorer.setState({ expanded: {} })
  persistExpanded()
}

export async function revealInExplorer(path: string): Promise<void> {
  const root = useExplorer.getState().root
  if (!root) return
  const dirs = ancestors(root, path)
  useExplorer.setState((s) => {
    const expanded = { ...s.expanded }
    for (const d of dirs) expanded[k(d)] = true
    return { expanded, selected: normalizePath(path), revealNonce: s.revealNonce + 1 }
  })
  persistExpanded()
  for (const d of [root, ...dirs]) if (!useExplorer.getState().children[k(d)]) await loadDir(d)
  useExplorer.setState((s) => ({ revealNonce: s.revealNonce + 1 }))
}

export function refreshForPaths(paths: string[]): void {
  const s = useExplorer.getState()
  const dirs = new Set<string>()
  for (const p of paths) {
    const parent = dirname(p)
    if (s.children[k(parent)]) dirs.add(parent)
    if (s.children[k(p)]) dirs.add(p)
  }
  for (const d of dirs) void loadDir(d)
}

export function refreshAllLoaded(): void {
  const s = useExplorer.getState()
  const loaded = Object.keys(s.children)
  const byKey = new Map<string, string>()
  for (const entries of Object.values(s.children)) for (const e of entries) if (e.isDir) byKey.set(k(e.path), e.path)
  if (s.root) byKey.set(k(s.root), s.root)
  for (const key of loaded) {
    const path = byKey.get(key)
    if (path) void loadDir(path)
  }
}

export function selectEntry(path: string | null): void {
  useExplorer.setState({ selected: path ? normalizePath(path) : null })
}

export function startRename(path: string): void {
  useExplorer.setState({ renaming: normalizePath(path), creating: null })
}

export function startCreate(parent: string, kind: "file" | "folder"): void {
  void toggleDir(parent, true)
  useExplorer.setState({ creating: { parent: normalizePath(parent), kind }, renaming: null })
}

export function cancelInlineEdit(): void {
  useExplorer.setState({ renaming: null, creating: null })
}
